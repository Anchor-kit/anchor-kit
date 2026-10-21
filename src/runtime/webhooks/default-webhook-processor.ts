import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { AnchorKitConfig } from '@/types/config.ts';
import type { DatabaseAdapter, WebhookProcessor } from '@/runtime/interfaces.ts';

interface DefaultWebhookProcessorOptions {
  config: AnchorKitConfig;
  database: DatabaseAdapter;
}

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

export class DefaultWebhookProcessor implements WebhookProcessor {
  private readonly config: AnchorKitConfig;
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
    rawBody: string;
    signature?: string;
  }): Promise<{ duplicate: boolean; eventId: string }> {
    if (this.shuttingDown) {
      throw new Error('Webhook processor is shutting down');
    }
    const process = this.processEvent(input);
    this.activeProcesses.add(process);
    try {
      return await process;
    } finally {
      this.activeProcesses.delete(process);
    }
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.activeControllers) {
      controller.abort(new Error('Webhook processor is shutting down'));
    }
    await Promise.allSettled(this.activeProcesses);
  }

  private async processEvent(input: {
    eventId: string;
    provider: string;
    payload: Record<string, unknown>;
    rawBody: string;
    signature?: string;
  }): Promise<{ duplicate: boolean; eventId: string }> {
    this.verifySignatureIfEnabled(input);

    const insertion = await this.database.insertWebhookEvent({
      id: randomUUID(),
      eventId: input.eventId,
      provider: input.provider,
      payload: input.payload,
    });

    if (!insertion.inserted) {
      return { duplicate: true, eventId: insertion.record.eventId };
    }

    try {
      const callback = this.config.webhooks?.onEvent;
      if (callback) {
        await this.invokeCallback(callback, {
          event: {
            id: insertion.record.id,
            eventId: insertion.record.eventId,
            provider: insertion.record.provider,
            payload: insertion.record.payload,
          },
          context: {
            receivedAt: insertion.record.createdAt,
            signature: input.signature,
          },
        });
      }

      await this.database.updateWebhookEventStatus({
        id: insertion.record.id,
        status: 'processed',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown webhook callback error';
      await this.database.updateWebhookEventStatus({
        id: insertion.record.id,
        status: 'failed',
        errorMessage: message,
      });
      throw error;
    }

    return { duplicate: false, eventId: insertion.record.eventId };
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
      context: { receivedAt: string; signature?: string };
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
    rawBody: string;
    signature?: string;
  }): void {
    const verifyEnabled = this.config.security.verifyWebhookSignatures ?? true;

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
