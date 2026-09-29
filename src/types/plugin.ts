import { RouteDefinition, SchemaDefinition } from './foundation';
import type { AnchorKitConfig, Asset } from './config';
import type { Transaction } from '@stellar/stellar-sdk';

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
  /** Return the challenge to use; throwing responds with HTTP 500 `challenge_hook_failed`. */
  onSep10Challenge?: (tx: Transaction) => Promise<Transaction>;
  onTransactionStatusChange?: (tx: unknown, oldStatus: string, newStatus: string) => Promise<void>;
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
