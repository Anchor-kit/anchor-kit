import type { PaymentRailOperation, PaymentRailStatus } from '@/types/transaction.ts';
import { validatePaystackReference } from './paystack-inputs.ts';

/** Look up a test-mode transaction. Callers must compare its amount with their expected operation. */
export async function getPaystackTestStatus(
  input: { operationId: string; reference: string },
  options: { secretKey: string; fetch?: (url: string, init: RequestInit) => Promise<Response> },
): Promise<PaymentRailOperation> {
  if (!options.secretKey.startsWith('sk_test_') || options.secretKey.length <= 8) {
    throw new Error('A Paystack test secret key is required');
  }
  if (!input.operationId || !validatePaystackReference(input.reference)) {
    throw new Error('A valid operation ID and Paystack reference are required');
  }
  const response = await (options.fetch ?? fetch)(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(input.reference)}`,
    { headers: { Authorization: `Bearer ${options.secretKey}` }, redirect: 'error' },
  );
  if (!response.ok) throw new Error('Paystack transaction lookup failed');
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('status' in payload) ||
    payload.status !== true ||
    !('data' in payload) ||
    !payload.data ||
    typeof payload.data !== 'object'
  ) {
    throw new Error('Invalid Paystack transaction response');
  }
  const data = payload.data;
  if (
    !('domain' in data) ||
    data.domain !== 'test' ||
    !('reference' in data) ||
    data.reference !== input.reference ||
    !('amount' in data) ||
    typeof data.amount !== 'number' ||
    !Number.isSafeInteger(data.amount) ||
    data.amount <= 0 ||
    !('currency' in data) ||
    typeof data.currency !== 'string' ||
    !['GHS', 'KES', 'NGN', 'USD', 'XOF', 'ZAR'].includes(data.currency) ||
    !('status' in data) ||
    typeof data.status !== 'string'
  ) {
    throw new Error('Invalid Paystack transaction data');
  }
  const status: PaymentRailStatus =
    data.status === 'success'
      ? 'succeeded'
      : data.status === 'failed' || data.status === 'abandoned'
        ? 'failed'
        : data.status === 'pending' ||
            data.status === 'ongoing' ||
            data.status === 'processing' ||
            data.status === 'queued'
          ? 'pending'
          : 'unknown';
  return {
    operationId: input.operationId,
    provider: 'paystack',
    reference: input.reference,
    amount: {
      amount:
        data.currency === 'XOF'
          ? String(Math.floor(data.amount / 100))
          : `${Math.floor(data.amount / 100)}.${String(data.amount % 100).padStart(2, '0')}`,
      currency: data.currency,
    },
    status,
  };
}
