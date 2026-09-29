import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { AnchorKitConfig } from '@/types/config.ts';
import type { DatabaseAdapter, WebhookProcessor } from '@/runtime/interfaces.ts';

interface DefaultWebhookProcessorOptions {
  config: AnchorKitConfig;
  database: DatabaseAdapter;
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 30_000;
const CALLBACK_FAILURE_MESSAGE = 'Webhook callback failed';
const CALLBACK_TIMEOUT_MESSAGE = 'Webhook callback timed out';

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
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() =>
              callback(
                {
                  id: insertion.record.id,
                  eventId: insertion.record.eventId,
                  provider: insertion.record.provider,
                  payload: insertion.record.payload,
                },
                {
                  receivedAt: insertion.record.createdAt,
                  signature: input.signature,
                },
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

      await this.database.updateWebhookEventStatus({
        id: insertion.record.id,
        status: 'processed',
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message === CALLBACK_TIMEOUT_MESSAGE
          ? CALLBACK_TIMEOUT_MESSAGE
          : CALLBACK_FAILURE_MESSAGE;
      await this.database.updateWebhookEventStatus({
        id: insertion.record.id,
        status: 'failed',
        errorMessage: message,
      });
      throw new Error('Webhook processing failed');
    }

    return { duplicate: false, eventId: insertion.record.eventId };
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

    if (!safeEquals(expected, input.signature)) {
      throw new Error('Invalid webhook signature');
    }
  }
}
