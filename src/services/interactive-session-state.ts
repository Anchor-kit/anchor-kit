import type { InteractiveTransactionRecord } from '@/runtime/interfaces.ts';
import type { TransactionStatus } from '@/types/transaction-status.ts';
import type { InteractiveSessionClaims } from '@/utils/interactive-session.ts';

export interface InteractiveSessionState {
  transaction_id: string;
  status: TransactionStatus;
  permitted_actions: string[];
  required_fields: string[];
}

/** Build a minimal response from claims already verified by the session gate. */
export function interactiveSessionState(
  transaction: InteractiveTransactionRecord,
  verifiedClaims: InteractiveSessionClaims,
  requiredFields: readonly string[],
): InteractiveSessionState {
  if (
    transaction.id !== verifiedClaims.transactionId ||
    transaction.account !== verifiedClaims.account
  ) {
    throw new Error('Session does not match transaction');
  }
  return {
    transaction_id: transaction.id,
    status: transaction.status,
    permitted_actions: [...verifiedClaims.actions],
    required_fields: [...requiredFields],
  };
}
