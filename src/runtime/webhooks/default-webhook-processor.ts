import type { DatabaseAdapter, WebhookProcessor } from '@/runtime/interfaces.ts';
import type { AnchorKitConfigSnapshot } from '@/types/config.ts';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

interface DefaultWebhookProcessorOptions {
  config: AnchorKitConfigSnapshot;
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
  private readonly config: AnchorKitConfigSnapshot;
  private readonly database: DatabaseAdapter;

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
  }): Promise<{ duplicate: boolean; eventId: string; provider: string }> {
    this.verifySignatureIfEnabled(input);

    const insertion = await this.database.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId: input.eventId,
      provider: input.provider,
      payload: input.payload,
    });

    if (!insertion.inserted) {
      return {
        duplicate: true,
        eventId: insertion.record.eventId,
        provider: insertion.record.provider,
      };
    }

    try {
      await this.config.webhooks?.onEvent?.(
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
      );

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

    return {
      duplicate: false,
      eventId: insertion.record.eventId,
      provider: insertion.record.provider,
    };
  }

  private verifySignatureIfEnabled(input: {
    payload: Record<string, unknown>;
    rawBody: string | Buffer | Uint8Array;
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
