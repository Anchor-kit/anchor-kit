import {
  createSqlDatabaseAdapter,
  makeSqliteDbUrlForTests,
} from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('sqlite idempotency persistence', () => {
  const dbUrl = makeSqliteDbUrlForTests();
  const dbPath = dbUrl.slice('file:'.length);
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
      // Ignore cleanup errors when SQLite did not create a file.
    }
  });

  it('stores and fetches an idempotency record by scope and key', async () => {
    const scope = 'sep24:deposit';
    const key = 'client-123';
    const responseBody = JSON.stringify({ message: 'ok', id: 'resp-1' });

    const inserted = await db.insertOrGetIdempotencyRecord({
      id: 'idempotency-1',
      scope,
      idempotencyKey: key,
      requestHash: 'abcd1234',
      statusCode: 200,
      responseBody,
    });

    expect(inserted).toEqual(
      expect.objectContaining({
        id: 'idempotency-1',
        scope,
        idempotencyKey: key,
        requestHash: 'abcd1234',
        statusCode: 200,
        responseBody,
      }),
    );
    await expect(db.getIdempotencyRecord(scope, key)).resolves.toEqual(inserted);
  });

  it('isolates idempotency records by scope when the same key is used', async () => {
    const key = 'shared-client-key';
    const scopeA = 'sep24:deposit';
    const scopeB = 'sep31:receive';
    const responseA = JSON.stringify({ message: 'deposit success', id: 'resp-A' });
    const responseB = JSON.stringify({ message: 'receive success', id: 'resp-B' });

    const recordA = await db.insertOrGetIdempotencyRecord({
      id: 'idempotency-scope-a',
      scope: scopeA,
      idempotencyKey: key,
      requestHash: 'hashA',
      statusCode: 200,
      responseBody: responseA,
    });
    const recordB = await db.insertOrGetIdempotencyRecord({
      id: 'idempotency-scope-b',
      scope: scopeB,
      idempotencyKey: key,
      requestHash: 'hashB',
      statusCode: 201,
      responseBody: responseB,
    });

    expect(recordA.id).not.toBe(recordB.id);
    expect(recordA.scope).toBe(scopeA);
    expect(recordB.scope).toBe(scopeB);
    expect(recordA.responseBody).toBe(responseA);
    expect(recordB.responseBody).toBe(responseB);
    await expect(db.getIdempotencyRecord(scopeA, key)).resolves.toEqual(recordA);
    await expect(db.getIdempotencyRecord(scopeB, key)).resolves.toEqual(recordB);
  });
});
