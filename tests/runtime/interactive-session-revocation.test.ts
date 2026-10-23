/**
 * AK-062 / #718 – Validate and revoke interactive sessions at each
 * state-changing action.
 *
 * Acceptance gate:
 *   - Expired, revoked, wrong-account and wrong-transaction sessions are
 *     rejected by the shared gate before any write happens (the write helper
 *     is never invoked, and no persisted row changes).
 *   - Completion consumes the permitted action exactly once; replays and
 *     concurrent callers cannot consume it a second time.
 *   - The same validation is shared by every interactive endpoint, so the
 *     transaction read and the completion write reject identical sessions.
 *
 * Run command:
 *   bun test tests/runtime/interactive-session-revocation.test.ts
 *
 * Expected result: all assertions pass (0 failures).
 */

import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { AnchorConfig } from '@/core/config.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  handleExpressRouterRequest,
  type ExpressRouterContext,
} from '@/runtime/http/express-router-impl.ts';
import { InMemoryRateLimiter } from '@/runtime/http/rate-limiter.ts';
import type { DatabaseAdapter, InteractiveSessionRecord } from '@/runtime/interfaces.ts';
import { DefaultWebhookProcessor } from '@/runtime/webhooks/default-webhook-processor.ts';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const JWT_SECRET = 'interactive-session-revocation-secret';
const HEADER = 'x-interactive-session';

const serverKeypair = Keypair.random();
const ownerAccount = Keypair.random().publicKey();
const otherAccount = Keypair.random().publicKey();

function bearerFor(account: string): string {
  return jwt.sign(
    {
      sub: account,
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
      scope: 'anchor_api',
      typ: 'access_token',
    },
    JWT_SECRET,
    { expiresIn: 300 },
  );
}

function makeRequest(options: { method: string; path: string; headers?: Record<string, string> }): {
  req: IncomingMessage;
  res: ServerResponse;
  getResult: () => { status: number; body: Record<string, unknown> };
} {
  const payload = JSON.stringify({});
  const req = new EventEmitter() as IncomingMessage & {
    url?: string;
    method?: string;
    headers: Record<string, string>;
  };
  req.url = options.path;
  req.method = options.method;
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    ...options.headers,
  };

  let status = 200;
  let responseBody = '';
  const res = {
    setHeader(_name: string, _value: string) {
      // Headers are irrelevant to these assertions; only status and body matter.
    },
    end(data?: string) {
      if (data) responseBody = data;
    },
    get statusCode() {
      return status;
    },
    set statusCode(code: number) {
      status = code;
    },
  } as unknown as ServerResponse;

  process.nextTick(() => {
    req.emit('data', Buffer.from(payload));
    req.emit('end');
  });

  return {
    req,
    res,
    getResult: () => ({
      status,
      body: responseBody ? (JSON.parse(responseBody) as Record<string, unknown>) : {},
    }),
  };
}

describe('AK-062 interactive session validation, revocation and single-use completion', () => {
  const databaseUrl = makeSqliteDbUrlForTests();
  const databasePath = databaseUrl.startsWith('file:')
    ? databaseUrl.slice('file:'.length)
    : databaseUrl;

  let database: DatabaseAdapter;
  let context: ExpressRouterContext;

  /** Counts writes attempted through the completion path. */
  let consumeCalls = 0;

  beforeAll(async () => {
    database = createSqlDatabaseAdapter({ provider: 'sqlite', url: databaseUrl });
    await database.connect();
    await database.migrate();

    const originalConsume = database.consumeInteractiveSessionAction.bind(database);
    database.consumeInteractiveSessionAction = (id, action) => {
      consumeCalls += 1;
      return originalConsume(id, action);
    };

    const config = new AnchorConfig({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.test' },
      security: {
        sep10SigningKey: serverKeypair.secret(),
        interactiveJwtSecret: JWT_SECRET,
        distributionAccountSecret: Keypair.random().secret(),
      },
      assets: { assets: [{ code: 'USDC', issuer: Keypair.random().publicKey() }] },
      framework: { database: { provider: 'sqlite', url: 'sqlite::memory:' } },
    });

    context = {
      config,
      database,
      webhookProcessor: new DefaultWebhookProcessor({ config: config.getConfig(), database }),
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
      corsOrigins: undefined,
      requestTimeout: 30_000,
    };
  });

  afterAll(async () => {
    await database.disconnect();
    try {
      unlinkSync(databasePath);
    } catch {
      // ignore cleanup errors
    }
  });

  async function seedDeposit(account: string): Promise<string> {
    const id = randomUUID();
    await database.insertInteractiveTransaction({
      id,
      account,
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '25.5',
      status: 'pending_user_transfer_start',
    });
    return id;
  }

  async function issueSession(input: {
    account: string;
    transactionId: string;
    expiresAt: string;
    actions?: string[];
  }): Promise<InteractiveSessionRecord> {
    return database.insertInteractiveSession({
      id: randomUUID(),
      account: input.account,
      transactionId: input.transactionId,
      actions: input.actions ?? ['view', 'complete'],
      expiresAt: input.expiresAt,
    });
  }

  function futureExpiry(): string {
    return new Date(Date.now() + 60_000).toISOString();
  }

  function pastExpiry(): string {
    return new Date(Date.now() - 60_000).toISOString();
  }

  async function complete(input: {
    transactionId: string;
    account: string;
    sessionId?: string | null;
  }) {
    const headers: Record<string, string> = { authorization: `Bearer ${bearerFor(input.account)}` };
    if (input.sessionId) headers[HEADER] = input.sessionId;

    const { req, res, getResult } = makeRequest({
      method: 'POST',
      path: `/transactions/${encodeURIComponent(input.transactionId)}/complete`,
      headers,
    });
    await handleExpressRouterRequest(context, req, res);
    return getResult();
  }

  async function readTransaction(input: {
    transactionId: string;
    account: string;
    sessionId?: string;
  }) {
    const headers: Record<string, string> = { authorization: `Bearer ${bearerFor(input.account)}` };
    if (input.sessionId) headers[HEADER] = input.sessionId;

    const { req, res, getResult } = makeRequest({
      method: 'GET',
      path: `/transactions/${encodeURIComponent(input.transactionId)}`,
      headers,
    });
    await handleExpressRouterRequest(context, req, res);
    return getResult();
  }

  /** Snapshot used to prove a rejected request left persisted state untouched. */
  async function snapshot(transactionId: string, sessionId: string) {
    const transaction = await database.getInteractiveTransactionById(transactionId);
    const session = await database.getInteractiveSessionById(sessionId);
    return {
      status: transaction?.status,
      updatedAt: transaction?.updatedAt,
      revokedAt: session?.revokedAt,
      consumedActions: session?.consumedActions,
    };
  }

  it('completes with a valid session and consumes the permitted action exactly once', async () => {
    const transactionId = await seedDeposit(ownerAccount);
    const session = await issueSession({
      account: ownerAccount,
      transactionId,
      expiresAt: futureExpiry(),
    });

    const before = await snapshot(transactionId, session.id);
    expect(before.consumedActions).toEqual([]);

    const callsBefore = consumeCalls;

    const first = await complete({ transactionId, account: ownerAccount, sessionId: session.id });
    expect(first.status).toBe(200);
    expect(first.body.consumed_action).toBe('complete');
    expect(first.body.interactive_session_id).toBe(session.id);
    expect(consumeCalls).toBe(callsBefore + 1);

    const afterFirst = await database.getInteractiveSessionById(session.id);
    expect(afterFirst?.consumedActions).toEqual(['complete']);

    const replay = await complete({ transactionId, account: ownerAccount, sessionId: session.id });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('interactive_session_consumed');

    // The replay is rejected by the shared gate, so the write helper is never
    // invoked a second time and the stored action list is unchanged.
    expect(consumeCalls).toBe(callsBefore + 1);

    const afterReplay = await database.getInteractiveSessionById(session.id);
    expect(afterReplay?.consumedActions).toEqual(['complete']);
  });

  it('rejects an expired session before any write', async () => {
    const transactionId = await seedDeposit(ownerAccount);
    const session = await issueSession({
      account: ownerAccount,
      transactionId,
      expiresAt: pastExpiry(),
    });

    const before = await snapshot(transactionId, session.id);
    const callsBefore = consumeCalls;

    const response = await complete({
      transactionId,
      account: ownerAccount,
      sessionId: session.id,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('interactive_session_expired');
    expect(consumeCalls).toBe(callsBefore);
    expect(await snapshot(transactionId, session.id)).toEqual(before);
  });

  it('rejects a revoked session before any write', async () => {
    const transactionId = await seedDeposit(ownerAccount);
    const session = await issueSession({
      account: ownerAccount,
      transactionId,
      expiresAt: futureExpiry(),
    });

    await expect(database.revokeInteractiveSession(session.id)).resolves.toBe(true);
    await expect(database.revokeInteractiveSession(session.id)).resolves.toBe(false);

    const before = await snapshot(transactionId, session.id);
    const callsBefore = consumeCalls;

    const response = await complete({
      transactionId,
      account: ownerAccount,
      sessionId: session.id,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('interactive_session_revoked');
    expect(consumeCalls).toBe(callsBefore);
    expect(await snapshot(transactionId, session.id)).toEqual(before);

    // Revocation is also enforced by the read endpoint through the same gate.
    const read = await readTransaction({
      transactionId,
      account: ownerAccount,
      sessionId: session.id,
    });
    expect(read.status).toBe(401);
    expect(read.body.error).toBe('interactive_session_revoked');
  });

  it('rejects a session owned by a different account before any write', async () => {
    const transactionId = await seedDeposit(ownerAccount);
    const session = await issueSession({
      account: ownerAccount,
      transactionId,
      expiresAt: futureExpiry(),
    });

    const before = await snapshot(transactionId, session.id);
    const callsBefore = consumeCalls;

    // A valid bearer token for a *different* account must not spend this session.
    const response = await complete({
      transactionId,
      account: otherAccount,
      sessionId: session.id,
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(response.body.message).toBe('Interactive session belongs to another account');
    expect(consumeCalls).toBe(callsBefore);
    expect(await snapshot(transactionId, session.id)).toEqual(before);
  });

  it('rejects a session bound to a different transaction before any write', async () => {
    const sessionTransactionId = await seedDeposit(ownerAccount);
    const otherTransactionId = await seedDeposit(ownerAccount);
    const session = await issueSession({
      account: ownerAccount,
      transactionId: sessionTransactionId,
      expiresAt: futureExpiry(),
    });

    const before = await snapshot(otherTransactionId, session.id);
    const callsBefore = consumeCalls;

    const response = await complete({
      transactionId: otherTransactionId,
      account: ownerAccount,
      sessionId: session.id,
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
    expect(response.body.message).toBe('Interactive session is bound to a different transaction');
    expect(consumeCalls).toBe(callsBefore);
    expect(await snapshot(otherTransactionId, session.id)).toEqual(before);
    expect((await database.getInteractiveSessionById(session.id))?.consumedActions).toEqual([]);
  });

  it('rejects a completion with no session at all', async () => {
    const transactionId = await seedDeposit(ownerAccount);
    const callsBefore = consumeCalls;

    const response = await complete({ transactionId, account: ownerAccount });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('interactive_session_required');
    expect(consumeCalls).toBe(callsBefore);
  });

  it('allows exactly one of many concurrent completions', async () => {
    const transactionId = await seedDeposit(ownerAccount);
    const session = await issueSession({
      account: ownerAccount,
      transactionId,
      expiresAt: futureExpiry(),
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        complete({ transactionId, account: ownerAccount, sessionId: session.id }),
      ),
    );

    const succeeded = results.filter((result) => result.status === 200);
    const rejected = results.filter((result) => result.status !== 200);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('interactive_session_consumed');
    }

    expect((await database.getInteractiveSessionById(session.id))?.consumedActions).toEqual([
      'complete',
    ]);
  });

  it('shares the same validation across the transaction read endpoint', async () => {
    const transactionId = await seedDeposit(ownerAccount);
    const expired = await issueSession({
      account: ownerAccount,
      transactionId,
      expiresAt: pastExpiry(),
    });

    const valid = await issueSession({
      account: ownerAccount,
      transactionId,
      expiresAt: futureExpiry(),
    });

    // A valid session passes the shared gate for the read endpoint.
    const ok = await readTransaction({
      transactionId,
      account: ownerAccount,
      sessionId: valid.id,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(transactionId);

    const expiredRead = await readTransaction({
      transactionId,
      account: ownerAccount,
      sessionId: expired.id,
    });
    expect(expiredRead.status).toBe(401);
    expect(expiredRead.body.error).toBe('interactive_session_expired');

    const wrongAccountRead = await readTransaction({
      transactionId,
      account: otherAccount,
      sessionId: valid.id,
    });
    expect(wrongAccountRead.status).toBe(403);
    expect(wrongAccountRead.body.message).toBe('Interactive session belongs to another account');

    // Reading never consumes the completion action.
    expect((await database.getInteractiveSessionById(valid.id))?.consumedActions).toEqual([]);

    // A plain bearer read without a session header remains valid.
    const bearerOnly = await readTransaction({ transactionId, account: ownerAccount });
    expect(bearerOnly.status).toBe(200);
  });
});
