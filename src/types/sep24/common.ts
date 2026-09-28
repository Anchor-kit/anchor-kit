/**
 * Common types for SEP-24 transactions
 * Based on Stellar SEP-24 specification
 * @see https://developers.stellar.org/docs/learn/fundamentals/stellar-ecosystem-proposals/sep-0024
 */

import type { TransactionStatus } from '../transaction-status.ts';

/**
 * Base transaction response type
 * Defines the common structure for all SEP-24 transactions
 */
export interface BaseTransactionResponse {
  /** Unique transaction identifier */
  id: string;

  /** Current status of the transaction */
  status: TransactionStatus;

  /** A URL the user can visit to see more information about a transaction */
  more_info_url?: string;

  /** Amount being transferred */
  amount_in?: {
    amount: string;
    asset: string;
  };

  /** Amount to be transferred */
  amount_out?: {
    amount: string;
    asset: string;
  };

  /** Amount charged as fees */
  amount_fee?: {
    amount: string;
    asset: string;
  };

  /** Unix timestamp when transaction was started */
  started_at?: number;

  /** Unix timestamp when transaction was completed */
  completed_at?: number;

  /** ISO 8601 timestamp when transaction record was created */
  created_at?: string;

  /** ISO 8601 timestamp when transaction record was last updated */
  updated_at?: string;

  /** Additional transaction data */
  message?: string;

  /** Refund details if transaction failed */
  refunds?: {
    amount_refunded: {
      amount: string;
      asset: string;
    };
    amount_fee: {
      amount: string;
      asset: string;
    };
    payments: Array<{
      id: string;
      id_type: string;
      amount: {
        amount: string;
        asset: string;
      };
      fee: {
        amount: string;
        asset: string;
      };
    }>;
  };
}

/**
 * TransactionNotFoundError represents the response when a transaction is not found
 *
 * This type is used in the Sep24TransactionResponse union to handle cases where
 * a requested transaction does not exist.
 *
 * @example
 * ```typescript
 * const response: Sep24TransactionResponse = getTransaction(id);
 * if (response.type === 'not_found') {
 *   console.log('Transaction not found:', response.error);
 * }
 * ```
 */
export interface TransactionNotFoundError {
  /** Discriminator field indicating this is a not found error response */
  type: 'not_found';
  /** Error message describing the not found error */
  error: string;
}

/**
 * Type guard to narrow a generic Sep24TransactionResponse to TransactionNotFoundError
 *
 * @param response - Response to check
 * @returns True if the response is a transaction not found error
 *
 * @example
 * ```typescript
 * const response = await getTransaction(id);
 * if (isTransactionNotFoundError(response)) {
 *   console.log('Error:', response.error);
 * }
 * ```
 */
export function isTransactionNotFoundError(
  response: unknown,
): response is TransactionNotFoundError {
  return (
    typeof response === 'object' &&
    response !== null &&
    'type' in response &&
    response.type === 'not_found' &&
    'error' in response &&
    typeof (response as Record<string, unknown>).error === 'string'
  );
}
