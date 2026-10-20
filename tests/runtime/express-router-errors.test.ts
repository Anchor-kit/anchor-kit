import { AnchorConfig } from '@/core/config.ts';
import { PayloadTooLargeError, ValidationError } from '@/core/errors.ts';
import { AnchorExpressRouter } from '@/runtime/http/express-router.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
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

function createMiddleware(database: Partial<DatabaseAdapter> = {}) {
  return new AnchorExpressRouter({
    config,
    database: database as DatabaseAdapter,
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
