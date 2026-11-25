import { matchRailEvent } from '@/runtime/settlement/match-rail-event.ts';
import type { NormalizedPaymentRailEvent, PaymentRailOperation } from '@/types/transaction.ts';
import { describe, expect, it } from 'vitest';

const operation: PaymentRailOperation = {
  operationId: 'op-1',
  provider: 'rail',
  reference: 'ref-1',
  providerReference: 'provider-ref',
  amount: { amount: '10000000000000000.010', currency: 'USD' },
  status: 'pending',
};
const event: NormalizedPaymentRailEvent = {
  eventId: 'evt-1',
  provider: 'rail',
  reference: 'ref-1',
  providerReference: 'provider-ref',
  amount: { amount: '10000000000000000.01', currency: 'USD' },
  status: 'succeeded',
  occurredAt: '2026-01-01T00:00:00Z',
};

describe('verified rail event matching', () => {
  it('matches equal decimal amounts without floating point rounding', () => {
    expect(matchRailEvent(operation, event)).toEqual({ matches: true });
    expect(matchRailEvent(operation, event)).toEqual({ matches: true });
    expect(
      matchRailEvent(operation, {
        ...event,
        amount: { ...event.amount, amount: '10000000000000000.00' },
      }),
    ).toEqual({ matches: false, reason: 'amount_mismatch' });
  });
  it('rejects unknown, mismatched or contradictory references and currencies', () => {
    expect(matchRailEvent(null, event)).toEqual({ matches: false, reason: 'unknown_reference' });
    expect(matchRailEvent(operation, { ...event, provider: 'other' })).toEqual({
      matches: false,
      reason: 'identity_mismatch',
    });
    expect(matchRailEvent(operation, { ...event, reference: 'other' })).toEqual({
      matches: false,
      reason: 'identity_mismatch',
    });
    expect(matchRailEvent(operation, { ...event, providerReference: 'other' })).toEqual({
      matches: false,
      reason: 'identity_mismatch',
    });
    expect(
      matchRailEvent(operation, { ...event, amount: { ...event.amount, currency: 'EUR' } }),
    ).toEqual({ matches: false, reason: 'amount_mismatch' });
    expect(matchRailEvent({ ...operation, status: 'failed' }, event)).toEqual({
      matches: false,
      reason: 'not_succeeded',
    });
    expect(matchRailEvent(operation, { ...event, status: 'pending' })).toEqual({
      matches: false,
      reason: 'not_succeeded',
    });
  });
  it('rejects malformed, exponent and nonpositive values', () => {
    for (const amount of ['1e2', '-1', '0', 'NaN', '1'.repeat(129)]) {
      expect(matchRailEvent(operation, { ...event, amount: { ...event.amount, amount } })).toEqual({
        matches: false,
        reason: 'invalid_data',
      });
    }
  });
});
