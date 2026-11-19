import { CryptoError } from '@/core/errors.ts';
import { Keypair, StrKey, Transaction } from '@stellar/stellar-sdk';

export interface StellarTransactionSigner {
  signTransaction(transactionXdr: string, networkPassphrase: string): Promise<string>;
}

export interface StellarAccountSigner {
  readonly key: string;
  readonly weight: number;
}

export interface StellarAccountThresholds {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}

export interface StellarAccountRecord {
  readonly accountId: string;
  readonly signers: readonly StellarAccountSigner[];
  readonly thresholds: StellarAccountThresholds;
}

export type StellarAccountLookupResult =
  | { readonly status: 'found'; readonly account: StellarAccountRecord }
  | { readonly status: 'not_found'; readonly accountId: string }
  | { readonly status: 'upstream_error'; readonly accountId: string; readonly message: string };

export interface StellarAccountLookup {
  lookupAccount(accountId: string): Promise<StellarAccountLookupResult>;
}

export class LocalKeypairSigner implements StellarTransactionSigner {
  readonly #keypair: Keypair;

  constructor(secretSeed: string) {
    if (typeof secretSeed !== 'string' || !StrKey.isValidEd25519SecretSeed(secretSeed)) {
      throw new CryptoError('Invalid Stellar signing secret seed.');
    }

    this.#keypair = Keypair.fromSecret(secretSeed);
  }

  public async signTransaction(transactionXdr: string, networkPassphrase: string): Promise<string> {
    if (typeof networkPassphrase !== 'string' || networkPassphrase.trim().length === 0) {
      throw new CryptoError('A Stellar network passphrase is required to sign a transaction.');
    }

    const transaction = new Transaction(transactionXdr, networkPassphrase);
    transaction.sign(this.#keypair);
    return transaction.toXDR();
  }
}
