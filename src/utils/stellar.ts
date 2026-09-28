import {
  Account,
  Memo as StellarMemo,
  TransactionBuilder,
  Asset,
  MuxedAccount,
  Networks,
  Operation,
  StrKey,
  Transaction,
} from '@stellar/stellar-sdk';
import { ValidationUtils } from './validation';

/**
 * Stellar memo types
 */
export type Memo = {
  value: string;
  type: 'text' | 'id' | 'hash' | 'return';
};

/**
 * Parsed transaction structure
 */
export interface ParsedTransaction {
  source: string;
  sequence: string;
  fee: string;
  memo?: Memo;
  operations: unknown[];
}

/**
 * Parameters for building a payment transaction
 */
export interface PaymentParams {
  source: string;
  destination: string;
  amount: string;
  assetCode: string;
  issuer?: string;
  memo?: Memo;
  network?: 'testnet' | 'public' | 'futurenet' | string;
}

/**
 * StellarUtils helper object providing reusable utilities for common Stellar tasks.
 */
export const StellarUtils = {
  /**
   * Generates a Stellar memo based on the transaction ID.
   *
   * @param transactionId - The internal transaction ID to use as the memo value
   * @param type - The memo type ('hash' or 'text')
   * @returns A Memo object
   */
  generateMemo(transactionId: string, type: 'hash' | 'text' = 'hash'): Memo {
    if (type === 'hash') {
      // For hash memo, we expect a 32-byte value. If transactionId is a UUID,
      // it's 16 bytes. We keep it as is, the SDK handles string/buffer.
      return {
        value: transactionId,
        type: 'hash',
      };
    }
    // Text memos are limited to 28 UTF-8 bytes, not JavaScript UTF-16 code units.
    return {
      value: truncateUtf8(transactionId, 28),
      type: 'text',
    };
  },

  /**
   * Parses a Base64-encoded XDR transaction.
   *
   * @param xdr - Base64-encoded Stellar transaction XDR
   * @returns ParsedTransaction object with key details
   */
  parseXdrTransaction(xdr: string): ParsedTransaction {
    try {
      // We don't know the network here, but for parsing core fields it might not matter
      // unless we're verifying signatures. Defaulting to Testnet for parsing.
      const tx = new Transaction(xdr, Networks.TESTNET);

      let memo: Memo | undefined;
      if (tx.memo && tx.memo.type !== 'none') {
        memo = {
          value: tx.memo.value ? tx.memo.value.toString() : '',
          type: tx.memo.type as 'text' | 'id' | 'hash' | 'return',
        };
      }

      return {
        source: tx.source,
        sequence: tx.sequence,
        fee: tx.fee.toString(),
        memo,
        operations: tx.operations,
      };
    } catch (error) {
      throw new Error(`Failed to parse XDR transaction: ${(error as Error).message}`, {
        cause: error,
      });
    }
  },

  /**
   * Builds a payment transaction XDR.
   *
   * @param params - Payment parameters
   * @returns Base64-encoded transaction XDR
   */
  async buildPaymentXdr(params: PaymentParams): Promise<string> {
    const { source, destination, amount, assetCode, issuer, memo, network } = params;
    const normalizedAssetCode = assetCode.trim().toUpperCase();

    if (!isPositiveFiniteDecimal(amount)) {
      throw new Error('amount must be a positive finite decimal string');
    }

    if (!isValidPaymentAccountAddress(source)) {
      throw new Error('source must be a valid Stellar public or muxed public key');
    }

    if (!isValidPaymentAccountAddress(destination)) {
      throw new Error('destination must be a valid Stellar public or muxed public key');
    }

    const networkPassphrase =
      network === undefined || network === 'testnet'
        ? Networks.TESTNET
        : network === 'public'
          ? Networks.PUBLIC
          : network === 'futurenet'
            ? Networks.FUTURENET
            : (() => {
                throw new Error(
                  'Unsupported network: ' +
                    network +
                    '. Must be one of: public, testnet, futurenet',
                );
              })();

    if (
      normalizedAssetCode !== 'XLM' &&
      (!issuer || !ValidationUtils.isValidStellarAddress(issuer))
    ) {
      throw new Error(
        'A valid issuer is required for non-native asset payments: ' + normalizedAssetCode,
      );
    }

    const asset =
      normalizedAssetCode === 'XLM' ? Asset.native() : new Asset(normalizedAssetCode, issuer);

    // We use a dummy sequence number because the actual submission will be handled later
    // or by a signer that manages sequence numbers.
    const sourceAccount = StrKey.isValidMed25519PublicKey(source)
      ? MuxedAccount.fromAddress(source, '0')
      : new Account(source, '0');

    const builder = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination,
          asset,
          amount,
        }),
      )
      .setTimeout(0); // Added .setTimeout(0)

    if (memo) {
      let stellarMemo: StellarMemo;
      switch (memo.type) {
        case 'text':
          stellarMemo = StellarMemo.text(memo.value);
          break;
        case 'id':
          stellarMemo = StellarMemo.id(memo.value);
          break;
        case 'hash':
          validateBinaryMemoValue(memo.value, memo.type);
          stellarMemo = StellarMemo.hash(memo.value);
          break;
        case 'return':
          validateBinaryMemoValue(memo.value, memo.type);
          stellarMemo = StellarMemo.return(memo.value);
          break;
        default:
          throw new Error(`Unsupported memo type: ${memo.type}`);
      }
      builder.addMemo(stellarMemo);
    }

    return builder.build().toXDR();
  },

  /**
   * Validates a Stellar account ID (starting with 'G').
   *
   * @param accountId - The public key to validate
   * @returns true if valid, false otherwise
   */
  validateAccountId(accountId: string): boolean {
    return ValidationUtils.isValidStellarAddress(accountId);
  },
};

function isValidPaymentAccountAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidMed25519PublicKey(address);
}

function isPositiveFiniteDecimal(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
}

function validateBinaryMemoValue(value: string, type: 'hash' | 'return'): void {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(type + ' memo must be exactly 32 bytes encoded as 64 hexadecimal characters');
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let byteLength = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > maxBytes) break;
    result += character;
    byteLength += characterBytes;
  }

  return result;
}
