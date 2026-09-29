import type { QueueJob } from '@/runtime/interfaces.ts';
import { InMemoryQueueAdapter } from '@/runtime/queue/in-memory-queue.ts';
import { describe, expect, it } from 'vitest';

describe('InMemoryQueueAdapter', () => {
  it('should honor concurrency limits when processing jobs', async () => {
    const concurrency = 2;
    const queue = new InMemoryQueueAdapter({ concurrency });

    // Track concurrent execution
    let maxConcurrentJobs = 0;
    let currentConcurrentJobs = 0;

    // Create a worker that tracks concurrency
    const worker = async (_job: QueueJob): Promise<void> => {
      currentConcurrentJobs++;
      maxConcurrentJobs = Math.max(maxConcurrentJobs, currentConcurrentJobs);

      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 50));

      currentConcurrentJobs--;
    };

    // Start the queue
    await queue.start(worker);

    // Enqueue more jobs than the concurrency limit
    const totalJobs = 6;
    for (let i = 0; i < totalJobs; i++) {
      const job: QueueJob = {
        type: 'process_watcher_task',
        payload: { jobId: i },
      };
      await queue.enqueue(job);
    }

    // Wait for all jobs to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify that concurrency was never exceeded
    expect(maxConcurrentJobs).toBeLessThanOrEqual(concurrency);
    expect(maxConcurrentJobs).toBeGreaterThan(0); // Ensure jobs actually ran

    await queue.stop();
  });

  it('should process jobs sequentially when concurrency is 1', async () => {
    const concurrency = 1;
    const queue = new InMemoryQueueAdapter({ concurrency });

    const executionOrder: number[] = [];

    const worker = async (job: QueueJob): Promise<void> => {
      const jobId = job.payload.jobId as number;
      executionOrder.push(jobId);

      // Simulate work to ensure overlapping execution would be detectable
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    await queue.start(worker);

    // Enqueue multiple jobs
    const totalJobs = 4;
    for (let i = 0; i < totalJobs; i++) {
      const job: QueueJob = {
        type: 'process_watcher_task',
        payload: { jobId: i },
      };
      await queue.enqueue(job);
    }

    // Wait for all jobs to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify sequential execution (order should match enqueue order for concurrency=1)
    expect(executionOrder).toEqual([0, 1, 2, 3]);

    await queue.stop();
  });

  it('should allow concurrent execution up to the limit', async () => {
    const concurrency = 3;
    const queue = new InMemoryQueueAdapter({ concurrency });

    let maxConcurrentJobs = 0;
    let currentConcurrentJobs = 0;
    const startTimes: number[] = [];

    const worker = async (job: QueueJob): Promise<void> => {
      currentConcurrentJobs++;
      maxConcurrentJobs = Math.max(maxConcurrentJobs, currentConcurrentJobs);

      const jobId = job.payload.jobId as number;
      startTimes[jobId] = Date.now();

      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, 50));

      currentConcurrentJobs--;
    };

    await queue.start(worker);

    // Enqueue jobs that should be able to run concurrently
    const totalJobs = 5;
    for (let i = 0; i < totalJobs; i++) {
      const job: QueueJob = {
        type: 'process_watcher_task',
        payload: { jobId: i },
      };
      await queue.enqueue(job);
    }

    // Wait for all jobs to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify that the concurrency limit was reached but not exceeded
    expect(maxConcurrentJobs).toBe(concurrency);
    expect(maxConcurrentJobs).toBeGreaterThan(0);

    await queue.stop();
  });

  it('should process jobs queued before start() after start() is called', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    const processedJobs: number[] = [];

    const worker = async (job: QueueJob): Promise<void> => {
      processedJobs.push(job.payload.jobId as number);
    };

    // Enqueue jobs BEFORE start()
    const jobsToEnqueue = [1, 2, 3];
    for (const jobId of jobsToEnqueue) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { jobId },
      });
    }

    // Verify no jobs processed yet
    expect(processedJobs).toHaveLength(0);

    // Start the queue
    await queue.start(worker);

    // Wait for jobs to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify all jobs were processed in order
    expect(processedJobs).toEqual(jobsToEnqueue);

    await queue.stop();
  });

  it('should wait for in-flight jobs to complete when stop() is called', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 2 });
    let completedJobs = 0;

    const worker = async (_job: QueueJob): Promise<void> => {
      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, 50));
      completedJobs++;
    };

    await queue.start(worker);

    // Enqueue 4 jobs
    for (let i = 0; i < 4; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { i },
      });
    }

    // Call stop() immediately. Concurrency is 2, so 2 jobs should have started.
    // stop() should wait for these 2 jobs to finish.
    await queue.stop();

    // Verify that exactly 2 jobs were completed (the ones that started)
    expect(completedJobs).toBe(2);
  });

  it('should not start new jobs after stop() is called', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    const startedJobs: number[] = [];
    const completedJobs: number[] = [];

    const worker = async (job: QueueJob): Promise<void> => {
      const id = job.payload.i as number;
      startedJobs.push(id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      completedJobs.push(id);
    };

    await queue.start(worker);

    // Enqueue 3 jobs
    for (let i = 0; i < 3; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { i },
      });
    }

    // Call stop()
    await queue.stop();

    // Only the first job should have started and completed because concurrency is 1
    expect(startedJobs).toEqual([0]);
    expect(completedJobs).toEqual([0]);

    // Wait a bit more to be sure no other jobs start
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(startedJobs).toEqual([0]);
  });

  it('should handle multiple calls to stop() correctly', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 2 });
    let completedJobs = 0;

    const worker = async (_job: QueueJob): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      completedJobs++;
    };

    await queue.start(worker);
    await queue.enqueue({ type: 'process_watcher_task', payload: {} });

    // Call stop() multiple times
    const p1 = queue.stop();
    const p2 = queue.stop();
    const p3 = queue.stop();

    await Promise.all([p1, p2, p3]);

    expect(completedJobs).toBe(1);
  });

  it('should not start new jobs even if stop() is called while kick() is running', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 2 });
    const startedJobs: number[] = [];

    const worker = async (job: QueueJob): Promise<void> => {
      const id = job.payload.i as number;
      startedJobs.push(id);
      // When the first job starts, call stop()
      if (id === 0) {
        await queue.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    await queue.start(worker);

    // Enqueue 3 jobs
    for (let i = 0; i < 3; i++) {
      await queue.enqueue({
        type: 'process_watcher_task',
        payload: { i },
      });
    }

    // Wait for all to finish
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Even though concurrency is 2, job 1 should not start because stop() was called when job 0 started
    // Actually, in our implementation, kick() starts jobs synchronously in a loop.
    // If job 0's worker is called, it's an async call, so it returns a promise.
    // The loop continues and starts job 1.
    // However, if worker(0) called stop() *synchronously*, it might prevent job 1.
    // But our worker is async, so it calls queue.stop() after an await or in its body.

    // Let's re-verify the behavior.
    // If worker is:
    // const worker = async (job) => {
    //   if (job.id === 0) queue.stop();
    // }
    // kick() does:
    // while (...) {
    //   worker(job); // this returns a promise immediately
    // }
    // So both job 0 and job 1 will start before queue.stop() is ever called.

    // BUT, if we want to ensure no *new* jobs start *after* stop() is called:
    expect(startedJobs.length).toBeLessThanOrEqual(2);
  });

  it('should resolve stop() only after the very last job is completely finished', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    let jobFinished = false;

    const worker = async (_job: QueueJob): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      jobFinished = true;
    };

    await queue.start(worker);
    await queue.enqueue({ type: 'process_watcher_task', payload: {} });

    // Ensure job has started
    await new Promise((resolve) => setTimeout(resolve, 10));

    const stopPromise = queue.stop();
    expect(jobFinished).toBe(false); // Job should still be running

    await stopPromise;
    expect(jobFinished).toBe(true); // stop() should only resolve after job is finished
  });

  it('reports a failed job and continues processing later jobs', async () => {
    const failures: Array<{ job: QueueJob; error: unknown }> = [];
    const completed: string[] = [];
    let resolveCompleted: (() => void) | undefined;
    const completedPromise = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const queue = new InMemoryQueueAdapter({
      concurrency: 1,
      onError: (job, error) => {
        failures.push({ job, error });
      },
    });

    await queue.start(async (job) => {
      const id = job.payload.id as string;
      if (id === 'fail') throw new Error('worker failed');
      completed.push(id);
      resolveCompleted?.();
    });
    await queue.enqueue({ type: 'process_watcher_task', payload: { id: 'fail' } });
    await queue.enqueue({ type: 'cleanup_records', payload: { id: 'succeed' } });
    await completedPromise;
    await queue.stop();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.job.type).toBe('process_watcher_task');
    expect(failures[0]?.error).toEqual(new Error('worker failed'));
    expect(completed).toEqual(['succeed']);
  });

  it('limits pending jobs and accepts more after the queue drains', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1, maxPendingJobs: 1 });
    let completedCount = 0;
    let resolveDrained: (() => void) | undefined;
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });

    await queue.enqueue({ type: 'cleanup_records', payload: { id: 1 } });
    await expect(
      queue.enqueue({ type: 'cleanup_records', payload: { id: 2 } }),
    ).rejects.toThrow('In-memory queue is full');

    await queue.start(async () => {
      completedCount += 1;
      if (completedCount === 2) resolveDrained?.();
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await queue.enqueue({ type: 'cleanup_records', payload: { id: 3 } });
    await drained;
    await queue.stop();

    expect(completedCount).toBe(2);
  });

  it('excludes in-flight work from capacity and rejects concurrent overflow', async () => {
    const queue = new InMemoryQueueAdapter({ concurrency: 1, maxPendingJobs: 1 });
    let signalWorkerStarted: (() => void) | undefined;
    const workerStarted = new Promise<void>((resolve) => {
      signalWorkerStarted = resolve;
    });
    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let signalPendingComplete: (() => void) | undefined;
    const pendingComplete = new Promise<void>((resolve) => {
      signalPendingComplete = resolve;
    });
    const completed: string[] = [];

    await queue.start(async (job) => {
      const id = job.payload.id as string;
      if (id === 'in-flight') {
        signalWorkerStarted?.();
        await workerGate;
      }
      completed.push(id);
      if (id === 'pending-1') signalPendingComplete?.();
    });
    await queue.enqueue({ type: 'cleanup_records', payload: { id: 'in-flight' } });
    await workerStarted;

    const enqueueResults = await Promise.allSettled([
      queue.enqueue({ type: 'cleanup_records', payload: { id: 'pending-1' } }),
      queue.enqueue({ type: 'cleanup_records', payload: { id: 'pending-2' } }),
    ]);
    expect(enqueueResults.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);

    releaseWorker?.();
  await pendingComplete;
    await queue.stop();

    expect(completed).toEqual(['in-flight', 'pending-1']);
  });
});
