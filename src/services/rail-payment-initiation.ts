import type { DatabaseAdapter, PaymentRailAdapter } from '@/runtime/interfaces.ts';
import type { PaymentRailOperation } from '@/types/transaction.ts';
import Big from 'big.js';

export class RailPaymentInitiationError extends Error {
  constructor(
    public readonly code:
      | 'missing_transaction'
      | 'invalid_payment'
      | 'unsupported_provider'
      | 'transaction_conflict'
      | 'provider_unavailable'
      | 'provider_mismatch',
  ) {
    super(`Rail payment initiation failed: ${code}`);
    this.name = 'RailPaymentInitiationError';
  }
}

/** Persist expected fiat values and a stable transaction reference before calling the rail. */
export async function initiateRailPayment(input: {
  database: Pick<DatabaseAdapter, 'getInteractiveTransactionById'> &
    Partial<Pick<DatabaseAdapter, 'setInteractiveTransactionRailPayment'>>;
  adapter: PaymentRailAdapter;
  transactionId: string;
  amount: string;
  currency: string;
}): Promise<PaymentRailOperation> {
  const amount = input.amount.trim();
  const currency = input.currency.trim().toUpperCase();
  const validAmount = (() => {
    try {
      return new Big(amount).gt(0);
    } catch {
      return false;
    }
  })();
  if (!validAmount || !/^[A-Z0-9]{3,12}$/.test(currency)) {
    throw new RailPaymentInitiationError('invalid_payment');
  }
  if (!input.adapter.provider.trim() || !input.adapter.capabilities.initiation) {
    throw new RailPaymentInitiationError('unsupported_provider');
  }
  if (!input.database.setInteractiveTransactionRailPayment) {
    throw new RailPaymentInitiationError('provider_unavailable');
  }

  const transaction = await input.database.getInteractiveTransactionById(input.transactionId);
  if (!transaction) throw new RailPaymentInitiationError('missing_transaction');
  if (transaction.kind !== 'deposit') {
    throw new RailPaymentInitiationError('transaction_conflict');
  }
  const operationId = `deposit:${input.adapter.provider}:${transaction.id}`;
  const reference = `${input.adapter.provider}:anchor-${transaction.id}`;
  const prepared = await input.database.setInteractiveTransactionRailPayment({
    transactionId: transaction.id,
    railReference: reference,
    amountIn: amount,
    currency,
  });
  if (!prepared) throw new RailPaymentInitiationError('transaction_conflict');

  let result: Awaited<ReturnType<PaymentRailAdapter['initiate']>>;
  try {
    result = await input.adapter.initiate({
      operationId,
      reference,
      accountId: transaction.account,
      amount: { amount, currency },
    });
  } catch {
    throw new RailPaymentInitiationError('provider_unavailable');
  }
  if (!result.supported) throw new RailPaymentInitiationError('provider_unavailable');
  const operation = result.value;
  if (
    operation.operationId !== operationId ||
    operation.provider !== input.adapter.provider ||
    operation.reference !== reference ||
    operation.amount.amount !== amount ||
    operation.amount.currency !== currency
  ) {
    throw new RailPaymentInitiationError('provider_mismatch');
  }
  return operation;
}
