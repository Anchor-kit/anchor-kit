import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createAnchor, type AnchorInstance } from '@/index.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { Database } from 'bun:sqlite';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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
  body?: Record<string, unknown>;
}

function createMountedInvoker(anchor: AnchorInstance) {
  const middleware = anchor.getExpressRouter();

  return async (options: TestRequestOptions): Promise<TestResponse> => {
    const serializedBody = options.body ? JSON.stringify(options.body) : '';

    const req = Readable.from(serializedBody ? [serializedBody] : []) as IncomingMessage & {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: Record<string, unknown>;
    };

    req.method = options.method ?? 'GET';
    req.url = `/anchor${options.path}`;
    req.headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );

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
      middleware(req, res, (error) => {
        if (error) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'internal_server_error' }));
          return;
        }
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
          depositMax: 20,
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

  it('2c) /info omits support_email when not configured', async () => {
    const response = await invoke({ path: '/info' });
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('support_email');
  });

  it('2d) /info omits interactive_domain when not configured', async () => {
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

  it('3) challenge -> token happy path', async () => {
    const account = clientKeypair.publicKey();
    const challengeResponse = await invoke({
      path: `/auth/challenge?account=${account}`,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(challengeResponse.status).toBe(200);
    expect(challengeResponse.headers['cache-control']).toBe('no-store');
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
    expect(tokenResponse.headers['cache-control']).toBe('no-store');
    // Verify default TTL is used when not configured
    expect(tokenResponse.body.expires_in).toBe(3600);
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
        challengeExpirationSeconds: 300,
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
    expect(response.body).not.toHaveProperty('idempotency_replay');
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
    expect(response.body.idempotency_replay).toBe(true);
  });

  it('6d) concurrent same-key deposits do not create duplicate transactions', async () => {
    const database = (anchor as unknown as { database: DatabaseAdapter }).database;
    if (!database) throw new Error('Expected initialized database');

    const createDeposit = database.createDepositWithIdempotency.bind(database);
    let createCalls = 0;
    let signalCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    database.createDepositWithIdempotency = async (input) => {
      createCalls += 1;
      signalCreateStarted();
      await createBarrier;
      return createDeposit(input);
    };

    try {
      const options: TestRequestOptions = {
        method: 'POST',
        path: '/transactions/deposit/interactive',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': 'concurrent-deposit-key',
        },
        body: { asset_code: 'USDC', amount: '15.5' },
      };

      const firstRequest = invoke(options);
      await createStarted;
      const secondResponse = await invoke(options);
      releaseCreate();
      const firstResponse = await firstRequest;
      const responses = [firstResponse, secondResponse];

      expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
      const createdResponse = responses.find(({ status }) => status === 201);
      const pendingResponse = responses.find(({ status }) => status === 409);
      expect(typeof createdResponse?.body.id).toBe('string');
      expect(pendingResponse?.body.error).toBe('idempotency_in_progress');
      expect(pendingResponse?.headers['retry-after']).toBe('1');
      expect(createCalls).toBe(1);
    } finally {
      releaseCreate();
      database.createDepositWithIdempotency = createDeposit;
    }
  });

  it('6e) failed deposit persistence is visible and can be retried safely', async () => {
    const database = (anchor as unknown as { database: DatabaseAdapter }).database;
    const rawDatabase = new Database(dbPath);
    rawDatabase.exec(`
      CREATE TRIGGER fail_deposit_response_update
      BEFORE UPDATE ON idempotency_keys
      WHEN OLD.status = 'pending' AND NEW.status = 'completed'
      BEGIN SELECT RAISE(FAIL, 'injected response update failure'); END;
    `);

    const options: TestRequestOptions = {
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'deposit-retry-after-write-failure',
      },
      body: { asset_code: 'USDC', amount: '21.21' },
    };

    try {
      const failedResponse = await invoke(options);
      expect(failedResponse.status).toBe(500);
      expect(failedResponse.body.error).toBe('internal_server_error');
      expect(
        await database.getIdempotencyRecord(
          `deposit:${clientKeypair.publicKey()}`,
          'deposit-retry-after-write-failure',
        ),
      ).toBeNull();

      rawDatabase.exec('DROP TRIGGER fail_deposit_response_update');
      const retryResponse = await invoke(options);
      expect(retryResponse.status).toBe(201);
      expect(retryResponse.body.id).toBeDefined();

      const replayResponse = await invoke(options);
      expect(replayResponse.status).toBe(201);
      expect(replayResponse.body.id).toBe(retryResponse.body.id);
      expect(replayResponse.body.idempotency_replay).toBe(true);

      const count = rawDatabase
        .prepare(
          'SELECT COUNT(*) AS count FROM interactive_transactions WHERE account = ? AND asset_code = ? AND amount = ?',
        )
        .get(clientKeypair.publicKey(), 'USDC', '21.21') as { count: number };
      expect(Number(count.count)).toBe(1);
    } finally {
      rawDatabase.exec('DROP TRIGGER IF EXISTS fail_deposit_response_update');
      rawDatabase.close();
    }
  });

  it('6f) incomplete legacy idempotency responses are not replayed as success', async () => {
    const database = (anchor as unknown as { database: DatabaseAdapter }).database;
    const amount = '23.23';
    const idempotencyKey = 'legacy-empty-response-key';
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ assetCode: 'USDC', amount }))
      .digest('hex');

    await database.insertIdempotencyRecord({
      id: randomUUID(),
      scope: `deposit:${clientKeypair.publicKey()}`,
      idempotencyKey,
      requestHash,
      statusCode: 201,
      responseBody: '',
    });

    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: { asset_code: 'USDC', amount },
    });

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('idempotency_response_unavailable');
    expect(response.body).not.toHaveProperty('id');
    expect(response.headers['retry-after']).toBe('1');
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

  it('10aa) challenge is valid before maxTime and expires at maxTime', async () => {
    const account = clientKeypair.publicKey();
    const initialNow = Date.UTC(2026, 1, 1, 0, 0, 0);
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
    const boundaryCases = [
      { offset: -1, status: 200 },
      { offset: 0, status: 401 },
      { offset: 1, status: 401 },
    ] as const;

    try {
      for (const [index, boundaryCase] of boundaryCases.entries()) {
        dateNowSpy.mockReturnValue(initialNow);
        const challengeResponse = await invoke({
          path: `/auth/challenge?account=${account}`,
          headers: { 'x-forwarded-for': `10.0.1.${index + 1}` },
        });
        expect(challengeResponse.status).toBe(200);

        const expiresAt = Date.parse(String(challengeResponse.body.expires_at));
        const challengeTx = new Transaction(
          String(challengeResponse.body.challenge),
          String(challengeResponse.body.network_passphrase),
        );
        expect(Number(challengeTx.timeBounds?.maxTime) * 1000).toBe(expiresAt);
        challengeTx.sign(clientKeypair);

        dateNowSpy.mockReturnValue(expiresAt + boundaryCase.offset);
        const tokenResponse = await invoke({
          method: 'POST',
          path: '/auth/token',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `10.0.1.${index + 1}`,
          },
          body: { account, challenge: challengeTx.toXDR() },
        });

        expect(tokenResponse.status).toBe(boundaryCase.status);
        if (boundaryCase.status === 401) {
          expect(tokenResponse.body.message).toBe('Challenge expired');
        }
      }
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('10ab) future challenges are distinct from expired challenges', async () => {
    const account = clientKeypair.publicKey();
    const initialNow = Date.UTC(2026, 1, 2, 0, 0, 0);
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(initialNow);

    try {
      const challengeResponse = await invoke({
        path: `/auth/challenge?account=${account}`,
        headers: { 'x-forwarded-for': '10.0.1.10' },
      });
      expect(challengeResponse.status).toBe(200);
      const challengeTx = new Transaction(
        String(challengeResponse.body.challenge),
        String(challengeResponse.body.network_passphrase),
      );
      challengeTx.sign(clientKeypair);

      dateNowSpy.mockReturnValue(initialNow - 1);
      const tokenResponse = await invoke({
        method: 'POST',
        path: '/auth/token',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '10.0.1.10',
        },
        body: { account, challenge: challengeTx.toXDR() },
      });

      expect(tokenResponse.status).toBe(401);
      expect(tokenResponse.body.message).toBe('Challenge not yet valid');
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
});
