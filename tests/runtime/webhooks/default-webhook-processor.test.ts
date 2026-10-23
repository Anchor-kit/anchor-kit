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
      operationKey: 'test-provider:evt_duplicate',
      attemptCount: 1,
      attemptId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    const eventRecords = new Map<string, WebhookEventRecord>([[existingRecord.id, existingRecord]]);

    // AK-046: deduplication is keyed by (provider, event_id). The mock mirrors
    // that behavior so a different provider using the same event_id is treated
    // as a distinct, non-duplicate event.
    mockDatabase = {
      insertOrGetWebhookEvent: async (input) => {
        const existing = [...eventRecords.values()].find(
          (record) => record.provider === input.provider && record.eventId === input.eventId,
        );
        if (existing) {
          if (existing.status === 'failed') {
            const retrying = {
              ...existing,
              status: 'pending' as const,
              errorMessage: null,
              processedAt: null,
              attemptId: null,
              leaseOwner: null,
              leaseExpiresAt: null,
            };
            eventRecords.set(existing.id, retrying);
            return { record: retrying, inserted: true };
          }
          return { record: existing, inserted: false };
        }
        const record: WebhookEventRecord = {
          id: input.id,
          eventId: input.eventId,
          provider: input.provider,
          payload: input.payload,
          status: 'pending',
          errorMessage: null,
          processedAt: null,
          createdAt: new Date().toISOString(),
          operationKey: input.operationKey ?? `${input.provider}:${input.eventId}`,
          attemptCount: 0,
          attemptId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        };
        eventRecords.set(record.id, record);
        return { record, inserted: true };
      },
      claimWebhookAttempt: async ({ id, leaseOwner, leaseDurationMs }) => {
        const record = [...eventRecords.values()].find((candidate) => candidate.id === id);
        if (!record || record.status !== 'pending') return null;
        const claimed = {
          ...record,
          attemptId: `attempt-${record.attemptCount + 1}`,
          attemptCount: record.attemptCount + 1,
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
        };
        eventRecords.set(id, claimed);
        return claimed;
      },
      completeWebhookAttempt: async (input) => {
        const record = eventRecords.get(input.id);
        if (
          !record ||
          record.attemptId !== input.attemptId ||
          record.leaseOwner !== input.leaseOwner ||
          record.status !== 'pending'
        ) {
          return false;
        }
        eventRecords.set(input.id, {
          ...record,
          status: input.status,
          errorMessage: input.errorMessage ?? null,
          processedAt: new Date().toISOString(),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return true;
      },
      updateWebhookEventStatus: async () => {},
    };

    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'test.example.com' },
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
    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'test.example.com' },
      assets: { assets: [] },
      framework: { database: { provider: 'sqlite', url: 'file::memory:' } },
      security: {
        sep10SigningKey: 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6',
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
        verifyWebhookSignatures: false,
      },
      webhooks: {
        onEvent: async (_event, context) => {
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
    expect(capturedContext).toBeDefined();
    expect(capturedContext?.attemptId).toBeTruthy();
    expect(capturedContext?.operationKey).toBeTruthy();
    expect(capturedContext?.leaseOwner).toBeTruthy();
    expect(capturedContext?.leaseExpiresAt).toBeTruthy();
    expect(result.attemptId).toBe((capturedContext as { attemptId?: string })?.attemptId);
  });

  test('retries reuse the operation key but get a new attempt identity', async () => {
    const attemptIds = new Set<string>();
    const operationKeys = new Set<string>();
    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'test.example.com' },
      assets: { assets: [] },
      framework: { database: { provider: 'sqlite', url: 'file::memory:' } },
      security: {
        sep10SigningKey: 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6',
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
        verifyWebhookSignatures: false,
      },
      webhooks: {
        onEvent: async (_event, context) => {
          const typedContext = context as unknown as {
            attemptId?: string;
            operationKey?: string;
          };
          if (typedContext.attemptId) attemptIds.add(typedContext.attemptId);
          if (typedContext.operationKey) operationKeys.add(typedContext.operationKey);
          callbackInvokedCount += 1;
          if (callbackInvokedCount === 1) throw new Error('temporary callback failure');
        },
      },
    };

    const retryProcessor = new DefaultWebhookProcessor({
      config,
      database: mockDatabase as DatabaseAdapter,
    });

    await expect(
      retryProcessor.process({
        eventId: 'evt_retry',
        provider: 'test-provider',
        payload: { type: 'test' },
        rawBody: '{}',
      }),
    ).rejects.toThrow('Webhook processing failed');
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

  test('duplicate event (same provider + eventId) returns duplicate: true and does not invoke callback', async () => {
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

  test('same eventId from a different provider is treated as a new event (AK-046)', async () => {
    const result = await processor.process({
      eventId: 'evt_duplicate',
      provider: 'different-provider',
      payload: { type: 'test' },
      rawBody: '{}',
    });

    // Under provider-plus-event identity, the different provider is a distinct
    // event and MUST be executed rather than silently swallowed as a duplicate.
    expect(result.duplicate).toBe(false);
    expect(result.eventId).toBe('evt_duplicate');
    expect(result.provider).toBe('different-provider');
    expect(callbackInvokedCount).toBe(1);
  });

  test('records an ambiguous timeout as unresolved and does not retry a duplicate delivery', async () => {
    const eventRecords = new Map<string, WebhookEventRecord>();
    let lateCallbackCount = 0;
    const database: Partial<DatabaseAdapter> = {
      async insertOrGetWebhookEvent(input) {
        const existing = [...eventRecords.values()].find(
          (record) => record.provider === input.provider && record.eventId === input.eventId,
        );
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
          operationKey: input.operationKey ?? `${input.provider}:${input.eventId}`,
          attemptCount: 0,
          attemptId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        };
        eventRecords.set(record.id, record);
        return { record, inserted: true };
      },
      async claimWebhookAttempt({ id, leaseOwner, leaseDurationMs }) {
        const record = eventRecords.get(id);
        if (!record || record.status !== 'pending') return null;
        const claimed = {
          ...record,
          attemptId: `attempt-${record.attemptCount + 1}`,
          attemptCount: record.attemptCount + 1,
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
        };
        eventRecords.set(id, claimed);
        return claimed;
      },
      async completeWebhookAttempt(input) {
        const record = eventRecords.get(input.id);
        if (
          !record ||
          record.attemptId !== input.attemptId ||
          record.leaseOwner !== input.leaseOwner ||
          record.status !== 'pending'
        ) {
          return false;
        }
        eventRecords.set(input.id, {
          ...record,
          status: input.status,
          errorMessage: input.errorMessage ?? null,
          processedAt: new Date().toISOString(),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return true;
      },
    };
    const timeoutProcessor = new DefaultWebhookProcessor({
      config: {
        network: { network: 'testnet' },
        server: { homeDomain: 'anchor.example.com', interactiveDomain: 'test.example.com' },
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
    expect(
      [...eventRecords.values()].find((record) => record.eventId === 'evt-timeout')?.status,
    ).toBe('unresolved');
    expect(lateCallbackCount).toBe(1);
  });

  test('throws when verification is enabled but webhook secret is missing', async () => {
    const config: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'test.example.com' },
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
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'test.example.com' },
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
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'test.example.com' },
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
