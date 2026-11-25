import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  makeSqliteDbUrlForTests,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';

async function exerciseLeases(
  first: SqlDatabaseAdapter,
  second: SqlDatabaseAdapter,
  expire: (id: string) => Promise<void>,
  markLegacyProcessing: (id: string) => Promise<void>,
) {
  const legacyId = randomUUID();
  await first.insertOrGetSettlementJob({
    id: randomUUID(),
    operationId: legacyId,
    payloadRef: 'legacy',
  });
  await markLegacyProcessing(legacyId);
  expect(
    await first.claimSettlementJob({ operationId: legacyId, owner: 'worker-a', durationMs: 60000 }),
  ).toBeNull();
  const operationId = randomUUID();
  await first.insertOrGetSettlementJob({
    id: randomUUID(),
    operationId,
    payloadRef: 'transaction:fixture',
  });
  expect(
    (await first.listClaimableSettlementJobs(100)).some((job) => job.operationId === operationId),
  ).toBe(true);
  const claims = await Promise.all([
    first.claimSettlementJob({ operationId, owner: 'worker-a', durationMs: 60000 }),
    second.claimSettlementJob({ operationId, owner: 'worker-b', durationMs: 60000 }),
  ]);
  const claimed = claims.filter((claim) => claim !== null);
  expect(claimed).toHaveLength(1);
  const original = claimed[0]!;
  expect(original.attempt).toBe(1);
  expect(
    await first.heartbeatSettlementJob({ operationId, token: original.token, durationMs: 60000 }),
  ).toBe(true);
  expect(
    (await first.listClaimableSettlementJobs(100)).some((job) => job.operationId === operationId),
  ).toBe(false);
  await expire(operationId);
  expect(
    (await first.listClaimableSettlementJobs(100)).some((job) => job.operationId === operationId),
  ).toBe(true);
  expect(
    await first.heartbeatSettlementJob({ operationId, token: original.token, durationMs: 60000 }),
  ).toBe(false);
  expect(
    await first.finishSettlementJob({ operationId, token: original.token, status: 'completed' }),
  ).toBe(false);
  const next = await second.claimSettlementJob({
    operationId,
    owner: 'worker-c',
    durationMs: 60000,
  });
  expect(next).not.toBeNull();
  expect(next!.attempt).toBe(2);
  expect(next!.token).not.toBe(original.token);
  expect(
    await first.finishSettlementJob({ operationId, token: original.token, status: 'completed' }),
  ).toBe(false);
  await expect(
    first.updateSettlementJobStatus({ operationId, status: 'completed' }),
  ).rejects.toThrow('require a lease token');
  expect(
    await second.finishSettlementJob({ operationId, token: next!.token, status: 'pending' }),
  ).toBe(true);
  await expect(
    first.updateSettlementJobStatus({ operationId, status: 'completed' }),
  ).rejects.toThrow('require a lease token');
  const last = await first.claimSettlementJob({
    operationId,
    owner: 'worker-d',
    durationMs: 60000,
  });
  expect(last!.attempt).toBe(3);
  expect(
    await first.finishSettlementJob({ operationId, token: last!.token, status: 'completed' }),
  ).toBe(true);
  expect(
    await second.claimSettlementJob({ operationId, owner: 'worker-e', durationMs: 60000 }),
  ).toBeNull();
  expect((await first.getSettlementJobByOperationId(operationId))?.status).toBe('completed');
}

describe('settlement job leases', () => {
  it('upgrades an existing settlement table without discarding its jobs', async () => {
    const url = makeSqliteDbUrlForTests();
    const path = url.slice('file:'.length);
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE settlement_jobs (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, payload_ref TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); INSERT INTO settlement_jobs VALUES ('old-job', 'old-operation', 'ref', 'pending',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`);
    legacy.close();
    const adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    try {
      await adapter.connect();
      await adapter.migrate();
      await adapter.migrate();
      expect((await adapter.getSettlementJobByOperationId('old-operation'))?.id).toBe('old-job');
      expect(
        (
          await adapter.claimSettlementJob({
            operationId: 'old-operation',
            owner: 'worker',
            durationMs: 1000,
          })
        )?.attempt,
      ).toBe(1);
    } finally {
      await adapter.disconnect();
      try {
        unlinkSync(path);
      } catch {
        /* Already removed. */
      }
    }
  });

  it('serializes SQLite claims and fences expired attempts across connections', async () => {
    const url = makeSqliteDbUrlForTests();
    const path = url.slice('file:'.length);
    const first = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    const second = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    try {
      await first.connect();
      await second.connect();
      await first.migrate();
      await second.migrate();
      const setFields = async (id: string, legacy: boolean) => {
        const raw = new Database(path);
        try {
          raw
            .prepare(
              legacy
                ? "UPDATE settlement_jobs SET status = 'processing', lease_expires_at = NULL WHERE operation_id = ?"
                : "UPDATE settlement_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE operation_id = ?",
            )
            .run(id);
        } finally {
          raw.close();
        }
      };
      await exerciseLeases(
        first,
        second,
        (id) => setFields(id, false),
        (id) => setFields(id, true),
      );
    } finally {
      await first.disconnect();
      await second.disconnect();
      try {
        unlinkSync(path);
      } catch {
        /* Already removed. */
      }
    }
  });

  const pgTest = process.env.DATABASE_URL ? it : it.skip;
  pgTest(
    'serializes PostgreSQL claims and fences expired attempts across connections',
    async () => {
      const url = process.env.DATABASE_URL!;
      const first = new SqlDatabaseAdapter({ provider: 'postgres', url });
      const second = new SqlDatabaseAdapter({ provider: 'postgres', url });
      const moduleName = 'pg';
      const pgModule: {
        Client: new (config: { connectionString: string }) => {
          connect(): Promise<void>;
          end(): Promise<void>;
          query(sql: string, values: Array<string>): Promise<void>;
        };
      } = await import(moduleName);
      const raw = new pgModule.Client({ connectionString: url });
      try {
        await first.connect();
        await second.connect();
        await raw.connect();
        await first.migrate();
        await second.migrate();
        await exerciseLeases(
          first,
          second,
          async (id) => {
            await raw.query(
              "UPDATE settlement_jobs SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE operation_id = $1",
              [id],
            );
          },
          async (id) => {
            await raw.query(
              "UPDATE settlement_jobs SET status = 'processing', lease_expires_at = NULL WHERE operation_id = $1",
              [id],
            );
          },
        );
      } finally {
        await first.disconnect();
        await second.disconnect();
        await raw.end();
      }
    },
  );
});
