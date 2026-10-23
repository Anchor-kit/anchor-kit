import type { TransactionStatus } from '@/types/transaction-status.ts';
import type { KycData, KycVerificationDecision } from '@/types/foundation.ts';
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

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  migrate(): Promise<void>;

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
  listPendingTransactionsBefore(cutoffIso: string): Promise<InteractiveTransactionRecord[]>;

  insertInteractiveSession(input: {
    id: string;
    account: string;
    transactionId: string;
    actions: string[];
    expiresAt: string;
  }): Promise<InteractiveSessionRecord>;
  getInteractiveSessionById(id: string): Promise<InteractiveSessionRecord | null>;
  /**
   * Revokes a session. Returns `true` only when this call performed the
   * revocation, so a second call observes the session was already revoked.
   */
  revokeInteractiveSession(id: string): Promise<boolean>;
  /**
   * Atomically consumes `action` for `id`.
   *
   * Returns `true` exactly once per (session, action) pair: the record is only
   * updated while it is unrevoked, unexpired, the action is still permitted,
   * and the stored consumption list is unchanged since it was read. Every
   * other outcome - unknown session, revoked, expired, unpermitted action, or
   * a replay/concurrent caller - returns `false` and leaves the record alone.
   */
  consumeInteractiveSessionAction(id: string, action: string): Promise<boolean>;
  updateTransactionStatus(
    id: string,
    status: TransactionStatus,
    expectedStatus?: TransactionStatus,
  ): Promise<boolean>;

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
  updateSettlementJobStatus(input: {
    operationId: string;
    status: SettlementJobRecord['status'];
  }): Promise<boolean>;
  cleanupOldRecords(cutoffIso: string): Promise<void>;
}

export type QueueJob =
  | { type: 'expire_transaction'; payload: { transactionId: string } }
  | { type: 'process_watcher_task'; payload: { watcherTaskId: string } }
  | { type: 'cleanup_records'; payload: { retentionDays: number } };

export interface QueueDrainStatus {
  readonly pending: number;
  readonly active: number;
}

export interface QueueDrainStatus {
  readonly pending: number;
  readonly active: number;
}

export interface QueueAdapter {
  readonly status?: QueueDrainStatus;
  enqueue(job: QueueJob): Promise<void>;
  start(worker: (job: QueueJob) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface Watcher {
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
    /** Stable operation key for this event (reused by all attempts). */
    operationKey?: string;
    /** Identity of the attempt that was claimed for this call, if any. */
    attemptId?: string;
    /** Monotonically increasing attempt counter for this event. */
    attemptCount?: number;
  }>;
}
