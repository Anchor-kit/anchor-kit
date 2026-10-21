import { createHmac } from 'node:crypto';
import type { DatabaseAdapter, WebhookEventRecord } from '../../../src/runtime/interfaces.ts';
import { DefaultWebhookProcessor } from '../../../src/runtime/webhooks/default-webhook-processor.ts';
import type { AnchorKitConfig } from '../../../src/types/config.ts';

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
      insertOrGetWebhookEvent: async (input) => {
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
    expect(result.provider).toBe('test-provider');
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
    expect(result.provider).toBe('test-provider');
    expect(callbackInvokedCount).toBe(0);
  });

  test('duplicate event with conflicting provider returns persisted provider', async () => {
    const result = await processor.process({
      eventId: 'evt_duplicate',
      provider: 'different-provider', // Conflicting provider
      payload: { type: 'test' },
      rawBody: '{}',
    });

    expect(result.duplicate).toBe(true);
    expect(result.eventId).toBe('evt_duplicate');
    expect(result.provider).toBe('test-provider'); // Should return the persisted provider, not the request provider
    expect(callbackInvokedCount).toBe(0);
  });

  test('records an ambiguous timeout as unresolved and does not retry a duplicate delivery', async () => {
    const eventRecords = new Map<string, WebhookEventRecord>();
    let lateCallbackCount = 0;
    const database: Partial<DatabaseAdapter> = {
      async insertOrGetWebhookEvent(input) {
        const existing = eventRecords.get(input.eventId);
        if (existing) return { record: existing, inserted: false };
        const record: WebhookEventRecord = {
          id: input.id,
          eventId: input.eventId,
          provider: input.provider,
          payload: input.payload,
          status: 'pending',
          errorMessage: null,
          processedAt: null,
          createdAt: new Date().toISOString(),
        };
        eventRecords.set(input.eventId, record);
        return { record, inserted: true };
      },
      async updateWebhookEventStatus(input) {
        const record = [...eventRecords.values()].find((candidate) => candidate.id === input.id);
        if (record) {
          record.status = input.status;
          record.errorMessage = input.errorMessage ?? null;
        }
      },
    };
    const timeoutProcessor = new DefaultWebhookProcessor({
      config: {
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
          callbackTimeoutMs: 1,
          onEvent: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            lateCallbackCount += 1;
          },
        },
      },
      database: database as DatabaseAdapter,
    });

    const event = {
      eventId: 'evt-timeout',
      provider: 'test-provider',
      payload: { type: 'test' },
      rawBody: '{}',
    };
    await expect(timeoutProcessor.process(event)).rejects.toThrow('Webhook processing failed');
    const duplicate = await timeoutProcessor.process(event);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(duplicate).toMatchObject({ duplicate: true, status: 'unresolved' });
    expect(eventRecords.get('evt-timeout')?.status).toBe('unresolved');
    expect(lateCallbackCount).toBe(1);
  });

  test('throws when verification is enabled but webhook secret is missing', async () => {
    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { interactiveDomain: 'test.example.com' },
      assets: { assets: [] },
      framework: { database: { provider: 'sqlite', url: 'file::memory:' } },
      security: {
        sep10SigningKey: 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6',
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
        verifyWebhookSignatures: true,
      },
      webhooks: {
        onEvent: async () => {
          callbackInvokedCount += 1;
        },
      },
    };

    const processorWithMissingSecret = new DefaultWebhookProcessor({
      config,
      database: mockDatabase as DatabaseAdapter,
    });

    await expect(
      processorWithMissingSecret.process({
        eventId: 'evt_missing_secret',
        provider: 'test-provider',
        payload: { type: 'test' },
        rawBody: '{}',
        signature: 'invalid-signature',
      }),
    ).rejects.toThrow(
      'Webhook signature verification is enabled but no webhook secret is configured',
    );

    expect(callbackInvokedCount).toBe(0);
  });

  test('throws on invalid webhook signature and does not invoke callback', async () => {
    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { interactiveDomain: 'test.example.com' },
      assets: { assets: [] },
      framework: { database: { provider: 'sqlite', url: 'file::memory:' } },
      security: {
        sep10SigningKey: 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6',
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
        verifyWebhookSignatures: true,
        webhookSecret: 'webhook-test-secret',
      },
      webhooks: {
        onEvent: async () => {
          callbackInvokedCount += 1;
        },
      },
    };

    const secureProcessor = new DefaultWebhookProcessor({
      config,
      database: mockDatabase as DatabaseAdapter,
    });

    await expect(
      secureProcessor.process({
        eventId: 'evt_invalid_signature',
        provider: 'test-provider',
        payload: { type: 'test' },
        rawBody: '{}',
        signature: 'invalid-signature',
      }),
    ).rejects.toThrow('Invalid webhook signature');

    expect(callbackInvokedCount).toBe(0);
  });

  test('accepts a valid webhook signature and invokes callback', async () => {
    const webhookSecret = 'webhook-test-secret';
    const rawBody = '{"type":"test"}';
    const validSignature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { interactiveDomain: 'test.example.com' },
      assets: { assets: [] },
      framework: { database: { provider: 'sqlite', url: 'file::memory:' } },
      security: {
        sep10SigningKey: 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6',
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
        verifyWebhookSignatures: true,
        webhookSecret,
      },
      webhooks: {
        onEvent: async () => {
          callbackInvokedCount += 1;
        },
      },
    };

    const secureProcessor = new DefaultWebhookProcessor({
      config,
      database: mockDatabase as DatabaseAdapter,
    });

    const result = await secureProcessor.process({
      eventId: 'evt_valid_signature',
      provider: 'test-provider',
      payload: { type: 'test' },
      rawBody,
      signature: validSignature,
    });

    expect(result.duplicate).toBe(false);
    expect(result.eventId).toBe('evt_valid_signature');
    expect(result.provider).toBe('test-provider');
    expect(callbackInvokedCount).toBe(1);
  });
});
