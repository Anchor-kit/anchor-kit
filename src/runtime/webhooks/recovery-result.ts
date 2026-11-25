import type { PaymentRailOperation } from '@/types/transaction.ts';

/** Validate provider data before persisting or returning it to a caller. */
export function parseRecoveredOperation(value: unknown): PaymentRailOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const amount = candidate.amount;
  if (!amount || typeof amount !== 'object' || Array.isArray(amount)) return null;
  const amountFields = amount as Record<string, unknown>;
  const { operationId, provider, reference, providerReference, status } = candidate;
  if (
    typeof operationId !== 'string' ||
    !operationId.trim() ||
    operationId.length > 256 ||
    typeof provider !== 'string' ||
    !provider.trim() ||
    provider.length > 128 ||
    typeof reference !== 'string' ||
    !reference.trim() ||
    reference.length > 256 ||
    (providerReference !== undefined &&
      (typeof providerReference !== 'string' ||
        !providerReference.trim() ||
        providerReference.length > 256)) ||
    typeof amountFields.amount !== 'string' ||
    !amountFields.amount.trim() ||
    amountFields.amount.length > 128 ||
    typeof amountFields.currency !== 'string' ||
    !amountFields.currency.trim() ||
    amountFields.currency.length > 32 ||
    (status !== 'pending' && status !== 'succeeded' && status !== 'failed' && status !== 'unknown')
  )
    return null;
  return {
    operationId,
    provider,
    reference,
    ...(providerReference === undefined ? {} : { providerReference }),
    amount: { amount: amountFields.amount, currency: amountFields.currency },
    status,
  };
}
