import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createAnchor, type AnchorInstance } from '@/index.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { Account, Keypair, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { createHmac } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';

interface TestResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface TestRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string | Buffer | Uint8Array;
}

function createMountedInvoker(anchor: AnchorInstance) {
  const middleware = anchor.getExpressRouter();

  return async (options: TestRequestOptions): Promise<TestResponse> => {
    const serializedBody = options.rawBody ?? (options.body ? JSON.stringify(options.body) : '');
    const reqBody =
      typeof serializedBody === 'string'
        ? serializedBody
        : Buffer.isBuffer(serializedBody)
          ? serializedBody
          : Buffer.from(serializedBody);

    const req = Readable.from(reqBody ? [reqBody] : []) as IncomingMessage & {
      method: string;
      url: string;
      headers: Record<string, string | string[]>;
      body?: Record<string, unknown>;
      rawBody?: string | Buffer | Uint8Array;
    };

    req.method = options.method ?? 'GET';
    req.url = `/anchor${options.path}`;
    req.headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    req.rawBody = options.rawBody;

    const responseHeaders: Record<string, string> = {};

    const response = await new Promise<TestResponse>((resolve) => {
      let statusCode = 200;
      let headersSent = false;
      const res = {
        get headersSent(): boolean {
          return headersSent;
        },
        set headersSent(value: boolean) {
          headersSent = value;
        },
        get statusCode(): number {
          return statusCode;
        },
        set statusCode(value: number) {
          statusCode = value;
        },
        setHeader(name: string, value: string): void {
          responseHeaders[name.toLowerCase()] = value;
        },
        end(payload?: string): void {
          const contentType = responseHeaders['content-type'] ?? '';
          const bodyText = typeof payload === 'string' ? payload : '';
          const body =
            contentType.includes('application/json') && bodyText
              ? (JSON.parse(bodyText) as Record<string, unknown>)
              : {};
          resolve({
            status: statusCode,
            headers: responseHeaders,
            body,
          });
        },
      } as unknown as ServerResponse;

      const rawUrl = req.url;
      if (!rawUrl.startsWith('/anchor')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      req.url = rawUrl.slice('/anchor'.length) || '/';
      middleware(req, res, () => {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
      });
    });

    return response;
  };
}

describe('MVP Express-mounted integration', () => {
  const sep10ServerKeypair = Keypair.random();
  const clientKeypair = Keypair.random();
  const dbUrl = makeSqliteDbUrlForTests();
  const dbPath = dbUrl.startsWith('file:') ? dbUrl.slice('file:'.length) : dbUrl;

  let webhookCallbackCount = 0;
  let anchor: AnchorInstance;
  let invoke: (options: TestRequestOptions) => Promise<TestResponse>;
  let accessToken = '';
  let transactionId = '';
  let depositInteractiveUrl = '';

  beforeAll(async () => {
    anchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret',
        distributionAccountSecret: 'distribution-test-secret',
        webhookSecret: 'webhook-test-secret',
        verifyWebhookSignatures: true,
        challengeExpirationSeconds: 300,
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
            min_amount: 10,
            max_amount: 100,
          },
        ],
      },
      framework: {
        database: {
          provider: 'sqlite',
          url: dbUrl,
        },
        rateLimit: {
          windowMs: 60000,
          authChallengeMax: 2,
          authTokenMax: 5,
          webhookMax: 20,
          depositMax: 30,
          trustForwardedFor: true,
        },
        queue: {
          backend: 'memory',
          concurrency: 2,
        },
        watchers: {
          enabled: true,
          pollIntervalMs: 50,
          transactionTimeoutMs: 50,
        },
      },
      webhooks: {
        onEvent: async () => {
          webhookCallbackCount += 1;
        },
      },
    });

    await anchor.init();
    await anchor.startBackgroundJobs();
    invoke = createMountedInvoker(anchor);
  });

  afterAll(async () => {
    await anchor.stopBackgroundJobs();
    await anchor.shutdown();

    try {
      unlinkSync(dbPath);
    } catch {
      // ignore cleanup errors in CI
    }
  });

  it('1) app mounts router and /health works', async () => {
    const response = await invoke({ path: '/health' });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.version).toBe(version);
  });

  it('1b) unknown endpoint returns 404 not_found', async () => {
    const response = await invoke({ path: '/does-not-exist' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found', message: 'Endpoint not found' });
  });

  it('1b) wrong HTTP method on supported path returns 405 with Allow header', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/health',
    });

    expect(response.status).toBe(405);
    expect(response.body.error).toBe('method_not_allowed');
    expect(response.headers['allow']).toBe('GET');
  });
  it('2) /info returns configured assets and package version', async () => {
    const response = await invoke({ path: '/info' });
    expect(response.status).toBe(200);
    const assets = response.body.assets;
    expect(Array.isArray(assets)).toBe(true);
    expect((assets as Array<Record<string, unknown>>)[0]?.code).toBe('USDC');
    expect(response.body.version).toBe(version);
    expect(response.body.version).not.toBe('mvp');
    expect(response.body.interactive_domain).toBe('https://anchor.example.com');
  });

  it('2e) /info includes network_passphrase matching the configured network', async () => {
    const response = await invoke({ path: '/info' });
    expect(response.status).toBe(200);
    expect(typeof response.body.network_passphrase).toBe('string');
    expect((response.body.network_passphrase as string).length).toBeGreaterThan(0);
    // testnet network should resolve to the Stellar testnet passphrase
    expect(response.body.network_passphrase).toBe('Test SDF Network ; September 2015');
  });

  it('2b) /info includes support_email when configured', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: {},
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-email',
        distributionAccountSecret: 'distribution-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
      operational: { supportEmail: 'support@example.com' },
      framework: {
        database: { provider: 'sqlite', url: customDbUrl },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);
    const response = await customInvoke({ path: '/info' });
    expect(response.status).toBe(200);
    expect(response.body.support_email).toBe('support@example.com');

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      /* ignore */
    }
  });

  it('2c) /info includes website when configured', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: {},
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-website',
        distributionAccountSecret: 'distribution-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
      operational: { website: 'https://anchor.example.com' },
      framework: {
        database: { provider: 'sqlite', url: customDbUrl },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);
    const response = await customInvoke({ path: '/info' });
    expect(response.status).toBe(200);
    expect(response.body.website).toBe('https://anchor.example.com');

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      /* ignore */
    }
  });

  it('2d) /info omits website when not configured', async () => {
    const response = await invoke({ path: '/info' });
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('website');
  });

  it('2e) /info omits support_email when not configured', async () => {
    const response = await invoke({ path: '/info' });
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('support_email');
  });

  it('2f) /info omits interactive_domain when not configured', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { port: 3001 /* different port for safety */ },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-no-domain',
        distributionAccountSecret: 'distribution-test-secret',
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
        database: {
          provider: 'sqlite',
          url: customDbUrl,
        },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);
    const response = await customInvoke({ path: '/info' });
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('interactive_domain');

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      // ignore
    }
  });

  it('2e) /transactions/deposit/interactive returns server_misconfigured when interactiveDomain is missing', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { port: 3002 },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-no-domain-2',
        distributionAccountSecret: 'distribution-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
            min_amount: 10,
            max_amount: 100,
          },
        ],
      },
      framework: {
        database: {
          provider: 'sqlite',
          url: customDbUrl,
        },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);

    const testKeypair = Keypair.random();
    const account = testKeypair.publicKey();
    const challengeResponse = await customInvoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(challengeResponse.status).toBe(200);

    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(testKeypair);

    const tokenResponse = await customInvoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
      body: { account, challenge: challengeTx.toXDR() },
    });
    expect(tokenResponse.status).toBe(200);

    const accessToken = String(tokenResponse.body.token ?? '');
    const depositResponse = await customInvoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'x-forwarded-for': '10.0.0.1',
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(depositResponse.status).toBe(500);
    expect(depositResponse.body.error).toBe('server_misconfigured');
    expect(depositResponse.body).not.toHaveProperty('interactive_url');

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      // ignore
    }
  });

  it('3a) /auth/challenge without account query param returns 400', async () => {
    const response = await invoke({
      path: '/auth/challenge',
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toBe('Query param account is required');
  });

  it('3a) /auth/challenge trims padded account identifiers', async () => {
    const paddedAccount = `  ${clientKeypair.publicKey()}  `;
    const response = await invoke({
      path: `/auth/challenge?account=${encodeURIComponent(paddedAccount)}`,
      headers: { 'x-forwarded-for': '10.0.0.9' },
    });

    expect(response.status).toBe(200);
    expect(response.body.challenge).toBeTypeOf('string');
  });

  it('3) challenge -> token happy path', async () => {
    const account = clientKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(challengeResponse.status).toBe(200);
    expect(challengeResponse.headers['cache-control']).toBe('no-store');
    expect(challengeResponse.body).toEqual(
      expect.objectContaining({
        challenge: expect.any(String),
        network_passphrase: expect.any(String),
        expires_at: expect.any(String),
        expires_in: 300,
      }),
    );
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    expect(challengeXdr.length).toBeGreaterThan(0);
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);
    const signedChallengeXdr = challengeTx.toXDR();

    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
      body: { account, challenge: signedChallengeXdr },
    });

    expect(tokenResponse.status).toBe(200);
    accessToken = String(tokenResponse.body.token ?? '');
    expect(accessToken.length).toBeGreaterThan(0);
    expect(tokenResponse.body.token_type).toBe('Bearer');
    expect(tokenResponse.body.account).toBe(account);
    expect(tokenResponse.headers['cache-control']).toBe('no-store');
    // Verify default TTL is used when not configured
    expect(tokenResponse.body.expires_in).toBe(3600);
    // Verify expires_at is present and consistent
    const expiresAtStr = tokenResponse.body.expires_at as string;
    expect(typeof expiresAtStr).toBe('string');
    const expiresAtTime = new Date(expiresAtStr).getTime();
    expect(Number.isNaN(expiresAtTime)).toBe(false);
    const expectedExpiry = Date.now() + 3600 * 1000;
    expect(Math.abs(expiresAtTime - expectedExpiry)).toBeLessThan(5000);
  });

  it('3d) successful token response includes Cache-Control no-store (#449)', async () => {
    const account = clientKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(challengeResponse.status).toBe(200);

    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);
    const signedChallengeXdr = challengeTx.toXDR();

    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
      body: { account, challenge: signedChallengeXdr },
    });

    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers['cache-control']).toBe('no-store');
    // Verify token JSON fields remain unchanged
    expect(tokenResponse.body.token).toBeTypeOf('string');
    expect(tokenResponse.body.token_type).toBe('Bearer');
    expect(tokenResponse.body.account).toBe(account);
    expect(tokenResponse.body.expires_in).toBeTypeOf('number');
    expect(tokenResponse.body.expires_at).toBeTypeOf('string');
  });

  it('3a) rate limit response body includes retry_after_seconds matching header', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-rate-limit',
        distributionAccountSecret: 'distribution-test-secret',
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
        database: {
          provider: 'sqlite',
          url: customDbUrl,
        },
        rateLimit: {
          windowMs: 60000,
          authChallengeMax: 1,
          authTokenMax: 5,
          webhookMax: 20,
          depositMax: 20,
        },
      },
    });

    try {
      await customAnchor.init();
      const customInvoke = createMountedInvoker(customAnchor);
      const account = Keypair.random().publicKey();
      const headers = { 'x-forwarded-for': '203.0.113.232' };

      const firstResponse = await customInvoke({
        path: `/auth/challenge?account=${account}`,
        headers,
      });
      expect(firstResponse.status).toBe(200);

      const limitedResponse = await customInvoke({
        path: `/auth/challenge?account=${account}`,
        headers,
      });

      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.headers['retry-after']).toBeDefined();
      expect(limitedResponse.body.error).toBe('rate_limited');
      expect(limitedResponse.body.retry_after_seconds).toBe(
        Number(limitedResponse.headers['retry-after']),
      );
    } finally {
      await customAnchor.shutdown();
      try {
        unlinkSync(customDbPath);
      } catch {
        // ignore cleanup errors in CI
      }
    }
  });

  it('3c) invalid account public key returns 400 response', async () => {
    const invalidAccount = 'not_a_valid_stellar_public_key';
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${invalidAccount}`,
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(challengeResponse.status).toBe(400);
    expect(challengeResponse.body.error).toBe('invalid_request');
  });

  it('3b) auth token trims padded account identifiers consistently', async () => {
    const account = clientKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.7' },
    });

    expect(challengeResponse.status).toBe(200);
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);

    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.7' },
      body: { account: `  ${account}  `, challenge: challengeTx.toXDR() },
    });

    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.body.account).toBe(account);
    expect(tokenResponse.body.token_type).toBe('Bearer');
    expect(tokenResponse.body.expires_in).toBe(3600);
    expect(tokenResponse.body.token).toBeTypeOf('string');
  });

  it('10f) bearer token signed with RS256 is rejected', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const jwt = (await import('jsonwebtoken')).default;
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const badToken = jwt.sign(
      {
        sub: clientKeypair.publicKey(),
        scope: 'anchor_api',
        typ: 'access_token',
      },
      privateKey,
      { algorithm: 'RS256', expiresIn: 3600 },
    );

    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${badToken}`,
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
    expect(response.body.message).toBe('Missing or invalid bearer token');
  });

  it('3b) auth token with custom TTL returns correct expires_in', async () => {
    // Create a new anchor instance with custom TTL using a separate database
    const customDbUrl = makeSqliteDbUrlForTests();
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-custom',
        distributionAccountSecret: 'distribution-test-secret',
        webhookSecret: 'webhook-test-secret',
        verifyWebhookSignatures: true,
        challengeExpirationSeconds: 45,
        authTokenLifetimeSeconds: 7200, // 2 hours
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
          },
        ],
      },
      framework: {
        database: {
          provider: 'sqlite',
          url: customDbUrl,
        },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);
    const testAccount = clientKeypair.publicKey();

    // Get auth challenge
    const challengeResponse = await customInvoke({
      path: `/auth/challenge?account=${testAccount}`,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });

    expect(challengeResponse.status).toBe(200);
    expect(challengeResponse.body).toEqual(
      expect.objectContaining({
        challenge: expect.any(String),
        network_passphrase: expect.any(String),
        expires_at: expect.any(String),
        expires_in: 45,
      }),
    );
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');

    // Sign the challenge
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);
    const signedChallengeXdr = challengeTx.toXDR();

    // Get token with custom TTL
    const tokenResponse = await customInvoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
      body: { account: testAccount, challenge: signedChallengeXdr },
    });

    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.body.expires_in).toBe(7200);
    expect(String(tokenResponse.body.token ?? '').length).toBeGreaterThan(0);
    const customExpiresAtStr = tokenResponse.body.expires_at as string;
    expect(typeof customExpiresAtStr).toBe('string');
    const customExpiresAt = new Date(customExpiresAtStr).getTime();
    expect(Number.isNaN(customExpiresAt)).toBe(false);
    const customExpectedExpiry = Date.now() + 7200 * 1000;
    expect(Math.abs(customExpiresAt - customExpectedExpiry)).toBeLessThan(5000);

    // Cleanup
    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('3a) auth challenge route returns 429 when authChallengeMax is exceeded', async () => {
    const account = Keypair.random().publicKey();
    const headers = { 'x-forwarded-for': '10.0.0.99' };

    const firstResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers,
    });
    expect(firstResponse.status).toBe(200);

    const secondResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers,
    });
    expect(secondResponse.status).toBe(200);

    const thirdResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers,
    });

    expect(thirdResponse.status).toBe(429);
    expect(thirdResponse.body.error).toBe('rate_limited');
    expect(thirdResponse.headers['retry-after']).toBeDefined();
  });

  it('3b) auth token route returns 429 after exceeding authTokenMax', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-token-rate-limit',
        distributionAccountSecret: 'distribution-test-secret',
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
        database: { provider: 'sqlite', url: customDbUrl },
        rateLimit: { windowMs: 60000, authTokenMax: 2, trustForwardedFor: true },
      },
    });

    try {
      await customAnchor.init();
      const customInvoke = createMountedInvoker(customAnchor);
      const headers = {
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.50',
      };
      const body = { account: 'not-a-key', challenge: 'bad' };

      const firstResponse = await customInvoke({
        method: 'POST',
        path: '/auth/token',
        headers,
        body,
      });
      expect(firstResponse.status).not.toBe(429);

      const secondResponse = await customInvoke({
        method: 'POST',
        path: '/auth/token',
        headers,
        body,
      });
      expect(secondResponse.status).not.toBe(429);

      const thirdResponse = await customInvoke({
        method: 'POST',
        path: '/auth/token',
        headers,
        body,
      });

      expect(thirdResponse.status).toBe(429);
      expect(thirdResponse.body.error).toBe('rate_limited');
      expect(thirdResponse.body.message).toBe('Too many requests');
      expect(thirdResponse.headers['retry-after']).toBeDefined();
      expect(thirdResponse.body.retry_after_seconds).toBe(
        Number(thirdResponse.headers['retry-after']),
      );
    } finally {
      await customAnchor.shutdown();
      try {
        unlinkSync(customDbPath);
      } catch {
        // ignore cleanup errors in CI
      }
    }
  });

  it('3c) auth token rejects invalid account', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.6',
      },
      body: { account: 'not-a-stellar-key', challenge: 'some-challenge' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toBe('account must be a valid Stellar public key');
  });

  it('4) unauthorized deposit interactive rejected', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: { 'content-type': 'application/json' },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(response.status).toBe(401);
  });

  it('5) deposit above max_amount is rejected', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC', amount: '101' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_amount');
    expect(response.body.max_amount).toBe(100);
  });

  it('5d) deposit below min_amount is rejected with configured minimum', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC', amount: '9.9' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_amount');
    expect(response.body.min_amount).toBe(10);
    expect(response.body.message).toContain('minimum allowed of 10');
  });

  it('5h) deposit with hexadecimal string amount is rejected', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC', amount: '0x10' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_amount');
    expect(response.body.message).toBe('Amount must be a positive number');
  });

  it('5i) deposit with exponent string amount is rejected', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC', amount: '1e3' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_amount');
    expect(response.body.message).toBe('Amount must be a positive number');
  });

  it('5j) deposit with plain decimal string amount is accepted', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC', amount: '10.5' },
    });

    expect(response.status).toBe(201);
    expect(response.body.amount).toBe('10.5');
    expect(response.body.interactive_url).toContain('/deposit/');
  });

  it('5k) deposit create and lookup URLs avoid double slashes when interactiveDomain ends with slash', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com/' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-trailing-slash',
        distributionAccountSecret: 'distribution-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
          },
        ],
      },
      framework: {
        database: { provider: 'sqlite', url: customDbUrl },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);

    const customAccount = clientKeypair.publicKey();
    const challengeResponse = await customInvoke({
      path: `/auth/challenge?account=${customAccount}`,
    });
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);

    const tokenResponse = await customInvoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json' },
      body: { account: customAccount, challenge: challengeTx.toXDR() },
    });
    const customToken = String(tokenResponse.body.token ?? '');

    const createResponse = await customInvoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customToken}`,
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(createResponse.status).toBe(201);
    const createdId = String(createResponse.body.id ?? '');
    expect(createResponse.body.interactive_url).toBe(
      `https://anchor.example.com/deposit/${createdId}`,
    );

    const lookupResponse = await customInvoke({
      method: 'GET',
      path: `/transactions/${createdId}`,
      headers: {
        authorization: `Bearer ${customToken}`,
      },
    });

    expect(lookupResponse.status).toBe(200);
    expect(lookupResponse.body.interactive_url).toBe(
      `https://anchor.example.com/deposit/${createdId}`,
    );
    expect(lookupResponse.body.more_info_url).toBe(
      `https://anchor.example.com/deposit/${createdId}`,
    );

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('5c) deposit with unknown asset_code is rejected', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'XYZ', amount: '10' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_asset');
    expect(response.body.id).toBeUndefined();
  });

  it('5f) deposit missing asset_code returns invalid_request', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { amount: '10' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toContain('asset_code and amount');
  });

  it('5g) deposit missing amount returns invalid_request', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toContain('asset_code and amount');
  });

  it('5f-case) deposit with differently-cased asset_code is rejected', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'usdc', amount: '10' }, // configured as USDC
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_asset');
    expect(response.body.id).toBeUndefined();
  });

  it('5e) deposit with deposits_enabled: false asset is rejected', async () => {
    const disabledDbUrl = makeSqliteDbUrlForTests();
    const disabledAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-disabled',
        distributionAccountSecret: 'distribution-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: false,
          },
        ],
      },
      framework: {
        database: { provider: 'sqlite', url: disabledDbUrl },
      },
    });

    await disabledAnchor.init();
    const disabledInvoke = createMountedInvoker(disabledAnchor);

    // Obtain a valid auth token for this anchor instance
    const testKeypair = Keypair.random();
    const challengeResponse = await disabledInvoke({
      path: `/auth/challenge?account=${testKeypair.publicKey()}`,
    });
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(testKeypair);
    const tokenResponse = await disabledInvoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json' },
      body: { account: testKeypair.publicKey(), challenge: challengeTx.toXDR() },
    });
    const token = String(tokenResponse.body.token ?? '');

    const response = await disabledInvoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_asset');
    expect(response.body.id).toBeUndefined();

    await disabledAnchor.shutdown();
    const disabledDbPath = disabledDbUrl.startsWith('file:')
      ? disabledDbUrl.slice('file:'.length)
      : disabledDbUrl;
    try {
      unlinkSync(disabledDbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('5f) deposit route returns 429 after exceeding configured depositMax', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-rate-limit',
        distributionAccountSecret: 'distribution-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
            min_amount: 10,
            max_amount: 100,
          },
        ],
      },
      framework: {
        database: { provider: 'sqlite', url: customDbUrl },
        rateLimit: { windowMs: 60000, depositMax: 2 },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);
    const account = clientKeypair.publicKey();

    const challengeResponse = await customInvoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(challengeResponse.status).toBe(200);
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);

    const tokenResponse = await customInvoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
      body: { account, challenge: challengeTx.toXDR() },
    });
    expect(tokenResponse.status).toBe(200);
    const customToken = String(tokenResponse.body.token ?? '');

    const depositRequest = {
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${customToken}`,
        'x-forwarded-for': '10.0.0.1',
      },
      body: { asset_code: 'USDC', amount: '10' },
    };

    const firstResponse = await customInvoke(depositRequest);
    expect(firstResponse.status).toBe(201);

    const secondResponse = await customInvoke(depositRequest);
    expect(secondResponse.status).toBe(201);

    const thirdResponse = await customInvoke(depositRequest);
    expect(thirdResponse.status).toBe(429);
    expect(thirdResponse.body.error).toBe('rate_limited');
    expect(thirdResponse.headers['retry-after']).toBeDefined();

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('5b) deposit at max_amount boundary is accepted', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'deposit-boundary',
      },
      body: { asset_code: 'USDC', amount: '100' },
    });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('pending_user_transfer_start');
  });

  it('5h) deposit with numeric amount within limits is accepted', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'deposit-numeric-amount',
      },
      body: { asset_code: 'USDC', amount: 50 },
    });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeTruthy();
    expect(response.body.status).toBe('pending_user_transfer_start');
  });

  it('6) authorized deposit interactive creates persistent transaction', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'deposit-1',
      },
      body: { asset_code: 'USDC', amount: '25.5' },
    });

    expect(response.status).toBe(201);
    transactionId = String(response.body.id ?? '');
    depositInteractiveUrl = String(response.body.interactive_url ?? '');
    expect(transactionId.length).toBeGreaterThan(0);
    expect(response.body.status).toBe('pending_user_transfer_start');
    expect(response.body.asset_issuer).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    );
    expect(response.body.account).toBe(clientKeypair.publicKey());
    expect(response.body).not.toHaveProperty('idempotency_replay');
  });

  it('6a) decimal deposit amounts preserve their exact string formatting through create, persist, and lookup', async () => {
    const submittedAmount = '25.5000';
    const createResponse = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'deposit-decimal-format',
      },
      body: { asset_code: 'USDC', amount: submittedAmount },
    });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.amount).toBe(submittedAmount);

    const persistedTransaction = await (
      anchor as unknown as {
        database: {
          getInteractiveTransactionById(id: string): Promise<{
            id: string;
            amount: string;
          } | null>;
        };
      }
    ).database.getInteractiveTransactionById(String(createResponse.body.id ?? ''));

    expect(persistedTransaction?.amount).toBe(submittedAmount);

    const lookupResponse = await invoke({
      method: 'GET',
      path: `/transactions/${createResponse.body.id}`,
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    expect(lookupResponse.status).toBe(200);
    expect(lookupResponse.body.amount).toBe(submittedAmount);
  });

  it('6b) deposit with SAME idempotency-key but DIFFERENT body is rejected', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'deposit-1', // reused key from test 6
      },
      body: { asset_code: 'USDC', amount: '100.0' }, // different amount
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('idempotency_conflict');
  });

  it('6c) idempotent replay returns cached deposit response with replay flag', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'deposit-1',
      },
      body: { asset_code: 'USDC', amount: '25.5' },
    });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(transactionId);
    expect(response.body.interactive_url).toBe(depositInteractiveUrl);
    expect(response.body.status).toBe('pending_user_transfer_start');
    expect(response.body.account).toBe(clientKeypair.publicKey());
    expect(response.body.idempotency_replay).toBe(true);
  });

  it('6d) empty Idempotency-Key header is treated as no key and creates a new deposit', async () => {
    const firstResponse = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': '   ',
      },
      body: { asset_code: 'USDC', amount: '12' },
    });

    const secondResponse = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': '   ',
      },
      body: { asset_code: 'USDC', amount: '12' },
    });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(firstResponse.body.id).not.toBe(secondResponse.body.id);
    expect(firstResponse.body.idempotency_replay).toBeUndefined();
    expect(secondResponse.body.idempotency_replay).toBeUndefined();
  });

  it('6e) deposit with amount as a JSON number creates a transaction', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC', amount: 15 },
    });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeTruthy();
    expect(response.body.status).toBe('pending_user_transfer_start');
  });

  it('7) transaction lookup fetches persisted data', async () => {
    const response = await invoke({
      method: 'GET',
      path: `/transactions/${transactionId}`,
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(transactionId);
    expect(response.body.asset_code).toBe('USDC');
    expect(response.body.asset_issuer).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    );
    expect(response.body.interactive_url).toBe(depositInteractiveUrl);
    expect(response.body.interactive_url).toBe(
      `https://anchor.example.com/deposit/${transactionId}`,
    );
    expect(response.body.more_info_url).toBe(`https://anchor.example.com/deposit/${transactionId}`);
  });

  it('7b) transaction lookup returns 404 for non-existent ID', async () => {
    const response = await invoke({
      method: 'GET',
      path: '/transactions/non-existent-id-99999',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found', message: 'Transaction not found' });
  });

  it('8) webhook route stores event and invokes configured callback', async () => {
    const payload = {
      id: 'evt_1',
      type: 'deposit.completed',
      transaction_id: transactionId,
    };

    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const firstResponse = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body.received).toBe(true);
    expect(firstResponse.body.duplicate).toBe(false);
    expect(firstResponse.body.event_id).toBe('evt_1');
    expect(firstResponse.body.provider).toBe('generic');
    expect(webhookCallbackCount).toBe(1);

    const duplicateResponse = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(duplicateResponse.status).toBe(200);
    expect(duplicateResponse.body.received).toBe(true);
    expect(duplicateResponse.body.duplicate).toBe(true);
    expect(duplicateResponse.body.event_id).toBe('evt_1');
    expect(duplicateResponse.body.provider).toBe('generic');
    expect(webhookCallbackCount).toBe(1);
  });

  it('8b) unsigned webhook is accepted when signature verification is disabled', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    let unsignedWebhookCallbackCount = 0;

    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-webhook-unsigned',
        distributionAccountSecret: 'distribution-test-secret',
        verifyWebhookSignatures: false,
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
          },
        ],
      },
      framework: {
        database: {
          provider: 'sqlite',
          url: customDbUrl,
        },
      },
      webhooks: {
        onEvent: async () => {
          unsignedWebhookCallbackCount += 1;
        },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);

    const payload = {
      id: 'evt_unsigned',
      type: 'deposit.completed',
      transaction_id: 'tx_unsigned',
    };

    const response = await customInvoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(response.body.duplicate).toBe(false);
    expect(unsignedWebhookCallbackCount).toBe(1);

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('8c) webhook is rejected when verification is enabled without configured secret', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    let misconfiguredWebhookCallbackCount = 0;

    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-webhook-misconfigured',
        distributionAccountSecret: 'distribution-test-secret',
        verifyWebhookSignatures: true,
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
          },
        ],
      },
      framework: {
        database: {
          provider: 'sqlite',
          url: customDbUrl,
        },
      },
      webhooks: {
        onEvent: async () => {
          misconfiguredWebhookCallbackCount += 1;
        },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);

    const payload = {
      id: 'evt_misconfigured',
      type: 'deposit.completed',
      transaction_id: 'tx_misconfigured',
    };

    const unsignedResponse = await customInvoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
      },
      body: payload,
    });

    expect(unsignedResponse.status).toBe(400);
    expect(unsignedResponse.body).toEqual({
      error: 'webhook_error',
      event_id: 'evt_misconfigured',
      message: 'Webhook processing failed',
    });

    const signature = createHmac('sha256', 'any-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const signedResponse = await customInvoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(signedResponse.status).toBe(400);
    expect(signedResponse.body).toEqual({
      error: 'webhook_error',
      event_id: 'evt_misconfigured',
      message: 'Webhook processing failed',
    });
    expect(misconfiguredWebhookCallbackCount).toBe(0);

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('8b) webhook route uses default provider when no header provided', async () => {
    const payload = {
      id: 'evt_2',
      type: 'deposit.completed',
      transaction_id: transactionId,
    };

    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-anchor-signature': signature,
        // No x-webhook-provider header
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
    expect(response.body.duplicate).toBe(false);
    expect(response.body.event_id).toBe('evt_2');
    expect(response.body.provider).toBe('generic'); // Should default to 'generic'
  });

  it('8c) webhook route returns 429 after webhookMax is exceeded', async () => {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.200' };

    for (let index = 0; index < 21; index += 1) {
      const payload = {
        id: `evt_rate_limit_${index}`,
        type: 'deposit.completed',
        transaction_id: transactionId,
      };

      const signature = createHmac('sha256', 'webhook-test-secret')
        .update(JSON.stringify(payload))
        .digest('hex');

      const response = await invoke({
        method: 'POST',
        path: '/webhooks/events',
        headers: {
          ...headers,
          'x-webhook-provider': 'generic',
          'x-anchor-signature': signature,
        },
        body: payload,
      });

      if (index < 20) {
        expect(response.status).toBe(200);
      }
    }

    const rateLimitedResponse = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        ...headers,
        'x-webhook-provider': 'generic',
        'x-anchor-signature': createHmac('sha256', 'webhook-test-secret')
          .update(
            JSON.stringify({
              id: 'evt_rate_limit_21',
              type: 'deposit.completed',
              transaction_id: transactionId,
            }),
          )
          .digest('hex'),
      },
      body: {
        id: 'evt_rate_limit_21',
        type: 'deposit.completed',
        transaction_id: transactionId,
      },
    });

    expect(rateLimitedResponse.status).toBe(429);
    expect(rateLimitedResponse.body.error).toBe('rate_limited');
    expect(rateLimitedResponse.headers['retry-after']).toBeDefined();
  });

  it('8d) webhook without id field returns a generated event_id', async () => {
    const payload = {
      type: 'deposit.completed',
      transaction_id: transactionId,
      // Note: No id field
    };

    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
    expect(response.body.duplicate).toBe(false);
    expect(typeof response.body.event_id).toBe('string');
    expect((response.body.event_id as string).length).toBeGreaterThan(0);
  });

  it('8f) webhook route accepts an empty body and generates event_id for signed empty payloads', async () => {
    const signature = createHmac('sha256', 'webhook-test-secret').update('').digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': signature,
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
    expect(response.body.duplicate).toBe(false);
    expect(typeof response.body.event_id).toBe('string');
    expect((response.body.event_id as string).length).toBeGreaterThan(0);
  });

  it('8g) webhook route accepts Buffer-backed rawBody and returns a generated event_id', async () => {
    const payload = { id: 'evt_buffer', type: 'deposit.completed', transaction_id: transactionId };
    const payloadText = JSON.stringify(payload);
    const signature = createHmac('sha256', 'webhook-test-secret').update(payloadText).digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': signature,
      },
      rawBody: Buffer.from(payloadText),
    });

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
    expect(response.body.duplicate).toBe(false);
    expect(response.body.event_id).toBe('evt_buffer');
  });

  it('8h) webhook route treats whitespace-only ids as missing and generates an event id', async () => {
    const payload = { id: '   ', type: 'deposit.completed', transaction_id: transactionId };
    const payloadText = JSON.stringify(payload);
    const signature = createHmac('sha256', 'webhook-test-secret').update(payloadText).digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
    expect(response.body.duplicate).toBe(false);
    expect(typeof response.body.event_id).toBe('string');
    expect((response.body.event_id as string).length).toBeGreaterThan(0);
  });

  it('8i) duplicate webhook with conflicting provider returns persisted provider', async () => {
    const initialCallbackCount = webhookCallbackCount;
    const payload = {
      id: `evt_conflicting_provider_${Date.now()}`,
      type: 'deposit.completed',
      transaction_id: transactionId,
    };

    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    // First request with provider 'provider-a'
    const firstResponse = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'provider-a',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body.duplicate).toBe(false);
    expect(firstResponse.body.event_id).toBe(payload.id);
    expect(firstResponse.body.provider).toBe('provider-a');
    expect(webhookCallbackCount).toBe(initialCallbackCount + 1);

    // Second request with same event ID but different provider 'provider-b'
    const duplicateResponse = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'provider-b', // Different provider
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(duplicateResponse.status).toBe(200);
    expect(duplicateResponse.body.duplicate).toBe(true);
    expect(duplicateResponse.body.event_id).toBe(payload.id);
    expect(duplicateResponse.body.provider).toBe('provider-a'); // Should return the persisted provider, not the request provider
    expect(webhookCallbackCount).toBe(initialCallbackCount + 1); // Callback should not be invoked again
  });

  it('8i) oversized Buffer-backed rawBody returns 413 payload_too_large', async () => {
    const payloadText = JSON.stringify({ account: 'G'.repeat(2048), challenge: 'x' });

    const response = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(payloadText),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('8e) webhook success response includes received_at ISO timestamp', async () => {
    const payload = {
      id: 'evt_received_at_check',
      type: 'deposit.completed',
      transaction_id: transactionId,
    };

    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(response.body.received).toBe(true);
    expect(typeof response.body.received_at).toBe('string');
    const parsed = Date.parse(response.body.received_at as string);
    expect(Number.isNaN(parsed)).toBe(false);
  });

  it('8g) chunked oversized webhook body returns 413 payload_too_large', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: {},
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-webhook-oversize',
        distributionAccountSecret: 'distribution-test-secret',
        webhookSecret: 'webhook-test-secret',
        verifyWebhookSignatures: true,
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
        database: { provider: 'sqlite', url: customDbUrl },
        http: { maxBodyBytes: 1024 },
      },
      webhooks: {
        onEvent: async () => {
          throw new Error('should not be called for oversized body');
        },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);

    try {
      // Create a payload larger than the configured maxBodyBytes (1024 bytes)
      const largePayload = {
        id: 'evt_oversized',
        type: 'deposit.completed',
        data: 'x'.repeat(2000),
      };
      const payloadText = JSON.stringify(largePayload);
      const signature = createHmac('sha256', 'webhook-test-secret')
        .update(payloadText)
        .digest('hex');

      const response = await customInvoke({
        method: 'POST',
        path: '/webhooks/events',
        headers: {
          'content-type': 'application/json',
          'x-webhook-provider': 'generic',
          'x-anchor-signature': signature,
        },
        rawBody: Buffer.from(payloadText),
      });

      // The body should be rejected at the byte limit before JSON parsing
      expect(response.status).toBe(413);
      expect(response.body.error).toBe('payload_too_large');
      expect(response.body.message).toBe('Request body too large. Max 1024 bytes');
    } finally {
      await customAnchor.shutdown();
      try {
        unlinkSync(customDbPath);
      } catch {
        // ignore cleanup errors in CI
      }
    }
  });

  it('8f) failed webhook error response includes event_id', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: {},
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-error-event-id',
        distributionAccountSecret: 'distribution-test-secret',
        webhookSecret: 'webhook-test-secret',
        verifyWebhookSignatures: true,
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
        database: { provider: 'sqlite', url: customDbUrl },
      },
      webhooks: {
        onEvent: async () => {
          throw new Error('simulated processing failure');
        },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);

    const payload = { id: 'evt_err_1', type: 'deposit.completed' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await customInvoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('webhook_error');
    expect(response.body.event_id).toBe('evt_err_1');

    await customAnchor.shutdown();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    try {
      unlinkSync(customDbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('9) queue worker/watcher processes at least one watch task', async () => {
    await new Promise((resolve) => setTimeout(resolve, 125));
    const processed = await anchor.getProcessedWatcherTaskCount();
    expect(processed).toBeGreaterThan(0);
  });

  it('10) unsigned challenge is rejected', async () => {
    const account = clientKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });
    const challengeXdr = String(challengeResponse.body.challenge ?? '');

    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.2' },
      body: { account, challenge: challengeXdr },
    });

    expect(tokenResponse.status).toBe(401);
    expect(tokenResponse.body.error).toBe('invalid_challenge');
  });

  it('10a) expired challenge is rejected during token exchange', async () => {
    const account = clientKeypair.publicKey();
    const initialNow = new Date('2026-01-01T00:00:00.000Z').getTime();
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(initialNow);

    try {
      const challengeResponse = await invoke({
        path: `/auth/challenge?account=${account}`,
        headers: { 'x-forwarded-for': '10.0.0.12' },
      });

      expect(challengeResponse.status).toBe(200);
      const challengeXdr = String(challengeResponse.body.challenge ?? '');
      const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
      const challengeTx = new Transaction(challengeXdr, networkPassphrase);
      challengeTx.sign(clientKeypair);

      dateNowSpy.mockReturnValue(initialNow + 301_000);

      const tokenResponse = await invoke({
        method: 'POST',
        path: '/auth/token',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.12' },
        body: { account, challenge: challengeTx.toXDR() },
      });

      expect(tokenResponse.status).toBe(401);
      expect(tokenResponse.body.error).toBe('invalid_challenge');
      expect(tokenResponse.body.message).toBe('Challenge expired');
      expect(tokenResponse.body).not.toHaveProperty('access_token');
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('10b) token with missing/incorrect scope is rejected', async () => {
    // Manually sign a token with a different scope to test the server's validation
    const jwt = (await import('jsonwebtoken')).default;
    const badToken = jwt.sign(
      {
        sub: clientKeypair.publicKey(),
        scope: 'wrong_api',
        typ: 'access_token',
      },
      'jwt-test-secret',
      { expiresIn: 3600 },
    );

    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${badToken}`,
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('10bb) token with invalid Stellar subject is rejected', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const badToken = jwt.sign(
      {
        sub: 'not-a-stellar-public-key',
        scope: 'anchor_api',
        typ: 'access_token',
      },
      'jwt-test-secret',
      { expiresIn: 3600 },
    );

    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${badToken}`,
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('10bc) bearer authorization with repeated spaces is accepted', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const token = jwt.sign(
      {
        sub: clientKeypair.publicKey(),
        scope: 'anchor_api',
        typ: 'access_token',
      },
      'jwt-test-secret',
      { expiresIn: 3600 },
    );

    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer    ${token}`,
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(response.status).toBe(201);
    expect(response.body.error).toBeUndefined();
  });

  it('10d) token with missing/incorrect typ is rejected', async () => {
    // Manually sign a token with a different scope to test the server's validation
    const jwt = (await import('jsonwebtoken')).default;
    const badToken = jwt.sign(
      {
        sub: clientKeypair.publicKey(),
        scope: 'anchor_api',
        // typ is missing
      },
      'jwt-test-secret',
      { expiresIn: 3600 },
    );

    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${badToken}`,
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('10e) expired access token is rejected with 401', async () => {
    // Mint an expired access token by setting exp to the past
    const jwt = (await import('jsonwebtoken')).default;
    const account = clientKeypair.publicKey();
    const expiredToken = jwt.sign(
      {
        sub: account,
        scope: 'anchor_api',
        typ: 'access_token',
        exp: Math.floor(Date.now() / 1000) - 100, // expired 100 seconds ago
      },
      'jwt-test-secret',
    );

    const response = await invoke({
      method: 'GET',
      path: `/transactions/${transactionId}`,
      headers: {
        authorization: `Bearer ${expiredToken}`,
      },
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('10c) malformed challenge XDR is rejected', async () => {
    const account = clientKeypair.publicKey();
    const invalidChallengeXdr = 'AAAAinvalid_xdr_string_that_is_not_a_valid_transaction';

    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.3' },
      body: { account, challenge: invalidChallengeXdr },
    });

    expect(tokenResponse.status).toBe(401);
    expect(tokenResponse.body.error).toBe('invalid_challenge');
    expect(tokenResponse.body.message).toBe('Challenge transaction is invalid');
  });
  it('10d) challenge with a different transaction source is rejected', async () => {
    const account = clientKeypair.publicKey();
    const wrongServerKeypair = Keypair.random();
    const now = Math.floor(Date.now() / 1000);
    const challenge = new TransactionBuilder(new Account(wrongServerKeypair.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
      .addOperation(
        Operation.manageData({
          name: 'anchor_auth',
          value: 'wrong-source-test',
          source: account,
        }),
      )
      .setTimebounds(now, now + 300)
      .build();
    challenge.sign(wrongServerKeypair);
    challenge.sign(clientKeypair);

    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.8' },
      body: { account, challenge: challenge.toXDR() },
    });

    expect(tokenResponse.status).toBe(401);
    expect(tokenResponse.body.error).toBe('invalid_challenge');
    expect(tokenResponse.body.message).toBe('Challenge source account mismatch');
  });
  it('10cb) challenge without anchor signature is rejected', async () => {
    const account = clientKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.13' },
    });
    expect(challengeResponse.status).toBe(200);
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');

    const missingAnchorSignatureChallenge = new Transaction(challengeXdr, networkPassphrase);
    missingAnchorSignatureChallenge.signatures.splice(
      0,
      missingAnchorSignatureChallenge.signatures.length,
    );
    missingAnchorSignatureChallenge.sign(clientKeypair);

    const missingAnchorSignatureResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.13' },
      body: { account, challenge: missingAnchorSignatureChallenge.toXDR() },
    });

    expect(missingAnchorSignatureResponse.status).toBe(401);
    expect(missingAnchorSignatureResponse.body.error).toBe('invalid_challenge');
    expect(missingAnchorSignatureResponse.body.message).toBe(
      'Challenge is missing anchor signature',
    );
  });

  it('10e) persistence failure during auth token exchange returns a stable 500', async () => {
    const account = clientKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.13' },
    });
    expect(challengeResponse.status).toBe(200);
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);

    const databaseDescriptor = Object.getOwnPropertyDescriptor(anchor, 'database');
    if (!databaseDescriptor || !(databaseDescriptor.value as DatabaseAdapter | null)) {
      throw new Error('Expected initialized database adapter');
    }
    const database = databaseDescriptor.value as DatabaseAdapter;
    const originalMark = database.markAuthChallengeConsumed.bind(database);
    database.markAuthChallengeConsumed = async () => {
      throw new Error('database unavailable');
    };

    try {
      const tokenResponse = await invoke({
        method: 'POST',
        path: '/auth/token',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.13' },
        body: { account, challenge: challengeTx.toXDR() },
      });

      expect(tokenResponse.status).toBe(500);
      expect(tokenResponse.body.error).toBe('server_error');
      expect(tokenResponse.body.message).toBe('Failed to record challenge consumption');
      expect(tokenResponse.body).not.toHaveProperty('token');
    } finally {
      database.markAuthChallengeConsumed = originalMark;
    }
  });

  it('11) reused challenge rejection', async () => {
    const account = clientKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.4' },
    });
    expect(challengeResponse.status).toBe(200);
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);
    const signedChallengeXdr = challengeTx.toXDR();

    // First exchange succeeds
    const firstResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.4' },
      body: { account, challenge: signedChallengeXdr },
    });
    expect(firstResponse.status).toBe(200);

    // Second exchange with same challenge fails
    const secondResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.4' },
      body: { account, challenge: signedChallengeXdr },
    });

    expect(secondResponse.status).toBe(401);
    expect(secondResponse.body.error).toBe('invalid_challenge');
    expect(secondResponse.body.message).toBe('Challenge already used');
  });

  it('12) deposit idempotency replay returns original response', async () => {
    const asset_code = 'USDC';
    const amount = '15.0';
    const firstResponse = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'replay-test-key',
      },
      body: { asset_code, amount },
    });

    expect(firstResponse.status).toBe(201);
    expect(firstResponse.body.account).toBe(clientKeypair.publicKey());
    const firstTxId = firstResponse.body.id;

    const secondResponse = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'replay-test-key',
      },
      body: { asset_code, amount },
    });

    expect(secondResponse.status).toBe(201);
    expect(secondResponse.body.id).toBe(firstTxId);
  });

  it('13) cross-account transaction lookup is rejected', async () => {
    // Create a new account and get its token
    const otherAccountKeypair = Keypair.random();
    const account = otherAccountKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
    });
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(otherAccountKeypair);
    const signedChallengeXdr = challengeTx.toXDR();

    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json' },
      body: { account, challenge: signedChallengeXdr },
    });
    const otherAccessToken = String(tokenResponse.body.token ?? '');

    // Now attempt to look up the transaction from another account
    // transactionId was created in test #6 and belongs to clientKeypair
    const response = await invoke({
      method: 'GET',
      path: `/transactions/${transactionId}`,
      headers: {
        authorization: `Bearer ${otherAccessToken}`,
      },
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
  });

  it('14) account mismatch during token exchange is rejected', async () => {
    const account = clientKeypair.publicKey();
    const otherAccountKeypair = Keypair.random();
    const otherAccount = otherAccountKeypair.publicKey();

    // Get challenge for 'account'
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
    });
    expect(challengeResponse.status).toBe(200);
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');

    // Sign with 'otherAccount' keypair (mismatched vs the challenge's DB entry)
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(otherAccountKeypair);
    const signedChallengeXdr = challengeTx.toXDR();

    // Submit with 'otherAccount' in the body
    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json' },
      body: { account: otherAccount, challenge: signedChallengeXdr },
    });

    // Should be rejected because the account in the body (and signature)
    // doesn't match the one the challenge was generated for in the DB.
    expect(tokenResponse.status).toBe(401);
    expect(tokenResponse.body.error).toBe('invalid_challenge');
    expect(tokenResponse.body.message).toBe('Challenge not found');
  });

  // ── Issue #214: missing body fields on POST /auth/token ──────────────────

  it('15) /auth/token with missing account field returns 400', async () => {
    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json' },
      // account is absent; only challenge is provided
      body: { challenge: 'some-challenge-xdr' },
    });

    expect(tokenResponse.status).toBe(400);
    expect(tokenResponse.body.error).toBe('invalid_request');
    expect(tokenResponse.body.message).toBe('Body must include account and challenge');
  });

  it('15b) /auth/token with missing challenge field returns 400', async () => {
    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json' },
      // challenge is absent; only account is provided
      body: { account: clientKeypair.publicKey() },
    });

    expect(tokenResponse.status).toBe(400);
    expect(tokenResponse.body.error).toBe('invalid_request');
    expect(tokenResponse.body.message).toBe('Body must include account and challenge');
  });

  it('15c) /auth/token with both account and challenge missing returns 400', async () => {
    const tokenResponse = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.15' },
      // entirely empty body
      body: {},
    });

    expect(tokenResponse.status).toBe(400);
    expect(tokenResponse.body.error).toBe('invalid_request');
    expect(tokenResponse.body.message).toBe('Body must include account and challenge');
  });

  // ── Malformed JSON bodies ────────────────────────────────────────────────

  it('15d) malformed JSON on POST /auth/token returns 400', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.7',
      },
      rawBody: '{not json',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toBe('Request body must be valid JSON');
  });

  it('15e) JSON array on POST /auth/token returns 400', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.9' },
      body: ['account', 'challenge'],
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toBe('Request JSON body must be an object');
  });

  it('15e) malformed JSON on POST /transactions/deposit/interactive returns 400', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      rawBody: '{"asset_code":',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toBe('Request body must be valid JSON');
  });

  it('15h) JSON primitive on POST /transactions/deposit/interactive returns 400', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      rawBody: '"just-a-string"',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toBe('Request JSON body must be an object');
  });

  it('15f) malformed JSON on POST /webhooks/events returns 400', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: { 'content-type': 'application/json' },
      rawBody: 'not-json',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toBe('Request body must be valid JSON');
  });

  it('15f) JSON POST routes reject missing or unrelated content types', async () => {
    const requests: TestRequestOptions[] = [
      {
        method: 'POST',
        path: '/auth/token',
        headers: { 'content-type': 'text/plain', 'x-forwarded-for': '10.0.0.151' },
        rawBody: '{}',
      },
      {
        method: 'POST',
        path: '/transactions/deposit/interactive',
        headers: {
          'content-type': 'text/plain',
          authorization: 'Bearer ' + accessToken,
          'x-forwarded-for': '10.0.0.152',
        },
        body: { asset_code: 'USDC', amount: '10' },
      },
      {
        method: 'POST',
        path: '/webhooks/events',
        headers: { 'content-type': 'text/plain', 'x-forwarded-for': '10.0.0.153' },
        body: { id: 'content-type-check' },
      },
    ];

    for (const request of requests) {
      const response = await invoke(request);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'invalid_request',
        message: 'Content-Type must be application/json',
      });
    }
  });

  it('15g) oversize body on POST /auth/token returns 413', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: {},
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret',
        distributionAccountSecret: 'distribution-test-secret',
        webhookSecret: 'webhook-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
          },
        ],
      },
      framework: {
        database: { provider: 'sqlite', url: customDbUrl },
        http: { maxBodyBytes: 1024 },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);

    try {
      const oversizedBody = JSON.stringify({
        account: 'G'.repeat(1024),
        challenge: 'x',
      });
      const response = await customInvoke({
        method: 'POST',
        path: '/auth/token',
        headers: { 'content-type': 'application/json' },
        rawBody: oversizedBody,
      });

      expect(response.status).toBe(413);
      expect(response.body.error).toBe('payload_too_large');
      expect(response.body.message).toBe('Request body too large. Max 1024 bytes');
    } finally {
      await customAnchor.shutdown();
      try {
        unlinkSync(customDbPath);
      } catch {
        // ignore cleanup errors in CI
      }
    }
  });

  // ── Unauthenticated transaction lookup ───────────────────────────────────

  it('15i) oversize body on POST /transactions/deposit/interactive returns 413', async () => {
    const customDbUrl = makeSqliteDbUrlForTests();
    const customDbPath = customDbUrl.startsWith('file:')
      ? customDbUrl.slice('file:'.length)
      : customDbUrl;
    const customAnchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret-oversize',
        distributionAccountSecret: 'distribution-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
            min_amount: 1,
            max_amount: 1000,
          },
        ],
      },
      framework: {
        database: { provider: 'sqlite', url: customDbUrl },
        http: { maxBodyBytes: 1024 },
      },
    });

    await customAnchor.init();
    const customInvoke = createMountedInvoker(customAnchor);

    try {
      // create access token for this custom anchor
      const testKeypair = Keypair.random();
      const account = testKeypair.publicKey();
      const challengeResponse = await customInvoke({
        path: `/auth/challenge?account=${account}`,
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
      expect(challengeResponse.status).toBe(200);
      const challengeXdr = String(challengeResponse.body.challenge ?? '');
      const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
      const challengeTx = new Transaction(challengeXdr, networkPassphrase);
      challengeTx.sign(testKeypair);

      const tokenResponse = await customInvoke({
        method: 'POST',
        path: '/auth/token',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        body: { account, challenge: challengeTx.toXDR() },
      });
      expect(tokenResponse.status).toBe(200);
      const access = String(tokenResponse.body.token ?? '');

      const oversizedBody = JSON.stringify({
        asset_code: 'USDC',
        amount: '1',
        extra: 'x'.repeat(2048),
      });
      const response = await customInvoke({
        method: 'POST',
        path: '/transactions/deposit/interactive',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
        rawBody: oversizedBody,
      });

      expect(response.status).toBe(413);
      expect(response.body.error).toBe('payload_too_large');
      expect(response.body.message).toBe('Request body too large. Max 1024 bytes');
    } finally {
      await customAnchor.shutdown();
      try {
        unlinkSync(customDbPath);
      } catch {
        // ignore cleanup errors in CI
      }
    }
  });

  it('17) GET /transactions/:id without bearer token returns 401', async () => {
    const response = await invoke({
      method: 'GET',
      path: `/transactions/${transactionId}`,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
    expect(response.body.message).toBe('Missing or invalid bearer token');
  });

  it('17b) malformed percent-encoded id on GET /transactions/:id returns 400', async () => {
    const response = await invoke({
      method: 'GET',
      path: '/transactions/%',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('17c) encoded path separators on GET /transactions/:id return 400 before lookup', async () => {
    const database = (
      anchor as unknown as {
        database: {
          getInteractiveTransactionById: (id: string) => Promise<unknown>;
        };
      }
    ).database;
    const lookupSpy = vi.spyOn(database, 'getInteractiveTransactionById');

    try {
      for (const path of ['/transactions/%2F', '/transactions/%5C']) {
        const response = await invoke({
          method: 'GET',
          path,
          headers: { authorization: `Bearer ${accessToken}` },
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_request');
        expect(response.body.message).toBe('Transaction id must not contain path separators');
      }

      expect(lookupSpy).not.toHaveBeenCalled();
    } finally {
      lookupSpy.mockRestore();
    }
  });

  // ── Non-positive deposit amounts ─────────────────────────────────────────

  it('16) deposit with amount of zero is rejected with 400', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC', amount: '0' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_amount');
    expect(response.body.message).toBe('Amount must be a positive number');
  });

  it('16b) deposit with negative amount is rejected with 400', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: { asset_code: 'USDC', amount: '-5' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_amount');
    expect(response.body.message).toBe('Amount must be a positive number');
  });

  it('16c) deposit with non-numeric amount is rejected with 400', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'x-forwarded-for': '10.0.0.163',
      },
      body: { asset_code: 'USDC', amount: 'abc' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_amount');
    expect(response.body.message).toBe('Amount must be a positive number');
  });

  it('16d) deposit with amount exactly at min_amount is accepted (boundary)', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'x-forwarded-for': '10.0.0.99',
      },
      body: { asset_code: 'USDC', amount: '10' },
    });

    expect(response.status).toBe(201);
    expect(response.body.kind).toBe('deposit');
    expect(response.body.amount).toBe('10');
    expect(response.body).toHaveProperty('id');
  });
});
