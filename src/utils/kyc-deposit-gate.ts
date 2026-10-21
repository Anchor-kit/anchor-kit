export type KycRequirementDecision = 'missing' | 'pending' | 'approved' | 'rejected' | 'exempt';

export type KycDepositGateResult =
  | { allowed: true }
  | { allowed: false; decision: 'missing' | 'pending' | 'rejected' };

/** Evaluate each configured KYC requirement before a deposit becomes payment-ready. */
export function evaluateKycDepositGate(
  decisions: readonly KycRequirementDecision[],
): KycDepositGateResult {
  for (const decision of decisions) {
    if (decision === 'missing' || decision === 'pending' || decision === 'rejected') {
      return { allowed: false, decision };
    }
  }

  return { allowed: true };
}
