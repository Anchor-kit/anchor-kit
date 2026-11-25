import type {
  DatabaseAdapter,
  StellarNetworkClient,
  StellarNetworkResult,
  StellarTransactionState,
} from '@/runtime/interfaces.ts';

export type StellarSubmissionRecoveryResult =
  | { outcome: 'confirmed'; hash: string; ledger: number }
  | { outcome: 'rejected'; hash: string; ledger: number }
  | {
      outcome: 'pending';
      hash: string;
      reason: 'not_found' | 'network' | 'timeout' | 'invalid_response' | 'network_mismatch';
    };

export type PersistedStellarSubmissionRecoveryResult =
  | { outcome: 'not_ready'; reason: 'transaction_not_found' | 'hash_not_persisted' }
  | StellarSubmissionRecoveryResult;

/** Load the stored hash by transaction ID and reconcile it without creating a new envelope. */
export async function recoverPersistedStellarSubmission(
  database: Pick<DatabaseAdapter, 'getInteractiveTransactionById' | 'updateTransactionStatus'>,
  network: Pick<StellarNetworkClient, 'getTransaction'>,
  transactionId: string,
): Promise<PersistedStellarSubmissionRecoveryResult> {
  const transaction = await database.getInteractiveTransactionById(transactionId);
  if (!transaction) return { outcome: 'not_ready', reason: 'transaction_not_found' };
  if (!transaction.stellarTransactionHash) {
    return { outcome: 'not_ready', reason: 'hash_not_persisted' };
  }
  const result = await recoverStellarSubmission(network, transaction.stellarTransactionHash);
  if (result.outcome === 'rejected') {
    await database.updateTransactionStatus(transaction.id, 'error', 'pending_stellar');
  }
  return result;
}

/** Query a previously persisted hash once; never submit a replacement envelope on uncertainty. */
export async function recoverStellarSubmission(
  network: Pick<StellarNetworkClient, 'getTransaction'>,
  persistedHash: string,
): Promise<StellarSubmissionRecoveryResult> {
  if (!/^[a-fA-F0-9]{64}$/.test(persistedHash)) {
    throw new TypeError('A persisted 64-character Stellar transaction hash is required');
  }

  const hash = persistedHash.toLowerCase();
  const result: StellarNetworkResult<StellarTransactionState> = await network.getTransaction(hash);
  if (result.status === 'not_found') return { outcome: 'pending', hash, reason: 'not_found' };
  if (result.status === 'unavailable') {
    return { outcome: 'pending', hash, reason: result.reason };
  }
  if (result.value.hash !== hash) {
    return { outcome: 'pending', hash, reason: 'invalid_response' };
  }
  return result.value.successful
    ? { outcome: 'confirmed', hash, ledger: result.value.ledger }
    : { outcome: 'rejected', hash, ledger: result.value.ledger };
}
