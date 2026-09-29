import { describe, expect, it } from 'vitest';
import { InMemoryQueueAdapter } from '@/runtime/queue/in-memory-queue.ts';

describe('InMemoryQueueAdapter', () => {
  it('rejects a different worker while the queue is running', async () => {
    const adapter = new InMemoryQueueAdapter({ concurrency: 1 });
    const firstWorker = async (): Promise<void> => undefined;
    const secondWorker = async (): Promise<void> => undefined;

    await adapter.start(firstWorker);
    await expect(adapter.start(secondWorker)).rejects.toThrow(/already running/i);
    await adapter.stop();
  });
});
