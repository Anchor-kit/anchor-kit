import { randomUUID } from 'node:crypto';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? describe : describe.skip;

postgresTest('SqlDatabaseAdapter – PostgreSQL integration', () => {
  let db: DatabaseAdapter;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required to run PostgreSQL adapter assertions');
    }

    db = createSqlDatabaseAdapter({ provider: 'postgres', url: databaseUrl });
    await db.connect();
    await db.migrate();
  });

  afterAll(async () => {
    await db?.disconnect();
  });

  it('connects, migrates, and persists interactive transactions', async () => {
    const id = randomUUID();
    const inserted = await db.insertInteractiveTransaction({
      id,
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '25.00',
      status: 'pending_user_transfer_start',
    });

    expect(inserted.id).toBe(id);
    expect(await db.getInteractiveTransactionById(id)).toMatchObject({
      id,
      kind: 'deposit',
      status: 'pending_user_transfer_start',
    });
  });

  it('atomically deduplicates concurrent deliveries of the same webhook event', async () => {
    const eventId = `evt-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        db.insertWebhookEvent({
          id: randomUUID(),
          eventId,
          provider: 'ci-test',
          payload: { delivery: index },
        }),
      ),
    );

    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
    expect(new Set(results.map(({ record }) => record.id)).size).toBe(1);
    expect(results.every(({ record }) => record.eventId === eventId)).toBe(true);
  });
});
