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
  }): Promise<{ record: WebhookEventRecord; inserted: boolean }>;
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
  }>;
}
