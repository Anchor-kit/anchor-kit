import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnchor } from '@/index.ts';
import type { DatabaseAdapter, QueueJob } from '@/runtime/interfaces.ts';

function createTestAnchor() {
  return createAnchor({
    network: { network: 'testnet' },
    server: { interactiveDomain: 'https://anchor.example.com' },
    security: {
      sep10SigningKey: Keypair.random().secret(),
      interactiveJwtSecret: 'jwt-test-secret',
      distributionAccountSecret: 'distribution-test-secret',
    },
    assets: {
      assets: [
        {
          code: 'USDC',
          issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        },
      ],
    },
    framework: {
      database: { provider: 'sqlite', url: 'file::memory:' },
    },
  });
}

const expiryJob = (transactionId: string): QueueJob => ({
  type: 'expire_transaction',
  payload: { transactionId },
});

describe('transaction status plugin hooks', () => {
  afterEach(() => vi.restoreAllMocks());

  it('notifies hooks only after a successful expiry transition', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    const anchor = createTestAnchor().use({
      id: 'status-hook',
      hooks: { onTransactionStatusChange: hook },
    });
    await anchor.init();
    const internal = anchor as unknown as {
      database: DatabaseAdapter;
      processQueueJob: (job: QueueJob) => Promise<void>;
    };
    const transaction = await internal.database.insertInteractiveTransaction({
      id: 'expiry-hook-1',
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '1.00',
      status: 'pending_user_transfer_start',
    });

    try {
      await internal.processQueueJob.call(anchor, expiryJob(transaction.id));

      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ id: transaction.id, status: 'expired' }),
        'pending_user_transfer_start',
        'expired',
      );
      await expect(
        internal.database.getInteractiveTransactionById(transaction.id),
      ).resolves.toMatchObject({ status: 'expired' });
    } finally {
      await anchor.shutdown();
    }
  });

  it('does not notify hooks when the conditional update affects no row', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    const anchor = createTestAnchor().use({
      id: 'status-hook',
      hooks: { onTransactionStatusChange: hook },
    });
    await anchor.init();
    const internal = anchor as unknown as {
      database: DatabaseAdapter;
      processQueueJob: (job: QueueJob) => Promise<void>;
    };
    const transaction = await internal.database.insertInteractiveTransaction({
      id: 'expiry-hook-noop',
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '1.00',
      status: 'pending_user_transfer_start',
    });
    vi.spyOn(internal.database, 'updateTransactionStatus').mockResolvedValue(false);

    try {
      await internal.processQueueJob.call(anchor, expiryJob(transaction.id));
      expect(hook).not.toHaveBeenCalled();
    } finally {
      await anchor.shutdown();
    }
  });

  it('logs hook failures and continues to later plugins', async () => {
    const firstHook = vi.fn().mockRejectedValue(new Error('plugin failed'));
    const secondHook = vi.fn().mockResolvedValue(undefined);
    const anchor = createTestAnchor()
      .use({ id: 'failing-hook', hooks: { onTransactionStatusChange: firstHook } })
      .use({ id: 'next-hook', hooks: { onTransactionStatusChange: secondHook } });
    await anchor.init();
    const internal = anchor as unknown as {
      database: DatabaseAdapter;
      processQueueJob: (job: QueueJob) => Promise<void>;
    };
    const transaction = await internal.database.insertInteractiveTransaction({
      id: 'expiry-hook-error',
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '1.00',
      status: 'pending_user_transfer_start',
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await internal.processQueueJob.call(anchor, expiryJob(transaction.id));
      expect(consoleError).toHaveBeenCalledWith(
        '[AnchorKit] Plugin "failing-hook" transaction status hook failed',
        expect.any(Error),
      );
      expect(secondHook).toHaveBeenCalledOnce();
    } finally {
      await anchor.shutdown();
    }
  });
});
