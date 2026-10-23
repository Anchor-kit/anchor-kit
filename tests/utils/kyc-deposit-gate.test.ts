import { describe, expect, it } from 'vitest';
import { evaluateKycDepositGate } from '@/utils/kyc-deposit-gate.ts';

describe('evaluateKycDepositGate', () => {
  it.each(['missing', 'pending', 'rejected'] as const)('blocks %s requirements', (decision) => {
    expect(evaluateKycDepositGate([decision])).toEqual({ allowed: false, decision });
  });

  it('allows approved and explicitly exempt requirements', () => {
    expect(evaluateKycDepositGate(['approved', 'exempt'])).toEqual({ allowed: true });
  });

  it('blocks when any configured requirement is unresolved', () => {
    expect(evaluateKycDepositGate(['approved', 'pending'])).toEqual({
      allowed: false,
      decision: 'pending',
    });
  });
});
