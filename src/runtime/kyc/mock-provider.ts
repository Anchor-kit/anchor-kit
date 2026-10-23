import type { KycData, KycVerificationDecision, KycStatus } from '@/types/foundation.ts';
import type { KycVerificationProvider } from '@/runtime/interfaces.ts';

export type KycDecisionStatus = Exclude<KycStatus, 'not_provided'>;

export interface MockKycVerificationProviderOptions {
  outcomes?: Readonly<Record<string, KycDecisionStatus>>;
  now?: () => Date;
}

/** Deterministic KYC provider for tests and local development. */
export class MockKycVerificationProvider implements KycVerificationProvider {
  private readonly decisions = new Map<string, KycVerificationDecision>();
  private readonly outcomes: Readonly<Record<string, KycDecisionStatus>>;
  private readonly now: () => Date;

  constructor(options: MockKycVerificationProviderOptions = {}) {
    this.outcomes = options.outcomes ?? {};
    this.now = options.now ?? (() => new Date());
  }

  async verify(input: {
    customerId: string;
    operationKey: string;
    data: KycData;
  }): Promise<KycVerificationDecision> {
    const cacheKey = JSON.stringify([input.customerId, input.operationKey]);
    const existing = this.decisions.get(cacheKey);
    if (existing) return existing;

    const decision: KycVerificationDecision = {
      decisionId: `mock-kyc-${this.decisions.size + 1}`,
      operationKey: input.operationKey,
      customerId: input.customerId,
      status: this.outcomes[input.customerId] ?? 'pending',
      decidedAt: this.now().toISOString(),
    };
    this.decisions.set(cacheKey, decision);
    return decision;
  }
}
