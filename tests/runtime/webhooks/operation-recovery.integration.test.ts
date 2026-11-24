import { randomUUID } from 'node:crypto';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import { DefaultWebhookProcessor } from '@/runtime/webhooks/default-webhook-processor.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import type { AnchorKitConfig } from '@/types/config.ts';
import type { PaymentRailOperation } from '@/types/transaction.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cases = [
  { name: 'SQLite', provider: 'sqlite' as const, url: 'file::memory:' },
  ...(process.env.DATABASE_URL
    ? [{ name: 'PostgreSQL', provider: 'postgres' as const, url: process.env.DATABASE_URL }]
    : []),
];

describe.each(cases)('webhook operation recovery ($name)', ({ provider, url }) => {
  let database: DatabaseAdapter;
  beforeAll(async () => {
    database = createSqlDatabaseAdapter({ provider, url });
    await database.connect();
    await database.migrate();
  });
  afterAll(async () => database.disconnect());

  function config(
    onEvent: () => Promise<void>,
    recoverOperation: NonNullable<NonNullable<AnchorKitConfig['webhooks']>['recoverOperation']>,
  ): AnchorKitConfig {
    return {
      network: { network: 'testnet' },
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'test.example.com' },
      assets: { assets: [] },
      framework: { database: { provider, url } },
      security: {
        sep10SigningKey: 'test',
        interactiveJwtSecret: 'test',
        distributionAccountSecret: 'test',
        verifyWebhookSignatures: false,
      },
      webhooks: { onEvent, recoverOperation },
    };
  }

  it('recovers the original provider success without repeating a transfer', async () => {
    let transfers = 0;
    let lookups = 0;
    const eventId = randomUUID();
    const operation: PaymentRailOperation = {
      operationId: `bank:${eventId}`,
      provider: 'bank',
      reference: 'transfer-1',
      amount: { amount: '12.50', currency: 'USD' },
      status: 'succeeded',
    };
    const options = {
      config: config(
        async () => {
          transfers++;
          throw new Error('lost callback result');
        },
        async ({ operationKey }) => {
          lookups++;
          expect(operationKey).toBe(operation.operationId);
          return operation;
        },
      ),
      database,
    };
    const processor = new DefaultWebhookProcessor(options);
    const input = { eventId, provider: 'bank', payload: {}, rawBody: '{}' };
    await expect(processor.process(input)).rejects.toThrow('Webhook processing failed');
    expect(await processor.process({ ...input, retry: true })).toMatchObject({
      status: 'processed',
      recoveryResult: operation,
    });
    expect(await new DefaultWebhookProcessor(options).process(input)).toMatchObject({
      status: 'processed',
      recoveryResult: operation,
    });
    expect(transfers).toBe(1);
    expect(lookups).toBe(1);
  });

  it('leaves an unknown result unresolved without repeating a transfer', async () => {
    let transfers = 0;
    const processor = new DefaultWebhookProcessor({
      config: config(
        async () => {
          transfers++;
          throw new Error('ambiguous');
        },
        async () => null,
      ),
      database,
    });
    const input = { eventId: randomUUID(), provider: 'bank', payload: {}, rawBody: '{}' };
    await expect(processor.process(input)).rejects.toThrow('Webhook processing failed');
    expect(await processor.process({ ...input, retry: true })).toMatchObject({
      status: 'unresolved',
    });
    expect(await processor.process({ ...input, retry: true })).toMatchObject({
      status: 'unresolved',
    });
    expect(transfers).toBe(1);
  });

  it('allows only one concurrent recovery lease', async () => {
    const eventId = randomUUID();
    const inserted = await database.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'bank',
      payload: {},
    });
    const claim = await database.claimWebhookAttempt({
      id: inserted.record.id,
      leaseOwner: 'first',
      leaseDurationMs: 10000,
    });
    expect(claim).not.toBeNull();
    expect(
      await database.completeWebhookAttempt({
        id: inserted.record.id,
        attemptId: claim!.attemptId!,
        leaseOwner: 'first',
        status: 'unresolved',
      }),
    ).toBe(true);
    const recoveries = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        database.claimWebhookRecovery({
          id: inserted.record.id,
          leaseOwner: `recovery-${i}`,
          leaseDurationMs: 10000,
        }),
      ),
    );
    expect(recoveries.filter(Boolean)).toHaveLength(1);
    expect(
      await database.completeWebhookAttempt({
        id: inserted.record.id,
        attemptId: claim!.attemptId!,
        leaseOwner: 'first',
        status: 'processed',
      }),
    ).toBe(false);
  });
});
