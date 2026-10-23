import { AnchorConfig } from '@/core/config.ts';
import { AnchorExpressRouter } from '@/runtime/http/express-router.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { Keypair } from '@stellar/stellar-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

function createMiddleware() {
  const signingKeypair = Keypair.random();
  const config = new AnchorConfig({
    network: { network: 'testnet' },
    server: {
      webAuthEndpoint: 'https://anchor.example.com/auth',
      transferServerSep24: 'https://anchor.example.com/sep24',
    },
    security: {
      sep10SigningKey: signingKeypair.secret(),
      interactiveJwtSecret: 'stellar-toml-test-secret',
      distributionAccountSecret: Keypair.random().secret(),
    },
    assets: {
      assets: [
        { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      ],
    },
    framework: { database: { provider: 'sqlite', url: 'file:stellar-toml-test.sqlite' } },
  });
  const middleware = new AnchorExpressRouter({
    config,
    database: {} as DatabaseAdapter,
    webhookProcessor: {
      async process(input) {
        return { duplicate: false, eventId: input.eventId, provider: input.provider };
      },
    },
  }).getMiddleware();
  return { middleware, signingKeypair };
}

function invoke(
  middleware: ReturnType<typeof createMiddleware>['middleware'],
  method: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const req = Readable.from([]) as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = '/.well-known/stellar.toml';
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
        resolve({ status, headers, body: payload ?? '' });
      },
    } as unknown as ServerResponse;
    middleware(req, res);
  });
}

describe('SEP-1 stellar.toml route', () => {
  it('publishes configured HTTPS endpoints, the SEP-10 key, and network passphrase', async () => {
    const { middleware, signingKeypair } = createMiddleware();
    const response = await invoke(middleware, 'GET');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.body).toContain(`SIGNING_KEY = "${signingKeypair.publicKey()}"`);
    expect(response.body).toContain('NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"');
    expect(response.body).toContain('WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"');
    expect(response.body).toContain('TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"');
  });

  it('supports HEAD without returning the document body', async () => {
    const { middleware } = createMiddleware();
    const response = await invoke(middleware, 'HEAD');

    expect(response.status).toBe(200);
    expect(Number(response.headers['content-length'])).toBeGreaterThan(0);
    expect(response.body).toBe('');
  });
});
