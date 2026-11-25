import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  makeSqliteDbUrlForTests,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';

describe('Stellar sequence leases', () => {
  it('serializes account sequences and reclaims only the same immutable operation', async () => {
    const url = makeSqliteDbUrlForTests();
    const path = url.slice('file:'.length);
    const first = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    const second = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    const accountId = 'G'.padEnd(56, 'A');
    const operationId = randomUUID();
    const payloadHash = 'a'.repeat(64);

    try {
      await first.connect();
      await second.connect();
      await first.migrate();
      await second.migrate();

      const claims = await Promise.all([
        first.reserveStellarSequence({
          accountId,
          networkSequence: '100',
          operationId,
          payloadHash,
          owner: 'worker-a',
          durationMs: 60_000,
        }),
        second.reserveStellarSequence({
          accountId,
          networkSequence: '100',
          operationId,
          payloadHash,
          owner: 'worker-b',
          durationMs: 60_000,
        }),
      ]);
      const original = claims.find((claim) => claim !== null)!;
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      expect(original.sequence).toBe('101');
      expect(original.attempt).toBe(1);

      expect(
        await second.reserveStellarSequence({
          accountId,
          networkSequence: '100',
          operationId: randomUUID(),
          payloadHash,
          owner: 'worker-c',
          durationMs: 60_000,
        }),
      ).toBeNull();

      const raw = new Database(path);
      try {
        raw
          .prepare(
            "UPDATE stellar_sequence_operations SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE operation_id = ?",
          )
          .run(operationId);
      } finally {
        raw.close();
      }

      const reclaimed = await second.reserveStellarSequence({
        accountId,
        networkSequence: '100',
        operationId,
        payloadHash,
        owner: 'worker-d',
        durationMs: 60_000,
      });
      expect(reclaimed).toMatchObject({ sequence: '101', attempt: 2, owner: 'worker-d' });
      expect(reclaimed!.token).not.toBe(original.token);
      expect(
        await first.completeStellarSequenceOperation({
          accountId,
          operationId,
          token: original.token,
        }),
      ).toBe(false);
      expect(
        await second.completeStellarSequenceOperation({
          accountId,
          operationId,
          token: reclaimed!.token,
        }),
      ).toBe(true);

      await expect(
        first.reserveStellarSequence({
          accountId,
          networkSequence: '100',
          operationId,
          payloadHash: 'b'.repeat(64),
          owner: 'worker-e',
          durationMs: 60_000,
        }),
      ).rejects.toThrow('identity was reused');

      const next = await first.reserveStellarSequence({
        accountId,
        networkSequence: '100',
        operationId: randomUUID(),
        payloadHash,
        owner: 'worker-f',
        durationMs: 60_000,
      });
      expect(next?.sequence).toBe('102');
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
});
