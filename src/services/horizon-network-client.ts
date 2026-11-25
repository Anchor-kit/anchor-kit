import { StrKey } from '@stellar/stellar-sdk';
import { signedSettlementHash } from './settlement-identity.ts';
import type {
  StellarAccountState,
  StellarNetworkClient,
  StellarNetworkResult,
  StellarTransactionState,
} from '@/runtime/interfaces.ts';

type UnavailableReason = Extract<StellarNetworkResult<never>, { status: 'unavailable' }>['reason'];

type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type WireResult =
  | { status: 'found'; value: Record<string, unknown> }
  | { status: 'not_found' }
  | { status: 'unavailable'; reason: UnavailableReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read-only Horizon client. The configured passphrase must match the server. */
export class HorizonNetworkClient implements StellarNetworkClient {
  private readonly baseUrl: URL;
  private readonly networkPassphrase: string;
  private readonly fetchImpl: HttpFetch;
  private readonly timeoutMs: number;

  constructor(
    config: { horizonUrl: string; networkPassphrase: string; timeoutMs?: number },
    fetchImpl: HttpFetch = fetch,
  ) {
    this.baseUrl = new URL(config.horizonUrl);
    if (
      !['http:', 'https:'].includes(this.baseUrl.protocol) ||
      this.baseUrl.search ||
      this.baseUrl.hash ||
      this.baseUrl.username ||
      this.baseUrl.password
    ) {
      throw new Error('Invalid Horizon URL.');
    }
    if (!config.networkPassphrase.trim()) throw new Error('Network passphrase is required.');
    if (
      config.timeoutMs !== undefined &&
      (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60000)
    ) {
      throw new Error('Timeout must be between 1 and 60000 milliseconds.');
    }
    this.baseUrl.pathname = `${this.baseUrl.pathname.replace(/\/+$/, '')}/`;
    this.networkPassphrase = config.networkPassphrase;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  private async request(path: string): Promise<WireResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const root = await this.fetchImpl(this.baseUrl, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!root.ok) return { status: 'unavailable', reason: 'network' };
      const rootBody: unknown = await root.json();
      if (!isRecord(rootBody) || typeof rootBody.network_passphrase !== 'string')
        return { status: 'unavailable', reason: 'invalid_response' };
      if (rootBody.network_passphrase !== this.networkPassphrase)
        return { status: 'unavailable', reason: 'network_mismatch' };
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 404) return { status: 'not_found' };
      if (!response.ok) return { status: 'unavailable', reason: 'network' };
      const value: unknown = await response.json();
      return isRecord(value)
        ? { status: 'found', value }
        : { status: 'unavailable', reason: 'invalid_response' };
    } catch {
      return { status: 'unavailable', reason: controller.signal.aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccount(accountId: string): Promise<StellarNetworkResult<StellarAccountState>> {
    if (!StrKey.isValidEd25519PublicKey(accountId)) throw new Error('Invalid Stellar account ID.');
    const result = await this.request(`accounts/${accountId}`);
    if (result.status !== 'found') return result;
    const { account_id: returnedId, sequence } = result.value;
    if (returnedId !== accountId || typeof sequence !== 'string' || !/^\d+$/.test(sequence))
      return { status: 'unavailable', reason: 'invalid_response' };
    return { status: 'found', value: { accountId, sequence } };
  }

  async getTransaction(hash: string): Promise<StellarNetworkResult<StellarTransactionState>> {
    if (!/^[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
    const normalized = hash.toLowerCase();
    const result = await this.request(`transactions/${normalized}`);
    if (result.status !== 'found') return result;
    const { hash: returnedHash, successful, ledger } = result.value;
    if (
      returnedHash !== normalized ||
      typeof successful !== 'boolean' ||
      typeof ledger !== 'number' ||
      !Number.isSafeInteger(ledger) ||
      ledger < 1
    )
      return { status: 'unavailable', reason: 'invalid_response' };
    return { status: 'found', value: { hash: normalized, successful, ledger } };
  }

  /** Submit an already-signed envelope. Unknown outcomes always retain its original hash. */
  async submitTransaction(signedXdr: string): Promise<StellarSubmissionResult> {
    const hash = signedSettlementHash(signedXdr, this.networkPassphrase);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const root = await this.fetchImpl(this.baseUrl, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!root.ok) return { outcome: 'unknown', hash, reason: 'network' };
      const rootBody: unknown = await root.json();
      if (!isRecord(rootBody) || typeof rootBody.network_passphrase !== 'string')
        return { outcome: 'unknown', hash, reason: 'invalid_response' };
      if (rootBody.network_passphrase !== this.networkPassphrase)
        return { outcome: 'unknown', hash, reason: 'network_mismatch' };

      const response = await this.fetchImpl(new URL('transactions', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tx: signedXdr }),
        signal: controller.signal,
        redirect: 'error',
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 400) {
        const extras = isRecord(body) && isRecord(body.extras) ? body.extras : null;
        const codes = extras && isRecord(extras.result_codes) ? extras.result_codes : null;
        const transactionCode =
          codes && typeof codes.transaction === 'string' ? codes.transaction : 'rejected';
        return { outcome: 'rejected', hash, code: transactionCode };
      }
      if (!response.ok) return { outcome: 'unknown', hash, reason: 'network' };
      if (!isRecord(body) || body.hash !== hash)
        return { outcome: 'unknown', hash, reason: 'invalid_response' };
      if (body.successful === false) return { outcome: 'rejected', hash, code: 'unsuccessful' };
      if (
        body.successful === true &&
        typeof body.ledger === 'number' &&
        Number.isSafeInteger(body.ledger) &&
        body.ledger > 0
      ) {
        return { outcome: 'confirmed', hash, ledger: body.ledger };
      }
      return { outcome: 'unknown', hash, reason: 'not_confirmed' };
    } catch {
      return {
        outcome: 'unknown',
        hash,
        reason: controller.signal.aborted ? 'timeout' : 'network',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export type StellarSubmissionResult =
  | { outcome: 'confirmed'; hash: string; ledger: number }
  | { outcome: 'rejected'; hash: string; code: string }
  | {
      outcome: 'unknown';
      hash: string;
      reason: 'network' | 'timeout' | 'invalid_response' | 'network_mismatch' | 'not_confirmed';
    };
