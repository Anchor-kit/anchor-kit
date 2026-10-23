import { AnchorConfig } from './config.ts';
import { ConfigError } from './errors.ts';
import {
  createSqlDatabaseAdapter,
  makeSqliteDbUrlForTests,
} from '../runtime/database/sql-database-adapter.ts';
import { AnchorExpressRouter, type ExpressLikeMiddleware } from '../runtime/http/express-router.ts';
import { validatePluginRoutes } from '../runtime/http/express-router-impl.ts';
import type {
  DatabaseAdapter,
  InteractiveTransactionRecord,
  QueueAdapter,
  QueueDrainStatus,
  Watcher,
  WebhookProcessor,
} from '@/runtime/interfaces.ts';
import { InMemoryQueueAdapter } from '@/runtime/queue/in-memory-queue.ts';
import { TransactionWatcher } from '@/runtime/watchers/transaction-watcher.ts';
import { DefaultWebhookProcessor } from '@/runtime/webhooks/default-webhook-processor.ts';
import type { SchemaMigration } from '@/types/foundation.ts';
import type { AnchorKitConfig } from '@/types/config.ts';
import type { AnchorPlugin, AnchorPluginHooks } from '@/types/plugin.ts';

export interface CreateAnchorOptions {
  /**
   * Caller-created adapter. AnchorKit manages connect/migrate during init and
   * disconnect during shutdown; do not share it with another active instance.
   */
  databaseAdapter?: DatabaseAdapter;
}

/**
 * AnchorInstance
 * Represents the core SDK instance controlling the anchor's behavior.
 */
export class AnchorInstance {
  public readonly config: AnchorConfig;
  private plugins: Map<string, AnchorPlugin> = new Map();

  private database: DatabaseAdapter | null = null;
  private readonly injectedDatabaseAdapter?: DatabaseAdapter;
  private queue: QueueAdapter | null = null;
  private webhookProcessor: WebhookProcessor | null = null;
  private watchers: Watcher[] = [];
  private expressRouter: ExpressLikeMiddleware | null = null;

  private initialized = false;
  private backgroundJobsRunning = false;
  private initPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private backgroundJobsPromise: Promise<void> | null = null;
  private backgroundJobsStopPromise: Promise<void> | null = null;

  constructor(config: Partial<AnchorKitConfig>, options: CreateAnchorOptions = {}) {
    this.config = new AnchorConfig(config);
    this.config.validate();
    this.injectedDatabaseAdapter = options.databaseAdapter;
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

    this.initPromise = (async () => {
      const pluginRoutes = Array.from(this.plugins.values()).flatMap((plugin) =>
        (plugin.routes ?? []).map((route) => ({ pluginId: plugin.id, route })),
      );
      const frameworkConfig = this.config.get('framework');

      try {
        validatePluginRoutes(pluginRoutes);
        this.database = this.createDatabaseAdapter();
        await this.database.connect();
        await this.database.migrate();

        const queueBackend = frameworkConfig.queue?.backend ?? 'memory';
        if (queueBackend !== 'memory') {
          throw new ConfigError(
            `Unsupported queue backend: "${queueBackend}". Only "memory" queue backend is currently supported. Please remove or set queue.backend to "memory" in your configuration.`,
          );
        }

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
          const retentionDays = this.config.get('operational')?.transactionRetentionDays ?? 90;
          this.watchers = [
            new TransactionWatcher(this.database, this.queue, {
              pollIntervalMs: frameworkConfig.watchers?.pollIntervalMs ?? 15000,
              transactionTimeoutMs: frameworkConfig.watchers?.transactionTimeoutMs ?? 300000,
              retentionDays,
            }),
          ];
        }

        const depositRequestHooks: NonNullable<AnchorPluginHooks['onDepositRequest']>[] = [];
        const sep10ChallengeHooks: NonNullable<AnchorPluginHooks['onSep10Challenge']>[] = [];
        for (const plugin of this.plugins.values()) {
          if (plugin.hooks?.onDepositRequest) {
            depositRequestHooks.push(plugin.hooks.onDepositRequest);
          }
          if (plugin.hooks?.onSep10Challenge) {
            sep10ChallengeHooks.push(plugin.hooks.onSep10Challenge);
          }
        }

        this.expressRouter = new AnchorExpressRouter({
          config: this.config,
          database: this.database,
          webhookProcessor: this.webhookProcessor,
          depositRequestHooks,
          sep10ChallengeHooks,
          pluginRoutes,
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
      const queue = this.requireQueue();
      const startedWatchers: Watcher[] = [];
      let queueStarted = false;

      try {
        await queue.start(async (job) => this.processQueueJob(job));
        queueStarted = true;

        for (const watcher of this.watchers) {
          await watcher.start();
          startedWatchers.push(watcher);
        }

        this.backgroundJobsRunning = true;
      } catch (startupError) {
        const rollbackErrors: unknown[] = [];
        for (const watcher of startedWatchers.reverse()) {
          try {
            await watcher.stop();
          } catch (error) {
            rollbackErrors.push(error);
          }
        }

        if (queueStarted) {
          try {
            await queue.stop();
          } catch (error) {
            rollbackErrors.push(error);
          }
        }

        if (rollbackErrors.length > 0) {
          console.error(
            'Background service startup rollback failed',
            new AggregateError(rollbackErrors, 'One or more background services failed to stop'),
          );
        }

        throw startupError;
      }
    })().finally(() => {
      this.backgroundJobsPromise = null;
    });

    return this.backgroundJobsPromise;
  }

  /**
   * Stop watcher services and queue workers.
   */
  public async stopBackgroundJobs(): Promise<void> {
    if (this.backgroundJobsStopPromise) return this.backgroundJobsStopPromise;
    if (this.backgroundJobsPromise) await this.backgroundJobsPromise;
    if (this.backgroundJobsStopPromise) return this.backgroundJobsStopPromise;
    if (!this.initialized || !this.backgroundJobsRunning) return;

    this.backgroundJobsStopPromise = (async () => {
      try {
        for (const watcher of this.watchers) {
          await watcher.stop();
        }

        await this.requireQueue().stop();
        this.backgroundJobsRunning = false;
      } finally {
        this.backgroundJobsStopPromise = null;
      }
    })();

    return this.backgroundJobsStopPromise;
  }

  /** Return pending and active queue counts without exposing job payloads. */
  public getQueueStatus(): QueueDrainStatus {
    return this.queue?.status ?? { pending: 0, active: 0 };
  }

  /**
   * Cleanly shut down all services. If initialization is pending, shutdown waits
   * for it to settle before releasing resources. The instance can then be initialized again.
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized && !this.initPromise && !this.shutdownPromise) return;
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      try {
        await this.initPromise?.catch(() => undefined);
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

  protected createDatabaseAdapter(): DatabaseAdapter {
    if (this.injectedDatabaseAdapter) {
      return this.injectedDatabaseAdapter;
    }

    const migrations: SchemaMigration[] = [];
    for (const plugin of this.plugins.values()) {
      for (const migration of plugin.schema?.migrations ?? []) {
        migrations.push({
          ...migration,
          name: `plugin:${encodeURIComponent(plugin.id)}:${encodeURIComponent(migration.name)}`,
        });
      }
    }

    return createSqlDatabaseAdapter(this.config.get('framework').database, migrations);
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

  private async processQueueJob(input: unknown): Promise<void> {
    const database = this.requireDatabase();
    if (
      typeof input !== 'object' ||
      input === null ||
      !('type' in input) ||
      !('payload' in input)
    ) {
      return;
    }

    const job = input as { type: unknown; payload: unknown };
    if (typeof job.type !== 'string') {
      return;
    }

    if (typeof job.payload !== 'object' || job.payload === null || Array.isArray(job.payload)) {
      return;
    }

    const payload = job.payload as Record<string, unknown>;

    if (job.type === 'expire_transaction') {
      const transactionIdValue = payload.transactionId;
      if (typeof transactionIdValue !== 'string' || transactionIdValue.length === 0) {
        return;
      }

      const transaction = await database.getInteractiveTransactionById(transactionIdValue);
      if (!transaction || transaction.status !== 'pending_user_transfer_start') {
        return;
      }

      const updated = await database.updateTransactionStatus(
        transactionIdValue,
        'expired',
        'pending_user_transfer_start',
      );
      if (!updated) return;

      await this.notifyTransactionStatusChange(
        { ...transaction, status: 'expired' },
        transaction.status,
        'expired',
      );
      return;
    }

    if (job.type === 'process_watcher_task') {
      const watcherTaskIdValue = payload.watcherTaskId;
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
      const retentionDaysValue = payload.retentionDays;
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

  private async notifyTransactionStatusChange(
    transaction: InteractiveTransactionRecord,
    oldStatus: InteractiveTransactionRecord['status'],
    newStatus: InteractiveTransactionRecord['status'],
  ): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const hook = plugin.hooks?.onTransactionStatusChange;
      if (!hook) continue;

      try {
        await hook(transaction, oldStatus, newStatus);
      } catch (error) {
        // The in-memory queue is best-effort and drops failed jobs without retry.
        // Log hook failures and continue so one plugin cannot block other hooks.
        console.error(`[AnchorKit] Plugin "${plugin.id}" transaction status hook failed`, error);
      }
    }
  }
}

/**
 * Create a new Anchor-Kit instance.
 *
 * A supplied database adapter is created and configured by the caller. The
 * instance manages its lifecycle: connect and migrate once per init cycle,
 * then disconnect once when that cycle shuts down.
 */
export function createAnchor(
  config: Partial<AnchorKitConfig>,
  options: CreateAnchorOptions = {},
): AnchorInstance {
  return new AnchorInstance(config, options);
}

export { makeSqliteDbUrlForTests };
