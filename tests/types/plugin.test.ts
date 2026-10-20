import type { AnchorPlugin, AnchorPluginHooks } from '@/types/plugin.ts';
import type { AnchorInstance } from '@/core/factory.ts';
import type { Transaction } from '@/types/transaction.ts';
import type { TransactionStatus } from '@/types/transaction-status.ts';
import { describe, expect, it } from 'vitest';

describe('AnchorPlugin type contracts', () => {
  it('types initialization and transaction hooks without casts', () => {
    const transaction: Transaction = {
      id: 'deposit-1',
      kind: 'deposit',
      status: 'pending_external',
      amount_in: { amount: '25.00', asset: 'USD' },
    };
    const hooks: AnchorPluginHooks = {
      onSep10Challenge: async (tx) => {
        expect(tx.id).toBeDefined();
        expect(tx.amount_in?.amount).toBeDefined();
        return tx;
      },
      onTransactionStatusChange: async (tx, oldStatus, newStatus) => {
        expect(tx.kind).toBe('deposit');
        const previous: TransactionStatus = oldStatus;
        const next: TransactionStatus = newStatus;
        expect(previous).toBe('pending_external');
        expect(next).toBe('pending_stellar');
      },
    };
    const plugin: AnchorPlugin = {
      id: 'typed-plugin',
      init: (instance) => {
        const anchor: AnchorInstance = instance;
        expect(anchor.config).toBeDefined();
      },
      hooks,
    };

    expect(plugin.id).toBe('typed-plugin');
    expect(transaction.amount_in?.amount).toBe('25.00');
  });

  it('rejects unsupported transaction fields and status values at compile time', () => {
    const hooks: AnchorPluginHooks = {
      onTransactionStatusChange: async (tx, _oldStatus, _newStatus) => {
        // @ts-expect-error — transaction records have no unsupported field
        expect(tx.unsupportedField).toBeUndefined();
      },
    };
    const plugin: AnchorPlugin = {
      id: 'invalid-plugin',
      hooks: {
        onTransactionStatusChange: async (_tx, oldStatus, _newStatus) => {
          // @ts-expect-error — hook status arguments are TransactionStatus
          const invalid: TransactionStatus = 'invalid';
          expect(invalid).toBeDefined();
          expect(oldStatus).toBeDefined();
        },
      },
    };

    expect(hooks).toBeDefined();
    expect(plugin).toBeDefined();
  });
});
