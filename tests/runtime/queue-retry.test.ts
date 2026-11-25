import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { createAnchor, makeSqliteDbUrlForTests } from '@/core/factory.ts';
import type { QueueJob, QueueJobFailure } from '@/runtime/interfaces.ts';
import {
  InMemoryQueueAdapter,
  PermanentJobError,
  RetryableJobError,
} from '@/runtime/queue/in-memory-queue.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function watcherJob(watcherTaskId: string): QueueJob {
  return { type: 'process_watcher_task', payload: { watcherTaskId } };
}

function watcherTaskLabel(job: QueueJob): string {
  if (job.type !== 'process_watcher_task') {
    throw new Error('Expected process_watcher_task job');
  }

  return job.payload.watcherTaskId;
}

describe('InMemoryQueueAdapter bounded retry and failed-job handling', () => {
  it('retries transient failures within the configured bounds and reports success', async () => {
    const attempts: string[] = [];
    const recovered = deferred();
    const queue = new InMemoryQueueAdapter({
      concurrency: 1,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      onError: () => {
        throw new Error('onError must not fire for a job that recovers');
      },
    });

    await queue.start(async (job) => {
      attempts.push(watcherTaskLabel(job));
      if (attempts.length < 3) {
        throw new RetryableJobError('temporary rail outage');
      }
      recovered.resolve();
    });

    await queue.enqueue(watcherJob('transient'));
    await recovered.promise;
    await queue.stop();

    expect(attempts).toEqual(['transient', 'transient', 'transient']);
    expect(queue.listFailedJobs()).toEqual([]);
    expect(queue.status).toEqual({ pending: 0, active: 0 });
  });

  it('stops at the attempt limit and records exhausted work for operator review', async () => {
    let attempts = 0;
    const failures: QueueJobFailure[] = [];
    const reportedErrors: unknown[] = [];
    const observed = deferred();
    const queue = new InMemoryQueueAdapter({
      concurrency: 1,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      onError: (_job, error) => {
        reportedErrors.push(error);
      },
      onFailedJob: (failure) => {
        failures.push(failure);
        observed.resolve();
      },
    });

    await queue.start(async () => {
      attempts += 1;
      throw new RetryableJobError('rail is still unavailable');
    });
    await queue.enqueue(watcherJob('exhausted'));
    await observed.promise;
    await queue.stop();

    expect(attempts).toBe(2);
    expect(reportedErrors).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ attempts: 2, outcome: 'exhausted' });
    expect(failures[0]?.job).toEqual(watcherJob('exhausted'));
    expect(queue.listFailedJobs()).toHaveLength(1);
    expect(queue.status).toEqual({ pending: 0, active: 0 });
  });

  it('counts scheduled retries against the pending-job limit', async () => {
    const blockerStarted = deferred();
    const fillerStarted = deferred();
    const releaseWorkers = deferred();
    const queue = new InMemoryQueueAdapter({
      concurrency: 2,
      maxPendingJobs: 1,
      retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100 },
    });
    await queue.start(async (job) => {
      const id = watcherTaskLabel(job);
      if (id === 'waiting-retry') throw new RetryableJobError('temporary outage');
      if (id === 'blocker') blockerStarted.resolve();
      if (id === 'filler') fillerStarted.resolve();
      await releaseWorkers.promise;
    });
    await queue.enqueue(watcherJob('waiting-retry'));
    await queue.enqueue(watcherJob('blocker'));
    await blockerStarted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(queue.status).toMatchObject({ pending: 1, active: 1 });
    await queue.enqueue(watcherJob('filler'));
    await fillerStarted.promise;
    expect(queue.status).toMatchObject({ pending: 1, active: 2 });
    await expect(queue.enqueue(watcherJob('overflow'))).rejects.toThrow('In-memory queue is full');
    const stopping = queue.stop();
    releaseWorkers.resolve();
    await stopping;
    expect(queue.status).toMatchObject({ pending: 1, active: 0 });
  });

  it('does not retry permanent failures and records them once', async () => {
    let attempts = 0;
    const failures: QueueJobFailure[] = [];
    const observed = deferred();
    const queue = new InMemoryQueueAdapter({
      concurrency: 1,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
      onFailedJob: (failure) => {
        failures.push(failure);
        observed.resolve();
      },
    });

    await queue.start(async () => {
      attempts += 1;
      throw new PermanentJobError('transaction id is invalid');
    });
    await queue.enqueue(watcherJob('permanent'));
    await observed.promise;

    expect(attempts).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ attempts: 1, outcome: 'permanent' });
    expect((failures[0]?.error as Error).message).toContain('transaction id is invalid');
    await queue.stop();
  });

  it('requeues a reviewed failure with a fresh attempt budget', async () => {
    let shouldFail = true;
    let attempts = 0;
    const failures: QueueJobFailure[] = [];
    const failed = deferred();
    const recovered = deferred();
    const queue = new InMemoryQueueAdapter({
      concurrency: 1,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      onFailedJob: (failure) => {
        failures.push(failure);
        failed.resolve();
      },
    });

    await queue.start(async () => {
      attempts += 1;
      if (shouldFail) {
        throw new PermanentJobError('operator fixed the upstream record');
      }
      recovered.resolve();
    });
    await queue.enqueue(watcherJob('recoverable'));
    await failed.promise;

    const failedId = failures[0]?.id;
    expect(failedId).toBeDefined();
    expect(await queue.requeueFailedJob('missing-job')).toBe(false);

    shouldFail = false;
    expect(await queue.requeueFailedJob(failedId as string)).toBe(true);
    await recovered.promise;

    expect(attempts).toBe(2);
    expect(queue.listFailedJobs()).toEqual([]);
    await queue.stop();
  });

  it('rejects invalid retry options', () => {
    expect(() => new InMemoryQueueAdapter({ concurrency: 1, retry: { maxAttempts: 0 } })).toThrow(
      /retry\.maxAttempts must be a positive safe integer/i,
    );
    expect(() => new InMemoryQueueAdapter({ concurrency: 1, retry: { baseDelayMs: -1 } })).toThrow(
      /retry\.baseDelayMs must be a non-negative safe integer/i,
    );
    expect(() => new InMemoryQueueAdapter({ concurrency: 1, retry: { maxDelayMs: -1 } })).toThrow(
      /retry\.maxDelayMs must be a non-negative safe integer/i,
    );
  });

  it('surfaces malformed financial jobs as permanent failures through the public factory', async () => {
    const failures: QueueJobFailure[] = [];
    const observed = deferred();
    const anchor = createAnchor({
      network: { network: 'testnet' },
      server: {
        homeDomain: 'anchor.example.com',
        interactiveDomain: 'https://anchor.example.com',
      },
      security: {
        sep10SigningKey: Keypair.random().secret(),
        interactiveJwtSecret: 'jwt-test-secret',
        distributionAccountSecret: 'distribution-test-secret',
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
        queue: {
          backend: 'memory',
          retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
          onFailedJob: (failure) => {
            failures.push(failure);
            observed.resolve();
          },
        },
        watchers: { enabled: false },
      },
    });

    await anchor.init();
    const queue = (anchor as unknown as { queue: InMemoryQueueAdapter }).queue;
    await anchor.startBackgroundJobs();

    await queue.enqueue({ type: 'expire_transaction', payload: {} } as QueueJob);
    await observed.promise;

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ attempts: 1, outcome: 'permanent' });
    expect((failures[0]?.error as Error).message).toMatch(/Malformed expire_transaction job/);
    expect(anchor.getFailedQueueJobs()).toHaveLength(1);
    await anchor.stopBackgroundJobs();
    expect(anchor.getQueueStatus()).toEqual({ pending: 0, active: 0 });

    await anchor.shutdown();
  });
});
