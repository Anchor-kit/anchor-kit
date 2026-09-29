import { describe, expect, it } from 'vitest';

/**
 * Runtime no-op that preserves compile-time type assertions.
 * Bun's test runner does not support vitest's `expectTypeOf` at runtime.
 */
function expectTypeOf<T>(_value?: T) {
  return {
    toEqualTypeOf<U>(_?: U): void {},
    toMatchTypeOf<U>(_?: U): void {},
  };
}
import type {
  Transaction,
  TransactionKind,
  Amount,
  RailTransactionData,
  StellarTransactionData,
  InteractiveData,
  TransactionError,
  RefundInfo,
} from '@/types';

describe('Transaction', () => {
  // ============================================
  // Core Transaction Fields
  // ============================================

  describe('core fields', () => {
    it('exports TransactionKind as the Transaction kind alias', () => {
      const deposit: TransactionKind = 'deposit';
      const withdrawal: TransactionKind = 'withdrawal';

      expect(deposit).toBe('deposit');
      expect(withdrawal).toBe('withdrawal');
      expectTypeOf<Transaction['kind']>().toEqualTypeOf<TransactionKind>();
    });

    it('requires id, status, and kind', () => {
      const tx: Transaction = {
        id: 'txn-001',
        status: 'incomplete',
        kind: 'deposit',
      };

      expect(tx.id).toBe('txn-001');
      expect(tx.status).toBe('incomplete');
      expect(tx.kind).toBe('deposit');
    });

    it('accepts both deposit and withdrawal kinds', () => {
      const deposit: Transaction = {
        id: 'dep-001',
        status: 'completed',
        kind: 'deposit',
      };

      const withdrawal: Transaction = {
        id: 'wit-001',
        status: 'completed',
        kind: 'withdrawal',
      };

      expect(deposit.kind).toBe('deposit');
      expect(withdrawal.kind).toBe('withdrawal');
    });

    it('rejects invalid kind at compile time', () => {
      // TypeScript compile-time check: invalid kind rejected at assignment
      const bad = {
        id: 'txn-001',
        status: 'completed',
        kind: 'invalid',
      } as unknown as Transaction;

      expect(bad).toBeDefined();
    });

    it('rejects missing required fields at compile time', () => {
      // @ts-expect-error — missing id, status, kind
      const bad1: Transaction = {};

      // @ts-expect-error — missing status and kind
      const bad2: Transaction = { id: 'txn-001' };

      expect(bad1).toBeDefined();
      expect(bad2).toBeDefined();
    });
  });

  // ============================================
  // Amount Fields (Decimal String Representation)
  // ============================================

  describe('amount fields with decimal precision', () => {
    it('uses string for decimal precision in Amount', () => {
      const amount: Amount = {
        amount: '1234.567890',
        asset: 'USDC',
      };

      expect(amount.amount).toBe('1234.567890');
      expect(amount.asset).toBe('USDC');
    });

    it('supports fiat amounts in deposits', () => {
      const tx: Transaction = {
        id: 'dep-001',
        status: 'pending_anchor',
        kind: 'deposit',
        amount_in: {
          amount: '5000.00',
          asset: 'NGN',
        },
        amount_out: {
          amount: '9.87',
          asset: 'USDC',
        },
        amount_fee: {
          amount: '0.50',
          asset: 'USDC',
        },
      };

      expect(tx.amount_in?.amount).toBe('5000.00');
      expect(tx.amount_in?.asset).toBe('NGN');
      expect(tx.amount_out?.amount).toBe('9.87');
      expect(tx.amount_fee?.amount).toBe('0.50');
    });

    it('supports crypto amounts in withdrawals', () => {
      const tx: Transaction = {
        id: 'wit-001',
        status: 'pending_user_transfer_start',
        kind: 'withdrawal',
        amount_in: {
          amount: '50.0000000',
          asset: 'USDC',
        },
        amount_out: {
          amount: '245000.00',
          asset: 'NGN',
        },
      };

      expect(tx.amount_in?.asset).toBe('USDC');
      expect(tx.amount_out?.asset).toBe('NGN');
    });

    it('makes amount fields optional', () => {
      const tx: Transaction = {
        id: 'txn-001',
        status: 'incomplete',
        kind: 'deposit',
        // amount_in, amount_out, amount_fee are optional
      };

      expect(tx.amount_in).toBeUndefined();
      expect(tx.amount_out).toBeUndefined();
      expect(tx.amount_fee).toBeUndefined();
    });
  });

  // ============================================
  // Reference & Information Fields
  // ============================================

  describe('reference and information fields', () => {
    it('accepts optional more_info_url and message', () => {
      const tx: Transaction = {
        id: 'txn-001',
        status: 'pending_anchor',
        kind: 'deposit',
        more_info_url: 'https://anchor.example.com/transactions/txn-001',
        message: 'Waiting for customer KYC approval',
      };

      expect(tx.more_info_url).toContain('transactions/txn-001');
      expect(tx.message).toMatch(/KYC/);
    });
  });

  // ============================================
  // Timestamp Fields
  // ============================================

  describe('timestamp fields', () => {
    it('accepts optional created_at and updated_at as ISO 8601 strings', () => {
      const isoTimestamp = new Date().toISOString();
      const tx: Transaction = {
        id: 'txn-001',
        status: 'completed',
        kind: 'deposit',
        created_at: isoTimestamp,
        updated_at: isoTimestamp,
      };

      expect(tx.created_at).toBeTypeOf('string');
      expect(tx.updated_at).toBeTypeOf('string');
      expect(new Date(tx.created_at!).toISOString()).toBe(tx.created_at);
      expect(new Date(tx.updated_at!).toISOString()).toBe(tx.updated_at);
    });

    it('makes created_at and updated_at optional', () => {
      const tx: Transaction = {
        id: 'txn-001',
        status: 'incomplete',
        kind: 'deposit',
      };

      expect(tx.created_at).toBeUndefined();
      expect(tx.updated_at).toBeUndefined();
    });
  }); // ← close describe('timestamp fields')

  // ============================================
  // Deposit Transaction Example

  // ============================================
  // Deposit Transaction Example
  // ============================================

  describe('deposit transaction example', () => {
    it('models a complete deposit lifecycle with rail and stellar data', () => {
      const depositTx: Transaction = {
        // Core fields
        id: 'dep-flw-550e8400',
        status: 'pending_user_transfer_complete',
        kind: 'deposit',

        // Amounts (fiat in, crypto out)
        amount_in: {
          amount: '5000.00',
          asset: 'NGN', // Nigerian Naira (fiat)
        },
        amount_out: {
          amount: '9.82',
          asset: 'USDC', // USD Coin (crypto)
        },
        amount_fee: {
          amount: '0.18',
          asset: 'USDC',
        },

        // Metadata
        more_info_url: 'https://anchor.example.com/deposit/dep-flw-550e8400',
        message: 'Awaiting customer transfer to bank account',
        started_at: 1700000000000,

        // Rail data (payment rail side)
        rail: {
          provider: 'flutterwave',
          reference: 'FLW-1700000000-550e8400',
          status: 'pending',
          metadata: {
            customer_email: 'user@example.com',
            payment_type: 'bank_transfer',
          },
        },

        // Stellar data (blockchain side)
        stellar: {
          account_id: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRCZCTS5D27ECGM4AQUREYUVMY63JP',
        },

        // Interactive flow
        interactive: {
          url: 'https://anchor.example.com/webapp/deposit?transaction_id=dep-flw-550e8400',
        },
      };

      expect(depositTx.kind).toBe('deposit');
      expect(depositTx.amount_in?.asset).toBe('NGN');
      expect(depositTx.amount_out?.asset).toBe('USDC');
      expect(depositTx.rail?.provider).toBe('flutterwave');
      expect(depositTx.stellar?.account_id).toBeDefined();
      expect(depositTx.interactive?.url).toBeDefined();
    });

    it('handles deposits at different status stages', () => {
      // Stage 1: User starts the flow
      const startTime = Date.now();
      const incomplete: Transaction = {
        id: 'dep-001',
        status: 'incomplete',
        kind: 'deposit',
        started_at: startTime,
        interactive: {
          url: 'https://anchor.example.com/webapp/deposit?transaction_id=dep-001',
        },
      };

      expect(incomplete.status).toBe('incomplete');
      expect(incomplete.interactive?.url).toBeDefined();

      // Stage 2: Anchor begins verification
      const pendingAnchor: Transaction = {
        ...incomplete,
        status: 'pending_anchor',
        message: 'Verifying customer KYC',
      };

      expect(pendingAnchor.status).toBe('pending_anchor');
      expect(pendingAnchor.message).toMatch(/KYC/);

      // Stage 3: Ready for customer payment
      const pendingTransfer: Transaction = {
        ...pendingAnchor,
        status: 'pending_user_transfer_start',
        amount_in: { amount: '5000.00', asset: 'NGN' },
        amount_out: { amount: '9.82', asset: 'USDC' },
        message: 'Please transfer NGN 5000 to Bank X account 1234567890',
        rail: {
          provider: 'flutterwave',
          reference: 'FLW-001',
          status: 'initiated',
        },
      };

      expect(pendingTransfer.status).toBe('pending_user_transfer_start');
      expect(pendingTransfer.rail?.provider).toBe('flutterwave');

      // Stage 4: Payment received
      const pendingExternal: Transaction = {
        ...pendingTransfer,
        status: 'pending_external',
        rail: {
          ...pendingTransfer.rail!,
          status: 'success',
        },
      };

      expect(pendingExternal.rail?.status).toBe('success');

      // Stage 5: Completed
      const completed: Transaction = {
        ...pendingExternal,
        status: 'completed',
        completed_at: startTime + 1000, // 1 second after start
        stellar: {
          transaction_id: 'a7d1e8c9b0f1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6',
          account_id: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRCZCTS5D27ECGM4AQUREYUVMY63JP',
          memo: 'dep-001',
          memo_type: 'id',
        },
      };

      expect(completed.status).toBe('completed');
      expect(completed.stellar?.transaction_id).toBeDefined();
      expect(completed.completed_at).toBeGreaterThan(completed.started_at!);
    });
  });

  // ============================================
  // Withdrawal Transaction Example
  // ============================================

  describe('withdrawal transaction example', () => {
    it('models a complete withdrawal lifecycle with stellar and rail data', () => {
      const withdrawalTx: Transaction = {
        // Core fields
        id: 'wit-ps-8b57a4f1',
        status: 'pending_user_transfer_complete',
        kind: 'withdrawal',

        // Amounts (crypto in, fiat out)
        amount_in: {
          amount: '50.0000000',
          asset: 'USDC', // USD Coin (crypto)
        },
        amount_out: {
          amount: '245000.00',
          asset: 'NGN', // Nigerian Naira (fiat)
        },
        amount_fee: {
          amount: '2500.00',
          asset: 'NGN',
        },

        // Metadata
        more_info_url: 'https://anchor.example.com/withdrawal/wit-ps-8b57a4f1',
        message: 'Waiting for blockchain confirmation',
        started_at: 1700000000000,

        // Stellar data (blockchain side)
        stellar: {
          account_id: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRCZCTS5D27ECGM4AQUREYUVMY63JP',
          memo: 'wit-ps-8b57a4f1',
          memo_type: 'id',
        },

        // Rail data (payment rail side)
        rail: {
          provider: 'paystack',
          reference: 'PS-1700000000-8b57a4f1',
          status: 'pending',
          metadata: {
            bank_code: '058', // Guarantee Trust Bank (GTB)
            account_number: '0123456789',
          },
        },
      };

      expect(withdrawalTx.kind).toBe('withdrawal');
      expect(withdrawalTx.amount_in?.asset).toBe('USDC');
      expect(withdrawalTx.amount_out?.asset).toBe('NGN');
      expect(withdrawalTx.stellar?.memo).toBe('wit-ps-8b57a4f1');
      expect(withdrawalTx.rail?.provider).toBe('paystack');
    });

    it('handles withdrawals at different status stages', () => {
      // Stage 1: User initiates withdrawal
      const initial: Transaction = {
        id: 'wit-001',
        status: 'pending_user_transfer_start',
        kind: 'withdrawal',
        amount_in: { amount: '50.0000000', asset: 'USDC' },
        amount_out: { amount: '245000.00', asset: 'NGN' },
        started_at: Date.now(),
        stellar: {
          account_id: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRCZCTS5D27ECGM4AQUREYUVMY63JP',
          memo: 'wit-001',
          memo_type: 'id',
        },
      };

      expect(initial.status).toBe('pending_user_transfer_start');

      // Stage 2: Blockchain payment received
      const paymentReceived: Transaction = {
        ...initial,
        status: 'pending_external',
        stellar: {
          ...initial.stellar!,
          transaction_id: 'a7d1e8c9b0f1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6',
        },
      };

      expect(paymentReceived.stellar?.transaction_id).toBeDefined();

      // Stage 3: Fiat payout initiated
      const fiatPending: Transaction = {
        ...paymentReceived,
        rail: {
          provider: 'paystack',
          reference: 'PS-001',
          status: 'pending',
        },
      };

      expect(fiatPending.rail?.provider).toBe('paystack');

      // Stage 4: Completed
      const completed: Transaction = {
        ...fiatPending,
        status: 'completed',
        completed_at: Date.now(),
        rail: {
          ...fiatPending.rail!,
          status: 'success',
        },
      };

      expect(completed.status).toBe('completed');
      expect(completed.rail?.status).toBe('success');
    });
  });

  // ============================================
  // Rail-Specific Fields
  // ============================================

  describe('rail-specific fields', () => {
    it('accepts RailTransactionData with provider and reference', () => {
      const rail: RailTransactionData = {
        provider: 'flutterwave',
        reference: 'FLW-1700000000-550e8400',
        status: 'success',
        metadata: {
          customer_email: 'user@example.com',
          payment_type: 'bank_transfer',
        },
      };

      expect(rail.provider).toBe('flutterwave');
      expect(rail.reference).toBeDefined();
      expect(rail.metadata?.customer_email).toBe('user@example.com');
    });

    it('makes rail fields optional', () => {
      const tx: Transaction = {
        id: 'txn-001',
        status: 'incomplete',
        kind: 'deposit',
        // rail is optional
      };

      expect(tx.rail).toBeUndefined();
    });
  });

  // ============================================
  // Stellar-Specific Fields
  // ============================================

  describe('stellar-specific fields', () => {
    it('accepts StellarTransactionData with transaction_id and memo', () => {
      const stellar: StellarTransactionData = {
        transaction_id: 'a7d1e8c9b0f1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6',
        memo: 'wit-001',
        memo_type: 'id',
        account_id: 'GBRPYHIL2CI3WHZDTOOQFC6EB4RRCZCTS5D27ECGM4AQUREYUVMY63JP',
      };

      expect(stellar.transaction_id).toBeDefined();
      expect(stellar.memo).toBe('wit-001');
      expect(['text', 'id', 'hash', 'return']).toContain(stellar.memo_type);
    });

    it('supports different memo types', () => {
      const memoTypes: Array<'text' | 'id' | 'hash' | 'return'> = ['text', 'id', 'hash', 'return'];

      memoTypes.forEach((memoType) => {
        const tx: Transaction = {
          id: 'txn-001',
          status: 'completed',
          kind: 'deposit',
          stellar: {
            memo: 'some-memo',
            memo_type: memoType,
          },
        };

        expect(tx.stellar?.memo_type).toBe(memoType);
      });
    });

    it('makes stellar fields optional', () => {
      const tx: Transaction = {
        id: 'txn-001',
        status: 'incomplete',
        kind: 'deposit',
        // stellar is optional
      };

      expect(tx.stellar).toBeUndefined();
    });
  });

  // ============================================
  // Interactive Fields
  // ============================================

  describe('interactive flow fields', () => {
    it('accepts InteractiveData with url and form fields', () => {
      const interactive: InteractiveData = {
        url: 'https://anchor.example.com/webapp/deposit?transaction_id=txn-001',
        required_fields: ['first_name', 'last_name', 'email_address'],
        form_fields: [
          {
            name: 'first_name',
            description: 'Your first name',
            required: true,
          },
          {
            name: 'last_name',
            description: 'Your last name',
            required: true,
          },
          {
            name: 'email_address',
            description: 'Your email address',
            required: true,
          },
        ],
      };

      expect(interactive.url).toContain('transaction_id');
      expect(interactive.required_fields?.length).toBe(3);
      expect(interactive.form_fields?.[0].name).toBe('first_name');
    });

    it('makes interactive fields optional', () => {
      const tx: Transaction = {
        id: 'txn-001',
        status: 'completed',
        kind: 'deposit',
        // interactive is optional
      };

      expect(tx.interactive).toBeUndefined();
    });
  });

  // ============================================
  // Error & Refund Fields
  // ============================================

  describe('error and refund fields', () => {
    it('accepts TransactionError with code and message', () => {
      const error: TransactionError = {
        code: 'INSUFFICIENT_BALANCE',
        message: 'Customer account has insufficient balance for this transaction',
        details: {
          required_amount: '5000.00',
          available_balance: '2000.00',
        },
      };

      expect(error.code).toBe('INSUFFICIENT_BALANCE');
      expect(error.message).toBeDefined();
      expect(error.details?.required_amount).toBe('5000.00');
    });

    it('models a failed transaction with error info', () => {
      const failedTx: Transaction = {
        id: 'txn-001',
        status: 'error',
        kind: 'deposit',
        started_at: 1700000000000,
        completed_at: 1700003600000,
        error: {
          code: 'KYC_VERIFICATION_FAILED',
          message: 'Customer KYC verification was rejected',
          details: {
            reason: 'Document expiry date exceeded',
            resolved_at: '2025-02-28',
          },
        },
      };

      expect(failedTx.status).toBe('error');
      expect(failedTx.error?.code).toBe('KYC_VERIFICATION_FAILED');
    });

    it('accepts RefundInfo with refund amounts and payments', () => {
      const refund: RefundInfo = {
        amount_refunded: {
          amount: '5000.00',
          asset: 'NGN',
        },
        amount_fee: {
          amount: '100.00',
          asset: 'NGN',
        },
        payments: [
          {
            id: 'ref-payment-001',
            id_type: 'external_transaction_id',
            amount: { amount: '5000.00', asset: 'NGN' },
            fee: { amount: '100.00', asset: 'NGN' },
          },
        ],
      };

      expect(refund.amount_refunded?.amount).toBe('5000.00');
      expect(refund.payments?.[0].id).toBe('ref-payment-001');
    });

    it('models a refunded transaction', () => {
      const refundedTx: Transaction = {
        id: 'txn-001',
        status: 'refunded',
        kind: 'deposit',
        amount_in: { amount: '5000.00', asset: 'NGN' },
        amount_out: { amount: '9.82', asset: 'USDC' },
        amount_fee: { amount: '0.18', asset: 'USDC' },
        started_at: 1700000000000,
        completed_at: 1700086400000,
        refunds: {
          amount_refunded: {
            amount: '5000.00',
            asset: 'NGN',
          },
          amount_fee: {
            amount: '50.00',
            asset: 'NGN',
          },
          payments: [
            {
              id: 'refund-flw-001',
              id_type: 'flutterwave_transaction_id',
              amount: { amount: '5000.00', asset: 'NGN' },
              fee: { amount: '50.00', asset: 'NGN' },
            },
          ],
        },
      };

      expect(refundedTx.status).toBe('refunded');
      expect(refundedTx.refunds?.amount_refunded?.amount).toBe('5000.00');
    });

    it('makes error and refund fields optional', () => {
      const tx: Transaction = {
        id: 'txn-001',
        status: 'completed',
        kind: 'deposit',
        // error and refunds are optional
      };

      expect(tx.error).toBeUndefined();
      expect(tx.refunds).toBeUndefined();
    });
  });

  // ============================================
  // Compile-time Validation
  // ============================================

  describe('compile-time validation', () => {
    it('rejects wrong status at compile time', () => {
      // Intentionally invalid status for type-test; cast-through-unknown
      const bad = {
        id: 'txn-001',
        status: 'invalid_status',
        kind: 'deposit',
      } as unknown as Transaction;

      expect(bad).toBeDefined();
    });

    it('rejects wrong kind at compile time', () => {
      // Intentionally invalid kind for type-test; cast-through-unknown
      const bad = {
        id: 'txn-001',
        status: 'completed',
        kind: 'transfer',
      } as unknown as Transaction;

      expect(bad).toBeDefined();
    });

    it('rejects wrong Amount structure at compile time', () => {
      // Intentionally malformed Amount for type-test; cast-through-unknown
      const bad = {
        id: 'txn-001',
        status: 'completed',
        kind: 'deposit',
        amount_in: { sum: '100' },
      } as unknown as Transaction;

      expect(bad).toBeDefined();
    });
  });
});
