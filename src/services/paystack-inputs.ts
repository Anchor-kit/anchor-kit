/** Convert a major-unit decimal to Paystack's minor-unit integer string. */
export function paystackSubunits(amount: string, currency: string): string {
  if (!['GHS', 'KES', 'NGN', 'USD', 'XOF', 'ZAR'].includes(currency)) {
    throw new Error('Unsupported Paystack currency');
  }
  if (amount.length > 32 || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount)) {
    throw new Error('Amount must be a non-negative decimal with at most two fractional digits');
  }
  if (currency === 'XOF' && amount.includes('.')) {
    throw new Error('XOF amounts must be whole numbers');
  }
  const [whole, fraction = ''] = amount.split('.');
  const subunits = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (subunits <= 0n) throw new Error('Amount must be greater than zero');
  return subunits.toString();
}

/** Reject references Paystack cannot accept without changing their identity. */
export function validatePaystackReference(reference: string): boolean {
  return /^[A-Za-z0-9.=-]+$/.test(reference);
}
