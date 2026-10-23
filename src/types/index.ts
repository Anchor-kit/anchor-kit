/**
 * Anchor-Kit Type Definitions
 * This is the main entry point for all type exports
 */

export {
  TRANSACTION_STATUSES,
  getAllowedNextTransactionStatuses,
  isPendingTransactionStatus,
  isTerminalTransactionStatus,
  isTransactionStatus,
} from './transaction-status.ts';
export type {
  PendingTransactionStatus,
  TerminalTransactionStatus,
  TransactionStatus,
} from './transaction-status.ts';

export type { Customer } from './customer.ts';

export type {
  Transaction,
  TransactionKind,
  Amount,
  RailTransactionData,
  RailAmount,
  PaymentRailStatus,
  PaymentRailOperation,
  PaymentRailInitiationRequest,
  NormalizedPaymentRailEvent,
  RailCapabilityResult,
  StellarTransactionData,
  InteractiveData,
  TransactionError,
  RefundInfo,
} from './transaction.ts';

export * from './config';
export * from './sep24';
export type { KycStatus } from './foundation';
export type { PostalAddress } from './foundation';
export type { IdentityDocument } from './foundation';
export type { KycData, KycData as CustomerKycData } from './foundation';
export type { KycVerificationDecision } from './foundation';
export type {
  AnchorPlugin,
  AnchorPluginContext,
  AnchorPluginHooks,
  DepositRequestBody,
  DepositRequestHookContext,
  Context as PluginContext,
} from './plugin';
export type {
  RouteDefinition,
  SchemaDefinition,
  SchemaMigration,
  SchemaMigrationContext,
  SepErrorCode,
} from './foundation';
