import Big from 'big.js';

/** A refund operation linked to the transaction it refunds. */
export interface RefundOperation {
  transactionId: string;
  paymentId: string;
  paymentIdType: 'stellar' | 'external';
  amount: string;
  fee: string;
  status: 'pending' | 'completed' | 'failed';
}

/** SEP-24 refund fields use decimal strings in the transaction's input asset. */
export interface Sep24Refunds {
  amount_refunded: string;
  amount_fee: string;
  payments: Array<{ id: string; id_type: 'stellar' | 'external'; amount: string; fee: string }>;
}

export function serializeRefunds(
  transactionId: string,
  operations: readonly RefundOperation[],
): Sep24Refunds {
  let amount = new Big(0);
  let fee = new Big(0);
  const payments: Sep24Refunds['payments'] = [];
  if (!transactionId.trim()) throw new Error('Transaction ID is required');

  for (const operation of operations) {
    if (operation.transactionId !== transactionId)
      throw new Error('Refund belongs to another transaction');
    if (!['pending', 'completed', 'failed'].includes(operation.status))
      throw new Error('Invalid refund status');
    if (operation.status !== 'completed') continue;
    if (
      !['stellar', 'external'].includes(operation.paymentIdType) ||
      !operation.paymentId.trim() ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(operation.amount) ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(operation.fee)
    ) {
      throw new Error('Invalid completed refund');
    }
    amount = amount.plus(operation.amount);
    fee = fee.plus(operation.fee);
    payments.push({
      id: operation.paymentId,
      id_type: operation.paymentIdType,
      amount: operation.amount,
      fee: operation.fee,
    });
  }
  return { amount_refunded: amount.toFixed(), amount_fee: fee.toFixed(), payments };
}
