import { describe, expect, it } from 'vitest';
import { interactiveSessionState, type InteractiveTransactionRecord } from '@/index.ts';

describe('interactiveSessionState', () => {
  const transaction: InteractiveTransactionRecord = {
    id: 'tx-1',
    account: 'account-1',
    kind: 'deposit',
    assetCode: 'USDC',
    amount: '10',
    status: 'pending_user',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const claims = { account: 'account-1', transactionId: 'tx-1', actions: ['complete'] };

  it('returns only the transaction status, actions and required fields', () => {
    expect(
      interactiveSessionState({ ...transaction, railReference: 'private-reference' }, claims, [
        'first_name',
      ]),
    ).toEqual({
      transaction_id: 'tx-1',
      status: 'pending_user',
      permitted_actions: ['complete'],
      required_fields: ['first_name'],
    });
  });

  it('rejects claims bound to another account or transaction', () => {
    expect(() => interactiveSessionState(transaction, { ...claims, account: 'other' }, [])).toThrow(
      'Session does not match transaction',
    );
    expect(() =>
      interactiveSessionState(transaction, { ...claims, transactionId: 'other' }, []),
    ).toThrow('Session does not match transaction');
  });
});
