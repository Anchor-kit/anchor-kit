/**
 * Unit tests for issue #637 — Reject oversized Idempotency-Key headers in the
 * deposit route before any DB access.
 *
 * Acceptance criteria:
 *  - Keys exactly at 255 bytes are accepted (201).
 *  - Keys above 255 bytes are rejected with 400 before touching storage.
 *  - Whitespace is normalized before the byte-length check.
 *  - No idempotency storage methods are called when the key is oversized.
 */
import { AnchorConfig } from '@/core/config.ts';
import {
  handleExpressRouterRequest,
  type ExpressRouterContext,
} from '@/runtime/http/express-router-impl.ts';
import { InMemoryRateLimiter } from '@/runtime/http/rate-limiter.ts';
import type {
  DatabaseAdapter,
  IdempotencyRecord,
  InteractiveTransactionRecord,
} from '@/runtime/interfaces.ts';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

// ─── helpers ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'idempotency-size-test-secret-32b';
const ASSET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const serverKeypair = Keypair.random();

const config = new AnchorConfig({
  network: { network: 'testnet' },
  server: { interactiveDomain: 'https://anchor.test' },
  security: {
    sep10SigningKey: serverKeypair.secret(),
    interactiveJwtSecret: JWT_SECRET,
    distributionAccountSecret: Keypair.random().secret(),
  },
  assets: {
    assets: [{ code: 'USDC', issuer: ASSET_ISSUER, deposits_enabled: true }],
  },
  framework: {
    database: { provider: 'sqlite', url: 'file:idempotency-size-test.sqlite' },
  },
});

/** Builds a valid interactive-deposit bearer token for the given account. */
function mintToken(account: string): string {
  return jwt.sign(
    {
      sub: account,
      iss: 'anchor-kit',
      aud: 'anchor-api',
      scope: 'anchor_api',
      typ: 'access_token',
    },
    JWT_SECRET,
    { expiresIn: 3600 },
  );
}

/**
 * Build a DatabaseAdapter where the happy-path methods work and the
 * idempotency storage methods are spied on so tests can assert call counts.
 *
 * @param rejectOnIdempotency when true the idempotency storage methods throw
 *   immediately, which verifies that oversized-key requests never reach storage.
 */
function makeFakeDb(rejectOnIdempotency = false): {
  db: DatabaseAdapter;
  spyReserve: ReturnType<typeof vi.spyOn>;
  spyCreateDeposit: ReturnType<typeof vi.spyOn>;
  spyInsertOrGet: ReturnType<typeof vi.spyOn>;
} {
  const now = new Date().toISOString();

  const db: DatabaseAdapter = {
    async connect() {},
    async disconnect() {},
    async migrate() {},
    async insertAuthChallenge() {},
    async getAuthChallengeByChallenge() {
      return null;
    },
    async markAuthChallengeConsumed() {
      return false;
    },
    async insertInteractiveTransaction(input): Promise<InteractiveTransactionRecord> {
      return {
        id: input.id,
        account: input.account,
        kind: 'deposit' as const,
        assetCode: input.assetCode,
        amount: input.amount,
        status: input.status,
        createdAt: now,
        updatedAt: now,
      };
    },
    async getInteractiveTransactionById() {
      return null;
    },
    async listPendingTransactionsBefore() {
      return [];
    },
    async updateTransactionStatus() {
      return true;
    },
    async getIdempotencyRecord() {
      return null;
    },
    async insertOrGetIdempotencyRecord(input): Promise<IdempotencyRecord> {
      if (rejectOnIdempotency) throw new Error('Should not be called');
      return {
        id: input.id,
        scope: input.scope,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        statusCode: input.statusCode,
        responseBody: input.responseBody,
        status: 'completed',
        createdAt: now,
      };
    },
    async updateIdempotencyRecord() {},
    async reserveIdempotencyRecord(input): Promise<{ record: IdempotencyRecord; inserted: boolean }> {
      if (rejectOnIdempotency) throw new Error('Should not be called');
      return {
        record: {
          id: input.id,
          scope: input.scope,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          statusCode: 201,
          responseBody: '{}',
          status: 'pending',
          createdAt: now,
        },
        inserted: true,
      };
    },
    async createDepositWithIdempotency(input): Promise<InteractiveTransactionRecord> {
      if (rejectOnIdempotency) throw new Error('Should not be called');
      return {
        id: input.transaction.id,
        account: input.transaction.account,
        kind: 'deposit' as const,
        assetCode: input.transaction.assetCode,
        amount: input.transaction.amount,
        status: input.transaction.status,
        createdAt: input.transaction.createdAt,
        updatedAt: now,
      };
    },
    async deletePendingIdempotencyRecord() {},
    async insertOrGetWebhookEvent() {
      throw new Error('Not implemented in this stub');
    },
    async updateWebhookEventStatus() {},
    async insertWatcherTask() {},
    async listPendingWatcherTasks() {
      return [];
    },
    async updateWatcherTaskStatus() {},
    async countProcessedWatcherTasks() {
      return 0;
    },
    async cleanupOldRecords() {},
  };

  return {
    db,
    spyReserve: vi.spyOn(db, 'reserveIdempotencyRecord'),
    spyCreateDeposit: vi.spyOn(db, 'createDepositWithIdempotency'),
    spyInsertOrGet: vi.spyOn(db, 'insertOrGetIdempotencyRecord'),
  };
}

function makeContext(db: DatabaseAdapter): ExpressRouterContext {
  return {
    config,
    database: db,
    webhookProcessor: {
      async process(input) {
        return { duplicate: false, eventId: input.eventId, provider: input.provider };
      },
    },
    sep10ServerKeypair: serverKeypair,
    networkPassphrase: Networks.TESTNET,
    maxBodyBytes: 65536,
    corsOrigins: undefined,
    requestTimeout: 30000,
    rateLimiter: new InMemoryRateLimiter(),
    rateRules: {
      auth_challenge: { windowMs: 60000, maxRequests: 1000 },
      auth_token: { windowMs: 60000, maxRequests: 1000 },
      webhook: { windowMs: 60000, maxRequests: 1000 },
      deposit: { windowMs: 60000, maxRequests: 1000 },
    },
  };
}

interface InvokeOptions {
  idempotencyKey?: string;
  body?: Record<string, unknown>;
}

async function invokeDeposit(
  context: ExpressRouterContext,
  account: string,
  options: InvokeOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = mintToken(account);
  const bodyStr = JSON.stringify(options.body ?? { asset_code: 'USDC', amount: '1' });

  const emitter = new EventEmitter() as unknown as IncomingMessage;
  (emitter as unknown as { method: string }).method = 'POST';
  (emitter as unknown as { url: string }).url = '/transactions/deposit/interactive';
  (emitter as unknown as { headers: Record<string, string> }).headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...(options.idempotencyKey !== undefined
      ? { 'idempotency-key': options.idempotencyKey }
      : {}),
  };
  (emitter as unknown as { rawBody: string }).rawBody = bodyStr;

  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    let status = 200;
    const res = {
      headersSent: false,
      get statusCode() {
        return status;
      },
      set statusCode(v: number) {
        status = v;
      },
      setHeader() {},
      getHeader() {
        return undefined;
      },
      end(payload?: string) {
        resolve({
          status,
          body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
        });
      },
    } as unknown as ServerResponse;

    void handleExpressRouterRequest(context, emitter, res);
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('Idempotency-Key size limit (issue #637)', () => {
  it('accepts a key exactly at 255 ASCII bytes', async () => {
    const { db } = makeFakeDb();
    const context = makeContext(db);
    const account = Keypair.random().publicKey();
    const key = 'a'.repeat(255);

    const response = await invokeDeposit(context, account, { idempotencyKey: key });

    expect(response.status).toBe(201);
  });

  it('rejects a key that is 256 ASCII bytes (one over the limit) with 400', async () => {
    const { db } = makeFakeDb(true); // idempotency methods must not be called
    const context = makeContext(db);
    const account = Keypair.random().publicKey();
    const key = 'a'.repeat(256);

    const response = await invokeDeposit(context, account, { idempotencyKey: key });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(String(response.body.message)).toMatch(/255/);
  });

  it('does NOT call any idempotency storage method when the key is oversized', async () => {
    const { db, spyReserve, spyCreateDeposit, spyInsertOrGet } = makeFakeDb();
    const context = makeContext(db);
    const account = Keypair.random().publicKey();
    const key = 'a'.repeat(256);

    await invokeDeposit(context, account, { idempotencyKey: key });

    expect(spyReserve).not.toHaveBeenCalled();
    expect(spyCreateDeposit).not.toHaveBeenCalled();
    expect(spyInsertOrGet).not.toHaveBeenCalled();
  });

  it('applies the byte-length check on the whitespace-normalized key value', async () => {
    // 256 bytes of content surrounded by whitespace → still 256 bytes after trim → rejected
    const accountReject = Keypair.random().publicKey();
    const keyOverLimit = `  ${'a'.repeat(256)}  `;
    const { db: dbReject } = makeFakeDb(true);
    const rejectedResponse = await invokeDeposit(makeContext(dbReject), accountReject, {
      idempotencyKey: keyOverLimit,
    });
    expect(rejectedResponse.status).toBe(400);
    expect(rejectedResponse.body.error).toBe('invalid_request');

    // 255 bytes of content surrounded by whitespace → 255 bytes after trim → accepted
    const accountAccept = Keypair.random().publicKey();
    const keyAtLimit = `  ${'a'.repeat(255)}  `;
    const { db: dbAccept } = makeFakeDb();
    const acceptedResponse = await invokeDeposit(makeContext(dbAccept), accountAccept, {
      idempotencyKey: keyAtLimit,
    });
    expect(acceptedResponse.status).toBe(201);
  });

  it('accepts a key whose byte length equals 255 with multi-byte UTF-8 characters', async () => {
    // Each '§' (U+00A7) is 2 bytes in UTF-8.
    // 127 '§' chars = 254 bytes, plus one 'a' = 255 bytes total.
    const { db } = makeFakeDb();
    const context = makeContext(db);
    const account = Keypair.random().publicKey();
    const multiByte = '§'.repeat(127) + 'a'; // 254 + 1 = 255 bytes
    const response = await invokeDeposit(context, account, { idempotencyKey: multiByte });
    expect(response.status).toBe(201);
  });

  it('rejects a key that is 256 bytes via multi-byte UTF-8 characters', async () => {
    // 128 '§' chars = 256 bytes in UTF-8 — over the limit.
    const { db, spyReserve } = makeFakeDb(true);
    const context = makeContext(db);
    const account = Keypair.random().publicKey();
    const multiByte = '§'.repeat(128); // 256 bytes
    const response = await invokeDeposit(context, account, { idempotencyKey: multiByte });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(spyReserve).not.toHaveBeenCalled();
  });
});
