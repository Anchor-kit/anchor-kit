import type {
  DatabaseAdapter,
  WebhookCallbackContext,
  WebhookEventRecord,
  WebhookProcessor,
} from '@/runtime/interfaces.ts';
import type { AnchorKitConfig, AnchorKitConfigSnapshot } from '@/types/config.ts';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

interface DefaultWebhookProcessorOptions {
  config: AnchorKitConfigSnapshot;
  database: DatabaseAdapter;
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 30_000;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const CALLBACK_FAILURE_MESSAGE = 'Webhook callback failed';
const CALLBACK_TIMEOUT_MESSAGE = 'Webhook callback timed out';
const CALLBACK_LOCK_LOST_MESSAGE = 'Webhook attempt lost its processing lease';

function toComparableBuffer(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = toComparableBuffer(left);
  const rightBuffer = toComparableBuffer(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Derives a stable operation key for a webhook event. The key is deterministic for a given
 * (provider, eventId) pair so that retries and concurrent attempts always resolve to the
 * same external operation identity.
 */
export function deriveWebhookOperationKey(provider: string, eventId: string): string {
  return `${provider}:${eventId}`;
}

export class DefaultWebhookProcessor implements WebhookProcessor {
  private readonly config: AnchorKitConfigSnapshot;
  private readonly database: DatabaseAdapter;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeProcesses = new Set<Promise<{ duplicate: boolean; eventId: string }>>();
  private shuttingDown = false;

  constructor(options: DefaultWebhookProcessorOptions) {
    this.config = options.config;
    this.database = options.database;
  }

  public async process(input: {
    eventId: string;
    provider: string;
    payload: Record<string, unknown>;
    rawBody: string | Buffer | Uint8Array;
    signature?: string;
    retry?: boolean;
  }): Promise<{
    duplicate: boolean;
    eventId: string;
    provider: string;
    status?: WebhookEventRecord['status'];
    operationKey?: string;
    attemptId?: string;
    attemptCount?: number;
  }> {
    this.verifySignatureIfEnabled(input);

    const operationKey = deriveWebhookOperationKey(input.provider, input.eventId);

    const insertion = await this.database.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId: input.eventId,
      provider: input.provider,
      payload: input.payload,
      operationKey,
    });

    if (!insertion.inserted && !input.retry) {
      return {
        duplicate: true,
        eventId: insertion.record.eventId,
        provider: insertion.record.provider,
        status: insertion.record.status,
        operationKey: insertion.record.operationKey,
        attemptId: insertion.record.attemptId ?? undefined,
        attemptCount: insertion.record.attemptCount,
      };
    }

    const leaseOwner = randomUUID();
    const leaseDurationMs = DEFAULT_LEASE_DURATION_MS;
    const claimed = await this.database.claimWebhookAttempt({
      id: insertion.record.id,
      leaseOwner,
      leaseDurationMs,
    });

    if (!claimed) {
      return {
        duplicate: true,
        eventId: insertion.record.eventId,
        provider: insertion.record.provider,
        status: insertion.record.status,
        operationKey: insertion.record.operationKey,
        attemptId: insertion.record.attemptId ?? undefined,
        attemptCount: insertion.record.attemptCount,
      };
    }

    const attemptId = claimed.attemptId;
    if (!attemptId) {
      throw new Error('Webhook attempt claim did not return an attempt identity');
    }

    const context: WebhookCallbackContext = {
      operationKey: claimed.operationKey,
      attemptId,
      attemptCount: claimed.attemptCount,
      leaseOwner,
      leaseExpiresAt:
        claimed.leaseExpiresAt ?? new Date(Date.now() + leaseDurationMs).toISOString(),
      receivedAt: claimed.createdAt,
      signature: input.signature,
      rawBody: input.rawBody,
    };

    try {
      const callback = this.config.webhooks?.onEvent;
      if (callback) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() =>
              callback(
                {
                  id: claimed.id,
                  eventId: claimed.eventId,
                  provider: claimed.provider,
                  payload: claimed.payload,
                },
                context,
              ),
            ),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error(CALLBACK_TIMEOUT_MESSAGE)),
                this.config.webhooks?.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }

      const completed = await this.database.completeWebhookAttempt({
        id: claimed.id,
        attemptId,
        leaseOwner,
        status: 'processed',
      });
      if (!completed) {
        throw new Error(CALLBACK_LOCK_LOST_MESSAGE);
      }
    } catch (error) {
      const timedOut = error instanceof Error && error.message === CALLBACK_TIMEOUT_MESSAGE;
      const message = timedOut ? CALLBACK_TIMEOUT_MESSAGE : CALLBACK_FAILURE_MESSAGE;
      await this.database.completeWebhookAttempt({
        id: claimed.id,
        attemptId,
        leaseOwner,
        status: timedOut ? 'unresolved' : 'failed',
        errorMessage: message,
      });
      throw new Error('Webhook processing failed', { cause: error });
    }

    return {
      duplicate: false,
      eventId: claimed.eventId,
      provider: claimed.provider,
      operationKey: claimed.operationKey,
      attemptId: attemptId,
      attemptCount: claimed.attemptCount,
    };
  }

  private async invokeCallback(
    callback: NonNullable<AnchorKitConfig['webhooks']>['onEvent'],
    input: {
      event: {
        id: string;
        eventId: string;
        provider: string;
        payload: Record<string, unknown>;
      };
      context: {
        receivedAt: string;
        signature?: string;
        rawBody: string | Buffer | Uint8Array;
        signal?: AbortSignal;
      };
    },
  ): Promise<void> {
    if (!callback) return;
    if (this.shuttingDown) {
      throw new Error('Webhook processor is shutting down');
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeoutMs = this.config.webhooks?.timeoutMs ?? 30_000;
    const timeout = setTimeout(
      () => controller.abort(new Error('Webhook callback deadline exceeded')),
      timeoutMs,
    );
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason ?? new Error('Webhook callback aborted')),
        { once: true },
      );
    });

    try {
      await Promise.race([
        Promise.resolve().then(() =>
          callback(input.event, { ...input.context, signal: controller.signal }),
        ),
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private verifySignatureIfEnabled(input: {
    payload: Record<string, unknown>;
    rawBody: string | Buffer | Uint8Array;
    signature?: string;
  }): void {
    const verifyEnabled = this.config.security.verifyWebhookSignatures ?? false;
    if (!verifyEnabled) {
      return;
    }

    const webhookSecret = this.config.security.webhookSecret;
    if (!webhookSecret) {
      throw new Error(
        'Webhook signature verification is enabled but no webhook secret is configured',
      );
    }

    if (!input.signature) {
      throw new Error('Missing webhook signature');
    }

    const expected = createHmac('sha256', webhookSecret).update(input.rawBody).digest('hex');
    const normalizedSignature = input.signature.toLowerCase();
    const normalizedExpected = expected.toLowerCase();

    if (!safeEquals(normalizedExpected, normalizedSignature)) {
      throw new Error('Invalid webhook signature');
    }
  }
}
