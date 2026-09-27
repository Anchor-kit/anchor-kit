import { AnchorConfig } from '@/core/config.ts';
import { ConfigError } from '@/core/errors.ts';
import {
  createSqlDatabaseAdapter,
  makeSqliteDbUrlForTests,
} from '@/runtime/database/sql-database-adapter.ts';
import { AnchorExpressRouter, type ExpressLikeMiddleware } from '@/runtime/http/express-router.ts';
import type {
  DatabaseAdapter,
  QueueAdapter,
  QueueJob,
  Watcher,
  WebhookProcessor,
} from '@/runtime/interfaces.ts';
import { InMemoryQueueAdapter } from '@/runtime/queue/in-memory-queue.ts';
import { TransactionWatcher } from '@/runtime/watchers/transaction-watcher.ts';
import { DefaultWebhookProcessor } from '@/runtime/webhooks/default-webhook-processor.ts';
import { AnchorKitConfig } from '@/types/config.ts';
import { AnchorPlugin } from '@/types/plugin.ts';

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
  private backgroundJobsPromise: Promise<void> | null = null;

  constructor(config: Partial<AnchorKitConfig>) {
    this.config = new AnchorConfig(config);
    this.config.validate();
  }

  /**
   * Register a plugin with the anchor instance.
   */
  public use(plugin: AnchorPlugin): this {
    if (this.initialized) {
      throw new ConfigError(
        `Plugin "${plugin.id}" cannot be registered after init() has been called. Register plugins before initialization.`,
      );
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin with id "${plugin.id}" is already registered.`);
    }
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  /**
   * Initialize registered plugins and all runtime services.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const frameworkConfig = this.config.get('framework');

      try {
        this.database = createSqlDatabaseAdapter(frameworkConfig.database);
        await this.database.connect();
        await this.database.migrate();

        const queueBackend = frameworkConfig.queue?.backend ?? 'memory';
        if (queueBackend !== 'memory') {
          throw new ConfigError(
            `Unsupported queue backend: "${queueBackend}". Only "memory" queue backend is currently supported. Please remove or set queue.backend to "memory" in your configuration.`,
          );
        }

        const queueConcurrency = frameworkConfig.queue?.concurrency ?? 1;
        this.queue = new InMemoryQueueAdapter({ concurrency: queueConcurrency });

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

        this.initialized = true;

        for (const plugin of this.plugins.values()) {
          if (plugin.init) {
            await plugin.init(this);
          }
        }
      } catch (error) {
        const originalError = error instanceof Error ? error : new Error(String(error));
        await this.rollbackInitialization();
        throw originalError;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Start queue workers and watcher services.
   */
  public async startBackgroundJobs(): Promise<void> {
    this.ensureInitialized();
    if (this.backgroundJobsRunning) return;
    if (this.backgroundJobsPromise) return this.backgroundJobsPromise;

    this.backgroundJobsPromise = (async () => {
      await this.requireQueue().start(async (job) => this.processQueueJob(job));

      for (const watcher of this.watchers) {
        await watcher.start();
      }

      this.backgroundJobsRunning = true;
    })().finally(() => {
      this.backgroundJobsPromise = null;
    });

    return this.backgroundJobsPromise;
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
   * Cleanly shutdown all services.
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized && !this.shutdownPromise) return;
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      try {
        if (!this.initialized) return;

        await this.stopBackgroundJobs();
        await this.requireDatabase().disconnect();
        this.initialized = false;
        this.backgroundJobsRunning = false;
        this.watchers = [];
        this.expressRouter = null;
        this.webhookProcessor = null;
        this.queue = null;
        this.database = null;
      } finally {
        this.shutdownPromise = null;
      }
    })();

    return this.shutdownPromise;
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

  private async rollbackInitialization(): Promise<void> {
    if (this.backgroundJobsRunning || this.initialized) {
      await this.stopBackgroundJobs();
    }

    if (this.database) {
      await this.database.disconnect().catch(() => undefined);
    }

    this.initialized = false;
    this.backgroundJobsRunning = false;
    this.database = null;
    this.queue = null;
    this.webhookProcessor = null;
    this.watchers = [];
    this.expressRouter = null;
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

    throw new Error(`Unknown queue job type: ${String(job.type)}`);
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
