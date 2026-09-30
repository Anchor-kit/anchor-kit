import { DefaultWebhookProcessor } from '../../../src/runtime/webhooks/default-webhook-processor.ts';
import type { AnchorKitConfig } from '../../../src/types/config.ts';
import type { DatabaseAdapter, WebhookEventRecord } from '../../../src/runtime/interfaces.ts';
import { createHmac } from 'node:crypto';

describe('DefaultWebhookProcessor', () => {
  let processor: DefaultWebhookProcessor;
  let mockDatabase: Partial<DatabaseAdapter>;
  let callbackInvokedCount: number;

  beforeEach(() => {
    callbackInvokedCount = 0;

    const existingRecord: WebhookEventRecord = {
      id: 'existing-id',
      eventId: 'evt_duplicate',
      provider: 'test-provider',
      payload: { type: 'test' },
      status: 'processed',
      errorMessage: null,
      processedAt: '2024-01-01T00:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    mockDatabase = {
      insertWebhookEvent: async (input) => {
        if (input.eventId === 'evt_duplicate') {
          return { record: existingRecord, inserted: false };
        }
        return {
          record: {
            id: input.id,
            eventId: input.eventId,
            provider: input.provider,
            payload: input.payload,
            status: 'pending' as const,
            errorMessage: null,
            processedAt: null,
            createdAt: new Date().toISOString(),
          },
          inserted: true,
        };
      },
      updateWebhookEventStatus: async () => {},
    };

    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { interactiveDomain: 'test.example.com' },
      assets: { assets: [] },
      framework: { database: { provider: 'sqlite', url: 'file::memory:' } },
      security: {
        sep10SigningKey: 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6',
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
        verifyWebhookSignatures: false,
      },
      webhooks: {
        onEvent: async () => {
          callbackInvokedCount += 1;
        },
      },
    };

    processor = new DefaultWebhookProcessor({
      config,
      database: mockDatabase as DatabaseAdapter,
    });
  });

  test('first event with new eventId invokes callback and returns duplicate: false', async () => {
    const result = await processor.process({
      eventId: 'evt_new',
      provider: 'test-provider',
      payload: { type: 'test' },
      rawBody: '{}',
    });

    expect(result.duplicate).toBe(false);
    expect(result.eventId).toBe('evt_new');
    expect(callbackInvokedCount).toBe(1);
  });

  test('duplicate event returns duplicate: true and does not invoke callback', async () => {
    const result = await processor.process({
      eventId: 'evt_duplicate',
      provider: 'test-provider',
      payload: { type: 'test' },
      rawBody: '{}',
    });

    expect(result.duplicate).toBe(true);
    expect(result.eventId).toBe('evt_duplicate');
    expect(callbackInvokedCount).toBe(0);
  });

  test('callback receives the exact signed raw body for strings and buffers', async () => {
    const secret = 'webhook-secret';
    const callbackRawBodies: Array<string | Buffer | Uint8Array> = [];
    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { interactiveDomain: 'test.example.com' },
      assets: { assets: [] },
      framework: { database: { provider: 'sqlite', url: 'file::memory:' } },
      security: {
        sep10SigningKey: 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6',
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
        webhookSecret: secret,
        verifyWebhookSignatures: true,
      },
      webhooks: {
        onEvent: async (_event, context) => {
          callbackRawBodies.push(context.rawBody);
        },
      },
    };
    const verifiedProcessor = new DefaultWebhookProcessor({
      config,
      database: mockDatabase as DatabaseAdapter,
    });
    const rawBodies = ['{"amount":"25.00"}', Buffer.from('{"amount":"25.00"}')];

    for (const [index, rawBody] of rawBodies.entries()) {
      const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
      await verifiedProcessor.process({
        eventId: `evt_signed_${index}`,
        provider: 'test-provider',
        payload: { amount: '25.00' },
        rawBody,
        signature,
      });
    }

    expect(callbackRawBodies[0]).toBe(rawBodies[0]);
    expect(Buffer.isBuffer(callbackRawBodies[1])).toBe(true);
    expect(callbackRawBodies[1]).toEqual(rawBodies[1]);
  });
});
