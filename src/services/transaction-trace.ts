export interface TransactionTraceEvent {
  transactionId: string;
  operationKey: string;
  event: 'received' | 'duplicate' | 'failed' | 'confirmed';
  railReference?: string;
  attemptCount?: number;
  confirmedHash?: string;
}

export type TransactionTraceSink = (event: TransactionTraceEvent) => void;

/** Forward only trace fields; never forward payloads or arbitrary error objects. */
export function emitTransactionTrace(
  sink: TransactionTraceSink,
  event: TransactionTraceEvent,
): void {
  if (!event.transactionId.trim() || !event.operationKey.trim())
    throw new Error('Trace identifiers are required');
  if (!['received', 'duplicate', 'failed', 'confirmed'].includes(event.event))
    throw new Error('Invalid trace event');
  if (
    event.attemptCount !== undefined &&
    (!Number.isSafeInteger(event.attemptCount) || event.attemptCount < 0)
  )
    throw new Error('Invalid attempt count');
  if (event.confirmedHash !== undefined && !/^[0-9a-f]{64}$/i.test(event.confirmedHash))
    throw new Error('Invalid confirmed transaction hash');
  sink({
    transactionId: event.transactionId,
    operationKey: event.operationKey,
    event: event.event,
    ...(event.railReference === undefined ? {} : { railReference: event.railReference }),
    ...(event.attemptCount === undefined ? {} : { attemptCount: event.attemptCount }),
    ...(event.confirmedHash === undefined ? {} : { confirmedHash: event.confirmedHash }),
  });
}
