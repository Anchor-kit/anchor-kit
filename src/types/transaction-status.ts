/**
 * Every valid status a SEP-24 transaction can be in.
 *
 * The TransactionStatus type is derived straight from this array,
 * so we only need to maintain the list in one place.
 *
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 */
export const TRANSACTION_STATUSES = [
  'incomplete',
  'pending_anchor',
  'pending_user_transfer_start',
  'pending_user_transfer_complete',
  'pending_external',
  'pending_trust',
  'pending_user',
  'pending_stellar',
  'completed',
  'refunded',
  'expired',
  'error',
  'no_market',
  'too_small',
  'too_large',
] as const;

/** Union of all valid transaction statuses, pulled from the array above. */
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

const TERMINAL_TRANSACTION_STATUSES = [
  'completed',
  'refunded',
  'expired',
  'error',
  'no_market',
  'too_small',
  'too_large',
] as const;

/** Union of transaction statuses that cannot make further progress. */
export type TerminalTransactionStatus = (typeof TERMINAL_TRANSACTION_STATUSES)[number];

/**
 * Runtime guard that validates arbitrary input is a `TransactionStatus`.
 * Uses the canonical `TRANSACTION_STATUSES` array as the single source of truth.
 */
export function isTransactionStatus(value: unknown): value is TransactionStatus {
  return typeof value === 'string' && (TRANSACTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Returns true when a transaction can no longer make progress.
 *
 * Terminal statuses:
 * `completed`, `refunded`, `expired`, `error`, `no_market`, `too_small`, `too_large`
 */
export function isTerminalTransactionStatus(
  status: TransactionStatus,
): status is TerminalTransactionStatus {
  return (TERMINAL_TRANSACTION_STATUSES as readonly TransactionStatus[]).includes(status);
}

const DEPOSIT_TRANSACTION_TRANSITIONS = {
  incomplete: ['pending_user', 'pending_anchor', 'pending_user_transfer_start', 'error', 'expired'],
  pending_user: ['pending_anchor', 'error', 'expired'],
  pending_anchor: ['pending_user', 'pending_user_transfer_start', 'error', 'expired'],
  pending_user_transfer_start: [
    'pending_user_transfer_complete',
    'pending_external',
    'error',
    'expired',
  ],
  pending_user_transfer_complete: ['pending_external', 'pending_stellar', 'error', 'expired'],
  pending_external: ['pending_stellar', 'error', 'expired'],
  pending_stellar: ['pending_trust', 'completed', 'error', 'expired'],
  pending_trust: ['pending_stellar', 'error', 'expired'],
  completed: [],
  refunded: [],
  expired: [],
  error: [],
  no_market: [],
  too_small: [],
  too_large: [],
} as const satisfies Record<TransactionStatus, readonly TransactionStatus[]>;

/**
 * Returns the next statuses supported by the initial deposit lifecycle.
 * Terminal statuses and SEP-24 states outside this deposit slice return no next states.
 */
export function getAllowedNextTransactionStatuses(
  status: TransactionStatus,
): readonly TransactionStatus[] {
  return DEPOSIT_TRANSACTION_TRANSITIONS[status];
}

/** Union of all pending transaction statuses. */
export type PendingTransactionStatus = Extract<TransactionStatus, `pending_${string}`>;

const PENDING_TRANSACTION_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  'pending_anchor',
  'pending_user_transfer_start',
  'pending_user_transfer_complete',
  'pending_external',
  'pending_trust',
  'pending_user',
  'pending_stellar',
]);

/**
 * Returns whether a transaction is still in progress.
 *
 * Pending statuses are:
 * - `pending_anchor`
 * - `pending_user_transfer_start`
 * - `pending_user_transfer_complete`
 * - `pending_external`
 * - `pending_trust`
 * - `pending_user`
 * - `pending_stellar`
 */
export function isPendingTransactionStatus(
  status: TransactionStatus,
): status is PendingTransactionStatus {
  return PENDING_TRANSACTION_STATUSES.has(status);
}
