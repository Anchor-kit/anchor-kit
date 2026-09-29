import type { QueueAdapter, QueueJob } from '@/runtime/interfaces.ts';

interface InMemoryQueueOptions {
  concurrency: number;
  maxPendingJobs?: number;
  onError?: (job: QueueJob, error: unknown) => void | Promise<void>;
}

export class InMemoryQueueAdapter implements QueueAdapter {
  private readonly concurrency: number;
  private readonly maxPendingJobs: number | undefined;
  private readonly onError: InMemoryQueueOptions['onError'];
  private readonly jobs: QueueJob[] = [];
  private running = false;
  private activeWorkers = 0;
  private worker: ((job: QueueJob) => Promise<void>) | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;

  constructor(options: InMemoryQueueOptions) {
    this.concurrency = options.concurrency;
    this.maxPendingJobs = options.maxPendingJobs;
    this.onError = options.onError;
  }

  public async enqueue(job: QueueJob): Promise<void> {
    const canStartImmediately = this.running && this.worker && this.activeWorkers < this.concurrency;
    if (
      this.maxPendingJobs !== undefined &&
      this.jobs.length >= this.maxPendingJobs &&
      !canStartImmediately
    ) {
      throw new Error('In-memory queue is full');
    }

    this.jobs.push(job);
    this.kick();
  }

  public async start(worker: (job: QueueJob) => Promise<void>): Promise<void> {
    this.worker = worker;
    this.running = true;
    this.kick();
  }

  public async stop(): Promise<void> {
    this.running = false;

    if (this.activeWorkers === 0) {
      return;
    }

    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });

    // In case activeWorkers reached 0 between our check and creating the promise
    if (this.activeWorkers === 0) {
      this.resolveStop?.();
      this.resolveStop = null;
      this.stopPromise = null;
    }

    return this.stopPromise || Promise.resolve();
  }

  private kick(): void {
    if (!this.running || !this.worker) return;

    while (this.activeWorkers < this.concurrency && this.jobs.length > 0) {
      if (!this.running) break;

      const job = this.jobs.shift();
      if (!job) break;

      this.activeWorkers += 1;
      const worker = this.worker;

      (async () => {
        try {
          await worker(job);
        } catch (error) {
          try {
            await this.onError?.(job, error);
          } catch {
            // Reporting failures must not prevent other queued jobs from running.
          }
        } finally {
          this.activeWorkers -= 1;

          if (!this.running && this.activeWorkers === 0 && this.resolveStop) {
            this.resolveStop();
            this.resolveStop = null;
            this.stopPromise = null;
          }

          this.kick();
        }
      })();
    }
  }
}
