import { Asset, StrKey, type Horizon } from '@stellar/stellar-sdk';
import Big from 'big.js';

type AccountSnapshot = Pick<Horizon.ServerApi.AccountRecord, 'account_id' | 'balances'>;
export type RecipientSnapshot =
  | { status: 'found'; account: AccountSnapshot }
  | { status: 'not_found' }
  | { status: 'unavailable' };

export type RecipientReadiness =
  | { status: 'ready' }
  | {
      status: 'pending_trust';
      reason: 'account_not_found' | 'trustline_missing' | 'unauthorized' | 'limit_exceeded';
    }
  | { status: 'unavailable' };

/** Assess a Horizon account snapshot; settlement must recheck immediately before signing. */
export function assessIssuedAssetRecipient(input: {
  recipient: string;
  assetCode: string;
  issuer: string;
  amount: string;
  snapshot: RecipientSnapshot;
}): RecipientReadiness {
  try {
    if (!StrKey.isValidEd25519PublicKey(input.recipient)) return { status: 'unavailable' };
    new Asset(input.assetCode, input.issuer);
    if (
      !/^\d+(?:\.\d{1,7})?$/.test(input.amount) ||
      !new Big(input.amount).gt(0) ||
      new Big(input.amount).gt('922337203685.4775807')
    )
      return { status: 'unavailable' };
    if (input.snapshot.status === 'unavailable') return { status: 'unavailable' };
    if (input.snapshot.status === 'not_found')
      return { status: 'pending_trust', reason: 'account_not_found' };
    const account = input.snapshot.account;
    if (account.account_id !== input.recipient || !Array.isArray(account.balances))
      return { status: 'unavailable' };
    if (input.recipient === input.issuer) return { status: 'ready' };
    const line = account.balances.find(
      (balance) =>
        (balance.asset_type === 'credit_alphanum4' || balance.asset_type === 'credit_alphanum12') &&
        balance.asset_code === input.assetCode &&
        balance.asset_issuer === input.issuer,
    );
    if (
      !line ||
      (line.asset_type !== 'credit_alphanum4' && line.asset_type !== 'credit_alphanum12')
    )
      return { status: 'pending_trust', reason: 'trustline_missing' };
    if (line.is_authorized !== true) return { status: 'pending_trust', reason: 'unauthorized' };
    const values = [line.limit, line.balance, line.buying_liabilities];
    if (values.some((value) => !/^\d+(?:\.\d{1,7})?$/.test(value)))
      return { status: 'unavailable' };
    const available = new Big(line.limit).minus(line.balance).minus(line.buying_liabilities);
    if (available.lt(input.amount)) return { status: 'pending_trust', reason: 'limit_exceeded' };
    return { status: 'ready' };
  } catch {
    return { status: 'unavailable' };
  }
}
