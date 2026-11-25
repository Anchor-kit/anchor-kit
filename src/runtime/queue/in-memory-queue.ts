import { ConfigError, ValidationError } from '../../core/errors.ts';
import type {
  QueueAdapter,
  QueueDrainStatus,
  QueueJob,
  QueueJobErrorClassification,
  QueueJobFailure,
  QueueJobRetryOptions,
} from '@/runtime/interfaces.ts';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Terminal failures retained per adapter. Financial work must stay reviewable; if an
 * operator does not drain the registry we keep the newest records and warn instead of
 * growing without bound.
 */
const MAX_RETAINED_FAILURES = 1000;

/**
 * Error codes that describe a deterministic defect in the job or its data. Retrying
 * these cannot succeed, so they are classified as permanent rather than transient.
 */
const NON_RETRYABLE_ERROR_CODES = new Set([
  '23502', // PostgreSQL not_null_violation
  '23503', // PostgreSQL foreign_key_violation
  '23505', // PostgreSQL unique_violation
  '22P02', // PostgreSQL invalid_text_representation
  '42703', // PostgreSQL undefined_column
  '42P01', // PostgreSQL undefined_table
  'SQLITE_CONSTRAINT',
  'SQLITE_MISMATCH',
  'SQLITE_NOTFOUND',
  'SQLITE_RANGE',
  'ERR_INVALID_ARG_TYPE',
  'ERR_OUT_OF_RANGE',
]);

/** Mark a job error as non-retryable, regardless of the configured classifier. */
export class PermanentJobError extends Error {
  public readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Mark a job error as transient even when its shape would otherwise look permanent. */
export class RetryableJobError extends Error {
  public readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

/**
 * Default retry classification. Explicit markers win, then known deterministic error
 * classes and codes, then an optional `retryable` flag on the error. Unknown errors are
 * treated as retryable because the attempt limit still guarantees termination; dropping
 * them immediately would hide work that a transient outage caused.
 */
export function classifyQueueJobError(error: unknown): QueueJobErrorClassification {
  if (error instanceof PermanentJobError) return 'permanent';
  if (error instanceof RetryableJobError) return 'retryable';
  if (error instanceof ConfigError || error instanceof ValidationError) return 'permanent';

  if (error !== null && typeof error === 'object') {
    const candidate = error as { retryable?: unknown; code?: unknown };
    if (candidate.retryable === false) return 'permanent';
    if (candidate.retryable === true) return 'retryable';
    if (typeof candidate.code === 'string' && NON_RETRYABLE_ERROR_CODES.has(candidate.code)) {
      return 'permanent';
    }
  }

  return 'retryable';
}

interface InMemoryQueueOptions {
  concurrency: number;
  maxPendingJobs?: number;
  retry?: QueueJobRetryOptions;
  classifyError?: (error: unknown) => QueueJobErrorClassification;
  onError?: (job: QueueJob, error: unknown) => void | Promise<void>;
  onFailedJob?: (failure: QueueJobFailure) => void | Promise<void>;
}

interface QueueEntry {
  id: string;
  job: QueueJob;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class InMemoryQueueAdapter implements QueueAdapter {
  private readonly concurrency: number;
  private readonly maxPendingJobs: number | undefined;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly classifyError: (error: unknown) => QueueJobErrorClassification;
  private readonly onError: InMemoryQueueOptions['onError'];
  private readonly onFailedJob: InMemoryQueueOptions['onFailedJob'];
  private readonly jobs: QueueEntry[] = [];
  private readonly waitingRetries = new Set<QueueEntry>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly failedJobs: QueueJobFailure[] = [];
  private running = false;
  private activeWorkers = 0;
  private worker: ((job: QueueJob) => Promise<void>) | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private nextJobId = 1;

  constructor(options: InMemoryQueueOptions) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      throw new ConfigError('InMemoryQueueAdapter concurrency must be a positive safe integer');
    }
    if (
      options.maxPendingJobs !== undefined &&
      (!Number.isSafeInteger(options.maxPendingJobs) || options.maxPendingJobs < 1)
    ) {
      throw new ConfigError('InMemoryQueueAdapter maxPendingJobs must be a positive safe integer');
    }

    const retry = options.retry ?? {};
    if (
      retry.maxAttempts !== undefined &&
      (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1)
    ) {
      throw new ConfigError(
        'InMemoryQueueAdapter retry.maxAttempts must be a positive safe integer',
      );
    }
    if (
      retry.baseDelayMs !== undefined &&
      (!Number.isSafeInteger(retry.baseDelayMs) || retry.baseDelayMs < 0)
    ) {
      throw new ConfigError(
        'InMemoryQueueAdapter retry.baseDelayMs must be a non-negative safe integer',
      );
    }
    if (
      retry.maxDelayMs !== undefined &&
      (!Number.isSafeInteger(retry.maxDelayMs) || retry.maxDelayMs < 0)
    ) {
      throw new ConfigError(
        'InMemoryQueueAdapter retry.maxDelayMs must be a non-negative safe integer',
      );
    }

    this.concurrency = options.concurrency;
    this.maxPendingJobs = options.maxPendingJobs;
    this.maxAttempts = retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.classifyError = options.classifyError ?? classifyQueueJobError;
    this.onError = options.onError;
    this.onFailedJob = options.onFailedJob;
  }

  public get status(): QueueDrainStatus {
    return {
      pending: this.jobs.length + this.waitingRetries.size,
      active: this.activeWorkers,
    };
  }

  public async enqueue(job: QueueJob): Promise<void> {
    const canStartImmediately =
      this.running && this.worker && this.activeWorkers < this.concurrency;
    if (
      this.maxPendingJobs !== undefined &&
      this.jobs.length + this.waitingRetries.size >= this.maxPendingJobs &&
      !canStartImmediately
    ) {
      throw new Error('In-memory queue is full');
    }

    this.jobs.push(this.createEntry(job));
    this.kick();
  }

  /**
   * Terminal failures awaiting operator review. The returned array is a copy; the queue
   * keeps ownership so callers cannot mutate its state.
   */
  public listFailedJobs(): readonly QueueJobFailure[] {
    return this.failedJobs.map((failure) => ({
      ...failure,
      job: structuredClone(failure.job),
    }));
  }

  /**
   * Re-enqueue a terminal failure with a fresh attempt budget. The failure record is
   * removed only when the job is accepted, so an operator retry is never lost.
   */
  public async requeueFailedJob(id: string): Promise<boolean> {
    const index = this.failedJobs.findIndex((failure) => failure.id === id);
    if (index === -1) return false;

    const canStartImmediately =
      this.running && this.worker && this.activeWorkers < this.concurrency;
    if (
      this.maxPendingJobs !== undefined &&
      this.jobs.length + this.waitingRetries.size >= this.maxPendingJobs &&
      !canStartImmediately
    ) {
      throw new Error('In-memory queue is full');
    }

    const [failure] = this.failedJobs.splice(index, 1);
    if (!failure) return false;

    this.jobs.push({ id: failure.id, job: failure.job, attempts: 0, timer: null });
    this.kick();
    return true;
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
    this.cancelPendingRetries();

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

  private createEntry(job: QueueJob): QueueEntry {
    return { id: `job-${this.nextJobId++}`, job, attempts: 0, timer: null };
  }

  /** Stop backoff timers and return their jobs to the waiting queue for the next start. */
  private cancelPendingRetries(): void {
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    for (const entry of this.waitingRetries) {
      entry.timer = null;
      this.jobs.push(entry);
    }
    this.waitingRetries.clear();
  }

  private computeBackoffMs(attempts: number): number {
    const exponential = this.baseDelayMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(this.maxDelayMs, exponential);
  }

  private scheduleRetry(entry: QueueEntry): void {
    this.waitingRetries.add(entry);
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      entry.timer = null;
      this.waitingRetries.delete(entry);

      this.jobs.push(entry);
      this.kick();
    }, this.computeBackoffMs(entry.attempts));

    entry.timer = timer;
    this.retryTimers.add(timer);
  }

  private recordFailure(
    entry: QueueEntry,
    attempts: number,
    outcome: QueueJobFailure['outcome'],
    error: unknown,
  ): QueueJobFailure {
    const failure: QueueJobFailure = {
      id: entry.id,
      job: entry.job,
      attempts,
      outcome,
      error,
      failedAt: new Date().toISOString(),
    };

    this.failedJobs.push(failure);
    if (this.failedJobs.length > MAX_RETAINED_FAILURES) {
      const dropped = this.failedJobs.shift();
      console.warn(
        `[AnchorKit] Failed queue job retention limit (${MAX_RETAINED_FAILURES}) reached; dropped the oldest record for job "${dropped?.job.type ?? 'unknown'}". Review failed jobs before older entries are lost.`,
      );
    }

    return failure;
  }

  private async reportFailure(
    job: QueueJob,
    error: unknown,
    failure: QueueJobFailure,
  ): Promise<void> {
    if (this.onError) {
      try {
        await this.onError(job, error);
      } catch (handlerError) {
        console.error(`[AnchorKit] Queue error handler failed for job "${job.type}"`, handlerError);
      }
    }

    if (this.onFailedJob) {
      try {
        await this.onFailedJob(failure);
      } catch (handlerError) {
        console.error(
          `[AnchorKit] Queue failed-job handler failed for job "${job.type}"`,
          handlerError,
        );
      }
    }

    if (!this.onError && !this.onFailedJob) {
      const reason =
        failure.outcome === 'permanent'
          ? 'failed permanently'
          : `exhausted ${failure.attempts} attempt(s)`;
      console.error(`[AnchorKit] Background queue job "${job.type}" ${reason}`, error);
    }
  }

  private async handleJobFailure(entry: QueueEntry, error: unknown): Promise<void> {
    const attempts = entry.attempts + 1;
    const classification = this.classifyError(error);

    if (classification === 'retryable' && attempts < this.maxAttempts) {
      entry.attempts = attempts;

      if (this.running) {
        this.scheduleRetry(entry);
      } else {
        // Shutdown raced the failure. Keep the job pending so a restart can retry it
        // instead of losing financial work.
        this.jobs.push(entry);
      }
      return;
    }

    const outcome: QueueJobFailure['outcome'] =
      classification === 'permanent' ? 'permanent' : 'exhausted';
    const failure = this.recordFailure(entry, attempts, outcome, error);
    await this.reportFailure(entry.job, error, failure);
  }

  private kick(): void {
    if (!this.running || !this.worker) return;

    while (this.activeWorkers < this.concurrency && this.jobs.length > 0) {
      if (!this.running) break;

      const entry = this.jobs.shift();
      if (!entry) break;

      this.activeWorkers += 1;
      const worker = this.worker;

      (async () => {
        try {
          await worker(entry.job);
        } catch (error) {
          await this.handleJobFailure(entry, error);
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
