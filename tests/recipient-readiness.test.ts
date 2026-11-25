import {
  assessIssuedAssetRecipient,
  type RecipientSnapshot,
} from '@/runtime/settlement/recipient-readiness.ts';
import { Keypair, Horizon } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

const recipient = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const base = { recipient, issuer, assetCode: 'USD', amount: '10.0000000' };
type Balance = Horizon.ServerApi.AccountRecord['balances'][number];
type IssuedBalance = Extract<Balance, { asset_code: string }>;
const line: IssuedBalance = {
  asset_type: 'credit_alphanum4' as IssuedBalance['asset_type'],
  asset_code: 'USD',
  asset_issuer: issuer,
  balance: '5.0000000',
  limit: '100.0000000',
  buying_liabilities: '0.0000000',
  selling_liabilities: '0.0000000',
  is_authorized: true,
  is_authorized_to_maintain_liabilities: false,
  is_clawback_enabled: false,
  last_modified_ledger: 1,
};
const found = (balances: Balance[]): RecipientSnapshot => ({
  status: 'found',
  account: { account_id: recipient, balances },
});

describe('issued-asset recipient readiness', () => {
  it('requires an existing account and matching authorized trustline', () => {
    expect(assessIssuedAssetRecipient({ ...base, snapshot: { status: 'not_found' } })).toEqual({
      status: 'pending_trust',
      reason: 'account_not_found',
    });
    expect(assessIssuedAssetRecipient({ ...base, snapshot: found([]) })).toEqual({
      status: 'pending_trust',
      reason: 'trustline_missing',
    });
    expect(
      assessIssuedAssetRecipient({
        ...base,
        snapshot: found([{ ...line, asset_issuer: Keypair.random().publicKey() }]),
      }),
    ).toEqual({ status: 'pending_trust', reason: 'trustline_missing' });
    expect(
      assessIssuedAssetRecipient({
        ...base,
        snapshot: found([
          { ...line, is_authorized: false, is_authorized_to_maintain_liabilities: true },
        ]),
      }),
    ).toEqual({ status: 'pending_trust', reason: 'unauthorized' });
    expect(assessIssuedAssetRecipient({ ...base, snapshot: found([line]) })).toEqual({
      status: 'ready',
    });
  });
  it('accounts for trustline capacity and outstanding buying liabilities', () => {
    expect(
      assessIssuedAssetRecipient({
        ...base,
        snapshot: found([{ ...line, limit: '15.0000000', buying_liabilities: '0.0000001' }]),
      }),
    ).toEqual({ status: 'pending_trust', reason: 'limit_exceeded' });
    expect(
      assessIssuedAssetRecipient({ ...base, snapshot: found([{ ...line, limit: '15.0000000' }]) }),
    ).toEqual({ status: 'ready' });
  });
  it('fails closed on unavailable or mismatched account data', () => {
    expect(assessIssuedAssetRecipient({ ...base, snapshot: { status: 'unavailable' } })).toEqual({
      status: 'unavailable',
    });
    expect(
      assessIssuedAssetRecipient({
        ...base,
        snapshot: { status: 'found', account: { account_id: issuer, balances: [line] } },
      }),
    ).toEqual({ status: 'unavailable' });
    expect(assessIssuedAssetRecipient({ ...base, amount: '1e3', snapshot: found([line]) })).toEqual(
      { status: 'unavailable' },
    );
    expect(
      assessIssuedAssetRecipient({ ...base, snapshot: found([{ ...line, limit: 'invalid' }]) }),
    ).toEqual({ status: 'unavailable' });
  });
  it('allows an existing issuing account without a trustline', () => {
    expect(
      assessIssuedAssetRecipient({
        ...base,
        recipient: issuer,
        snapshot: { status: 'found', account: { account_id: issuer, balances: [] } },
      }),
    ).toEqual({ status: 'ready' });
  });
});
