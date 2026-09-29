import type { QueueJob } from '@/runtime/interfaces.ts';
import { describe, expect, it } from 'vitest';

describe('QueueJob type', () => {
  it('accepts each job with its required payload', () => {
    const jobs: QueueJob[] = [
      { type: 'expire_transaction', payload: { transactionId: 'transaction-1' } },
      { type: 'process_watcher_task', payload: { watcherTaskId: 'watcher-task-1' } },
      { type: 'cleanup_records', payload: { retentionDays: 90 } },
    ];

    expect(jobs).toHaveLength(3);
  });

  it('rejects missing or mismatched payload fields at compile time', () => {
    // @ts-expect-error expire_transaction requires transactionId
    const missingTransactionId: QueueJob = { type: 'expire_transaction', payload: {} };
    // @ts-expect-error process_watcher_task requires watcherTaskId
    const missingWatcherTaskId: QueueJob = { type: 'process_watcher_task', payload: {} };
    // @ts-expect-error cleanup_records requires retentionDays
    const missingRetentionDays: QueueJob = { type: 'cleanup_records', payload: {} };
    const mismatchedPayloadBody = { transactionId: 'transaction-1' };
    // @ts-expect-error transactionId does not belong to cleanup_records
    const mismatchedPayload: QueueJob = { type: 'cleanup_records', payload: mismatchedPayloadBody };

    expect([
      missingTransactionId,
      missingWatcherTaskId,
      missingRetentionDays,
      mismatchedPayload,
    ]).toHaveLength(4);
  });
});
