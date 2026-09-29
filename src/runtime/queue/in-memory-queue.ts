import { ConfigError } from '@/core/errors.ts';
import type { QueueAdapter, QueueJob } from '@/runtime/interfaces.ts';

interface InMemoryQueueOptions {
  concurrency: number;
}

export class InMemoryQueueAdapter implements QueueAdapter {
  private readonly concurrency: number;
  private readonly jobs: QueueJob[] = [];
  private running = false;
  private activeWorkers = 0;
  private worker: ((job: QueueJob) => Promise<void>) | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;

  constructor(options: InMemoryQueueOptions) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      throw new ConfigError('InMemoryQueueAdapter concurrency must be a positive safe integer');
    }

    this.concurrency = options.concurrency;
  }

  public async enqueue(job: QueueJob): Promise<void> {
    this.jobs.push(job);
    this.kick();
  }

  public async start(worker: (job: QueueJob) => Promise<void>): Promise<void> {
    if (this.running) {
      if (this.worker === worker) {
        return;
      }
      throw new Error('Queue is already running with a different worker callback.');
    }

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
        } catch {
          // Best-effort queue for MVP: job errors are handled by worker logic.
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
