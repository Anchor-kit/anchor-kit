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
          createdAt: new Date().toISOString(),
        },
      }),
      updateWebhookEventStatus: vi.fn().mockResolvedValue(undefined),
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

    // Should rethrow the error
    await expect(processor.process(input)).rejects.toThrow('Callback failed');

    // Should have updated status to failed with error message
    expect(mockDatabase.updateWebhookEventStatus).toHaveBeenCalledWith({
      id: 'internal-id',
      status: 'failed',
      errorMessage: 'Callback failed',
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
          createdAt: new Date().toISOString(),
        },
      }),
      updateWebhookEventStatus: vi.fn().mockResolvedValue(undefined),
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
    expect(mockDatabase.updateWebhookEventStatus).toHaveBeenCalledWith({
      id: 'internal-id-2',
      status: 'processed',
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
        },
      });
    const mockDatabase = {
      insertOrGetWebhookEvent,
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
    expect(mockDatabase.updateWebhookEventStatus).toHaveBeenLastCalledWith({
      id: 'internal-id-3',
      status: 'processed',
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
