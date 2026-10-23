import { describe, it, expect, vi } from 'vitest';
import { DefaultWebhookProcessor } from '@/runtime/webhooks/default-webhook-processor.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import type { AnchorKitConfig } from '@/types/config.ts';

describe('DefaultWebhookProcessor Unit Tests', () => {
  it('updates event status to failed when callback throws', async () => {
    const mockDatabase = {
      insertOrGetWebhookEvent: vi.fn().mockResolvedValue({
        inserted: true,
        record: {
          id: 'internal-id',
          eventId: 'external-id',
          provider: 'generic',
          payload: {},
          status: 'pending',
          errorMessage: null,
          processedAt: null,
          createdAt: new Date().toISOString(),
          operationKey: 'generic:external-id',
          attemptCount: 0,
          attemptId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
      claimWebhookAttempt: vi.fn().mockImplementation(async ({ id, leaseOwner }) => ({
        id,
        eventId: 'external-id',
        provider: 'generic',
        payload: {},
        status: 'pending',
        errorMessage: null,
        processedAt: null,
        createdAt: new Date().toISOString(),
        operationKey: 'generic:external-id',
        attemptCount: 1,
        attemptId: 'attempt-1',
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      completeWebhookAttempt: vi.fn().mockResolvedValue(true),
    } as unknown as DatabaseAdapter;

    const mockConfig = {
      security: {
        verifyWebhookSignatures: false,
      },
      webhooks: {
        onEvent: vi.fn().mockRejectedValue(new Error('Callback failed')),
      },
    } as unknown as AnchorKitConfig;

    const processor = new DefaultWebhookProcessor({
      config: mockConfig,
      database: mockDatabase,
    });

    const input = {
      eventId: 'external-id',
      provider: 'generic',
      payload: {},
      rawBody: '{}',
    };

    await expect(processor.process(input)).rejects.toThrow('Webhook processing failed');

    // Should have updated status to failed with error message
    expect(mockDatabase.completeWebhookAttempt).toHaveBeenCalledWith({
      id: 'internal-id',
      attemptId: 'attempt-1',
      leaseOwner: expect.any(String),
      status: 'failed',
      errorMessage: 'Webhook callback failed',
    });
  });

  it('updates event status to processed when callback succeeds', async () => {
    const mockDatabase = {
      insertOrGetWebhookEvent: vi.fn().mockResolvedValue({
        inserted: true,
        record: {
          id: 'internal-id-2',
          eventId: 'external-id-2',
          provider: 'generic',
          payload: {},
          status: 'pending',
          errorMessage: null,
          processedAt: null,
          createdAt: new Date().toISOString(),
          operationKey: 'generic:external-id-2',
          attemptCount: 0,
          attemptId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
      claimWebhookAttempt: vi.fn().mockImplementation(async ({ id, leaseOwner }) => ({
        id,
        eventId: 'external-id-2',
        provider: 'generic',
        payload: {},
        status: 'pending',
        errorMessage: null,
        processedAt: null,
        createdAt: new Date().toISOString(),
        operationKey: 'generic:external-id-2',
        attemptCount: 1,
        attemptId: 'attempt-1',
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      completeWebhookAttempt: vi.fn().mockResolvedValue(true),
    } as unknown as DatabaseAdapter;

    const mockConfig = {
      security: {
        verifyWebhookSignatures: false,
      },
      webhooks: {
        onEvent: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as AnchorKitConfig;

    const processor = new DefaultWebhookProcessor({
      config: mockConfig,
      database: mockDatabase,
    });

    const input = {
      eventId: 'external-id-2',
      provider: 'generic',
      payload: {},
      rawBody: '{}',
    };

    const result = await processor.process(input);
    expect(result.duplicate).toBe(false);

    // Should have updated status to processed
    expect(mockDatabase.completeWebhookAttempt).toHaveBeenCalledWith({
      id: 'internal-id-2',
      attemptId: 'attempt-1',
      leaseOwner: expect.any(String),
      status: 'processed',
      errorMessage: undefined,
    });
  });

  it('retries a failed event but blocks an already processed duplicate', async () => {
    const failingRecord = {
      id: 'internal-id-3',
      eventId: 'external-id-3',
      provider: 'generic',
      payload: { type: 'test' },
      status: 'failed',
      errorMessage: 'temporary failure',
      processedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      operationKey: 'generic:external-id-3',
      attemptCount: 0,
      attemptId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    };

    const insertOrGetWebhookEvent = vi
      .fn<DatabaseAdapter['insertOrGetWebhookEvent']>()
      .mockResolvedValueOnce({
        inserted: true,
        record: {
          ...failingRecord,
          status: 'pending',
          errorMessage: null,
          processedAt: null,
          payload: { type: 'retry' },
          attemptId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
    const mockDatabase = {
      insertOrGetWebhookEvent,
      async claimWebhookAttempt({ id, leaseOwner }: { id: string; leaseOwner: string }) {
        return {
          ...failingRecord,
          id,
          status: 'pending' as const,
          attemptId: 'attempt-1',
          attemptCount: 1,
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      completeWebhookAttempt: vi.fn().mockResolvedValue(true),
      updateWebhookEventStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseAdapter;

    const onEvent = vi.fn().mockResolvedValue(undefined);
    const processor = new DefaultWebhookProcessor({
      config: {
        security: { verifyWebhookSignatures: false },
        webhooks: { onEvent },
      } as unknown as AnchorKitConfig,
      database: mockDatabase,
    });

    const retryResult = await processor.process({
      eventId: 'external-id-3',
      provider: 'generic',
      payload: { type: 'retry' },
      rawBody: '{}',
    });

    expect(retryResult.duplicate).toBe(false);
    expect(retryResult.eventId).toBe('external-id-3');
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(mockDatabase.completeWebhookAttempt).toHaveBeenLastCalledWith({
      id: 'internal-id-3',
      attemptId: 'attempt-1',
      leaseOwner: expect.any(String),
      status: 'processed',
      errorMessage: undefined,
    });

    insertOrGetWebhookEvent.mockResolvedValueOnce({
      inserted: false,
      record: {
        ...failingRecord,
        status: 'processed',
        errorMessage: null,
      },
    });

    const duplicateResult = await processor.process({
      eventId: 'external-id-3',
      provider: 'generic',
      payload: { type: 'retry' },
      rawBody: '{}',
    });

    expect(duplicateResult.duplicate).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
