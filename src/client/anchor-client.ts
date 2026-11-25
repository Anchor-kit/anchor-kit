/** Stable failure categories; response bodies and credentials are never included. */
export class AnchorClientError extends Error {
  constructor(
    public readonly code: 'network' | 'http' | 'invalid_response',
    public readonly status?: number,
  ) {
    super(`Anchor request failed: ${code}`);
    this.name = 'AnchorClientError';
  }
}

export interface AuthChallenge {
  transaction: string;
  network_passphrase?: string;
}
export interface AuthToken {
  token: string;
}
export interface DepositRequest {
  asset_code: string;
  asset_issuer?: string;
  amount?: string;
  account?: string;
}
export interface InteractiveResponse {
  type: 'interactive_customer_info_needed';
  url: string;
  id: string;
}
export interface TransactionResponse {
  transaction: { id: string; status: string; kind?: 'deposit' | 'withdrawal' };
}
export interface AnchorClientOptions {
  /** Full SEP-10 WEB_AUTH_ENDPOINT URL. */
  authEndpoint: string;
  /** SEP-24 transfer server URL, including its path prefix. */
  transferServer: string;
  fetch?: typeof fetch;
}

function checkedEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new TypeError('Endpoint must be an HTTPS URL without credentials, query or fragment');
  return url;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function bearer(token: string): string {
  if (!token || /\s/.test(token)) throw new TypeError('Invalid bearer token');
  return `Bearer ${token}`;
}

export class AnchorClient {
  private readonly authEndpoint: URL;
  private readonly transferServer: URL;
  private readonly fetcher: typeof fetch;
  constructor(options: AnchorClientOptions) {
    this.authEndpoint = checkedEndpoint(options.authEndpoint);
    this.transferServer = checkedEndpoint(options.transferServer);
    if (!this.transferServer.pathname.endsWith('/')) this.transferServer.pathname += '/';
    this.fetcher = options.fetch ?? fetch;
  }
  private async request(url: URL, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new AnchorClientError('network');
    }
    if (!response.ok) throw new AnchorClientError('http', response.status);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new AnchorClientError('invalid_response');
    }
  }
  async getChallenge(account: string): Promise<AuthChallenge> {
    const url = new URL(this.authEndpoint);
    url.searchParams.set('account', account);
    const result = object(await this.request(url, { method: 'GET' }));
    if (
      !result ||
      !nonempty(result.transaction) ||
      (result.network_passphrase !== undefined && !nonempty(result.network_passphrase))
    )
      throw new AnchorClientError('invalid_response');
    return {
      transaction: result.transaction,
      ...(result.network_passphrase === undefined
        ? {}
        : { network_passphrase: result.network_passphrase }),
    };
  }
  async exchangeChallenge(signedTransaction: string): Promise<AuthToken> {
    const body = new URLSearchParams({ transaction: signedTransaction });
    const result = object(
      await this.request(this.authEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    if (!result || !nonempty(result.token)) throw new AnchorClientError('invalid_response');
    return { token: result.token };
  }
  async initiateDeposit(token: string, input: DepositRequest): Promise<InteractiveResponse> {
    const result = object(
      await this.request(new URL('transactions/deposit/interactive', this.transferServer), {
        method: 'POST',
        headers: { authorization: bearer(token), 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
    if (
      !result ||
      result.type !== 'interactive_customer_info_needed' ||
      !nonempty(result.url) ||
      !nonempty(result.id)
    )
      throw new AnchorClientError('invalid_response');
    try {
      const interactiveUrl = new URL(result.url);
      if (
        interactiveUrl.protocol !== 'https:' ||
        interactiveUrl.username ||
        interactiveUrl.password
      )
        throw new Error();
    } catch {
      throw new AnchorClientError('invalid_response');
    }
    return { type: result.type, url: result.url, id: result.id };
  }
  async getTransaction(token: string, id: string): Promise<TransactionResponse> {
    const url = new URL('transaction', this.transferServer);
    url.searchParams.set('id', id);
    const result = object(
      await this.request(url, { method: 'GET', headers: { authorization: bearer(token) } }),
    );
    const transaction = object(result?.transaction);
    if (
      !transaction ||
      !nonempty(transaction.id) ||
      transaction.id !== id ||
      !nonempty(transaction.status) ||
      (transaction.kind !== undefined &&
        transaction.kind !== 'deposit' &&
        transaction.kind !== 'withdrawal')
    )
      throw new AnchorClientError('invalid_response');
    return {
      transaction: {
        id: transaction.id,
        status: transaction.status,
        ...(transaction.kind === undefined ? {} : { kind: transaction.kind }),
      },
    };
  }
}
