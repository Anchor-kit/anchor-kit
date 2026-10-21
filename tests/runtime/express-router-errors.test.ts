import { AnchorConfig } from '@/core/config.ts';
import { PayloadTooLargeError, ValidationError } from '@/core/errors.ts';
import { AnchorExpressRouter } from '@/runtime/http/express-router.ts';
import type {
  AccountLookup,
  AccountLookupResult,
  DatabaseAdapter,
} from '@/runtime/interfaces.ts';
import { Keypair } from '@stellar/stellar-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

interface TestResult {
  status: number;
  body: Record<string, unknown>;
  nextError?: unknown;
}

const config = new AnchorConfig({
  network: { network: 'testnet' },
  server: { interactiveDomain: 'https://anchor.example.com' },
  security: {
    sep10SigningKey: Keypair.random().secret(),
    interactiveJwtSecret: 'router-error-test-secret',
    distributionAccountSecret: Keypair.random().secret(),
  },
  assets: {
    assets: [
      {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
    ],
  },
  framework: {
    database: { provider: 'sqlite', url: 'file:router-errors-test.sqlite' },
    http: { maxBodyBytes: 1024 },
  },
});

function createMiddleware(
  database: Partial<DatabaseAdapter> = {},
  accountLookup?: AccountLookup,
) {
  return new AnchorExpressRouter({
    config,
    database: database as DatabaseAdapter,
    accountLookup,
    webhookProcessor: {
      async process(input) {
        return { duplicate: false, eventId: input.eventId, provider: input.provider };
      },
    },
  }).getMiddleware();
}

function invoke(
  middleware: ReturnType<typeof createMiddleware>,
  options: { method: string; path: string; body?: string },
  withNext = false,
): Promise<TestResult> {
  const req = Readable.from(options.body ? [options.body] : []) as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = options.method;
  req.url = options.path;
  req.headers = {};

  return new Promise((resolve) => {
    let status = 200;
    const headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      get statusCode() {
        return status;
      },
      set statusCode(value: number) {
        status = value;
      },
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      end(payload?: string) {
        resolve({
          status,
          body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
        });
      },
    } as unknown as ServerResponse;

    middleware(
      req,
      res,
      withNext ? (error) => resolve({ status, body: {}, nextError: error }) : undefined,
    );
  });
}

describe('AnchorExpressRouter error responses', () => {
  it('maps ValidationError to its stable status and JSON payload without next', async () => {
    const middleware = createMiddleware({
      async insertAuthChallenge() {
        throw new ValidationError('Invalid challenge data');
      },
    });
    const response = await invoke(middleware, {
      method: 'GET',
      path: `/auth/challenge?account=${Keypair.random().publicKey()}`,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'INVALID_REQUEST',
      message: 'Invalid challenge data',
    });
  });

  it('maps PayloadTooLargeError to its stable status and JSON payload without next', async () => {
    const middleware = createMiddleware({
      async insertAuthChallenge() {
        throw new PayloadTooLargeError('Request exceeded the configured size');
      },
    });
    const response = await invoke(middleware, {
      method: 'GET',
      path: `/auth/challenge?account=${Keypair.random().publicKey()}`,
    });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: 'PAYLOAD_TOO_LARGE',
      message: 'Request exceeded the configured size',
    });
  });

  it('loads signers and thresholds for an existing account through the injectable lookup', async () => {
    const account = Keypair.random().publicKey();
    const signer = Keypair.random().publicKey();
    const accountLookup: AccountLookup = {
      async loadAccount() {
        return {
          kind: 'found',
          account: {
            accountId: account,
            signers: [
              { key: account, weight: 1 },
              { key: signer, weight: 2 },
            ],
            thresholds: { low: 1, medium: 2, high: 2 },
          },
        };
      },
    };
    const middleware = createMiddleware({}, accountLookup);
    const response = await invoke(middleware, {
      method: 'GET',
      path: `/auth/challenge?account=${account}`,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ account });
  });

  it('distinguishes a nonexistent account from an unavailable upstream lookup', async () => {
    const account = Keypair.random().publicKey();
    const notFoundLookup: AccountLookup = {
      async loadAccount(): Promise<AccountLookupResult> {
        return { kind: 'not_found' };
      },
    };
    const notFoundResponse = await invoke(
      createMiddleware({}, notFoundLookup),
      { method: 'GET', path: `/auth/challenge?account=${account}` },
    );
    expect(notFoundResponse.status).toBe(404);
    expect(notFoundResponse.body).toEqual({
      error: 'ACCOUNT_NOT_FOUND',
      message: 'Account not found.',
    });

    const unavailableLookup: AccountLookup = {
      async loadAccount(): Promise<AccountLookupResult> {
        return { kind: 'upstream_error', message: 'horizon unavailable' };
      },
    };
    const unavailableResponse = await invoke(
      createMiddleware({}, unavailableLookup),
      { method: 'GET', path: `/auth/challenge?account=${account}` },
    );
    expect(unavailableResponse.status).toBe(502);
    expect(unavailableResponse.body).toEqual({
      error: 'ACCOUNT_LOOKUP_UNAVAILABLE',
      message: 'Account lookup is temporarily unavailable.',
    });
  });

  it('keeps unknown errors generic and forwards errors to next when configured', async () => {
    const failure = new Error('database details must remain private');
    const middleware = createMiddleware({
      async insertAuthChallenge() {
        throw failure;
      },
    });
    const path = `/auth/challenge?account=${Keypair.random().publicKey()}`;

    const response = await invoke(middleware, { method: 'GET', path });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An internal server error occurred.',
    });

    const forwarded = await invoke(middleware, { method: 'GET', path }, true);
    expect(forwarded.nextError).toBe(failure);
  });
});
