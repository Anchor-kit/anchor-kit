import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const postgresUrl = process.env.ANCHOR_KIT_TEST_POSTGRES_URL;

describe('PostgreSQL schema isolation', () => {
  it('rejects malformed identifiers before opening a connection', () => {
    expect(() =>
      createSqlDatabaseAdapter({
        provider: 'postgres',
        url: 'postgres://localhost/anchor_kit',
        schema: 'records; DROP SCHEMA public;--',
      }),
    ).toThrow(/schema must be a PostgreSQL identifier/i);
  });

  (postgresUrl ? it : it.skip)(
    'keeps records isolated between two configured schemas',
    async () => {
      const suffix = randomUUID().replaceAll('-', '');
      const firstSchema = `anchor_test_a_${suffix}`;
      const secondSchema = `anchor_test_b_${suffix}`;
      const transactionId = randomUUID();
      const first: DatabaseAdapter = createSqlDatabaseAdapter({
        provider: 'postgres',
        url: postgresUrl!,
        schema: firstSchema,
      });
      const second: DatabaseAdapter = createSqlDatabaseAdapter({
        provider: 'postgres',
        url: postgresUrl!,
        schema: secondSchema,
      });

      try {
        await first.connect();
        await second.connect();
        await first.migrate();
        await second.migrate();

        await first.insertInteractiveTransaction({
          id: transactionId,
          account: 'GTEST',
          kind: 'deposit',
          assetCode: 'USDC',
          amount: '1.00',
          amountIn: '12345678901234567890.00000001',
          amountOut: '0.00000009',
          amountFee: '0.0000000000000000001',
          currency: 'USD',
          railReference: 'rail-ref-pg',
          stellarTransactionHash: 'stellar-hash-pg',
          status: 'pending_user_transfer_start',
        });

        const firstRecord = await first.getInteractiveTransactionById(transactionId);
        expect(firstRecord).toMatchObject({
          amountIn: '12345678901234567890.00000001',
          amountOut: '0.00000009',
          amountFee: '0.0000000000000000001',
          currency: 'USD',
          railReference: 'rail-ref-pg',
          stellarTransactionHash: 'stellar-hash-pg',
        });
        expect(await second.getInteractiveTransactionById(transactionId)).toBeNull();

        const reservedId = randomUUID();
        await first.reserveIdempotencyRecord({
          id: randomUUID(),
          scope: 'schema-test',
          idempotencyKey: reservedId,
          requestHash: 'hash',
        });
        await first.createDepositWithIdempotency({
          transaction: {
            id: reservedId,
            account: 'GTEST',
            kind: 'deposit',
            assetCode: 'USDC',
            amount: '2',
            status: 'pending_user_transfer_start',
            createdAt: new Date().toISOString(),
          },
          idempotency: {
            scope: 'schema-test',
            idempotencyKey: reservedId,
            requestHash: 'hash',
            statusCode: 201,
            responseBody: '{}',
          },
        });
        expect(await first.getInteractiveTransactionById(reservedId)).not.toBeNull();
        expect(await second.getInteractiveTransactionById(reservedId)).toBeNull();

        const railTransactionId = randomUUID();
        const railOperationId = randomUUID();
        const railJobId = randomUUID();
        await first.insertInteractiveTransaction({
          id: railTransactionId,
          account: 'GTEST',
          kind: 'deposit',
          assetCode: 'USDC',
          amount: '3.00',
          status: 'pending_external',
        });
        await expect(
          first.recordReconciledRailPayment({
            transactionId: railTransactionId,
            operationId: railOperationId,
            jobId: railJobId,
          }),
        ).resolves.toMatchObject({
          outcome: 'enqueued',
          transaction: { id: railTransactionId, status: 'pending_stellar' },
          job: { id: railJobId, operationId: railOperationId },
        });
        expect(await second.getInteractiveTransactionById(railTransactionId)).toBeNull();
        expect(await second.getSettlementJobByOperationId(railOperationId)).toBeNull();

        const confirmedTransactionId = randomUUID();
        const transactionHash = 'c'.repeat(64);
        await first.insertInteractiveTransaction({
          id: confirmedTransactionId,
          account: 'GTEST',
          kind: 'deposit',
          assetCode: 'USDC',
          amount: '4.00',
          status: 'pending_stellar',
        });
        await expect(
          first.confirmSettlement({
            transactionId: confirmedTransactionId,
            transactionHash,
            amount: '4',
            recipient: 'GTEST',
          }),
        ).resolves.toMatchObject({
          outcome: 'completed',
          transaction: { id: confirmedTransactionId, status: 'completed' },
        });
        expect(await first.getInteractiveTransactionById(confirmedTransactionId)).toMatchObject({
          status: 'completed',
          stellarTransactionHash: transactionHash,
        });
        expect(await second.getInteractiveTransactionById(confirmedTransactionId)).toBeNull();
      } finally {
        await first.disconnect();
        await second.disconnect();
        const moduleName = 'pg';
        const pgModuleUnknown: unknown = await import(moduleName);
        const pgModule = pgModuleUnknown as {
          Client: new (config: { connectionString: string }) => {
            connect(): Promise<void>;
            end(): Promise<void>;
            query(sql: string): Promise<unknown>;
          };
        };
        const cleanup = new pgModule.Client({ connectionString: postgresUrl! });
        await cleanup.connect();
        try {
          await cleanup.query(`DROP SCHEMA IF EXISTS "${firstSchema}" CASCADE`);
          await cleanup.query(`DROP SCHEMA IF EXISTS "${secondSchema}" CASCADE`);
        } finally {
          await cleanup.end();
        }
      }
    },
  );
});
