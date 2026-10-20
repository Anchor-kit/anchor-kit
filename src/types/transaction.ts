/**
 * Unified Transaction interface
 * Combines core SEP-24 transaction fields with optional rail/stellar/interactive/error fields
 * Based on Stellar Anchor Platform unified specification
 *
 * @see https://developers.stellar.org/docs/build/apps/anchor-platform
 */

import type { TransactionStatus } from './transaction-status.ts';

export type TransactionKind = 'deposit' | 'withdrawal';

/**
 * Represents a monetary amount with currency/asset information
 * Uses string for decimal precision (common pattern for financial data)
 */
export interface Amount {
  /** Amount value as a string for decimal precision */
  amount: string;
  /** Asset code (e.g., 'USDC', 'BRL') or currency code (e.g., 'USD', 'NGN') */
  asset: string;
}

/**
 * Rail-specific transaction data
 * Represents the fiat/USSD payment rail side of the transaction
 */
export interface RailTransactionData {
  /** Payment provider identifier (e.g., 'flutterwave', 'paystack', 'momo') */
  provider: string;
  /** Reference ID from the payment rail (e.g., Flutterwave tx_ref) */
  reference: string;
  /** Status from the payment rail can differ from Stellar status */
  status?: string;
  /** Additional metadata from the rail provider */
  metadata?: Record<string, unknown>;
}

/**
 * Stellar-specific transaction data
 * Represents the blockchain side of the transaction
 */
export interface StellarTransactionData {
  /** Stellar transaction hash */
  transaction_id?: string;
  /** Memo used to link Stellar payment to this transaction */
  memo?: string;
  /** Memo type: 'text', 'id', 'hash', or 'return' */
  memo_type?: 'text' | 'id' | 'hash' | 'return';
  /** Receiving or sending account public key */
  account_id?: string;
}

/**
 * Interactive flow exchange request details
 * Used for hosting interactive deposit/withdrawal flows
 */
export interface InteractiveData {
  /** URL where the user should be directed to complete the interactive flow */
  url?: string;
  /** Form fields required from the user (KYC, payment details, etc.) */
  required_fields?: string[];
  /** Current form state or step in the interactive flow */
  form_fields?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Error details for failed transactions
 */
export interface TransactionError {
  /** Error code for programmatic handling */
  code?: string;
  /** Human-readable error message */
  message?: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

/**
 * Refund information if transaction was refunded
 */
export interface RefundInfo {
  /** Total amount refunded */
  amount_refunded?: Amount;
  /** Fee charged for the refund */
  amount_fee?: Amount;
  /** Individual refund payments if applicable */
  payments?: Array<{
    id: string;
    id_type: string;
    amount: Amount;
    fee: Amount;
  }>;
}

/**
 * Unified Transaction interface
 * Represents a complete transaction with core, rail, stellar, interactive, and error fields
 *
 * The Transaction interface is designed to support the complete lifecycle of a transaction,
 * from initial request through completion across multiple systems (fiat rail + Stellar blockchain).
 *
 * @example
 * ```typescript
 * const deposit: Transaction = {
 *   id: 'txn-123',
 *   status: 'pending_user_transfer_start',
 *   kind: 'deposit',
 *   amount_in: { amount: '5000', asset: 'NGN' },
 *   amount_out: { amount: '25.50', asset: 'USDC' },
 *   started_at: Date.now(),
 *   // Rail data
 *   rail: {
 *     provider: 'flutterwave',
 *     reference: 'FLW-txn-xyz',
 *     status: 'pending'
 *   },
 *   // Stellar data
 *   stellar: {
 *     account_id: 'GXYZ...'
 *   },
 *   // Interactive flow
 *   interactive: {
 *     url: 'https://anchor.example.com/deposit/abc123'
 *   }
 * };
 * ```
 */
export interface Transaction {
  // ============================================
  // Core Transaction Fields
  // ============================================

  /** Unique transaction identifier */
  id: string;

  /** Current status of the transaction */
  status: TransactionStatus;

  /** Transaction type: 'deposit' (fiat->crypto) or 'withdrawal' (crypto->fiat) */
  kind: TransactionKind;

  // ============================================
  // Amount Fields (using Decimal string representation)
  // ============================================

  /** Amount received or to be received (fiat for deposits, crypto for withdrawals) */
  amount_in?: Amount;

  /** Amount sent or to be sent (crypto for deposits, fiat for withdrawals) */
  amount_out?: Amount;

  /** Transaction fee amount */
  amount_fee?: Amount;

  // ============================================
  // Reference & Information Fields
  // ============================================

  /** URL for more information about this transaction */
  more_info_url?: string;

  /** Human-readable message or status update */
  message?: string;

  // ============================================
  // ============================================
  // Timestamp Fields
  // ============================================

  /** Unix timestamp (in milliseconds) when transaction was initiated */
  started_at?: number;

  /** Unix timestamp (in milliseconds) when transaction completed */
  completed_at?: number;

  /** ISO 8601 timestamp when transaction record was created */
  created_at?: string;

  /** ISO 8601 timestamp when transaction record was last updated */
  updated_at?: string;

  // ============================================
  // Optional Rail-Specific Fields
  // ============================================

  /** Payment rail information (Flutterwave, Paystack, mobile money, etc.) */
  rail?: RailTransactionData;

  // ============================================
  // Optional Stellar-Specific Fields
  // ============================================

  /** Stellar blockchain transaction details */
  stellar?: StellarTransactionData;

  // ============================================
  // Optional Interactive Flow Fields
  // ============================================

  /** Interactive flow details (for hosted deposit/withdrawal) */
  interactive?: InteractiveData;

  // ============================================
  // Optional Error & Refund Fields
  // ============================================

  /** Error information if transaction failed */
  error?: TransactionError;

  /** Refund details if transaction was refunded */
  refunds?: RefundInfo;
}
