import { describe, it, expect } from 'vitest';
import { Account, Keypair, MuxedAccount, Transaction, Networks } from '@stellar/stellar-sdk';
import { StellarUtils } from '@/utils/stellar.ts';

interface ParsedPaymentOperation {
  type: string;
  amount: string;
  asset?: {
    isNative(): boolean;
  };
}

function asPaymentOperation(operation: unknown): ParsedPaymentOperation {
  if (!operation || typeof operation !== 'object') {
    throw new Error('Unexpected operation payload');
  }
  return operation as ParsedPaymentOperation;
}

describe('StellarUtils', () => {
  const validAccountId = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const invalidAccountId = 'INVALID_ACCOUNT_ID';

  describe('validateAccountId()', () => {
    it('should return true for valid account IDs', () => {
      expect(StellarUtils.validateAccountId(validAccountId)).toBe(true);
    });

    it('should return false for invalid account IDs', () => {
      expect(StellarUtils.validateAccountId(invalidAccountId)).toBe(false);
      expect(StellarUtils.validateAccountId('SABC...')).toBe(false); // Seed not allowed
      expect(StellarUtils.validateAccountId('')).toBe(false);
    });
  });

  describe('generateMemo()', () => {
    it('should generate a hash memo', () => {
      const txId = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const memo = StellarUtils.generateMemo(txId, 'hash');
      expect(memo.type).toBe('hash');
      expect(memo.value).toBe(txId);
    });

    it('should generate a text memo (truncated to 28 bytes)', () => {
      const txId = 'this_is_a_very_long_transaction_id_that_exceeds_28_bytes';
      const memo = StellarUtils.generateMemo(txId, 'text');
      expect(memo.type).toBe('text');
      expect(Buffer.byteLength(memo.value, 'utf8')).toBeLessThanOrEqual(28);
      expect(memo.value).toBe(txId.substring(0, 28));
    });

    it('should truncate text memos at a UTF-8 byte boundary', () => {
      const memo = StellarUtils.generateMemo('😀'.repeat(10), 'text');

      expect(memo.value).toBe('😀'.repeat(7));
      expect(Buffer.byteLength(memo.value, 'utf8')).toBe(28);
    });

    it('should preserve combining characters without exceeding the byte limit', () => {
      const memo = StellarUtils.generateMemo('e\u0301'.repeat(10), 'text');

      expect(Buffer.byteLength(memo.value, 'utf8')).toBeLessThanOrEqual(28);
      expect(memo.value).not.toMatch(/\uD800|\uDC00/);
    });
  });

  describe('buildPaymentXdr() and parseXdrTransaction()', () => {
    it('should build and then parse back a payment transaction', async () => {
      const params = {
        source: validAccountId,
        destination: validAccountId,
        amount: '100.00',
        assetCode: 'USDC',
        issuer: validAccountId,
        memo: { value: 'test-memo', type: 'text' as const },
        network: 'testnet',
      };

      const xdr = await StellarUtils.buildPaymentXdr(params);
      expect(typeof xdr).toBe('string');
      expect(xdr.length).toBeGreaterThan(0);

      const parsed = StellarUtils.parseXdrTransaction(xdr);
      expect(parsed.source).toBe(params.source);
      expect(parsed.memo?.value).toBe(params.memo.value);
      expect(parsed.memo?.type).toBe(params.memo.type);
      expect(parsed.operations.length).toBe(1);
      const operation = asPaymentOperation(parsed.operations[0]);
      expect(operation.type).toBe('payment');
      // Stellar internal amounts are typically formatted to 7 decimal places
      expect(parseFloat(operation.amount)).toBe(parseFloat(params.amount));
    });

    it('should build a native XLM payment', async () => {
      const params = {
        source: validAccountId,
        destination: validAccountId,
        amount: '1.5',
        assetCode: 'XLM',
        network: 'testnet',
      };

      const xdr = await StellarUtils.buildPaymentXdr(params);
      const parsed = StellarUtils.parseXdrTransaction(xdr);
      const operation = asPaymentOperation(parsed.operations[0]);
      expect(operation.asset?.isNative()).toBe(true);
      expect(parseFloat(operation.amount)).toBe(parseFloat(params.amount));
    });

    it.each(['0', '-1', '1e3', 'not-a-number', '9'.repeat(400)])(
      'should reject invalid payment amount %s',
      async (amount) => {
        await expect(
          StellarUtils.buildPaymentXdr({
            source: validAccountId,
            destination: validAccountId,
            amount,
            assetCode: 'XLM',
            network: 'testnet',
          }),
        ).rejects.toThrow('amount must be a positive finite decimal string');
      },
    );

    it('should preserve a valid positive decimal amount', async () => {
      await expect(
        StellarUtils.buildPaymentXdr({
          source: validAccountId,
          destination: validAccountId,
          amount: '0.000001',
          assetCode: 'XLM',
          network: 'testnet',
        }),
      ).resolves.toBeTypeOf('string');
    });

    it.each(['xlm', 'Xlm', ' XLM '])('should treat %s as the native asset', async (assetCode) => {
      const xdr = await StellarUtils.buildPaymentXdr({
        source: validAccountId,
        destination: validAccountId,
        amount: '1.5',
        assetCode,
        network: 'testnet',
      });

      const operation = asPaymentOperation(StellarUtils.parseXdrTransaction(xdr).operations[0]);
      expect(operation.asset?.isNative()).toBe(true);
    });

    it('should preserve an id memo', async () => {
      const params = {
        source: validAccountId,
        destination: validAccountId,
        amount: '5',
        assetCode: 'USDC',
        issuer: validAccountId,
        memo: { value: '123456', type: 'id' as const },
        network: 'testnet',
      };

      const xdr = await StellarUtils.buildPaymentXdr(params);
      const parsed = StellarUtils.parseXdrTransaction(xdr);
      expect(parsed.memo?.type).toBe('id');
      expect(parsed.memo?.value).toBe(params.memo.value);
    });

    it('should preserve a hash memo', async () => {
      const hashValue = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const params = {
        source: validAccountId,
        destination: validAccountId,
        amount: '5',
        assetCode: 'USDC',
        issuer: validAccountId,
        memo: { value: hashValue, type: 'hash' as const },
        network: 'testnet',
      };

      const xdr = await StellarUtils.buildPaymentXdr(params);
      const tx = new Transaction(xdr, Networks.TESTNET);
      expect(tx.memo.type).toBe('hash');
      const parsedHex = Buffer.from(tx.memo.value as Buffer).toString('hex');
      expect(parsedHex).toBe(hashValue);
    });

    it('should preserve a return memo', async () => {
      // Use a 32-byte (64-hex) value for return memo as required by Stellar SDK
      const returnValue = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
      const params = {
        source: validAccountId,
        destination: validAccountId,
        amount: '5',
        assetCode: 'USDC',
        issuer: validAccountId,
        memo: { value: returnValue, type: 'return' as const },
        network: 'testnet',
      };

      const xdr = await StellarUtils.buildPaymentXdr(params);
      const tx = new Transaction(xdr, Networks.TESTNET);
      expect(tx.memo.type).toBe('return');
      const parsedHex = Buffer.from(tx.memo.value as Buffer).toString('hex');
      expect(parsedHex).toBe(returnValue);
    });

    it.each(['hash', 'return'] as const)(
      'should reject malformed %s memo payloads before building',
      async (type) => {
        await expect(
          StellarUtils.buildPaymentXdr({
            source: validAccountId,
            destination: validAccountId,
            amount: '5',
            assetCode: 'USDC',
            issuer: validAccountId,
            memo: { value: 'not-a-32-byte-hex-value', type },
            network: 'testnet',
          }),
        ).rejects.toThrow(type + ' memo must be exactly 32 bytes');
      },
    );

    it('should fail early for an invalid source public key', async () => {
      await expect(
        StellarUtils.buildPaymentXdr({
          source: invalidAccountId,
          destination: validAccountId,
          amount: '1',
          assetCode: 'XLM',
          network: 'testnet',
        }),
      ).rejects.toThrow('source must be a valid Stellar public or muxed public key');
    });

    it('should fail early for an invalid destination public key', async () => {
      await expect(
        StellarUtils.buildPaymentXdr({
          source: validAccountId,
          destination: invalidAccountId,
          amount: '1',
          assetCode: 'XLM',
          network: 'testnet',
        }),
      ).rejects.toThrow('destination must be a valid Stellar public or muxed public key');
    });

    it('should throw a clear error when a non-native asset issuer is missing', async () => {
      await expect(
        StellarUtils.buildPaymentXdr({
          source: validAccountId,
          destination: validAccountId,
          amount: '1.5',
          assetCode: 'USDC',
          network: 'testnet',
        }),
      ).rejects.toThrow('A valid issuer is required for non-native asset payments: USDC');
    });

    it('should throw a clear error when a non-native asset issuer is invalid', async () => {
      await expect(
        StellarUtils.buildPaymentXdr({
          source: validAccountId,
          destination: validAccountId,
          amount: '1.5',
          assetCode: 'USDC',
          issuer: invalidAccountId,
          network: 'testnet',
        }),
      ).rejects.toThrow('A valid issuer is required for non-native asset payments: USDC');
    });

    it('should fail early for an invalid issuer on non-native assets', async () => {
      await expect(
        StellarUtils.buildPaymentXdr({
          source: validAccountId,
          destination: validAccountId,
          amount: '1',
          assetCode: 'USDC',
          issuer: invalidAccountId,
          network: 'testnet',
        }),
      ).rejects.toThrow('A valid issuer is required for non-native asset payments: USDC');
    });

    it('should accept muxed source and destination accounts', async () => {
      const baseAccount = Keypair.random().publicKey();
      const source = new MuxedAccount(new Account(baseAccount, '0'), '123').accountId();
      const destination = new MuxedAccount(new Account(baseAccount, '0'), '456').accountId();

      const xdr = await StellarUtils.buildPaymentXdr({
        source,
        destination,
        amount: '1',
        assetCode: 'XLM',
        network: 'testnet',
      });

      const parsed = StellarUtils.parseXdrTransaction(xdr);
      expect(parsed.source).toBe(source);
      expect(parsed.operations.length).toBe(1);
    });

    it('should throw when parsing invalid XDR', () => {
      expect(() => StellarUtils.parseXdrTransaction('invalid-xdr')).toThrow(/Failed to parse XDR/);
    });

    it('should build a payment using the public network passphrase', async () => {
      const params = {
        source: validAccountId,
        destination: validAccountId,
        amount: '2.5',
        assetCode: 'XLM',
        network: 'public' as const,
      };

      const xdr = await StellarUtils.buildPaymentXdr(params);
      expect(typeof xdr).toBe('string');

      const tx = new Transaction(xdr, Networks.PUBLIC);
      expect(tx.networkPassphrase).toBe(Networks.PUBLIC);
      expect(tx.source).toBe(params.source);
      expect(tx.operations.length).toBe(1);
    });

    it('should reject unsupported network values instead of falling back to testnet', async () => {
      await expect(
        StellarUtils.buildPaymentXdr({
          source: validAccountId,
          destination: validAccountId,
          amount: '1',
          assetCode: 'XLM',
          network: 'unknown-network',
        }),
      ).rejects.toThrow('Unsupported network: unknown-network');
    });
  });
});
