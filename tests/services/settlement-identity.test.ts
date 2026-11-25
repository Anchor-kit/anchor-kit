import { describe, expect, it } from 'vitest';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import { signedSettlementHash, StellarUtils } from '@/index.ts';

describe('signedSettlementHash', () => {
  it('returns the same network-specific hash when a signed envelope is reloaded', async () => {
    const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
    const unsigned = await StellarUtils.buildPaymentXdr({
      source: keypair.publicKey(),
      destination: keypair.publicKey(),
      amount: '1',
      assetCode: 'XLM',
    });
    const transaction = new Transaction(unsigned, Networks.TESTNET);
    transaction.sign(keypair);
    const envelope = transaction.toXDR();
    expect(signedSettlementHash(envelope, Networks.TESTNET)).toBe(
      transaction.hash().toString('hex'),
    );
    const reloaded = new Transaction(envelope, Networks.TESTNET).toXDR();
    expect(signedSettlementHash(reloaded, Networks.TESTNET)).toBe(
      transaction.hash().toString('hex'),
    );
    expect(signedSettlementHash(envelope, Networks.PUBLIC)).not.toBe(
      signedSettlementHash(envelope, Networks.TESTNET),
    );
  });

  it('rejects unsigned and malformed envelopes without exposing their contents', async () => {
    const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
    const unsigned = await StellarUtils.buildPaymentXdr({
      source: keypair.publicKey(),
      destination: keypair.publicKey(),
      amount: '1',
      assetCode: 'XLM',
    });
    expect(() => signedSettlementHash(unsigned, Networks.TESTNET)).toThrow(
      'A valid signed transaction envelope is required',
    );
    const malformed = 'sensitive-invalid-envelope';
    expect(() => signedSettlementHash(malformed, Networks.TESTNET)).toThrow(
      'A valid signed transaction envelope is required',
    );
    try {
      signedSettlementHash(malformed, Networks.TESTNET);
      throw new Error('Expected rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain(malformed);
    }
    expect(() => signedSettlementHash(unsigned, '')).toThrow('A network passphrase is required');
  });
});
