import type { DatabaseAdapter, QueueAdapter } from '@/runtime/interfaces.ts';
import type { InteractiveTransactionRecord } from '@/runtime/interfaces.ts';
import { TransactionWatcher } from '@/runtime/watchers/transaction-watcher.ts';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

describe('TransactionWatcher Unit Tests', () => {
  let mockDatabase: DatabaseAdapter;
  let mockQueue: QueueAdapter;
  let transactionWatcher: TransactionWatcher;

  beforeEach(() => {
    mockDatabase = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      migrate: vi.fn().mockResolvedValue(undefined),
      insertAuthChallenge: vi.fn().mockResolvedValue(undefined),
      getAuthChallengeByChallenge: vi.fn().mockResolvedValue(null),
      markAuthChallengeConsumed: vi.fn().mockResolvedValue(true),
      insertInteractiveTransaction: vi.fn().mockResolvedValue({
        id: 'test-tx-id',
        account: 'test-account',
        kind: 'deposit' as const,
        assetCode: 'USDC',
        amount: '100',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      getInteractiveTransactionById: vi.fn().mockResolvedValue(null),
      listPendingTransactionsBefore: vi.fn().mockResolvedValue([]),
      updateTransactionStatus: vi.fn().mockResolvedValue(undefined),
      getIdempotencyRecord: vi.fn().mockResolvedValue(null),
      insertIdempotencyRecord: vi.fn().mockResolvedValue(undefined),
      insertWebhookEvent: vi.fn().mockResolvedValue({
        inserted: true,
        record: {
          id: 'webhook-id',
          eventId: 'external-id',
          provider: 'generic',
          payload: {},
          status: 'pending' as const,
          errorMessage: null,
          processedAt: null,
          createdAt: new Date().toISOString(),
        },
      }),
      updateWebhookEventStatus: vi.fn().mockResolvedValue(undefined),
      insertWatcherTask: vi.fn().mockResolvedValue(undefined),
      listPendingWatcherTasks: vi.fn().mockResolvedValue([]),
      updateWatcherTaskStatus: vi.fn().mockResolvedValue(undefined),
      countProcessedWatcherTasks: vi.fn().mockResolvedValue(0),
      cleanupOldRecords: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseAdapter;

    mockQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as QueueAdapter;

    transactionWatcher = new TransactionWatcher(mockDatabase, mockQueue, {
      pollIntervalMs: 1000,
      transactionTimeoutMs: 300000, // 5 minutes
      retentionDays: 30,
    });
  });

  it('treats stop() before start() as a safe no-op', async () => {
    await expect(transactionWatcher.stop()).resolves.toBeUndefined();
    expect(mockDatabase.listPendingTransactionsBefore).not.toHaveBeenCalled();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
    expect(mockQueue.stop).not.toHaveBeenCalled();
  });

  it('enqueues expiration jobs for stale pending deposits', async () => {
    const staleTransaction = {
      id: 'stale-tx-1',
      account: 'account-1',
      kind: 'deposit' as const,
      assetCode: 'USDC',
      amount: '100',
      status: 'pending',
      createdAt: new Date(Date.now() - 400000).toISOString(), // 6+ minutes ago (stale)
      updatedAt: new Date(Date.now() - 400000).toISOString(),
    };

    const anotherStaleTransaction = {
      id: 'stale-tx-2',
      account: 'account-2',
      kind: 'deposit' as const,
      assetCode: 'EURT',
      amount: '50',
      status: 'pending',
      createdAt: new Date(Date.now() - 350000).toISOString(), // 5+ minutes ago (stale)
      updatedAt: new Date(Date.now() - 350000).toISOString(),
    };

    mockDatabase.listPendingTransactionsBefore = vi
      .fn()
      .mockResolvedValue([staleTransaction, anotherStaleTransaction]);

    // Start the watcher to trigger the tick
    await transactionWatcher.start();

    // Should enqueue expire_transaction jobs for each stale transaction
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: 'expire_transaction',
      payload: { transactionId: 'stale-tx-1' },
    });

    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: 'expire_transaction',
      payload: { transactionId: 'stale-tx-2' },
    });

    // Should have called enqueue at least 4 times:
    // 2 for expire_transaction, 1 for process_watcher_task, 1 for cleanup_records
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(4);

    // Should have inserted a watcher task record
    expect(mockDatabase.insertWatcherTask).toHaveBeenCalledWith({
      id: expect.any(String),
      watcherName: 'transaction-watcher',
      payload: {
        pendingTransactionsChecked: 2,
        checkedAt: expect.any(String),
      },
    });

    // Stop the watcher to clean up
    await transactionWatcher.stop();
  });

  it('does not enqueue expiration jobs when no stale pending deposits exist', async () => {
    mockDatabase.listPendingTransactionsBefore = vi.fn().mockResolvedValue([]);

    // Start the watcher to trigger the tick
    await transactionWatcher.start();

    // Should not enqueue any expire_transaction jobs
    expect(mockQueue.enqueue).not.toHaveBeenCalledWith({
      type: 'expire_transaction',
      payload: expect.any(Object),
    });

    // Should still enqueue process_watcher_task and cleanup_records
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);

    // Should have inserted a watcher task record with zero checked
    expect(mockDatabase.insertWatcherTask).toHaveBeenCalledWith({
      id: expect.any(String),
      watcherName: 'transaction-watcher',
      payload: {
        pendingTransactionsChecked: 0,
        checkedAt: expect.any(String),
      },
    });

    // Stop the watcher to clean up
    await transactionWatcher.stop();
  });

  it('calculates cutoff time correctly for transaction timeout', async () => {
    const now = Date.now();
    const timeoutMs = 300000; // 5 minutes
    const expectedCutoff = new Date(now - timeoutMs).toISOString();

    // Mock Date.now to control timing
    const originalDateNow = Date.now;
    Date.now = vi.fn().mockReturnValue(now);

    const staleTransaction = {
      id: 'stale-tx',
      account: 'account',
      kind: 'deposit' as const,
      assetCode: 'USDC',
      amount: '100',
      status: 'pending',
      createdAt: new Date(now - timeoutMs - 1000).toISOString(), // Just over timeout
      updatedAt: new Date(now - timeoutMs - 1000).toISOString(),
    };

    mockDatabase.listPendingTransactionsBefore = vi.fn().mockResolvedValue([staleTransaction]);

    // Start the watcher to trigger the tick
    await transactionWatcher.start();

    // Verify the cutoff time was calculated correctly
    expect(mockDatabase.listPendingTransactionsBefore).toHaveBeenCalledWith(expectedCutoff);

    // Restore original Date.now
    Date.now = originalDateNow;

    // Stop the watcher to clean up
    await transactionWatcher.stop();
  });

  it('prevents overlapping ticks when called concurrently', async () => {
    let resolveTick!: (value: unknown[]) => void;
    const tickPromise = new Promise<unknown[]>((resolve) => {
      resolveTick = resolve;
    });

    mockDatabase.listPendingTransactionsBefore = vi.fn().mockReturnValue(tickPromise);

    // Start two ticks concurrently
    // Accessing private method for testing purposes
    const watcherWithTick = transactionWatcher as unknown as { tick: () => Promise<void> };
    const tick1 = watcherWithTick.tick();
    const tick2 = watcherWithTick.tick();

    // Resolve the database call
    resolveTick!([]);

    await Promise.all([tick1, tick2]);

    // Database should only be called once because the second tick should have returned early
    expect(mockDatabase.listPendingTransactionsBefore).toHaveBeenCalledTimes(1);
  });

  it('continues polling after a scheduled tick rejects', async () => {
    let calls = 0;
    mockDatabase.listPendingTransactionsBefore = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        throw new Error('db failure');
      }

      return [];
    });

    // Use a very short poll interval for testing
    const shortIntervalWatcher = new TransactionWatcher(mockDatabase, mockQueue, {
      pollIntervalMs: 10,
      transactionTimeoutMs: 300000,
      retentionDays: 30,
    });

    await shortIntervalWatcher.start();

    // Wait for multiple polling cycles to occur
    await new Promise((resolve) => setTimeout(resolve, 50));

    await shortIntervalWatcher.stop();

    // Timing can vary across environments; accept at least 4 calls
    expect(mockDatabase.listPendingTransactionsBefore).toHaveBeenCalled();
    const callCount = (mockDatabase.listPendingTransactionsBefore as Mock).mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(4);
  });

  it('stop() resolves even when an active tick rejects and clears the timer', async () => {
    const rejectTick = vi.fn();
    mockDatabase.listPendingTransactionsBefore = vi.fn<
      (cutoffIso: string) => Promise<InteractiveTransactionRecord[]>
    >(
      () =>
        new Promise((_, reject) => {
          rejectTick.mockImplementation(() => reject(new Error('db failure')));
        }),
    );

    const startPromise = transactionWatcher.start();
    await Promise.resolve();
    const stopPromise = transactionWatcher.stop();
    rejectTick();

    await expect(startPromise).rejects.toThrow('db failure');
    await expect(stopPromise).resolves.toBeUndefined();
    expect(
      (transactionWatcher as unknown as { timer: ReturnType<typeof setInterval> | null }).timer,
    ).toBeNull();
  });

  it('enqueues a cleanup_records job with the configured retention days', async () => {
    const retentionDays = 45;
    const customWatcher = new TransactionWatcher(mockDatabase, mockQueue, {
      pollIntervalMs: 1000,
      transactionTimeoutMs: 300000,
      retentionDays,
    });

    // Start the watcher to trigger one tick
    await customWatcher.start();

    // Assert that the cleanup_records job was enqueued with the correct retentionDays
    expect(mockQueue.enqueue).toHaveBeenCalledWith({
      type: 'cleanup_records',
      payload: {
        retentionDays,
      },
    });

    // Stop the watcher
    await customWatcher.stop();
  });

  it('does not create additional polling timer when start() is called twice', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    try {
      await transactionWatcher.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      setIntervalSpy.mockClear();

      await transactionWatcher.start();
      expect(setIntervalSpy).not.toHaveBeenCalled();

      expect(mockDatabase.listPendingTransactionsBefore).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      await transactionWatcher.stop();
    }
  });
});
