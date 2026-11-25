import { describe, expect, it, vi } from 'vitest';
import { emitTransactionTrace } from '@/index.ts';

describe('emitTransactionTrace', () => {
  it('forwards correlation fields and drops unrelated payload or secrets', () => {
    const sink = vi.fn();
    const input = {
      transactionId: 'tx-1',
      operationKey: 'rail:1',
      event: 'duplicate' as const,
      attemptCount: 2,
      railReference: 'ref-1',
      payload: { kyc: 'private' },
      secret: 'sensitive',
    };
    emitTransactionTrace(sink, input);
    expect(sink).toHaveBeenCalledWith({
      transactionId: 'tx-1',
      operationKey: 'rail:1',
      event: 'duplicate',
      attemptCount: 2,
      railReference: 'ref-1',
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain('private');
    expect(JSON.stringify(sink.mock.calls)).not.toContain('sensitive');
  });

  it('rejects malformed hashes and attempts before calling the sink', () => {
    const sink = vi.fn();
    expect(() =>
      emitTransactionTrace(sink, {
        transactionId: 'tx',
        operationKey: 'op',
        event: 'failed',
        attemptCount: -1,
      }),
    ).toThrow();
    expect(() =>
      emitTransactionTrace(sink, {
        transactionId: 'tx',
        operationKey: 'op',
        event: 'confirmed',
        confirmedHash: 'bad',
      }),
    ).toThrow();
    expect(sink).not.toHaveBeenCalled();
  });
});
