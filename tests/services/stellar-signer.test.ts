import { describe, expect, it } from 'vitest';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import { CryptoError } from '@/core/errors.ts';
import { StellarUtils } from '@/utils/stellar.ts';
import { LocalKeypairSigner, type StellarTransactionSigner } from '@/index.ts';

describe('LocalKeypairSigner', () => {
  it('signs an unsigned testnet transaction with a verifiable signature', async () => {
    const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
    const unsignedXdr = await StellarUtils.buildPaymentXdr({
      source: keypair.publicKey(),
      destination: keypair.publicKey(),
      amount: '1',
      assetCode: 'XLM',
      network: 'testnet',
    });
    const transaction = new Transaction(unsignedXdr, Networks.TESTNET);
    const signer: StellarTransactionSigner = new LocalKeypairSigner(keypair.secret());

    const signedXdr = await signer.signTransaction(transaction.toXDR(), Networks.TESTNET);
    const signedTransaction = new Transaction(signedXdr, Networks.TESTNET);
    const signature = signedTransaction.signatures[0];

    expect(signedTransaction.signatures).toHaveLength(1);
    expect(signature).toBeDefined();
    expect(keypair.verify(signedTransaction.hash(), signature!.signature())).toBe(true);
  });

  it('rejects invalid seeds without including them in the error', () => {
    const invalidSeed = 'this-is-not-a-stellar-secret-seed';

    try {
      new LocalKeypairSigner(invalidSeed);
      throw new Error('Expected invalid seed to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as Error).message).not.toContain(invalidSeed);
    }
  });

  it('requires a network passphrase', async () => {
    const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
    const signer = new LocalKeypairSigner(keypair.secret());

    await expect(signer.signTransaction('not-used', '')).rejects.toBeInstanceOf(CryptoError);
  });
});
