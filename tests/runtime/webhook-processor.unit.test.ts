import { describe, it, expect, vi } from 'vitest';
import { DefaultWebhookProcessor } from '@/runtime/webhooks/default-webhook-processor.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import type { AnchorKitConfig } from '@/types/config.ts';

describe('DefaultWebhookProcessor Unit Tests', () => {
  it('updates event status to failed when callback throws', async () => {
    const mockDatabase = {
      insertWebhookEvent: vi.fn().mockResolvedValue({
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

    await expect(processor.process(input)).rejects.toThrow('Webhook processing failed');

    // Should have updated status to failed with error message
    expect(mockDatabase.updateWebhookEventStatus).toHaveBeenCalledWith({
      id: 'internal-id',
      status: 'failed',
      errorMessage: 'Webhook callback failed',
    });
  });

  it('updates event status to processed when callback succeeds', async () => {
    const mockDatabase = {
      insertWebhookEvent: vi.fn().mockResolvedValue({
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

  it('marks a stalled callback failed when its configured timeout elapses', async () => {
    const mockDatabase = {
      insertWebhookEvent: vi.fn().mockResolvedValue({
        inserted: true,
        record: {
          id: 'timed-out-id',
          eventId: 'stalled-event',
          provider: 'generic',
          payload: {},
          createdAt: new Date().toISOString(),
        },
      }),
      updateWebhookEventStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseAdapter;
    const mockConfig = {
      security: { verifyWebhookSignatures: false },
      webhooks: {
        callbackTimeoutMs: 5,
        onEvent: vi.fn(() => new Promise<void>(() => undefined)),
      },
    } as unknown as AnchorKitConfig;
    const processor = new DefaultWebhookProcessor({
      config: mockConfig,
      database: mockDatabase,
    });

    await expect(
      processor.process({
        eventId: 'stalled-event',
        provider: 'generic',
        payload: {},
        rawBody: '{}',
      }),
    ).rejects.toThrow('Webhook processing failed');

    expect(mockDatabase.updateWebhookEventStatus).toHaveBeenCalledWith({
      id: 'timed-out-id',
      status: 'failed',
      errorMessage: 'Webhook callback timed out',
    });
  });
});
