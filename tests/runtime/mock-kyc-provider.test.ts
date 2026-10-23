import { describe, expect, it } from 'vitest';
import { MockKycVerificationProvider } from '../../src/runtime/kyc/mock-provider.ts';

const kycData = { status: 'pending' as const, first_name: 'Ada' };

describe('MockKycVerificationProvider', () => {
  it('records customer, operation key, timestamp, and configured outcome', async () => {
    const provider = new MockKycVerificationProvider({
      outcomes: { 'customer-1': 'approved' },
      now: () => new Date('2026-10-21T10:00:00.000Z'),
    });

    await expect(
      provider.verify({ customerId: 'customer-1', operationKey: 'verify-1', data: kycData }),
    ).resolves.toEqual({
      decisionId: 'mock-kyc-1',
      operationKey: 'verify-1',
      customerId: 'customer-1',
      status: 'approved',
      decidedAt: '2026-10-21T10:00:00.000Z',
    });
  });

  it('reuses a decision for duplicate customer and operation key requests', async () => {
    let calls = 0;
    const provider = new MockKycVerificationProvider({
      outcomes: { 'customer-1': 'rejected' },
      now: () => {
        calls += 1;
        return new Date('2026-10-21T10:00:00.000Z');
      },
    });
    const input = { customerId: 'customer-1', operationKey: 'verify-1', data: kycData };

    const first = await provider.verify(input);
    const duplicate = await provider.verify(input);

    expect(duplicate).toBe(first);
    expect(calls).toBe(1);
  });

  it('supports pending as the default and independent decisions for each outcome', async () => {
    const provider = new MockKycVerificationProvider({
      outcomes: { approved: 'approved', rejected: 'rejected' },
      now: () => new Date('2026-10-21T10:00:00.000Z'),
    });

    const pending = await provider.verify({
      customerId: 'pending',
      operationKey: 'pending-1',
      data: kycData,
    });
    const approved = await provider.verify({
      customerId: 'approved',
      operationKey: 'approved-1',
      data: kycData,
    });
    const rejected = await provider.verify({
      customerId: 'rejected',
      operationKey: 'rejected-1',
      data: kycData,
    });

    expect([pending.status, approved.status, rejected.status]).toEqual([
      'pending',
      'approved',
      'rejected',
    ]);
  });
});
