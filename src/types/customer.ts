import type { KycData } from './foundation.ts';

/**
 * Represents an anchor customer.
 *
 * Maps to the TRD's AnchorUser model with an added Stellar account
 * link (`account_id`) and optional contact / KYC info.
 */
export interface Customer {
  id: string;
  account_id: string;
  email_address?: string;
  phone_number?: string;
  created_at: number;
  kyc_data?: KycData;
}

/** Safe customer metadata for transaction responses and operational diagnostics. */
export type CustomerSummary = Pick<Customer, 'id' | 'account_id' | 'created_at'> & {
  kyc_status?: KycData['status'];
};

/** Expose only stable identifiers and KYC status; omit contact and identity data. */
export function toCustomerSummary(customer: Customer): CustomerSummary {
  return {
    id: customer.id,
    account_id: customer.account_id,
    created_at: customer.created_at,
    ...(customer.kyc_data ? { kyc_status: customer.kyc_data.status } : {}),
  };
}

/** Customer records may only be read by the Stellar account associated with them. */
export function canReadCustomer(customer: Customer, accountId: string): boolean {
  return customer.account_id === accountId;
}
