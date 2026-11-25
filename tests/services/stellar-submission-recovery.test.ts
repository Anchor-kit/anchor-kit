import { describe, expect, it, vi } from 'vitest';
import {
  recoverPersistedStellarSubmission,
  recoverStellarSubmission,
} from '@/services/stellar-submission-recovery.ts';
import type { InteractiveTransactionRecord } from '@/runtime/interfaces.ts';

const hash = 'a'.repeat(64);

describe('recoverStellarSubmission', () => {
  it('recovers a lost successful submit response from the saved hash', async () => {
    const getTransaction = vi.fn().mockResolvedValue({
      status: 'found',
      value: { hash, successful: true, ledger: 42 },
    });
    await expect(recoverStellarSubmission({ getTransaction }, hash.toUpperCase())).resolves.toEqual(
      {
        outcome: 'confirmed',
        hash,
        ledger: 42,
      },
    );
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(getTransaction).toHaveBeenCalledWith(hash);
  });

  it('keeps unknown lookups pending and never submits a new envelope', async () => {
    const getTransaction = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'timeout' });
    await expect(recoverStellarSubmission({ getTransaction }, hash)).resolves.toEqual({
      outcome: 'pending',
      hash,
      reason: 'timeout',
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed persisted hashes before querying the network', async () => {
    const getTransaction = vi.fn();
    await expect(recoverStellarSubmission({ getTransaction }, 'bad-hash')).rejects.toThrow(
      'A persisted 64-character Stellar transaction hash is required',
    );
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('loads and reconciles the transaction hash saved in the database', async () => {
    const transaction: InteractiveTransactionRecord = {
      id: 'transaction-1',
      account: 'GACCOUNT',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '1',
      status: 'pending_stellar',
      stellarTransactionHash: hash,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const getTransaction = vi.fn().mockResolvedValue({
      status: 'found',
      value: { hash, successful: true, ledger: 99 },
    });
    const getInteractiveTransactionById = vi.fn().mockResolvedValue(transaction);
    const updateTransactionStatus = vi.fn().mockResolvedValue(true);
    await expect(
      recoverPersistedStellarSubmission(
        { getInteractiveTransactionById, updateTransactionStatus },
        { getTransaction },
        transaction.id,
      ),
    ).resolves.toEqual({ outcome: 'confirmed', hash, ledger: 99 });
    expect(getInteractiveTransactionById).toHaveBeenCalledWith(transaction.id);
    expect(getTransaction).toHaveBeenCalledWith(hash);

    getInteractiveTransactionById.mockResolvedValue({
      ...transaction,
      stellarTransactionHash: null,
    });
    await expect(
      recoverPersistedStellarSubmission(
        { getInteractiveTransactionById, updateTransactionStatus },
        { getTransaction },
        transaction.id,
      ),
    ).resolves.toEqual({ outcome: 'not_ready', reason: 'hash_not_persisted' });
    expect(getTransaction).toHaveBeenCalledTimes(1);

    getInteractiveTransactionById.mockResolvedValue(transaction);
    getTransaction.mockResolvedValue({
      status: 'found',
      value: { hash, successful: false, ledger: 101 },
    });
    await expect(
      recoverPersistedStellarSubmission(
        { getInteractiveTransactionById, updateTransactionStatus },
        { getTransaction },
        transaction.id,
      ),
    ).resolves.toEqual({ outcome: 'rejected', hash, ledger: 101 });
    expect(updateTransactionStatus).toHaveBeenCalledWith(
      transaction.id,
      'error',
      'pending_stellar',
    );
  });
});
