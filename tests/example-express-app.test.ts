import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import {
  createInteractiveSession,
  verifyInteractiveSession,
} from '../src/utils/interactive-session.ts';
import request from 'supertest';
import { createExampleApp, isSqliteDatabaseUrl } from '../example/express-app.ts';
import type { KycVerificationProvider } from '../src/runtime/interfaces.ts';
import { version } from '../package.json';

interface ExampleAppRuntime {
  app: Express;
  anchor: {
    config: {
      get: (key: 'framework' | 'security') => {
        watchers?: {
          enabled?: boolean;
        };
        http?: {
          maxBodyBytes?: number;
        };
        sep10SigningKey?: string;
      };
    };
  };
  shutdown: () => Promise<void>;
}

interface InvokeOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

interface InvokeResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const DEFAULT_CHALLENGE_EXPIRATION_SECONDS = 300;

interface ExampleAppHarness {
  runtime: ExampleAppRuntime;
  cleanup: () => Promise<void>;
}

function getChallengeLifetimeSeconds(challengeTx: Transaction): number {
  if (!challengeTx.timeBounds) {
    throw new Error('Expected SEP-10 challenge transaction to include time bounds');
  }

  return Number(challengeTx.timeBounds.maxTime) - Number(challengeTx.timeBounds.minTime);
}

function setOptionalEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function removeFileIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore cleanup errors
  }
}

async function invokeExpress(app: Express, options: InvokeOptions): Promise<InvokeResponse> {
  const serializedBody = options.body ? JSON.stringify(options.body) : '';

  const req = Readable.from(serializedBody ? [serializedBody] : []) as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };

  req.method = options.method ?? 'GET';
  req.url = options.path;
  req.headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );

  const responseHeaders: Record<string, string> = {};

  return new Promise<InvokeResponse>((resolve) => {
    let statusCode = 200;

    const res = {
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
          body,
          headers: responseHeaders,
        });
      },
    } as unknown as ServerResponse;

    app(req, res);
  });
}

async function createExampleAppHarness(
  options: {
    challengeExpirationSeconds?: string;
    watchersEnabled?: string;
    maxBodyBytes?: string;
    authTokenLifetimeSeconds?: string;
    interactiveCallbackOrigins?: string;
    interactiveDomain?: string;
    kycRequired?: Record<string, string[]>;
    kycVerificationProvider?: KycVerificationProvider;
  } = {},
): Promise<ExampleAppHarness> {
  const sep10ServerKeypair = Keypair.random();
  const dbPath = join(tmpdir(), `anchor-kit-example-test-${Date.now()}-${Math.random()}.sqlite`);
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSep10SigningKey = process.env.SEP10_SIGNING_KEY;
  const originalChallengeExpirationSeconds = process.env.CHALLENGE_EXPIRATION_SECONDS;
  const originalWatchersEnabled = process.env.WATCHERS_ENABLED;
  const originalMaxBodyBytes = process.env.MAX_BODY_BYTES;
  const originalAuthTokenLifetimeSeconds = process.env.AUTH_TOKEN_LIFETIME_SECONDS;
  const originalInteractiveCallbackOrigins = process.env.INTERACTIVE_CALLBACK_ORIGINS;
  const originalInteractiveDomain = process.env.INTERACTIVE_DOMAIN;

  setOptionalEnvVar('DATABASE_URL', `file:${dbPath}`);
  setOptionalEnvVar('SEP10_SIGNING_KEY', sep10ServerKeypair.secret());
  setOptionalEnvVar('CHALLENGE_EXPIRATION_SECONDS', options.challengeExpirationSeconds);
  setOptionalEnvVar('WATCHERS_ENABLED', options.watchersEnabled);
  setOptionalEnvVar('MAX_BODY_BYTES', options.maxBodyBytes);
  setOptionalEnvVar('AUTH_TOKEN_LIFETIME_SECONDS', options.authTokenLifetimeSeconds);
  setOptionalEnvVar('INTERACTIVE_CALLBACK_ORIGINS', options.interactiveCallbackOrigins);
  setOptionalEnvVar('INTERACTIVE_DOMAIN', options.interactiveDomain);

  const runtime = await createExampleApp({
    kycRequired: options.kycRequired,
    kycVerificationProvider: options.kycVerificationProvider,
  });

  return {
    runtime,
    cleanup: async () => {
      await runtime.shutdown();

      setOptionalEnvVar('DATABASE_URL', originalDatabaseUrl);
      setOptionalEnvVar('SEP10_SIGNING_KEY', originalSep10SigningKey);
      setOptionalEnvVar('CHALLENGE_EXPIRATION_SECONDS', originalChallengeExpirationSeconds);
      setOptionalEnvVar('WATCHERS_ENABLED', originalWatchersEnabled);
      setOptionalEnvVar('MAX_BODY_BYTES', originalMaxBodyBytes);
      setOptionalEnvVar('AUTH_TOKEN_LIFETIME_SECONDS', originalAuthTokenLifetimeSeconds);
      setOptionalEnvVar('INTERACTIVE_CALLBACK_ORIGINS', originalInteractiveCallbackOrigins);
      setOptionalEnvVar('INTERACTIVE_DOMAIN', originalInteractiveDomain);
      removeFileIfPresent(dbPath);
    },
  };
}

describe('example/express-app', () => {
  const clientKeypair = Keypair.random();
  let harness: ExampleAppHarness;

  beforeAll(async () => {
    harness = await createExampleAppHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it('serves a non-cacheable deposit page without echoing its session token', async () => {
    const response = await request(harness.runtime.app).get(
      '/deposit/example-id?token=private-session-token&callback=postMessage',
    );
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.text).toContain('Deposit details');
    expect(response.text).not.toContain('private-session-token');
    expect(response.text).toContain('window.opener');
    expect(response.text).toContain('window.parent');
    expect(response.text).toContain('allowedOrigins.includes(origin)');
  });

  it('loads and completes a session-scoped no-KYC deposit', async () => {
    const token = await fetchAuthToken(harness.runtime.app);
    const initiated = await invokeExpress(harness.runtime.app, {
      method: 'POST',
      path: '/anchor/transactions/deposit/interactive',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: { asset_code: 'USDC', amount: '5' },
    });
    expect(initiated.status).toBe(201);
    const id = String(initiated.body.id);
    const account = String(initiated.body.account);
    const session = await createInteractiveSession(
      { account, transactionId: id, actions: ['deposit'] },
      'example-jwt-secret',
    );

    const state = await invokeExpress(harness.runtime.app, {
      path: `/anchor/interactive/deposit/${id}`,
      headers: { authorization: `Bearer ${session}` },
    });
    expect(state.status).toBe(200);
    expect(state.body.transaction).toMatchObject({ id, status: 'incomplete', amount: '5' });
    expect(state.body.required_fields).toEqual([]);
    expect(state.body.missing_fields).toEqual([]);

    const completed = await invokeExpress(harness.runtime.app, {
      method: 'POST',
      path: `/anchor/interactive/deposit/${id}/complete`,
      headers: {
        authorization: `Bearer ${session}`,
        'content-type': 'application/json',
      },
      body: { fields: {} },
    });
    expect(completed.status).toBe(200);
    expect(completed.body.transaction).toMatchObject({
      id,
      status: 'pending_user_transfer_start',
    });
    expect(completed.body.kyc_verified).toBe(true);

    const replay = await invokeExpress(harness.runtime.app, {
      method: 'POST',
      path: `/anchor/interactive/deposit/${id}/complete`,
      headers: {
        authorization: `Bearer ${session}`,
        'content-type': 'application/json',
      },
      body: { fields: {} },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotency_replay).toBe(true);
  });

  it('keeps a KYC-required deposit incomplete until an approval arrives', async () => {
    const kycHarness = await createExampleAppHarness({
      kycRequired: { USDC: ['first_name'] },
    });
    try {
      const accessToken = await fetchAuthToken(kycHarness.runtime.app);
      const initiated = await invokeExpress(kycHarness.runtime.app, {
        method: 'POST',
        path: '/anchor/transactions/deposit/interactive',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: { asset_code: 'USDC', amount: '3' },
      });
      const transactionId = String(initiated.body.id);
      const session = await createInteractiveSession(
        {
          account: String(initiated.body.account),
          transactionId,
          actions: ['deposit'],
        },
        'example-jwt-secret',
      );
      const completion = async (fields: Record<string, string>) =>
        invokeExpress(kycHarness.runtime.app, {
          method: 'POST',
          path: `/anchor/interactive/deposit/${transactionId}/complete`,
          headers: {
            authorization: `Bearer ${session}`,
            'content-type': 'application/json',
          },
          body: { fields },
        });

      const missing = await completion({});
      expect(missing.status).toBe(422);
      expect(missing.body.missing_fields).toEqual(['first_name']);
      const pending = await completion({ first_name: 'Ada' });
      expect(pending.status).toBe(202);
      expect(pending.body).toMatchObject({
        kyc_status: 'pending',
        transaction: { status: 'incomplete' },
      });
    } finally {
      await kycHarness.cleanup();
    }
  });

  it('replays matching completion and rejects a conflicting submission', async () => {
    let verificationCalls = 0;
    const kycHarness = await createExampleAppHarness({
      kycRequired: { USDC: ['first_name'] },
      kycVerificationProvider: {
        async verify(input) {
          verificationCalls += 1;
          return {
            decisionId: 'decision-1',
            operationKey: input.operationKey,
            customerId: input.customerId,
            status: 'approved',
            decidedAt: new Date().toISOString(),
          };
        },
      },
    });
    try {
      const accessToken = await fetchAuthToken(kycHarness.runtime.app);
      const initiated = await invokeExpress(kycHarness.runtime.app, {
        method: 'POST',
        path: '/anchor/transactions/deposit/interactive',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: { asset_code: 'USDC', amount: '4' },
      });
      const transactionId = String(initiated.body.id);
      const session = await createInteractiveSession(
        {
          account: String(initiated.body.account),
          transactionId,
          actions: ['deposit'],
        },
        'example-jwt-secret',
      );
      const submit = (firstName: string) =>
        invokeExpress(kycHarness.runtime.app, {
          method: 'POST',
          path: `/anchor/interactive/deposit/${transactionId}/complete`,
          headers: {
            authorization: `Bearer ${session}`,
            'content-type': 'application/json',
          },
          body: { fields: { first_name: firstName } },
        });

      const completed = await submit('Ada');
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({
        transaction: { status: 'pending_user_transfer_start' },
      });
      const replay = await submit('Ada');
      expect(replay.status).toBe(200);
      expect(replay.body.idempotency_replay).toBe(true);
      const conflict = await submit('Grace');
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toBe('idempotency_conflict');
      expect(verificationCalls).toBe(1);
    } finally {
      await kycHarness.cleanup();
    }
  });

  it('limits wallet messaging and signs allowed URL callbacks', async () => {
    const callbackHarness = await createExampleAppHarness({
      interactiveCallbackOrigins: 'https://wallet.example',
      interactiveDomain: 'https://anchor.example',
    });
    const callbackFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const page = await request(callbackHarness.runtime.app).get(
        '/deposit/example-id?token=private-session-token&callback=postMessage',
      );
      expect(page.status).toBe(200);
      expect(page.headers['content-security-policy']).toContain(
        'frame-ancestors https://wallet.example',
      );
      expect(page.text).toContain('allowedOrigins.includes(origin)');
      expect(page.text).not.toContain('private-session-token');

      const accessToken = await fetchAuthToken(callbackHarness.runtime.app);
      const initiated = await request(callbackHarness.runtime.app)
        .post('/anchor/transactions/deposit/interactive')
        .set('authorization', `Bearer ${accessToken}`)
        .type('form')
        .send({ asset_code: 'USDC', amount: '2' });
      expect(initiated.status).toBe(200);
      const transactionId = String(initiated.body.id);
      const session = new URL(String(initiated.body.url)).searchParams.get('token') ?? '';
      const claims = await verifyInteractiveSession(
        session,
        'example-jwt-secret',
        transactionId,
        'deposit',
      );
      expect(claims.account).toMatch(/^G/);
      const completion = await invokeExpress(callbackHarness.runtime.app, {
        method: 'POST',
        path: `/anchor/interactive/deposit/${transactionId}/complete`,
        headers: {
          authorization: `Bearer ${session}`,
          'content-type': 'application/json',
        },
        body: { fields: {}, callback: 'https://wallet.example/sep24/callback' },
      });
      expect(completion.status).toBe(200);
      expect(completion.body.callback_delivered).toBe(true);
      const [callbackUrl, callbackOptions] = callbackFetch.mock.calls[0] ?? [];
      expect(String(callbackUrl)).toBe('https://wallet.example/sep24/callback');
      const signatureHeader = new Headers(callbackOptions?.headers).get('signature') ?? '';
      expect(signatureHeader).toMatch(/^t=\d+, s=.+/);
      const signatureParts = /^t=(\d+), s=(.+)$/.exec(signatureHeader);
      const callbackBody = String(callbackOptions?.body);
      const signingKey = Keypair.fromSecret(
        String(callbackHarness.runtime.anchor.config.get('security').sep10SigningKey),
      );
      expect(
        signingKey.verify(
          Buffer.from(`${signatureParts?.[1]}.wallet.example.${callbackBody}`),
          Buffer.from(signatureParts?.[2] ?? '', 'base64'),
        ),
      ).toBe(true);
      expect(JSON.parse(String(callbackOptions?.body)).transaction).toMatchObject({
        id: transactionId,
        status: 'pending_user_transfer_start',
      });

      const rejected = await invokeExpress(callbackHarness.runtime.app, {
        method: 'POST',
        path: `/anchor/interactive/deposit/${transactionId}/complete`,
        headers: {
          authorization: `Bearer ${session}`,
          'content-type': 'application/json',
        },
        body: { fields: {}, callback: 'https://attacker.example/callback' },
      });
      expect(rejected.status).toBe(400);
      expect(callbackFetch).toHaveBeenCalledTimes(1);
    } finally {
      callbackFetch.mockRestore();
      await callbackHarness.cleanup();
    }
  });

  it.each([
    '/tmp/anchor.sqlite',
    './anchor.sqlite',
    'file:./anchor.sqlite',
    'sqlite:./anchor.sqlite',
  ])('recognizes %s as SQLite', (databaseUrl) => {
    expect(isSqliteDatabaseUrl(databaseUrl)).toBe(true);
  });

  it.each(['postgres://user:pass@localhost/db', 'postgresql://localhost/db'])(
    'keeps %s on PostgreSQL',
    (databaseUrl) => {
      expect(isSqliteDatabaseUrl(databaseUrl)).toBe(false);
    },
  );

  it('mounts /anchor and serves /health', async () => {
    const response = await invokeExpress(harness.runtime.app, { path: '/anchor/health' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', version });
  });

  it('serves HEAD /anchor/health with status 200 and no body', async () => {
    const response = await invokeExpress(harness.runtime.app, {
      method: 'HEAD',
      path: '/anchor/health',
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  it('runs challenge -> token flow', async () => {
    const account = clientKeypair.publicKey();

    const challengeResponse = await invokeExpress(harness.runtime.app, {
      path: `/anchor/auth/challenge?account=${account}`,
    });
    expect(challengeResponse.status).toBe(200);
    expect(challengeResponse.headers['cache-control']).toBe('no-store');
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);
    challengeTx.sign(clientKeypair);
    const signedChallengeXdr = challengeTx.toXDR();

    const tokenResponse = await invokeExpress(harness.runtime.app, {
      method: 'POST',
      path: '/anchor/auth/token',
      headers: { 'content-type': 'application/json' },
      body: {
        account,
        challenge: signedChallengeXdr,
      },
    });

    expect(tokenResponse.status).toBe(200);
    expect(typeof tokenResponse.body.token).toBe('string');
    expect(String(tokenResponse.body.token).length).toBeGreaterThan(0);
  });

  it('uses the default challenge expiration when the env var is absent', async () => {
    const account = clientKeypair.publicKey();

    const challengeResponse = await invokeExpress(harness.runtime.app, {
      path: `/anchor/auth/challenge?account=${account}`,
    });

    expect(challengeResponse.status).toBe(200);
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);

    expect(getChallengeLifetimeSeconds(challengeTx)).toBe(DEFAULT_CHALLENGE_EXPIRATION_SECONDS);
  });

  it('keeps watchers enabled when the env var is absent', () => {
    expect(harness.runtime.anchor.config.get('framework').watchers?.enabled).toBe(true);
  });

  it('preserves the SDK default max body bytes when the env var is absent', () => {
    expect(harness.runtime.anchor.config.get('framework').http?.maxBodyBytes).toBe(1048576);
  });
});

describe('example/express-app MAX_BODY_BYTES', () => {
  let harness: ExampleAppHarness;

  beforeAll(async () => {
    harness = await createExampleAppHarness({ maxBodyBytes: '204800' });
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it('uses the configured max body bytes from the environment', () => {
    expect(harness.runtime.anchor.config.get('framework').http?.maxBodyBytes).toBe(204800);
  });
});

describe('example/express-app CHALLENGE_EXPIRATION_SECONDS', () => {
  let harness: ExampleAppHarness;

  beforeAll(async () => {
    harness = await createExampleAppHarness({ challengeExpirationSeconds: '45' });
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it('uses the configured challenge expiration from the environment', async () => {
    const clientKeypair = Keypair.random();
    const account = clientKeypair.publicKey();

    const challengeResponse = await invokeExpress(harness.runtime.app, {
      path: `/anchor/auth/challenge?account=${account}`,
    });

    expect(challengeResponse.status).toBe(200);
    const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
    const challengeXdr = String(challengeResponse.body.challenge ?? '');
    const challengeTx = new Transaction(challengeXdr, networkPassphrase);

    expect(getChallengeLifetimeSeconds(challengeTx)).toBe(45);
  });
});

describe('example/express-app WATCHERS_ENABLED', () => {
  let harness: ExampleAppHarness;

  beforeAll(async () => {
    harness = await createExampleAppHarness({ watchersEnabled: 'false' });
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it('disables watchers when configured through the environment', () => {
    expect(harness.runtime.anchor.config.get('framework').watchers?.enabled).toBe(false);
  });
});

const DEFAULT_AUTH_TOKEN_LIFETIME_SECONDS = 3600;

function decodeJwtPayload(token: string): { exp?: number; iat?: number } {
  const payload = token.split('.')[1] ?? '';
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(json) as { exp?: number; iat?: number };
}

async function fetchAuthToken(app: Express): Promise<string> {
  const clientKeypair = Keypair.random();
  const account = clientKeypair.publicKey();

  const challengeResponse = await invokeExpress(app, {
    path: `/anchor/auth/challenge?account=${account}`,
  });
  expect(challengeResponse.status).toBe(200);
  const networkPassphrase = String(challengeResponse.body.network_passphrase ?? '');
  const challengeTx = new Transaction(String(challengeResponse.body.challenge), networkPassphrase);
  challengeTx.sign(clientKeypair);

  const tokenResponse = await invokeExpress(app, {
    method: 'POST',
    path: '/anchor/auth/token',
    headers: { 'content-type': 'application/json' },
    body: { account, challenge: challengeTx.toXDR() },
  });
  expect(tokenResponse.status).toBe(200);
  return String(tokenResponse.body.token);
}

describe('example/express-app AUTH_TOKEN_LIFETIME_SECONDS', () => {
  let harness: ExampleAppHarness;

  beforeAll(async () => {
    harness = await createExampleAppHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it('uses the default auth token lifetime when the env var is absent', async () => {
    const token = await fetchAuthToken(harness.runtime.app);
    const { exp, iat } = decodeJwtPayload(token);
    expect(exp).toBeDefined();
    expect(iat).toBeDefined();
    expect(Number(exp) - Number(iat)).toBe(DEFAULT_AUTH_TOKEN_LIFETIME_SECONDS);
  });
});

describe('example/express-app AUTH_TOKEN_LIFETIME_SECONDS configured', () => {
  let harness: ExampleAppHarness;

  beforeAll(async () => {
    harness = await createExampleAppHarness({ authTokenLifetimeSeconds: '60' });
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it('uses the configured auth token lifetime from the environment', async () => {
    const token = await fetchAuthToken(harness.runtime.app);
    const { exp, iat } = decodeJwtPayload(token);
    expect(exp).toBeDefined();
    expect(iat).toBeDefined();
    expect(Number(exp) - Number(iat)).toBe(60);
  });
});
