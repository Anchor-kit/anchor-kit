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

  it('aborts a cooperative callback when its deadline expires', async () => {
    const mockDatabase = {
      insertWebhookEvent: vi.fn().mockResolvedValue({
        inserted: true,
        record: {
          id: 'timeout-id',
          eventId: 'timeout-event',
          provider: 'generic',
          payload: {},
          createdAt: new Date().toISOString(),
        },
      }),
      updateWebhookEventStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseAdapter;
    let callbackSignal: AbortSignal | undefined;
    const mockConfig = {
      security: { verifyWebhookSignatures: false },
      webhooks: {
        timeoutMs: 10,
        onEvent: vi.fn(
          (_event, context: { signal: AbortSignal }) =>
            new Promise<void>((resolve) => {
              callbackSignal = context.signal;
              context.signal.addEventListener('abort', () => resolve(), { once: true });
            }),
        ),
      },
    } as unknown as AnchorKitConfig;
    const processor = new DefaultWebhookProcessor({
      config: mockConfig,
      database: mockDatabase,
    });

    await expect(
      processor.process({
        eventId: 'timeout-event',
        provider: 'generic',
        payload: {},
        rawBody: '{}',
      }),
    ).rejects.toThrow('Webhook callback deadline exceeded');
    expect(callbackSignal?.aborted).toBe(true);
    expect(mockDatabase.updateWebhookEventStatus).toHaveBeenCalledWith({
      id: 'timeout-id',
      status: 'failed',
      errorMessage: 'Webhook callback deadline exceeded',
    });
  });

  it('aborts active callbacks during shutdown', async () => {
    const mockDatabase = {
      insertWebhookEvent: vi.fn().mockResolvedValue({
        inserted: true,
        record: {
          id: 'shutdown-id',
          eventId: 'shutdown-event',
          provider: 'generic',
          payload: {},
          createdAt: new Date().toISOString(),
        },
      }),
      updateWebhookEventStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseAdapter;
    let callbackSignal: AbortSignal | undefined;
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    const mockConfig = {
      security: { verifyWebhookSignatures: false },
      webhooks: {
        onEvent: vi.fn(
          (_event, context: { signal: AbortSignal }) =>
            new Promise<void>((resolve) => {
              callbackSignal = context.signal;
              callbackStarted();
              context.signal.addEventListener('abort', () => resolve(), { once: true });
            }),
        ),
      },
    } as unknown as AnchorKitConfig;
    const processor = new DefaultWebhookProcessor({
      config: mockConfig,
      database: mockDatabase,
    });
    const processing = processor.process({
      eventId: 'shutdown-event',
      provider: 'generic',
      payload: {},
      rawBody: '{}',
    });

    await started;
    await processor.shutdown();

    await expect(processing).rejects.toThrow('Webhook processor is shutting down');
    expect(callbackSignal?.aborted).toBe(true);
  });
});
