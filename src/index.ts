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
export { LocalKeypairSigner } from './services/stellar-signer.ts';
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
  DatabaseAdapter,
  IdempotencyRecord,
  InteractiveTransactionRecord,
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
