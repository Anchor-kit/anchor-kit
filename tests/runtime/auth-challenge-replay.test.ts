import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import { AnchorConfig } from '@/core/config.ts';
import {
  handleExpressRouterRequest,
  type ExpressRouterContext,
} from '@/runtime/http/express-router-impl.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { InMemoryRateLimiter } from '@/runtime/http/rate-limiter.ts';
import { DefaultWebhookProcessor } from '@/runtime/webhooks/default-webhook-processor.ts';
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

class ControllableFakeDatabaseAdapter implements DatabaseAdapter {
  public challenges = new Map<
    string,
    {
      id: string;
      account: string;
      challenge: string;
      expiresAt: string;
      consumedAt: string | null;
      createdAt: string;
    }
  >();
  public markConsumedFailOnce = false;
  public markConsumedDelayMs = 0;
  private consumeLock = false;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async migrate(): Promise<void> {}

  async insertAuthChallenge(input: {
    id: string;
    account: string;
    challenge: string;
    expiresAt: string;
  }): Promise<void> {
    this.challenges.set(input.challenge, {
      id: input.id,
      account: input.account,
      challenge: input.challenge,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  async getAuthChallengeByChallenge(challenge: string) {
    const found = this.challenges.get(challenge);
    return found ? { ...found } : null;
  }

  async markAuthChallengeConsumed(id: string): Promise<boolean> {
    if (this.markConsumedFailOnce) {
      this.markConsumedFailOnce = false;
      throw new Error('Database persistence failure during challenge consume');
    }

    if (this.markConsumedDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.markConsumedDelayMs));
    }

    // Atomic compare-and-set simulation
    for (const record of this.challenges.values()) {
      if (record.id === id) {
        if (record.consumedAt !== null) {
          return false;
        }
        if (this.consumeLock) {
          return false;
        }
        this.consumeLock = true;
        try {
          record.consumedAt = new Date().toISOString();
          return true;
        } finally {
          this.consumeLock = false;
        }
      }
    }
    return false;
  }

  async insertInteractiveTransaction(): Promise<never> {
    throw new Error('Not implemented');
  }
  async getInteractiveTransactionById(): Promise<null> {
    return null;
  }
  async listPendingTransactionsBefore(): Promise<never[]> {
    return [];
  }
  async updateTransactionStatus(_id: string, _status: string): Promise<boolean> {
    return true;
  }
  async getIdempotencyRecord(): Promise<null> {
    return null;
  }
  async insertOrGetIdempotencyRecord(): Promise<never> {
    throw new Error('Not implemented');
  }
  async updateIdempotencyRecord(): Promise<void> {}
  async insertOrGetWebhookEvent(): Promise<never> {
    throw new Error('Not implemented');
  }
  async updateWebhookEventStatus(): Promise<void> {}
  async insertWatcherTask(): Promise<void> {}
  async listPendingWatcherTasks(): Promise<never[]> {
    return [];
  }
  async updateWatcherTaskStatus(): Promise<void> {}
  async countProcessedWatcherTasks(): Promise<number> {
    return 0;
  }
  async cleanupOldRecords(): Promise<void> {}
}

function makeTestContext(dbAdapter: DatabaseAdapter, serverKeypair: Keypair): ExpressRouterContext {
  const config = new AnchorConfig({
    network: { network: 'testnet' },
    server: { interactiveDomain: 'https://anchor.test' },
    security: {
      sep10SigningKey: serverKeypair.secret(),
      interactiveJwtSecret: 'test-jwt-secret-key-1234567890',
      distributionAccountSecret: Keypair.random().secret(),
    },
    assets: {
      assets: [{ code: 'USDC', issuer: Keypair.random().publicKey() }],
    },
    framework: {
      database: { provider: 'sqlite', url: 'sqlite::memory:' },
    },
  });

  return {
    config,
    database: dbAdapter,
    webhookProcessor: new DefaultWebhookProcessor({
      config: config.getConfig(),
      database: dbAdapter,
    }),
    rateLimiter: new InMemoryRateLimiter(),
    rateRules: {
      auth_challenge: { windowMs: 60000, max: 1000 },
      auth_token: { windowMs: 60000, max: 1000 },
      webhook: { windowMs: 60000, max: 1000 },
      deposit: { windowMs: 60000, max: 1000 },
    },
    sep10ServerKeypair: serverKeypair,
    networkPassphrase: Networks.TESTNET,
    maxBodyBytes: 1048576,
  };
}

async function buildSignedChallengeXdr(
  serverKeypair: Keypair,
  userKeypair: Keypair,
  context: ExpressRouterContext,
): Promise<{ challengeXdr: string; nonce: string }> {
  const account = userKeypair.publicKey();
  const nonce = 'test-nonce-' + Math.random().toString(36).slice(2);
  const now = Math.floor(Date.now() / 1000);

  const tx = new TransactionBuilder(new Account(serverKeypair.publicKey(), '0'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: 'anchor_auth',
        value: nonce,
        source: account,
      }),
    )
    .setTimebounds(now, now + 300)
    .build();

  tx.sign(serverKeypair);
  tx.sign(userKeypair);

  const expiresAt = new Date((now + 300) * 1000).toISOString();
  await context.database.insertAuthChallenge({
    id: 'challenge-id-' + nonce,
    account,
    challenge: nonce,
    expiresAt,
  });

  return { challengeXdr: tx.toXDR(), nonce };
}

function makeMockRequestResponse(method: string, path: string, body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  const req = new EventEmitter() as IncomingMessage & {
    body?: unknown;
    rawBody?: unknown;
    url?: string;
    method?: string;
    headers: Record<string, string>;
  };
  req.url = path;
  req.method = method;
  req.body = body;
  req.rawBody = json;
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(json)),
  };

  let responseStatusCode = 200;
  const responseHeaders: Record<string, string> = {};
  let responseBody = '';

  const res = {
    setHeader(name: string, value: string) {
      responseHeaders[name.toLowerCase()] = value;
    },
    end(data?: string) {
      if (data) responseBody = data;
    },
    get statusCode() {
      return responseStatusCode;
    },
    set statusCode(code: number) {
      responseStatusCode = code;
    },
  } as unknown as ServerResponse;

  process.nextTick(() => {
    req.emit('data', Buffer.from(json));
    req.emit('end');
  });

  return {
    req,
    res,
    getResult() {
      return {
        status: responseStatusCode,
        headers: responseHeaders,
        body: responseBody ? JSON.parse(responseBody) : {},
      };
    },
  };
}

describe('Auth Challenge Consumption Atomicity & Recovery (#451)', () => {
  it('ensures concurrent exchanges have at most one successful consumer', async () => {
    const serverKeypair = Keypair.random();
    const userKeypair = Keypair.random();
    const fakeDb = new ControllableFakeDatabaseAdapter();
    fakeDb.markConsumedDelayMs = 10; // add slight delay to test concurrency race condition
    const context = makeTestContext(fakeDb, serverKeypair);

    const { challengeXdr } = await buildSignedChallengeXdr(serverKeypair, userKeypair, context);

    // Launch 5 concurrent requests for token exchange using the same challenge
    const numConcurrent = 5;
    const promises = Array.from({ length: numConcurrent }, async () => {
      const { req, res, getResult } = makeMockRequestResponse('POST', '/auth/token', {
        account: userKeypair.publicKey(),
        challenge: challengeXdr,
      });
      await handleExpressRouterRequest(context, req, res);
      return getResult();
    });

    const results = await Promise.all(promises);

    const successful = results.filter((r) => r.status === 200);
    const failed = results.filter((r) => r.status === 401);

    expect(successful).toHaveLength(1);
    expect(successful[0].body.token).toBeDefined();
    expect(successful[0].body.token_type).toBe('Bearer');

    expect(failed).toHaveLength(numConcurrent - 1);
    failed.forEach((f) => {
      expect(f.body.error).toBe('invalid_challenge');
      expect(f.body.message).toBe('Challenge already used');
    });
  });

  it('handles failed persistence operation with 500 error, issues no token, and allows recovery on retry', async () => {
    const serverKeypair = Keypair.random();
    const userKeypair = Keypair.random();
    const fakeDb = new ControllableFakeDatabaseAdapter();
    fakeDb.markConsumedFailOnce = true; // DB throws error on consume
    const context = makeTestContext(fakeDb, serverKeypair);

    const { challengeXdr } = await buildSignedChallengeXdr(serverKeypair, userKeypair, context);

    // First attempt: DB persistence fails during consume
    const reqRes1 = makeMockRequestResponse('POST', '/auth/token', {
      account: userKeypair.publicKey(),
      challenge: challengeXdr,
    });
    await handleExpressRouterRequest(context, reqRes1.req, reqRes1.res);
    const result1 = reqRes1.getResult();

    expect(result1.status).toBe(500);
    expect(result1.body.error).toBe('server_error');
    expect(result1.body.message).toBe('Failed to record challenge consumption');
    expect(result1.body.token).toBeUndefined();

    // Second attempt: DB persistence succeeds (recovery)
    const reqRes2 = makeMockRequestResponse('POST', '/auth/token', {
      account: userKeypair.publicKey(),
      challenge: challengeXdr,
    });
    await handleExpressRouterRequest(context, reqRes2.req, reqRes2.res);
    const result2 = reqRes2.getResult();

    expect(result2.status).toBe(200);
    expect(result2.body.token).toBeDefined();
    expect(result2.body.token_type).toBe('Bearer');
  });

  it('guarantees atomic consumption in SqlDatabaseAdapter under concurrent calls', async () => {
    const dbUrl = makeSqliteDbUrlForTests();
    const adapter = createSqlDatabaseAdapter({ provider: 'sqlite', url: dbUrl });
    await adapter.connect();
    await adapter.migrate();

    const challengeId = 'concurrent-challenge-id';
    await adapter.insertAuthChallenge({
      id: challengeId,
      account: Keypair.random().publicKey(),
      challenge: 'nonce-concurrent-123',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });

    const numConcurrent = 10;
    const results = await Promise.all(
      Array.from({ length: numConcurrent }, () => adapter.markAuthChallengeConsumed(challengeId)),
    );

    const trueCount = results.filter((r) => r === true).length;
    const falseCount = results.filter((r) => r === false).length;

    expect(trueCount).toBe(1);
    expect(falseCount).toBe(numConcurrent - 1);

    await adapter.disconnect();
  });
});
