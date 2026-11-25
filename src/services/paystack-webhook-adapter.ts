import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentRailAdapter } from '@/runtime/interfaces.ts';
import type {
  NormalizedPaymentRailEvent,
  PaymentRailInitiationRequest,
  PaymentRailOperation,
  RailCapabilityResult,
} from '@/types/transaction.ts';
import { getPaystackTestStatus } from './paystack-status.ts';
import { validatePaystackReference } from './paystack-inputs.ts';

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBuffer(rawBody: string | Buffer | Uint8Array): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
}

function safeHexEquals(expectedHex: string, actualHex: string): boolean {
  if (!/^[a-f0-9]{128}$/i.test(actualHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function verifyLegacySignature(rawBody: Buffer, signature: string, secretKey: string): boolean {
  if (!/^sk_(?:test|live)_.+/.test(secretKey)) return false;
  const digest = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  return safeHexEquals(digest, signature);
}

function verifyRotatingSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
  nowSeconds: number,
): boolean {
  if (!secret.startsWith('whsec_') || secret.length <= 6 || signature.length > 4096) return false;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const field of signature.split(',')) {
    const separator = field.indexOf('=');
    if (separator <= 0) continue;
    const key = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return false;
      timestamp = value;
    } else if (key === 'v1') {
      const split = value.indexOf(':');
      if (split <= 0 || !/^whk_[A-Za-z0-9]+$/.test(value.slice(0, split))) return false;
      signatures.push(value.slice(split + 1));
    }
  }
  if (!timestamp || signatures.length === 0) return false;
  const signedAt = Number(timestamp);
  if (
    !Number.isSafeInteger(signedAt) ||
    Math.abs(nowSeconds - signedAt) > SIGNATURE_TOLERANCE_SECONDS
  )
    return false;
  const digest = createHmac('sha512', secret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest('hex');
  return signatures.some((signatureValue) => safeHexEquals(digest, signatureValue));
}

function normalizeAmount(subunits: number, currency: string): string | null {
  if (!Number.isSafeInteger(subunits) || subunits <= 0) return null;
  const value = BigInt(subunits);
  const whole = value / 100n;
  const fraction = value % 100n;
  if (currency === 'XOF') return fraction === 0n ? whole.toString() : null;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

export interface PaystackWebhookOptions {
  secret: string;
  /** Test-domain deliveries are rejected unless this is explicitly enabled. */
  allowTestMode?: boolean;
  now?: () => number;
}

/** Verify official Paystack signatures over exact raw bytes, then normalize charge events. */
export function verifyPaystackWebhook(input: {
  rawBody: string | Buffer | Uint8Array;
  signature?: string;
  options: PaystackWebhookOptions;
}): RailCapabilityResult<NormalizedPaymentRailEvent> {
  const rawBody = toBuffer(input.rawBody);
  const signature = input.signature?.trim() ?? '';
  const { secret, allowTestMode = false, now = Date.now } = input.options;
  if (!signature || rawBody.byteLength === 0 || rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    return { supported: false, reason: 'invalid Paystack webhook signature or payload' };
  }
  const verified = signature.startsWith('t=')
    ? verifyRotatingSignature(rawBody, signature, secret, Math.floor(now() / 1000))
    : verifyLegacySignature(rawBody, signature, secret);
  if (!verified)
    return { supported: false, reason: 'invalid Paystack webhook signature or payload' };

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    return { supported: false, reason: 'invalid Paystack webhook signature or payload' };
  }
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return { supported: false, reason: 'unsupported Paystack webhook event' };
  }
  const data = payload.data;
  const event = payload.event;
  const domain = data.domain;
  const testKey = secret.startsWith('sk_test_');
  const liveKey = secret.startsWith('sk_live_');
  if (
    (domain !== 'test' && domain !== 'live') ||
    (domain === 'test' && !allowTestMode) ||
    (testKey && (!allowTestMode || domain !== 'test')) ||
    (liveKey && domain !== 'live') ||
    (!testKey && !liveKey && !secret.startsWith('whsec_'))
  ) {
    return { supported: false, reason: 'Paystack test-mode delivery is not enabled' };
  }

  if (event !== 'charge.success' && event !== 'charge.failed') {
    return { supported: false, reason: 'unsupported Paystack webhook event' };
  }
  const id =
    typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0
      ? String(data.id)
      : typeof data.id === 'string' && /^[1-9]\d*$/.test(data.id)
        ? data.id
        : '';
  const reference = typeof data.reference === 'string' ? data.reference : '';
  const currency = typeof data.currency === 'string' ? data.currency : '';
  const status = data.status;
  const timestamp = typeof data.paid_at === 'string' ? data.paid_at : data.created_at;
  if (
    !id ||
    !validatePaystackReference(reference) ||
    !['GHS', 'KES', 'NGN', 'USD', 'XOF', 'ZAR'].includes(currency) ||
    typeof data.amount !== 'number' ||
    !['success', 'failed', 'abandoned'].includes(String(status)) ||
    (event === 'charge.success' && status !== 'success') ||
    (event === 'charge.failed' && status === 'success') ||
    typeof timestamp !== 'string' ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    return { supported: false, reason: 'invalid Paystack transaction data' };
  }
  const amount = normalizeAmount(data.amount, currency);
  if (amount === null)
    return { supported: false, reason: 'invalid Paystack transaction amount units' };
  return {
    supported: true,
    value: {
      eventId: `${event}:${id}`,
      provider: 'paystack',
      reference,
      providerReference: id,
      amount: { amount, currency },
      status: event === 'charge.success' ? 'succeeded' : 'failed',
      occurredAt: timestamp,
    },
  };
}

export class PaystackWebhookAdapter implements PaymentRailAdapter {
  readonly provider = 'paystack';
  readonly capabilities = {
    initiation: false,
    eventVerification: true,
    statusLookup: true,
    recovery: true,
  } as const;

  constructor(private readonly options: PaystackWebhookOptions) {}

  async initiate(
    _input: PaymentRailInitiationRequest,
  ): Promise<RailCapabilityResult<PaymentRailOperation>> {
    return { supported: false, reason: 'Paystack initiation is not provided by this adapter' };
  }

  async verifyEvent(input: {
    rawBody: string | Buffer | Uint8Array;
    signature?: string;
  }): Promise<RailCapabilityResult<NormalizedPaymentRailEvent>> {
    return verifyPaystackWebhook({ ...input, options: this.options });
  }

  async getStatus(input: {
    operationId: string;
    reference: string;
  }): Promise<RailCapabilityResult<PaymentRailOperation>> {
    if (!this.options.secret.startsWith('sk_test_')) {
      return { supported: false, reason: 'Paystack status lookup is available only for test keys' };
    }
    try {
      return {
        supported: true,
        value: await getPaystackTestStatus(input, { secretKey: this.options.secret }),
      };
    } catch {
      return { supported: false, reason: 'Paystack status lookup failed' };
    }
  }

  async recover(input: {
    operationId: string;
    reference: string;
  }): Promise<RailCapabilityResult<PaymentRailOperation>> {
    return this.getStatus(input);
  }
}
