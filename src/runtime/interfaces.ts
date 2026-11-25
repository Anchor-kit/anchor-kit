import type { TransactionStatus } from '@/types/transaction-status.ts';
import type { KycData, KycVerificationDecision } from '@/types/foundation.ts';
import type { RefundOperation } from '@/services/refund-serialization.ts';
import type { Customer } from '@/types/customer.ts';
import type {
  NormalizedPaymentRailEvent,
  PaymentRailInitiationRequest,
  PaymentRailOperation,
  RailCapabilityResult,
} from '@/types/transaction.ts';

export interface KycVerificationProvider {
  verify(input: {
    customerId: string;
    operationKey: string;
    data: KycData;
  }): Promise<KycVerificationDecision>;
}

export interface PaymentRailAdapter {
  readonly provider: string;
  readonly capabilities: Readonly<{
    initiation: boolean;
    eventVerification: boolean;
    statusLookup: boolean;
    recovery: boolean;
  }>;
  initiate(
    input: PaymentRailInitiationRequest,
  ): Promise<RailCapabilityResult<PaymentRailOperation>>;
  verifyEvent(input: {
    rawBody: string | Buffer | Uint8Array;
    signature?: string;
  }): Promise<RailCapabilityResult<NormalizedPaymentRailEvent>>;
  getStatus(input: {
    operationId: string;
    reference: string;
  }): Promise<RailCapabilityResult<PaymentRailOperation>>;
  recover(input: {
    operationId: string;
    reference: string;
  }): Promise<RailCapabilityResult<PaymentRailOperation>>;
}

export interface AccountSigner {
  publicKey: string;
  weight: number;
}

/**
 * Signer summary for a SEP-10 client account.
 *
 * `signers` must be the complete authorization set reported by the network,
 * including the master key entry (whose public key equals the account ID) when
 * the master key has non-zero weight. Duplicate keys are rejected.
 */
export interface Sep10AccountSigners {
  signers: readonly AccountSigner[];
  /** Account thresholds; SEP-10 authentication requires the medium threshold. */
  thresholds: {
    low: number;
    medium: number;
    high: number;
  };
}

/**
 * Injectable SEP-10 client account lookup.
 *
 * Return `null` only when the account genuinely does not exist on the network;
 * that selects the protocol's nonexistent-account signature branch. Throw for
 * transport or upstream failures so an outage is never treated as an absent
 * account.
 */
export interface Sep10AccountLookup {
  load(accountId: string): Promise<Sep10AccountSigners | null>;
}

export interface AuthChallengeRecord {
  id: string;
  account: string;
  challenge: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface InteractiveTransactionRecord {
  id: string;
  account: string;
  kind: 'deposit';
  assetCode: string;
  amount: string;
  amountIn?: string | null;
  amountOut?: string | null;
  amountFee?: string | null;
  currency?: string | null;
  railReference?: string | null;
  stellarTransactionHash?: string | null;
  status: TransactionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionHistoryQuery {
  account: string;
  assetCode: string;
  limit?: number;
  kind?: 'deposit' | 'withdrawal';
  noOlderThan?: string;
  pagingId?: string;
}

export type InteractiveTransactionIdentifier =
  | { kind: 'id'; value: string }
  | { kind: 'stellar_transaction_id'; value: string }
  | { kind: 'external_transaction_id'; value: string };

export type TransactionTransitionResult =
  | { outcome: 'updated'; transaction: InteractiveTransactionRecord }
  | {
      outcome: 'conflict';
      reason: 'invalid_transition' | 'status_mismatch' | 'not_found';
      transaction: InteractiveTransactionRecord | null;
    };

export interface IdempotencyRecord {
  id: string;
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  status: 'pending' | 'completed';
  statusCode: number;
  responseBody: string;
  createdAt: string;
}

export interface WebhookEventRecord {
  id: string;
  eventId: string;
  provider: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processed' | 'failed' | 'unresolved';
  errorMessage: string | null;
  processedAt: string | null;
  createdAt: string;
  /** Original provider operation returned by reconciliation, when available. */
  recoveryResult?: PaymentRailOperation | null;
  /** Stable identity for the external operation this event represents. Reused across all attempts and retries. */
  operationKey: string;
  /** Monotonically incrementing attempt counter for this event. */
  attemptCount: number;
  /** Identity of the currently claimed attempt (if any). */
  attemptId: string | null;
  /** Owner token of the current processing lease (if any). */
  leaseOwner: string | null;
  /** Expiration instant of the current processing lease (if any). */
  leaseExpiresAt: string | null;
}

export interface WatcherTaskRecord {
  id: string;
  watcherName: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processed' | 'failed';
  errorMessage: string | null;
  processedAt: string | null;
  createdAt: string;
}

/** Typed context passed to the webhook callback for a specific attempt. */
export interface WebhookCallbackContext {
  /** Stable operation key shared by all attempts for this event. */
  operationKey: string;
  /** Unique identity of this attempt. */
  attemptId: string;
  /** Monotonically increasing attempt counter for this event. */
  attemptCount: number;
  /** Owner token of the processing lease held by this attempt. */
  leaseOwner: string;
  /** Expiration instant of the processing lease held by this attempt. */
  leaseExpiresAt: string;
  /** Time the underlying webhook event was received. */
  receivedAt: string;
  /** Optional raw request body. */
  rawBody: string | Buffer | Uint8Array;
  /** Optional signature provided with the request. */
  signature?: string;
}

export interface SettlementJobRecord {
  id: string;
  operationId: string;
  payloadRef: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface RefundRecord extends RefundOperation {
  operationId: string;
}

export type ConfirmSettlementResult =
  | {
      outcome: 'completed' | 'replayed';
      transaction: InteractiveTransactionRecord;
    }
  | {
      outcome: 'conflict';
      reason: 'not_found' | 'status_mismatch' | 'confirmation_mismatch' | 'hash_mismatch';
      transaction: InteractiveTransactionRecord | null;
    };

export type ReconciledRailPaymentResult =
  | {
      outcome: 'enqueued' | 'replayed';
      transaction: InteractiveTransactionRecord;
      job: SettlementJobRecord;
    }
  | {
      outcome: 'conflict';
      reason: 'not_found' | 'status_mismatch' | 'operation_reused';
      transaction: InteractiveTransactionRecord | null;
    };

/** Ownership for one settlement-job attempt. Tokens must not be reused. */
export interface SettlementJobLease {
  job: SettlementJobRecord;
  owner: string;
  token: string;
  expiresAt: string;
  attempt: number;
}

export interface SettlementLeaseAdapter {
  /** Lists pending jobs and expired leases; claim remains the ownership gate. */
  listClaimableSettlementJobs(limit: number): Promise<SettlementJobRecord[]>;
  claimSettlementJob(input: {
    operationId: string;
    owner: string;
    durationMs: number;
  }): Promise<SettlementJobLease | null>;
  heartbeatSettlementJob(input: {
    operationId: string;
    token: string;
    durationMs: number;
  }): Promise<boolean>;
  finishSettlementJob(input: {
    operationId: string;
    token: string;
    status: 'pending' | 'completed' | 'failed';
  }): Promise<boolean>;
}

export interface DatabaseAdapter extends SettlementLeaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  migrate(): Promise<void>;
  /** Check storage connectivity without exposing connection details. */
  checkReadiness?(): Promise<void>;
  insertRefundOperation?(record: RefundRecord): Promise<void>;
  listRefundOperations?(transactionId: string): Promise<RefundRecord[]>;
  finishRefundOperation?(operationId: string, status: 'completed' | 'failed'): Promise<boolean>;

  insertAuthChallenge(input: {
    id: string;
    account: string;
    challenge: string;
    expiresAt: string;
  }): Promise<void>;
  getAuthChallengeByChallenge(challenge: string): Promise<AuthChallengeRecord | null>;
  markAuthChallengeConsumed(id: string): Promise<boolean>;

  insertInteractiveTransaction(input: {
    id: string;
    account: string;
    kind: 'deposit';
    assetCode: string;
    amount: string;
    amountIn?: string | null;
    amountOut?: string | null;
    amountFee?: string | null;
    currency?: string | null;
    railReference?: string | null;
    stellarTransactionHash?: string | null;
    status: TransactionStatus;
  }): Promise<InteractiveTransactionRecord>;
  getInteractiveTransactionById(id: string): Promise<InteractiveTransactionRecord | null>;
  findInteractiveTransaction(input: {
    account: string;
    identifier: InteractiveTransactionIdentifier;
  }): Promise<InteractiveTransactionRecord | null>;
  listTransactions(input: TransactionHistoryQuery): Promise<InteractiveTransactionRecord[]>;
  listPendingTransactionsBefore(cutoffIso: string): Promise<InteractiveTransactionRecord[]>;
  updateTransactionStatus(
    id: string,
    status: TransactionStatus,
    expectedStatus?: TransactionStatus,
  ): Promise<boolean>;

  insertOrGetCustomer(input: Omit<Customer, 'created_at'>): Promise<Customer>;
  getCustomerByAccountId(accountId: string): Promise<Customer | null>;
  updateCustomer(input: {
    id: string;
    account_id: string;
    email_address?: string;
    phone_number?: string;
    kyc_data: KycData;
  }): Promise<boolean>;

  getIdempotencyRecord(scope: string, idempotencyKey: string): Promise<IdempotencyRecord | null>;
  insertOrGetIdempotencyRecord(input: {
    id: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    statusCode: number;
    responseBody: string;
  }): Promise<IdempotencyRecord>;
  updateIdempotencyRecord(input: {
    scope: string;
    idempotencyKey: string;
    statusCode: number;
    responseBody: string;
  }): Promise<void>;
  reserveIdempotencyRecord(input: {
    id: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ record: IdempotencyRecord; inserted: boolean }>;
  createDepositWithIdempotency(input: {
    transaction: {
      id: string;
      account: string;
      kind: 'deposit';
      assetCode: string;
      amount: string;
      status: TransactionStatus;
      createdAt: string;
    };
    idempotency: {
      scope: string;
      idempotencyKey: string;
      requestHash: string;
      statusCode: number;
      responseBody: string;
    };
  }): Promise<InteractiveTransactionRecord>;
  deletePendingIdempotencyRecord(
    scope: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<void>;

  insertOrGetWebhookEvent(input: {
    id: string;
    eventId: string;
    provider: string;
    payload: Record<string, unknown>;
    /** Stable operation key for this event. Must be reused by all attempts and retries. */
    operationKey?: string;
  }): Promise<{ record: WebhookEventRecord; inserted: boolean }>;
  /**
   * Atomically claims the next attempt for a webhook event. Returns null when the event is already
   * processed or is currently leased by another owner. On success the returned record carries a
   * fresh attemptId, attemptCount, leaseOwner and leaseExpiresAt.
   */
  claimWebhookAttempt(input: {
    id: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }): Promise<WebhookEventRecord | null>;
  /** Claims an ambiguous prior attempt for read-only provider reconciliation. */
  claimWebhookRecovery(input: {
    id: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }): Promise<WebhookEventRecord | null>;
  /** Stores the recovered outcome only for the current, unexpired reconciliation lease. */
  completeWebhookRecovery(input: {
    id: string;
    attemptId: string;
    leaseOwner: string;
    status: 'processed' | 'failed' | 'unresolved';
    result: PaymentRailOperation | null;
  }): Promise<boolean>;
  /**
   * Records the final outcome of an attempt. Only the current lease owner may complete the
   * attempt; stale owners receive false and must not retry the financial side effect.
   */
  completeWebhookAttempt(input: {
    id: string;
    attemptId: string;
    leaseOwner: string;
    status: 'processed' | 'failed' | 'unresolved';
    errorMessage?: string;
  }): Promise<boolean>;
  updateWebhookEventStatus(input: {
    id: string;
    status: 'processed' | 'failed' | 'unresolved';
    errorMessage?: string;
  }): Promise<void>;

  insertWatcherTask(input: {
    id: string;
    watcherName: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  listPendingWatcherTasks(limit: number): Promise<WatcherTaskRecord[]>;
  updateWatcherTaskStatus(input: {
    id: string;
    status: 'processed' | 'failed';
    errorMessage?: string;
  }): Promise<void>;
  countProcessedWatcherTasks(): Promise<number>;
  insertOrGetSettlementJob(input: {
    id: string;
    operationId: string;
    payloadRef: string;
  }): Promise<{ record: SettlementJobRecord; inserted: boolean }>;
  getSettlementJobByOperationId(operationId: string): Promise<SettlementJobRecord | null>;
  listPendingSettlementJobs(limit: number): Promise<SettlementJobRecord[]>;
  /** @deprecated Status changes require a lease; this method rejects without one. */
  updateSettlementJobStatus(input: {
    operationId: string;
    status: SettlementJobRecord['status'];
  }): Promise<boolean>;
  confirmSettlement(input: {
    transactionId: string;
    transactionHash: string;
    amount: string;
    recipient: string;
  }): Promise<ConfirmSettlementResult>;
  recordReconciledRailPayment(input: {
    transactionId: string;
    operationId: string;
    jobId: string;
  }): Promise<ReconciledRailPaymentResult>;
  cleanupOldRecords(cutoffIso: string): Promise<void>;
}

export type QueueJob =
  | { type: 'expire_transaction'; payload: { transactionId: string } }
  | { type: 'process_watcher_task'; payload: { watcherTaskId: string } }
  | { type: 'cleanup_records'; payload: { retentionDays: number } };

/**
 * Classification of a queue failure. Retryable failures are attempted again until the
 * configured attempt limit; permanent failures are recorded once and never retried.
 */
export type QueueJobErrorClassification = 'retryable' | 'permanent';

/** Bounded retry policy for the in-memory queue. */
export interface QueueJobRetryOptions {
  /** Total attempts including the first. Defaults to 3. */
  maxAttempts?: number;
  /** First retry delay in milliseconds, doubled per attempt. Defaults to 250. */
  baseDelayMs?: number;
  /** Upper bound for any single retry delay. Defaults to 30000. */
  maxDelayMs?: number;
}

/**
 * Terminal failure record retained for operator review. Retries that are still in
 * progress are not failures; only permanent or attempt-exhausted work is recorded here.
 */
export interface QueueJobFailure {
  /** Stable identity of the original queue job, usable with `requeueFailedJob`. */
  readonly id: string;
  readonly job: QueueJob;
  /** Number of attempts made before the failure became terminal. */
  readonly attempts: number;
  /** `permanent` when not retryable; `exhausted` when the attempt limit was reached. */
  readonly outcome: 'permanent' | 'exhausted';
  readonly error: unknown;
  readonly failedAt: string;
}

export interface QueueDrainStatus {
  /** Waiting jobs, including jobs currently scheduled for a bounded retry. */
  readonly pending: number;
  readonly active: number;
}

export interface QueueAdapter {
  readonly isRunning?: boolean;
  readonly status?: QueueDrainStatus;
  enqueue(job: QueueJob): Promise<void>;
  start(worker: (job: QueueJob) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  /** Terminal failures retained for operator review, newest last. */
  listFailedJobs?(): readonly QueueJobFailure[];
  /** Re-enqueue a terminal failure with a fresh attempt budget. Returns false if unknown. */
  requeueFailedJob?(id: string): Promise<boolean>;
}

export interface Watcher {
  readonly isRunning?: boolean;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WebhookProcessor {
  process(input: {
    eventId: string;
    provider: string;
    payload: Record<string, unknown>;
    rawBody: string | Buffer | Uint8Array;
    signature?: string;
  }): Promise<{
    duplicate: boolean;
    eventId: string;
    provider: string;
    status?: WebhookEventRecord['status'];
    recoveryResult?: PaymentRailOperation | null;
    /** Stable operation key for this event (reused by all attempts). */
    operationKey?: string;
    /** Identity of the attempt that was claimed for this call, if any. */
    attemptId?: string;
    /** Monotonically increasing attempt counter for this event. */
    attemptCount?: number;
  }>;
}

export interface StellarAccountState {
  accountId: string;
  sequence: string;
}

export interface StellarTransactionState {
  hash: string;
  successful: boolean;
  ledger: number;
}

export type StellarNetworkResult<T> =
  | { status: 'found'; value: T }
  | { status: 'not_found' }
  | {
      status: 'unavailable';
      reason: 'network' | 'timeout' | 'invalid_response' | 'network_mismatch';
    };

export interface StellarNetworkClient {
  getAccount(accountId: string): Promise<StellarNetworkResult<StellarAccountState>>;
  getTransaction(hash: string): Promise<StellarNetworkResult<StellarTransactionState>>;
}
