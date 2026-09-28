import { createAnchor, makeSqliteDbUrlForTests } from '@/core/factory.ts';
import type { QueueJob } from '@/runtime/interfaces.ts';
import { InMemoryQueueAdapter } from '@/runtime/queue/in-memory-queue.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

describe('InMemoryQueueAdapter', () => {
  it('rejects invalid constructor concurrency values', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new InMemoryQueueAdapter({ concurrency: value as number })).toThrow(
        /positive safe integer/i,
      );
    }

    expect(() => new InMemoryQueueAdapter({ concurrency: 1 })).not.toThrow();
  });

  it('should honor concurrency limits when processing jobs', async () => {
    const concurrency = 2;
    const queue = new InMemoryQueueAdapter({ concurrency });

    let maxConcurrentJobs = 0;
    let currentConcurrentJobs = 0;
    let startedJobs = 0;
    const releases = Array.from({ length: 6 }, () => deferred());
    const twoStarted = deferred();

    const worker = async (job: QueueJob): Promise<void> => {
      const jobId = job.payload.jobId as number;
      currentConcurrentJobs += 1;
      startedJobs += 1;
      maxConcurrentJobs = Math.max(maxConcurrentJobs, currentConcurrentJobs);

      if (startedJobs === 2) {
        twoStarted.resolve();
      }

      await releases[jobId].promise;
      currentConcurrentJobs -= 1;
    };

    await queue.start(worker);

    for (let i = 0; i < 6; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { jobId: i },
      });
    }

    await twoStarted.promise;

    expect(maxConcurrentJobs).toBeLessThanOrEqual(concurrency);
    expect(maxConcurrentJobs).toBeGreaterThan(0);

    for (const release of releases) {
      release.resolve();
    }

    await queue.stop();
  });

  it('should process jobs sequentially when concurrency is 1', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });

    const executionOrder: number[] = [];
    const startedResolvers: Array<(() => void) | null> = [];
    const releaseResolvers: Array<(() => void) | null> = [];
    const startedPromises: Promise<void>[] = [];
    const releasePromises: Promise<void>[] = [];

    for (let i = 0; i < 4; i++) {
      startedPromises.push(
        new Promise<void>((resolve) => {
          startedResolvers[i] = resolve;
        }),
      );
      releasePromises.push(
        new Promise<void>((resolve) => {
          releaseResolvers[i] = resolve;
        }),
      );
    }

    const worker = async (job: QueueJob): Promise<void> => {
      const jobId = job.payload.jobId as number;
      executionOrder.push(jobId);
      startedResolvers[jobId]?.();
      await releasePromises[jobId];
    };

    await queue.start(worker);

    for (let i = 0; i < 4; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { jobId: i },
      });
    }

    for (let i = 0; i < 4; i++) {
      await startedPromises[i];
      releaseResolvers[i]?.();
    }

    expect(executionOrder).toEqual([0, 1, 2, 3]);
    await queue.stop();
  });

  it('continues processing later jobs after a worker throws', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    const processedJobs: number[] = [];
    const firstJobStarted = deferred();
    const firstJobRelease = deferred();
    const secondJobFinished = deferred();

    const worker = async (job: QueueJob): Promise<void> => {
      const id = job.payload.jobId as number;
      if (id === 0) {
        firstJobStarted.resolve();
        await firstJobRelease.promise;
        throw new Error('boom');
      }

      processedJobs.push(id);
      secondJobFinished.resolve();
    };

    await queue.start(worker);
    await queue.enqueue({ type: 'process_watcher_task', payload: { jobId: 0 } });
    await queue.enqueue({ type: 'process_watcher_task', payload: { jobId: 1 } });

    await firstJobStarted.promise;
    firstJobRelease.resolve();

    await secondJobFinished.promise;
    await queue.stop();

    expect(processedJobs).toEqual([1]);
  });

  it('should allow concurrent execution up to the limit', async () => {
    const concurrency = 3;
    const queue = new InMemoryQueueAdapter({ concurrency });

    let maxConcurrentJobs = 0;
    let currentConcurrentJobs = 0;
    const startedJobs = deferred();
    const releases = Array.from({ length: 5 }, () => deferred());

    const worker = async (job: QueueJob): Promise<void> => {
      const jobId = job.payload.jobId as number;
      currentConcurrentJobs += 1;
      maxConcurrentJobs = Math.max(maxConcurrentJobs, currentConcurrentJobs);

      if (currentConcurrentJobs === concurrency) {
        startedJobs.resolve();
      }

      await releases[jobId].promise;
      currentConcurrentJobs -= 1;
    };

    await queue.start(worker);

    for (let i = 0; i < 5; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { jobId: i },
      });
    }

    await startedJobs.promise;
    expect(maxConcurrentJobs).toBe(concurrency);
    expect(maxConcurrentJobs).toBeGreaterThan(0);

    for (const release of releases) {
      release.resolve();
    }

    await queue.stop();
  });

  it('should process jobs queued before start() after start() is called', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    const processedJobs: number[] = [];
    const done = deferred();

    const worker = async (job: QueueJob): Promise<void> => {
      processedJobs.push(job.payload.jobId as number);
      if (processedJobs.length === 3) {
        done.resolve();
      }
    };

    for (const jobId of [1, 2, 3]) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { jobId },
      });
    }

    expect(processedJobs).toHaveLength(0);

    await queue.start(worker);
    await done.promise;

    expect(processedJobs).toEqual([1, 2, 3]);
    await queue.stop();
  });

  it('should wait for in-flight jobs to complete when stop() is called', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 2 });
    let completedJobs = 0;
    let startedJobs = 0;
    const twoStarted = deferred();
    const releases = Array.from({ length: 4 }, () => deferred());

    const worker = async (job: QueueJob): Promise<void> => {
      const jobId = job.payload.i as number;
      startedJobs += 1;
      if (startedJobs === 2) {
        twoStarted.resolve();
      }

      await releases[jobId].promise;
      completedJobs += 1;
    };

    await queue.start(worker);

    for (let i = 0; i < 4; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { i },
      });
    }

    await twoStarted.promise;
    const stopPromise = queue.stop();

    releases[0].resolve();
    releases[1].resolve();

    await stopPromise;
    expect(completedJobs).toBe(2);
  });

  it('should not start new jobs after stop() is called', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    const startedJobs: number[] = [];
    const completedJobs: number[] = [];
    const firstJobStarted = deferred();
    const firstJobRelease = deferred();

    const worker = async (job: QueueJob): Promise<void> => {
      const id = job.payload.i as number;
      startedJobs.push(id);
      if (id === 0) {
        firstJobStarted.resolve();
      }

      await firstJobRelease.promise;
      completedJobs.push(id);
    };

    await queue.start(worker);

    for (let i = 0; i < 3; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { i },
      });
    }

    await firstJobStarted.promise;
    const stopPromise = queue.stop();
    firstJobRelease.resolve();

    await stopPromise;
    expect(startedJobs).toEqual([0]);
    expect(completedJobs).toEqual([0]);
    expect(startedJobs).toEqual([0]);
  });

  it('should handle multiple calls to stop() correctly', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 2 });
    let completedJobs = 0;
    const jobStarted = deferred();
    const jobRelease = deferred();

    const worker = async (_job: QueueJob): Promise<void> => {
      jobStarted.resolve();
      await jobRelease.promise;
      completedJobs += 1;
    };

    await queue.start(worker);
    await queue.enqueue({ type: 'process_watcher_task', payload: {} });

    await jobStarted.promise;
    const p1 = queue.stop();
    const p2 = queue.stop();
    const p3 = queue.stop();
    jobRelease.resolve();

    await Promise.all([p1, p2, p3]);
    expect(completedJobs).toBe(1);
  });

  it('should not start new jobs even if stop() is called while kick() is running', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 2 });
    const startedJobs: number[] = [];
    const firstTwoStarted = deferred();
    const releases = Array.from({ length: 3 }, () => deferred());

    const worker = async (job: QueueJob): Promise<void> => {
      const id = job.payload.i as number;
      startedJobs.push(id);
      if (startedJobs.length === 2) {
        firstTwoStarted.resolve();
      }

      await releases[id].promise;
    };

    await queue.start(worker);

    for (let i = 0; i < 3; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { i },
      });
    }

    await firstTwoStarted.promise;
    const stopPromise = queue.stop();
    releases[0].resolve();
    releases[1].resolve();
    await stopPromise;

    expect(startedJobs.length).toBeLessThanOrEqual(2);
  });

  it('should not process jobs enqueued after stop()', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    const processedJobs: number[] = [];

    const worker = async (job: QueueJob): Promise<void> => {
      processedJobs.push(job.payload.jobId as number);
    };

    await queue.start(worker);
    await queue.stop();

    await queue.enqueue({
      type: 'process_watcher_task',
      payload: { jobId: 99 },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processedJobs).toEqual([]);
  });

  it('should resolve stop() only after the very last job is completely finished', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    let jobFinished = false;
    const jobStarted = deferred();
    const jobRelease = deferred();

    const worker = async (_job: QueueJob): Promise<void> => {
      jobStarted.resolve();
      await jobRelease.promise;
      jobFinished = true;
    };

    await queue.start(worker);
    await queue.enqueue({ type: 'process_watcher_task', payload: {} });

    await jobStarted.promise;
    const stopPromise = queue.stop();
    expect(jobFinished).toBe(false);

    jobRelease.resolve();
    await stopPromise;
    expect(jobFinished).toBe(true);
  });

  it('rejects a different worker while the queue is running', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    const firstWorker = async (_job: QueueJob): Promise<void> => undefined;
    const secondWorker = async (_job: QueueJob): Promise<void> => undefined;

    await queue.start(firstWorker);

    await expect(queue.start(secondWorker)).rejects.toThrow(/already running/i);
    await queue.stop();
  });

  it('keeps pending jobs across stop and restart', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    const processed: number[] = [];
    const started = deferred();
    const complete = deferred();

    const worker = async (job: QueueJob): Promise<void> => {
      const id = job.payload.jobId as number;
      processed.push(id);
      if (processed.length === 3) {
        started.resolve();
      }
      if (id === 3) {
        complete.resolve();
      }
    };

    await queue.enqueue({ type: 'process_watcher_task', payload: { jobId: 1 } });
    await queue.enqueue({ type: 'process_watcher_task', payload: { jobId: 2 } });
    await queue.start(worker);
    await queue.stop();
    await queue.enqueue({ type: 'process_watcher_task', payload: { jobId: 3 } });
    await queue.start(worker);

    await complete.promise;
    await started.promise;
    expect(processed).toEqual([1, 2, 3]);
  });

  it('surfaces unknown queue job types instead of silently succeeding', async () => {
    const anchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: Keypair.random().secret(),
        interactiveJwtSecret: 'jwt-secret',
        distributionAccountSecret: 'distribution-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
      framework: {
        database: { provider: 'sqlite', url: makeSqliteDbUrlForTests() },
      },
    });

    await anchor.init();
    const processQueueJob = (
      Object.getPrototypeOf(anchor) as {
        processQueueJob: (job: { type: string; payload: Record<string, unknown> }) => Promise<void>;
      }
    ).processQueueJob.bind(anchor);
    await expect(
      processQueueJob({
        type: 'unknown_job',
        payload: { jobId: 42 },
      }),
    ).rejects.toThrow(/Unknown queue job type: unknown_job/);
    await anchor.shutdown();
  });
});
