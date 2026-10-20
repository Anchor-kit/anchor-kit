import {
  getAllowedNextTransactionStatuses,
  isPendingTransactionStatus,
  isTerminalTransactionStatus,
  TRANSACTION_STATUSES,
  type PendingTransactionStatus,
  type TerminalTransactionStatus,
  type TransactionStatus,
} from '@/types/index.ts';

describe('TransactionStatus', () => {
  // -- runtime checks on the status array --

  it('covers every SEP-24 lifecycle status', () => {
    const expected = [
      'completed',
      'error',
      'expired',
      'incomplete',
      'no_market',
      'pending_anchor',
      'pending_external',
      'pending_stellar',
      'pending_trust',
      'pending_user',
      'pending_user_transfer_complete',
      'pending_user_transfer_start',
      'refunded',
      'too_large',
      'too_small',
    ];

    expect([...TRANSACTION_STATUSES].sort()).toEqual(expected);
  });

  it('contains no duplicates', () => {
    const unique = new Set(TRANSACTION_STATUSES);
    expect(unique.size).toBe(TRANSACTION_STATUSES.length);
  });

  it('returns the expected result for every valid status', () => {
    const terminalStatuses = new Set<TransactionStatus>([
      'completed',
      'refunded',
      'expired',
      'error',
      'no_market',
      'too_small',
      'too_large',
    ]);

    for (const status of TRANSACTION_STATUSES) {
      expect(isTerminalTransactionStatus(status)).toBe(terminalStatuses.has(status));
    }
  });

  it('acts as a type guard for terminal statuses', () => {
    const terminalStatuses = TRANSACTION_STATUSES.filter(isTerminalTransactionStatus);

    const narrowed: TerminalTransactionStatus[] = terminalStatuses;

    expect(narrowed).toEqual([
      'completed',
      'refunded',
      'expired',
      'error',
      'no_market',
      'too_small',
      'too_large',
    ] satisfies TerminalTransactionStatus[]);
  });

  it('returns true for every pending or in-progress status', () => {
    const pendingStatuses: TransactionStatus[] = [
      'pending_anchor',
      'pending_user_transfer_start',
      'pending_user_transfer_complete',
      'pending_external',
      'pending_trust',
      'pending_user',
      'pending_stellar',
    ];

    expect(pendingStatuses.every((status) => isPendingTransactionStatus(status))).toBe(true);
  });

  it('returns false for every non-pending status', () => {
    const nonPendingStatuses: TransactionStatus[] = [
      'incomplete',
      'completed',
      'refunded',
      'expired',
      'error',
      'no_market',
      'too_small',
      'too_large',
    ];

    expect(nonPendingStatuses.every((status) => !isPendingTransactionStatus(status))).toBe(true);
  });

  it('narrows to PendingTransactionStatus when the helper returns true', () => {
    const status: TransactionStatus = 'pending_anchor';

    if (isPendingTransactionStatus(status)) {
      const narrowed: PendingTransactionStatus = status;
      expect(narrowed).toBe('pending_anchor');
      return;
    }

    throw new Error('expected status to narrow to PendingTransactionStatus');
  });

  it('exposes the allowed first-deposit lifecycle transitions', () => {
    expect(getAllowedNextTransactionStatuses('incomplete')).toEqual([
      'pending_user',
      'pending_anchor',
      'pending_user_transfer_start',
      'error',
      'expired',
    ]);
    expect(getAllowedNextTransactionStatuses('pending_anchor')).toContain(
      'pending_user_transfer_start',
    );
    expect(getAllowedNextTransactionStatuses('pending_user')).toContain('pending_anchor');
    expect(getAllowedNextTransactionStatuses('pending_external')).toEqual([
      'pending_stellar',
      'error',
      'expired',
    ]);
    expect(getAllowedNextTransactionStatuses('pending_stellar')).toContain('completed');
    expect(getAllowedNextTransactionStatuses('pending_stellar')).toContain('pending_trust');
    expect(getAllowedNextTransactionStatuses('pending_trust')).toContain('pending_stellar');
  });

  it('rejects regressions and transitions out of terminal statuses', () => {
    expect(getAllowedNextTransactionStatuses('pending_stellar')).not.toContain('pending_external');
    expect(getAllowedNextTransactionStatuses('completed')).toEqual([]);
    expect(getAllowedNextTransactionStatuses('expired')).toEqual([]);
  });

  it('exposes allowed next statuses as a checked union', () => {
    const allowed: readonly TransactionStatus[] =
      getAllowedNextTransactionStatuses('pending_stellar');
    expect(allowed).toContain('completed');
  });

  // -- compile-time checks (tsc catches these before tests even run) --

  it('accepts every valid status', () => {
    const all: TransactionStatus[] = [
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
    ];

    expect(all).toBeDefined();
  });

  it('rejects invalid strings at compile time', () => {
    // @ts-expect-error — not a real status
    const x: TransactionStatus = 'invalid';

    // @ts-expect-error — wrong casing
    const y: TransactionStatus = 'COMPLETED';

    // @ts-expect-error — partial match doesn't count
    const z: TransactionStatus = 'pending';

    expect(x).toBeDefined();
    expect(y).toBeDefined();
    expect(z).toBeDefined();
  });
});
