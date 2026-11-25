import { Transaction } from '@stellar/stellar-sdk';

/** Return the network-specific hash of an envelope containing signatures. This does not verify them. */
export function signedSettlementHash(signedXdr: string, networkPassphrase: string): string {
  if (typeof networkPassphrase !== 'string' || networkPassphrase.trim().length === 0) {
    throw new Error('A network passphrase is required');
  }
  try {
    const transaction = new Transaction(signedXdr, networkPassphrase);
    if (transaction.signatures.length === 0) throw new Error('Unsigned transaction');
    return transaction.hash().toString('hex');
  } catch {
    throw new Error('A valid signed transaction envelope is required');
  }
}
