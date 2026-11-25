/**
 * Anchor-Kit SDK
 * A developer-friendly SDK for implementing Stellar anchor services
 *
 * @see https://github.com/0xNgoo/anchor-kit
 */

export * from './types';

export { AnchorInstance, createAnchor, makeSqliteDbUrlForTests } from './core/factory';
export type { CreateAnchorOptions } from './core/factory';
export * from './core/errors';
export { HorizonNetworkClient } from './services/horizon-network-client.ts';
export { LocalKeypairSigner } from './services/stellar-signer.ts';
export { paystackSubunits, validatePaystackReference } from './services/paystack-inputs.ts';
export { getPaystackTestStatus } from './services/paystack-status.ts';
export { emitTransactionTrace } from './services/transaction-trace.ts';
export type { TransactionTraceEvent, TransactionTraceSink } from './services/transaction-trace.ts';
export { signedSettlementHash } from './services/settlement-identity.ts';
export type { StellarTransactionSigner } from './services/stellar-signer.ts';
export * as utils from './utils';
export {
  AssetSchema,
  DatabaseUrlSchema,
  SecurityConfigSchema,
  ValidationUtils,
  AnchorKitConfigSchema,
  StellarUtils,
} from './utils';
export type { Memo, PaymentParams, SettlementPaymentParams } from './utils';
export type {
  AuthChallengeRecord,
  AccountSigner,
  StellarAccountState,
  StellarNetworkClient,
  StellarNetworkResult,
  StellarTransactionState,
  ConfirmSettlementResult,
  DatabaseAdapter,
  IdempotencyRecord,
  InteractiveTransactionRecord,
  InteractiveTransactionIdentifier,
  KycVerificationProvider,
  PaymentRailAdapter,
  QueueJob,
  QueueJobErrorClassification,
  QueueJobFailure,
  QueueJobRetryOptions,
  QueueDrainStatus,
  QueueAdapter,
  ReconciledRailPaymentResult,
  Sep10AccountLookup,
  Sep10AccountSigners,
  SettlementJobRecord,
  SettlementJobLease,
  SettlementLeaseAdapter,
  Watcher,
  WebhookEventRecord,
  WebhookProcessor,
  WatcherTaskRecord,
  TransactionTransitionResult,
} from './runtime/interfaces.ts';
export { MockKycVerificationProvider } from './runtime/kyc/mock-provider.ts';
export {
  classifyQueueJobError,
  PermanentJobError,
  RetryableJobError,
} from './runtime/queue/in-memory-queue.ts';
export type { ExpressLikeMiddleware } from './runtime/http/express-router.ts';

export { matchRailEvent } from './runtime/settlement/match-rail-event.ts';
export type { RailMatchResult } from './runtime/settlement/match-rail-event.ts';
export { AnchorClient, AnchorClientError } from './client/anchor-client.ts';
export type {
  AnchorClientOptions,
  AuthChallenge,
  AuthToken,
  DepositRequest,
  InteractiveResponse,
  TransactionResponse,
} from './client/anchor-client.ts';

export { createInteractiveInitiationResponse } from './core/sep24/interactive-response.ts';
export type { InteractiveInitiationResponse } from './core/sep24/interactive-response.ts';
