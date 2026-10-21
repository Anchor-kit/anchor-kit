import { createHmac } from 'node:crypto';
import type { DatabaseAdapter, WebhookEventRecord } from '../../../src/runtime/interfaces.ts';
import { DefaultWebhookProcessor } from '../../../src/runtime/webhooks/default-webhook-processor.ts';
import type { AnchorItConfig } from '../../../src/types/config.ts';

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

    const config: AnchorItConfig = {
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

  test('attempt identity and stable operation key are exposed to the callback context', async () => {
    let capturedContext: Record<string, unknown> | undefined;
    const config: AnchorItConfig = {
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
        onEvent: async (context) => {
          capturedContext = context as unknown as Record<string, unknown>;
          callbackInvokedCount += 1;
        },
      },
    };

    const contextProcessor = new DefaultWebhookProcessor({
      config,
      database: mockDatabase as DatabaseAdapter,
    });

    const result = await contextProcessor.process({
      eventId: 'evt_context',
      provider: 'test-provider',
      payload: { type: 'test' },
      rawBody: '{}',
    });

    expect(callbackInvokedCount).toBe(1);
    expect(capturedContext).defined();
    expect(capturedContext?.attemptId).toBeTruthy();
    expect(capturedContext?.operationKey).toBeTruthy();
    expect(capturedContext?.leaseOwner).toBeTruthy();
    expect(capturedContext?.leaseExpiresAt).toBeTruthy();
    expect(result.attemptId).toBe((capturedContext as { attemptId?: string })?.attemptId);
  });

  test('retries reuse the operation key but get a new attempt identity', async () => {
    const attemptIds = new Set<string>();
    const operationKeys = new Set<string>();
    const config: AnchorItConfig = {
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
        onEvent: async (context) => {
          const typedContext = context as unknown as {
            attemptId?: string;
            operationKey?: string;
          };
          if (typedContext.attemptId) attemptIds.add(typedContext.attemptId);
          if (typedContext.operationKey) operationKeys.add(typedContext.operationKey);
          callbackInvokedCount += 1;
        },
      },
    };

    const retryProcessor = new DefaultWebhookProcessor({
      config,
      database: mockDatabase as DatabaseAdapter,
    });

    await retryProcessor.process({
      eventId: 'evt_retry',
      provider: 'test-provider',
      payload: { type: 'test' },
      rawBody: '{}',
    });
    await retryProcessor.process({
      eventId: 'evt_retry',
      provider: 'test-provider',
      payload: { type: 'test' },
      rawBody: '{}',
      retry: true,
    });

    expect(callbackInvokedCount).toBe(2);
    expect(attemptIds.size).toBe(2);
    expect(operationKeys.size).toBe(1);
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

  test('Duplicate event with conflicting provider returns persisted provider', async () => {
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

  test('throws when verification is enabled but webhook secret is missing', async () => {
    const config: AnchorItConfig = {
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
    const config: AnchorItConfig = {
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

    const config: AnchorItConfig = {
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
