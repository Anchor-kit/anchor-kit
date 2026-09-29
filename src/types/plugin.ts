import { RouteDefinition, SchemaDefinition } from './foundation';
import type { TransactionStatus } from './transaction-status.ts';

export interface AnchorPluginContext<
  TConfig = unknown,
  TDb = unknown,
  TBody = unknown,
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
> {
  config: TConfig;
  db: TDb;
  params: TParams;
  query: TQuery;
  body: TBody;
}

export type Context = AnchorPluginContext;

export type DepositRequestBody = Record<string, unknown> & {
  asset_code: string;
  amount: string | number;
};

export interface DepositRequestHookContext
  extends AnchorPluginContext<AnchorKitConfig, unknown, DepositRequestBody> {
  account: string;
  asset: Asset;
}

export interface AnchorPluginHooks {
  /** Throw to reject with HTTP 400 `deposit_rejected` before persistence. */
  onDepositRequest?: (ctx: DepositRequestHookContext) => Promise<void>;
  onWithdrawalRequest?: (ctx: Context) => Promise<void>;
  onSep10Challenge?: (tx: unknown) => Promise<unknown>;
  onTransactionStatusChange?: (
    tx: unknown,
    oldStatus: TransactionStatus,
    newStatus: TransactionStatus,
  ) => Promise<void>;
}

export interface AnchorPlugin {
  id: string;
  name?: string;
  version?: string;

  /**
   * Inject API routes into the main server instance
   */
  routes?: RouteDefinition[];

  /**
   * Extend the database schema context
   */
  schema?: SchemaDefinition;

  /**
   * Hook into the transaction lifecycle
   */
  hooks?: AnchorPluginHooks;

  /**
   * Plugin initialization lifecycle
   */
  init?: (instance: unknown) => Promise<void> | void;
}
