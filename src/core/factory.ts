import { AnchorKitConfig } from '@/types/config.ts';
import { AnchorConfig } from '@/core/config.ts';
import { AnchorPlugin } from '@/types/plugin.ts';
import {
  createSqlDatabaseAdapter,
  makeSqliteDbUrlForTests,
} from '@/runtime/database/sql-database-adapter.ts';
import { InMemoryQueueAdapter } from '@/runtime/queue/in-memory-queue.ts';
import type {
  DatabaseAdapter,
  QueueAdapter,
  QueueJob,
  Watcher,
  WebhookProcessor,
} from '@/runtime/interfaces.ts';
import { DefaultWebhookProcessor } from '@/runtime/webhooks/default-webhook-processor.ts';
import { AnchorExpressRouter, type ExpressLikeMiddleware } from '@/runtime/http/express-router.ts';
import { TransactionWatcher } from '@/runtime/watchers/transaction-watcher.ts';
import { ConfigError } from '@/core/errors.ts';

/**
 * AnchorInstance
 * Represents the core SDK instance controlling the anchor's behavior.
 */
export class AnchorInstance {
  public readonly config: AnchorConfig;
  private plugins: Map<string, AnchorPlugin> = new Map();

  private database: DatabaseAdapter | null = null;
  private queue: QueueAdapter | null = null;
  private webhookProcessor: WebhookProcessor | null = null;
  private watchers: Watcher[] = [];
  private expressRouter: ExpressLikeMiddleware | null = null;

  private initialized = false;
  private backgroundJobsRunning = false;
  private initPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(config: Partial<AnchorKitConfig>) {
    this.config = new AnchorConfig(config);
    this.config.validate();
  }

  /**
   * Register a plugin with the anchor instance.
   */
  public use(plugin: AnchorPlugin): this {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin with id "${plugin.id}" is already registered.`);
    }
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  /**
   * Initialize registered plugins and runtime services. Concurrent calls share
   * one initialization attempt; calls made during shutdown run afterward.
   */
  public async init(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return this.init();
    }
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    const initPromise = this.initializeResources();
    this.initPromise = initPromise;
    try {
      await initPromise;
    } finally {
      if (this.initPromise === initPromise) this.initPromise = null;
    }
  }

  private async initializeResources(): Promise<void> {
    const frameworkConfig = this.config.get('framework');

    try {
      this.database = this.createDatabaseAdapter();
      await this.database.connect();
      await this.database.migrate();

      const queueConcurrency = frameworkConfig.queue?.concurrency ?? 1;
      this.queue = new InMemoryQueueAdapter({
        concurrency: queueConcurrency,
        maxPendingJobs: frameworkConfig.queue?.maxPendingJobs,
        onError: frameworkConfig.queue?.onError,
      });

      this.webhookProcessor = new DefaultWebhookProcessor({
        config: this.config.getConfig(),
        database: this.database,
      });

      const watchersEnabled = frameworkConfig.watchers?.enabled ?? true;
      if (watchersEnabled) {
        this.watchers = [
          new TransactionWatcher(this.database, this.queue, {
            pollIntervalMs: frameworkConfig.watchers?.pollIntervalMs ?? 15000,
            transactionTimeoutMs: frameworkConfig.watchers?.transactionTimeoutMs ?? 300000,
            retentionDays: frameworkConfig.watchers?.retentionDays ?? 90,
          }),
        ];
      }

      this.expressRouter = new AnchorExpressRouter({
        config: this.config,
        database: this.database,
        webhookProcessor: this.webhookProcessor,
      }).getMiddleware();

      for (const plugin of this.plugins.values()) {
        if (plugin.init) {
          await plugin.init(this);
        }
      }

      this.initialized = true;
    } catch (error) {
      try {
        await this.releaseResources();
      } catch {
        // Preserve the initialization error; shutdown can retry resource cleanup.
      }
      throw error;
    }
  }

  protected createDatabaseAdapter(): DatabaseAdapter {
    return createSqlDatabaseAdapter(this.config.get('framework').database);
  }

  /**
   * Start queue workers and watcher services.
   */
  public async startBackgroundJobs(): Promise<void> {
    this.ensureInitialized();
    if (this.backgroundJobsRunning) return;

    await this.requireQueue().start(async (job) => this.processQueueJob(job));

    for (const watcher of this.watchers) {
      await watcher.start();
    }

    this.backgroundJobsRunning = true;
  }

  /**
   * Stop watcher services and queue workers.
   */
  public async stopBackgroundJobs(): Promise<void> {
    if (!this.initialized || !this.backgroundJobsRunning) return;

    for (const watcher of this.watchers) {
      await watcher.stop();
    }

    await this.requireQueue().stop();
    this.backgroundJobsRunning = false;
  }

  /**
  * Cleanly shut down all services. If initialization is pending, shutdown waits
  * for it to settle before releasing resources. The instance can then be initialized again.
   */
  public async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (
      !this.initialized &&
      !this.initPromise &&
      !this.database &&
      !this.queue &&
      this.watchers.length === 0
    ) {
      return;
    }

    const shutdownPromise = this.shutdownResources();
    this.shutdownPromise = shutdownPromise;
    try {
      await shutdownPromise;
    } finally {
      if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = null;
    }
  }

  private async shutdownResources(): Promise<void> {
    await this.initPromise?.catch(() => undefined);
    await this.releaseResources();
  }

  private async releaseResources(): Promise<void> {
    if (this.backgroundJobsRunning) {
      for (const watcher of this.watchers) {
        await watcher.stop();
      }
      await this.queue?.stop();
      this.backgroundJobsRunning = false;
    }

    if (this.database) {
      await this.database.disconnect();
    }

    this.database = null;
    this.queue = null;
    this.webhookProcessor = null;
    this.watchers = [];
    this.expressRouter = null;
    this.initialized = false;
  }

  /**
   * Return middleware compatible with Express router mounting.
   *
   * Example: app.use('/anchor', anchor.getExpressRouter())
   */
  public getExpressRouter(): ExpressLikeMiddleware {
    this.ensureInitialized();
    if (!this.expressRouter) {
      throw new ConfigError('Express router has not been initialized');
    }
    return this.expressRouter;
  }

  /**
   * Get a registered plugin by its ID.
   */
  public getPlugin<T extends AnchorPlugin>(id: string): T | undefined {
    return this.plugins.get(id) as T;
  }

  /**
   * Test helper for verifying background processing behavior.
   */
  public async getProcessedWatcherTaskCount(): Promise<number> {
    this.ensureInitialized();
    return this.requireDatabase().countProcessedWatcherTasks();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new ConfigError('Anchor is not initialized. Call init() first.');
    }
  }

  private requireDatabase(): DatabaseAdapter {
    if (!this.database) {
      throw new ConfigError('Database adapter is not initialized');
    }
    return this.database;
  }

  private requireQueue(): QueueAdapter {
    if (!this.queue) {
      throw new ConfigError('Queue adapter is not initialized');
    }
    return this.queue;
  }

  private async processQueueJob(job: QueueJob): Promise<void> {
    const database = this.requireDatabase();

    if (job.type === 'expire_transaction') {
      const transactionIdValue = job.payload.transactionId;
      if (typeof transactionIdValue !== 'string' || transactionIdValue.length === 0) {
        return;
      }

      await database.updateTransactionStatus(transactionIdValue, 'expired');
      return;
    }

    if (job.type === 'process_watcher_task') {
      const watcherTaskIdValue = job.payload.watcherTaskId;
      if (typeof watcherTaskIdValue !== 'string' || watcherTaskIdValue.length === 0) {
        return;
      }

      await database.updateWatcherTaskStatus({
        id: watcherTaskIdValue,
        status: 'processed',
      });
      return;
    }

    if (job.type === 'cleanup_records') {
      const retentionDaysValue = job.payload.retentionDays;
      if (typeof retentionDaysValue !== 'number' || !Number.isFinite(retentionDaysValue)) {
        return;
      }

      const cutoffMs = Date.now() - retentionDaysValue * 24 * 60 * 60 * 1000;
      const cutoffIso = new Date(cutoffMs).toISOString();
      await database.cleanupOldRecords(cutoffIso);
      return;
    }
  }
}

/**
 * createAnchor
 * Factory function to initialize a new Anchor-Kit instance.
 */
export function createAnchor(config: Partial<AnchorKitConfig>): AnchorInstance {
  return new AnchorInstance(config);
}

export { makeSqliteDbUrlForTests };
