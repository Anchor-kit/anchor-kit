import { ValidationError } from '@/core/errors.ts';
import type { TransactionHistoryQuery } from '@/runtime/interfaces.ts';

export const MAX_HISTORY_PAGE_SIZE = 100;

export function validateTransactionHistory(input: TransactionHistoryQuery): void {
  const validText = (value: string) =>
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= 256 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    );
  if (
    !validText(input.account) ||
    !validText(input.assetCode) ||
    (input.pagingId !== undefined && !validText(input.pagingId)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_HISTORY_PAGE_SIZE)) ||
    (input.kind !== undefined && input.kind !== 'deposit' && input.kind !== 'withdrawal')
  ) {
    throw new ValidationError('Invalid transaction history filters or page size (1-100)');
  }
  if (input.noOlderThan !== undefined) {
    const value = input.noOlderThan;
    const date = new Date(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString() !==
        value.replace(
          /(?:\.(\d{1,3}))?Z$/,
          (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`,
        )
    ) {
      throw new ValidationError('no_older_than must be a valid UTC ISO 8601 timestamp');
    }
  }
}
