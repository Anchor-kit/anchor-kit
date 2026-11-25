import { describe, expect, it, vi } from 'vitest';
import { recoverStellarSubmission } from '@/services/stellar-submission-recovery.ts';

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
});
