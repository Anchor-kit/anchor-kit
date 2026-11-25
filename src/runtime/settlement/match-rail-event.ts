import Big from 'big.js';
import type { NormalizedPaymentRailEvent, PaymentRailOperation } from '@/types/transaction.ts';

export type RailMatchResult =
  | { matches: true }
  | {
      matches: false;
      reason:
        | 'unknown_reference'
        | 'identity_mismatch'
        | 'amount_mismatch'
        | 'not_succeeded'
        | 'invalid_data';
    };

/** Compare an already-verified event to an independently stored expected operation. */
export function matchRailEvent(
  operation: PaymentRailOperation | null,
  event: NormalizedPaymentRailEvent,
): RailMatchResult {
  if (!operation) return { matches: false, reason: 'unknown_reference' };
  if (
    !operation.provider ||
    !operation.reference ||
    !event.provider ||
    !event.reference ||
    !event.eventId
  )
    return { matches: false, reason: 'invalid_data' };
  if (
    operation.provider !== event.provider ||
    operation.reference !== event.reference ||
    (operation.providerReference !== undefined &&
      operation.providerReference !== event.providerReference)
  )
    return { matches: false, reason: 'identity_mismatch' };
  if (event.status !== 'succeeded' || operation.status === 'failed')
    return { matches: false, reason: 'not_succeeded' };
  const expected = operation.amount;
  const actual = event.amount;
  if (
    !expected ||
    !actual ||
    !expected.currency ||
    !actual.currency ||
    typeof expected.amount !== 'string' ||
    typeof actual.amount !== 'string' ||
    !/^\d+(?:\.\d+)?$/.test(expected.amount) ||
    !/^\d+(?:\.\d+)?$/.test(actual.amount) ||
    expected.amount.length > 128 ||
    actual.amount.length > 128
  )
    return { matches: false, reason: 'invalid_data' };
  try {
    const expectedValue = new Big(expected.amount);
    const actualValue = new Big(actual.amount);
    if (!expectedValue.gt(0) || !actualValue.gt(0))
      return { matches: false, reason: 'invalid_data' };
    if (expected.currency !== actual.currency || !expectedValue.eq(actualValue))
      return { matches: false, reason: 'amount_mismatch' };
  } catch {
    return { matches: false, reason: 'invalid_data' };
  }
  return { matches: true };
}
