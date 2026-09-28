import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { createExampleApp, isSqliteDatabaseUrl } from '../example/express-app.ts';
import { version } from '../package.json';

interface ExampleAppRuntime {
  app: Express;
  anchor: {
    config: {
      get: (key: 'framework') => {
        watchers?: {
          enabled?: boolean;
        };
        http?: {
          maxBodyBytes?: number;
        };
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

  setOptionalEnvVar('DATABASE_URL', `file:${dbPath}`);
  setOptionalEnvVar('SEP10_SIGNING_KEY', sep10ServerKeypair.secret());
  setOptionalEnvVar('CHALLENGE_EXPIRATION_SECONDS', options.challengeExpirationSeconds);
  setOptionalEnvVar('WATCHERS_ENABLED', options.watchersEnabled);
  setOptionalEnvVar('MAX_BODY_BYTES', options.maxBodyBytes);
  setOptionalEnvVar('AUTH_TOKEN_LIFETIME_SECONDS', options.authTokenLifetimeSeconds);

  const runtime = await createExampleApp();

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
