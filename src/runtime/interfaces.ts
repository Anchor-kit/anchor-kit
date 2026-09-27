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
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdempotencyRecord {
  id: string;
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  statusCode: number;
  responseBody: string;
  createdAt: string;
}

export interface WebhookEventRecord {
  id: string;
  eventId: string;
  provider: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processed' | 'failed';
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
  markAuthChallengeConsumed(id: string): Promise<void>;

  insertInteractiveTransaction(input: {
    id: string;
    account: string;
    kind: 'deposit';
    assetCode: string;
    amount: string;
    status: string;
  }): Promise<InteractiveTransactionRecord>;
  getInteractiveTransactionById(id: string): Promise<InteractiveTransactionRecord | null>;
  listPendingTransactionsBefore(cutoffIso: string): Promise<InteractiveTransactionRecord[]>;
  updateTransactionStatus(id: string, status: string): Promise<void>;

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

  insertOrGetWebhookEvent(input: {
    id: string;
    eventId: string;
    provider: string;
    payload: Record<string, unknown>;
  }): Promise<{ record: WebhookEventRecord; inserted: boolean }>;
  updateWebhookEventStatus(input: {
    id: string;
    status: 'processed' | 'failed';
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
  cleanupOldRecords(cutoffIso: string): Promise<void>;
}

export interface QueueJob {
  type: 'expire_transaction' | 'process_watcher_task' | 'cleanup_records';
  payload: Record<string, unknown>;
}

export interface QueueAdapter {
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
  }): Promise<{ duplicate: boolean; eventId: string }>;
}
