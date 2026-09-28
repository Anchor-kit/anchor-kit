import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';

interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

function getSqlite(db: DatabaseAdapter): SqliteHandle {
  const sqlite = (db as unknown as { sqlite?: SqliteHandle }).sqlite;
  if (!sqlite) {
    throw new Error('SQLite handle unavailable for test');
  }
  return sqlite;
}

function insertWatcherRow(
  db: DatabaseAdapter,
  fields: {
    id: string;
    watcherName: string;
    payload: Record<string, unknown>;
    status: 'pending' | 'processed';
    createdAt: string;
  },
): void {
  getSqlite(db)
    .prepare(
      'INSERT INTO watcher_tasks (id, watcher_name, payload, status, error_message, processed_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
    )
    .run(
      fields.id,
      fields.watcherName,
      JSON.stringify(fields.payload),
      fields.status,
      fields.createdAt,
    );
}

describe('SqlDatabaseAdapter – watcher task persistence and processed counts', () => {
  const dbUrl = makeSqliteDbUrlForTests();
  const dbPath = dbUrl.startsWith('file:') ? dbUrl.slice('file:'.length) : dbUrl;
  let db: DatabaseAdapter;

  beforeAll(async () => {
    db = createSqlDatabaseAdapter({ provider: 'sqlite', url: dbUrl });
    await db.connect();
    await db.migrate();
  });

  afterAll(async () => {
    await db.disconnect();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    // Clean up watcher tasks between tests
    getSqlite(db).exec('DELETE FROM watcher_tasks');
  });

  afterEach(async () => {
    // Ensure cleanup after each test
    getSqlite(db).exec('DELETE FROM watcher_tasks');
  });

  it('inserts a watcher task, updates status to processed, and counts it correctly', async () => {
    const taskId = randomUUID();
    const watcherName = 'test-watcher';
    const payload = { foo: 'bar', count: 42 };

    // Insert a new watcher task
    await db.insertWatcherTask({
      id: taskId,
      watcherName,
      payload,
    });

    // Verify initial count is 0 (task is pending)
    let processedCount = await db.countProcessedWatcherTasks();
    expect(processedCount).toBe(0);

    // List pending tasks to verify the task exists
    const pendingTasks = await db.listPendingWatcherTasks(10);
    expect(pendingTasks).toHaveLength(1);
    expect(pendingTasks[0].id).toBe(taskId);
    expect(pendingTasks[0].watcherName).toBe(watcherName);
    expect(pendingTasks[0].payload).toEqual(payload);
    expect(pendingTasks[0].status).toBe('pending');

    // Update the task status to processed
    await db.updateWatcherTaskStatus({
      id: taskId,
      status: 'processed',
    });

    // Verify the processed count is now 1
    processedCount = await db.countProcessedWatcherTasks();
    expect(processedCount).toBe(1);

    // Verify the task is no longer in pending list
    const stillPending = await db.listPendingWatcherTasks(10);
    expect(stillPending).toHaveLength(0);
  });

  it('handles multiple watcher tasks with mixed statuses', async () => {
    const task1Id = randomUUID();
    const task2Id = randomUUID();
    const task3Id = randomUUID();

    // Insert three tasks
    await db.insertWatcherTask({
      id: task1Id,
      watcherName: 'multi-task-watcher',
      payload: { task: 1 },
    });
    await db.insertWatcherTask({
      id: task2Id,
      watcherName: 'multi-task-watcher',
      payload: { task: 2 },
    });
    await db.insertWatcherTask({
      id: task3Id,
      watcherName: 'multi-task-watcher',
      payload: { task: 3 },
    });

    // Initially all are pending
    expect(await db.countProcessedWatcherTasks()).toBe(0);
    expect((await db.listPendingWatcherTasks(10)).length).toBe(3);

    // Mark task1 and task3 as processed
    await db.updateWatcherTaskStatus({ id: task1Id, status: 'processed' });
    await db.updateWatcherTaskStatus({ id: task3Id, status: 'processed' });

    // Count should be 2
    expect(await db.countProcessedWatcherTasks()).toBe(2);

    // Only task2 should remain pending
    const pending = await db.listPendingWatcherTasks(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(task2Id);

    // Mark task2 as failed
    await db.updateWatcherTaskStatus({
      id: task2Id,
      status: 'failed',
      errorMessage: 'Test failure',
    });

    // Count should still be 2 (failed tasks don't count)
    expect(await db.countProcessedWatcherTasks()).toBe(2);

    // No pending tasks left
    expect(await db.listPendingWatcherTasks(10)).toHaveLength(0);
  });

  it('caps the returned pending watcher tasks at the requested limit', async () => {
    const watcherName = 'limit-watcher';
    const total = 5;
    const baseTimestamp = Date.parse('2024-01-01T00:00:00.000Z');

    for (let i = 0; i < total; i++) {
      insertWatcherRow(db, {
        id: randomUUID(),
        watcherName,
        payload: { order: i + 1 },
        status: 'pending',
        // Spread timestamps by an hour so total ordering is deterministic.
        createdAt: new Date(baseTimestamp + i * 60 * 60 * 1000).toISOString(),
      });
    }

    // Insert an additional non-pending row to confirm pending-only filtering while
    // asserting the limit applies to pending rows alone.
    insertWatcherRow(db, {
      id: randomUUID(),
      watcherName,
      payload: { order: 99 },
      status: 'processed',
      createdAt: new Date(baseTimestamp - 60 * 60 * 1000).toISOString(),
    });

    // Sanity check: every pending row is persisted before we exercise the limit.
    expect((await db.listPendingWatcherTasks(total + 1)).length).toBe(total);

    const limited = await db.listPendingWatcherTasks(2);

    // Result count must not exceed the requested limit.
    expect(limited).toHaveLength(2);

    // The two oldest pending IDs should be the ones with orders 1 and 2.
    expect(limited.map((task) => task.payload.order)).toEqual([1, 2]);
  });

  it('returns pending watcher tasks in oldest-first order regardless of insertion order', async () => {
    const watcherName = 'order-watcher';
    const baseTimestamp = Date.parse('2024-02-01T00:00:00.000Z');

    // Insert five pending tasks with deterministic timestamps but in REVERSE
    // chronological order. This proves the ordering is driven by created_at,
    // not by primary-key insertion order.
    const insertionOrder = [5, 4, 3, 2, 1];
    for (const order of insertionOrder) {
      insertWatcherRow(db, {
        id: randomUUID(),
        watcherName,
        payload: { order },
        status: 'pending',
        createdAt: new Date(baseTimestamp + (order - 1) * 60 * 60 * 1000).toISOString(),
      });
    }

    // Mix in a processed task whose created_at falls between the earliest two
    // pending tasks; it must not appear in oldest-first pending results.
    insertWatcherRow(db, {
      id: randomUUID(),
      watcherName,
      payload: { order: 0 },
      status: 'processed',
      createdAt: new Date(baseTimestamp + 30 * 60 * 1000).toISOString(),
    });

    const pending = await db.listPendingWatcherTasks(10);

    // Only the five pending tasks are returned and they are oldest-first.
    expect(pending).toHaveLength(insertionOrder.length);
    expect(pending.map((task) => task.payload.order)).toEqual([1, 2, 3, 4, 5]);

    // A smaller limit still preserves the oldest-first ordering.
    const limited = await db.listPendingWatcherTasks(3);
    expect(limited).toHaveLength(3);
    expect(limited.map((task) => task.payload.order)).toEqual([1, 2, 3]);
  });
});
