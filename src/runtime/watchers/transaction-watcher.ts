import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter, QueueAdapter, Watcher } from '@/runtime/interfaces.ts';

interface TransactionWatcherOptions {
  pollIntervalMs: number;
  transactionTimeoutMs: number;
  retentionDays: number;
}

export class TransactionWatcher implements Watcher {
  public readonly name = 'transaction-watcher';

  private readonly database: DatabaseAdapter;
  private readonly queue: QueueAdapter;
  private readonly pollIntervalMs: number;
  private readonly transactionTimeoutMs: number;
  private readonly retentionDays: number;
  private isTickInProgress = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(database: DatabaseAdapter, queue: QueueAdapter, options: TransactionWatcherOptions) {
    this.database = database;
    this.queue = queue;
    this.pollIntervalMs = options.pollIntervalMs;
    this.transactionTimeoutMs = options.transactionTimeoutMs;
    this.retentionDays = options.retentionDays;
  }

  public async start(): Promise<void> {
    // If already started, return immediately
    if (this.timer) return;

    // If start is in progress, wait for it to complete
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    // Mark start as in progress
    this.startPromise = this.performStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async performStart(): Promise<void> {
    // Double-check that another concurrent start didn't already create the timer
    if (this.timer) return;

    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;

    // Wait for any active tick to complete
    if (this.tickPromise) {
      await this.tickPromise;
    }
  }

  private async tick(): Promise<void> {
    if (this.isTickInProgress) {
      return;
    }

    this.isTickInProgress = true;
    this.tickPromise = this.performTick();

    try {
      await this.tickPromise;
    } finally {
      this.isTickInProgress = false;
      this.tickPromise = null;
    }
  }

  private async performTick(): Promise<void> {
    const cutoff = new Date(Date.now() - this.transactionTimeoutMs).toISOString();
    const pendingTransactions = await this.database.listPendingTransactionsBefore(cutoff);

    for (const transaction of pendingTransactions) {
      await this.queue.enqueue({
        type: 'expire_transaction',
        payload: { transactionId: transaction.id },
      });
    }

    const watcherTaskId = randomUUID();
    await this.database.insertWatcherTask({
      id: watcherTaskId,
      watcherName: this.name,
      payload: {
        pendingTransactionsChecked: pendingTransactions.length,
        checkedAt: new Date().toISOString(),
      },
    });

    await this.queue.enqueue({
      type: 'process_watcher_task',
      payload: { watcherTaskId },
    });

    await this.queue.enqueue({
      type: 'cleanup_records',
      payload: {
        retentionDays: this.retentionDays,
      },
    });
  }
}
