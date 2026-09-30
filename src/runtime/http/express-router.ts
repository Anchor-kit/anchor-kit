import { version } from '../../../package.json';
import Big from 'big.js';
import type { AnchorConfig } from '@/core/config.ts';
import { ValidationError } from '@/core/errors.ts';
import { InMemoryRateLimiter, type RateLimitRule } from '@/runtime/http/rate-limiter.ts';
import type { DatabaseAdapter, WebhookProcessor } from '@/runtime/interfaces.ts';
import {
  Account,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { IdempotencyUtils } from '@/utils/idempotency.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ExpressLikeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
) => void;

interface RouterDependencies {
  config: AnchorConfig;
  database: DatabaseAdapter;
  webhookProcessor: WebhookProcessor;
}

interface AuthenticatedRequestData {
  account: string;
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

interface RawBodyCarrier {
  rawBody?: string;
}

const SEP10_NONCE_OP = 'anchor_auth';

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
  }
  res.end(JSON.stringify(body));
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

function getBodyByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

async function readRawBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const reqWithRaw = req as IncomingMessage & RawBodyCarrier;
  if (typeof reqWithRaw.rawBody === 'string') {
    if (getBodyByteLength(reqWithRaw.rawBody) > maxBodyBytes) {
      throw new ValidationError(`Request body too large. Max ${maxBodyBytes} bytes`);
    }
    return reqWithRaw.rawBody;
  }

  const bodyFromFramework = (req as IncomingMessage & { body?: unknown }).body;
  if (bodyFromFramework !== undefined) {
    const serialized =
      typeof bodyFromFramework === 'string' ? bodyFromFramework : JSON.stringify(bodyFromFramework);
    if (getBodyByteLength(serialized) > maxBodyBytes) {
      throw new ValidationError(`Request body too large. Max ${maxBodyBytes} bytes`);
    }
    return serialized;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += chunkBuffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new ValidationError(`Request body too large. Max ${maxBodyBytes} bytes`);
    }
    chunks.push(chunkBuffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function jsonParseObject(rawBody: string): Record<string, unknown> {
  if (!rawBody) return {};

  const parsed: unknown = JSON.parse(rawBody);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Request JSON body must be an object');
  }

  return parsed as Record<string, unknown>;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeDepositAmount(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  ) {
    return null;
  }

  return new Big(value).toFixed();
}

function readBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const [scheme, token] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function endpointPath(req: IncomingMessage): string {
  return parseUrl(req).pathname;
}

function extractClientIdentifier(req: IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  const leftMost = typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null;
  const socketIp = req.socket?.remoteAddress;
  return leftMost || socketIp || 'unknown';
}

function hasValidSignature(transaction: Transaction, publicKey: string): boolean {
  const keypair = Keypair.fromPublicKey(publicKey);
  const hash = transaction.hash();

  for (const signature of transaction.signatures) {
    try {
      if (keypair.verify(hash, signature.signature())) {
        return true;
      }
    } catch {
      // skip invalid signature entries
    }
  }

  return false;
}

function extractNonceFromChallenge(transaction: Transaction): string | null {
  for (const operation of transaction.operations) {
    if (operation.type !== 'manageData') {
      continue;
    }

    const manageDataOp = operation as unknown as {
      name?: unknown;
      value?: unknown;
    };

    const name = manageDataOp.name;
    if (typeof name !== 'string' || name !== SEP10_NONCE_OP) {
      continue;
    }

    const value = manageDataOp.value;
    if (value instanceof Buffer) {
      return value.toString('utf8');
    }

    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('utf8');
    }

    if (typeof value === 'string') {
      return value;
    }
  }

  return null;
}

export class AnchorExpressRouter {
  private readonly config: AnchorConfig;
  private readonly database: DatabaseAdapter;
  private readonly webhookProcessor: WebhookProcessor;
  private readonly sep10ServerKeypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly maxBodyBytes: number;
  private readonly rateLimiter = new InMemoryRateLimiter();
  private readonly rateRules: Record<
    'auth_challenge' | 'auth_token' | 'webhook' | 'deposit',
    RateLimitRule
  >;

  constructor(dependencies: RouterDependencies) {
    this.config = dependencies.config;
    this.database = dependencies.database;
    this.webhookProcessor = dependencies.webhookProcessor;
    this.sep10ServerKeypair = Keypair.fromSecret(this.config.get('security').sep10SigningKey);
    this.networkPassphrase = this.config.get('network').networkPassphrase ?? '';
    this.maxBodyBytes = this.config.get('framework').http?.maxBodyBytes ?? 1024 * 1024;

    const rateLimitConfig = this.config.get('framework').rateLimit;
    const windowMs = rateLimitConfig?.windowMs ?? 60000;

    this.rateRules = {
      auth_challenge: { windowMs, max: rateLimitConfig?.authChallengeMax ?? 30 },
      auth_token: { windowMs, max: rateLimitConfig?.authTokenMax ?? 30 },
      webhook: { windowMs, max: rateLimitConfig?.webhookMax ?? 120 },
      deposit: { windowMs, max: rateLimitConfig?.depositMax ?? 60 },
    };
  }

  public getMiddleware(): ExpressLikeMiddleware {
    return (req, res, next) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (next) {
          next(error);
          return;
        }

        sendJson(res, 500, {
          error: 'internal_server_error',
          message: 'Internal server error',
        });
      });
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = endpointPath(req);
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && path === '/info') {
      const fullConfig = this.config.getConfig();
      const responseBody: Record<string, unknown> = {
        name: fullConfig.operational?.name ?? 'Anchor-Kit Anchor',
        network: fullConfig.network.network,
        assets: fullConfig.assets.assets,
        version,
      };

      if (fullConfig.server.interactiveDomain) {
        responseBody.interactive_domain = fullConfig.server.interactiveDomain;
      }

      if (fullConfig.operational?.supportEmail) {
        responseBody.support_email = fullConfig.operational.supportEmail;
      }

      if (fullConfig.operational?.website) {
        responseBody.website = fullConfig.operational.website;
      }

      sendJson(res, 200, responseBody);
      return;
    }

    if (method === 'GET' && path === '/auth/challenge') {
      if (!this.checkRateLimit(req, res, 'auth_challenge')) {
        return;
      }

      const account = parseUrl(req).searchParams.get('account');
      if (!account) {
        sendJson(res, 400, {
          error: 'invalid_request',
          message: 'Query param account is required',
        });
        return;
      }

      if (!StrKey.isValidEd25519PublicKey(account)) {
        sendJson(res, 400, {
          error: 'invalid_request',
          message: 'account must be a valid Stellar public key',
        });
        return;
      }

      const nonce = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const expirationSeconds = this.config.get('security').challengeExpirationSeconds ?? 300;
      const expiresAtUnix = now + expirationSeconds;

      const challengeTx = new TransactionBuilder(
        new Account(this.sep10ServerKeypair.publicKey(), '0'),
        {
          fee: '100',
          networkPassphrase: this.networkPassphrase,
        },
      )
        .addOperation(
          Operation.manageData({
            name: SEP10_NONCE_OP,
            value: nonce,
            source: account,
          }),
        )
        .setTimebounds(now, expiresAtUnix)
        .build();

      challengeTx.sign(this.sep10ServerKeypair);
      const challengeXdr = challengeTx.toXDR();
      const expiresAt = new Date(expiresAtUnix * 1000).toISOString();

      await this.database.insertAuthChallenge({
        id: randomUUID(),
        account,
        challenge: nonce,
        expiresAt,
      });

      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, 200, {
        challenge: challengeXdr,
        network_passphrase: this.networkPassphrase,
        expires_at: expiresAt,
      });
      return;
    }

    if (method === 'POST' && path === '/auth/token') {
      if (!this.checkRateLimit(req, res, 'auth_token')) {
        return;
      }

      const rawBody = await readRawBody(req, this.maxBodyBytes);
      const body = jsonParseObject(rawBody);
      const account = typeof body.account === 'string' ? body.account : '';
      const signedChallenge = typeof body.challenge === 'string' ? body.challenge : '';

      if (!account || !signedChallenge) {
        sendJson(res, 400, {
          error: 'invalid_request',
          message: 'Body must include account and challenge',
        });
        return;
      }

      if (!StrKey.isValidEd25519PublicKey(account)) {
        sendJson(res, 400, {
          error: 'invalid_request',
          message: 'account must be a valid Stellar public key',
        });
        return;
      }

      let transaction: Transaction;
      try {
        transaction = new Transaction(signedChallenge, this.networkPassphrase);
      } catch {
        sendJson(res, 401, {
          error: 'invalid_challenge',
          message: 'Challenge transaction is invalid',
        });
        return;
      }

      if (transaction.source !== this.sep10ServerKeypair.publicKey()) {
        sendJson(res, 401, {
          error: 'invalid_challenge',
          message: 'Challenge source account mismatch',
        });
        return;
      }

      const nonce = extractNonceFromChallenge(transaction);
      if (!nonce) {
        sendJson(res, 401, {
          error: 'invalid_challenge',
          message: 'Challenge nonce missing',
        });
        return;
      }

      if (!hasValidSignature(transaction, this.sep10ServerKeypair.publicKey())) {
        sendJson(res, 401, {
          error: 'invalid_challenge',
          message: 'Challenge is missing anchor signature',
        });
        return;
      }

      if (!hasValidSignature(transaction, account)) {
        sendJson(res, 401, {
          error: 'invalid_challenge',
          message: 'Challenge is missing account signature',
        });
        return;
      }

      const stored = await this.database.getAuthChallengeByChallenge(nonce);
      if (!stored || stored.account !== account) {
        sendJson(res, 401, { error: 'invalid_challenge', message: 'Challenge not found' });
        return;
      }

      if (stored.consumedAt) {
        sendJson(res, 401, { error: 'invalid_challenge', message: 'Challenge already used' });
        return;
      }

      if (new Date(stored.expiresAt).getTime() < Date.now()) {
        sendJson(res, 401, { error: 'invalid_challenge', message: 'Challenge expired' });
        return;
      }

      await this.database.markAuthChallengeConsumed(stored.id);

      const tokenLifetime = this.config.get('security').authTokenLifetimeSeconds ?? 3600;

      const token = jwt.sign(
        {
          sub: account,
          scope: 'anchor_api',
          typ: 'access_token',
        },
        this.config.get('security').interactiveJwtSecret,
        { expiresIn: tokenLifetime },
      );

      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, 200, {
        token,
        expires_in: tokenLifetime,
        token_type: 'Bearer',
      });
      return;
    }

    if (method === 'POST' && path === '/transactions/deposit/interactive') {
      if (!this.checkRateLimit(req, res, 'deposit')) {
        return;
      }

      const auth = this.authenticate(req);
      if (!auth) {
        sendJson(res, 401, { error: 'unauthorized', message: 'Missing or invalid bearer token' });
        return;
      }

      const rawBody = await readRawBody(req, this.maxBodyBytes);
      const body = jsonParseObject(rawBody);
      const assetCode = typeof body.asset_code === 'string' ? body.asset_code : '';
      const amount = normalizeDepositAmount(body.amount);

      if (!assetCode || amount === null || !amount) {
        sendJson(res, 400, {
          error: 'invalid_request',
          message: 'Body must include asset_code and amount',
        });
        return;
      }

      const selectedAsset = this.config.getAsset(assetCode);
      if (!selectedAsset || selectedAsset.deposits_enabled === false) {
        sendJson(res, 400, { error: 'invalid_asset', message: 'Unsupported or disabled asset' });
        return;
      }

      const numericAmount = toNumber(amount);
      if (
        !/^-?\d+(\.\d+)?$/.test(amount) ||
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        sendJson(res, 400, {
          error: 'invalid_amount',
          message: 'Amount must be a positive number',
        });
        return;
      }

      if (selectedAsset.max_amount !== undefined && numericAmount > selectedAsset.max_amount) {
        sendJson(res, 400, {
          error: 'invalid_amount',
          message: `Amount exceeds the maximum allowed of ${selectedAsset.max_amount}`,
          max_amount: selectedAsset.max_amount,
        });
        return;
      }

      if (selectedAsset.min_amount !== undefined && numericAmount < selectedAsset.min_amount) {
        sendJson(res, 400, {
          error: 'invalid_amount',
          message: `Amount is below the minimum allowed of ${selectedAsset.min_amount}`,
          min_amount: selectedAsset.min_amount,
        });
        return;
      }

      const idempotencyKey = IdempotencyUtils.extractIdempotencyHeader(
        req.headers,
        'idempotency-key',
      );
      const scope = `deposit:${auth.account}`;
      const requestHash = sha256(JSON.stringify({ assetCode, amount }));

      if (idempotencyKey !== null) {
        const existing = await this.database.getIdempotencyRecord(scope, idempotencyKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            sendJson(res, 409, {
              error: 'idempotency_conflict',
              message: 'Idempotency key was already used with a different request body',
            });
            return;
          }

          const cachedResponse = JSON.parse(existing.responseBody) as Record<string, unknown>;
          sendJson(res, existing.statusCode, {
            ...cachedResponse,
            updated_at: cachedResponse.updated_at ?? cachedResponse.created_at,
            idempotency_replay: true,
          });
          return;
        }
      }

      const transactionId = randomUUID();
      const created = await this.database.insertInteractiveTransaction({
        id: transactionId,
        account: auth.account,
        kind: 'deposit',
        assetCode,
        amount,
        status: 'pending_user_transfer_start',
      });

      const response: JsonResponse = {
        status: 201,
        body: {
          id: created.id,
          kind: created.kind,
          status: created.status,
          amount: created.amount,
          asset_code: created.assetCode,
          asset_issuer: selectedAsset.issuer,
          interactive_url: `${this.config.get('server').interactiveDomain ?? 'http://localhost:3000'}/deposit/${created.id}`,
          created_at: created.createdAt,
          updated_at: created.updatedAt,
        },
      };

      if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
        await this.database.insertIdempotencyRecord({
          id: randomUUID(),
          scope,
          idempotencyKey,
          requestHash,
          statusCode: response.status,
          responseBody: JSON.stringify(response.body),
        });
      }

      sendJson(res, response.status, response.body);
      return;
    }

    const transactionMatch = /^\/transactions\/([^/]+)$/.exec(path);
    if (method === 'GET' && transactionMatch) {
      const auth = this.authenticate(req);
      if (!auth) {
        sendJson(res, 401, { error: 'unauthorized', message: 'Missing or invalid bearer token' });
        return;
      }

      const transactionId = decodeURIComponent(transactionMatch[1]);
      const transaction = await this.database.getInteractiveTransactionById(transactionId);

      if (!transaction) {
        sendJson(res, 404, { error: 'not_found', message: 'Transaction not found' });
        return;
      }

      if (transaction.account !== auth.account) {
        sendJson(res, 403, {
          error: 'forbidden',
          message: 'Transaction belongs to another account',
        });
        return;
      }

      const serverConfig = this.config.get('server');
      const selectedAsset = this.config.getAsset(transaction.assetCode);
      const responseData: Record<string, unknown> & { more_info_url?: string } = {
        id: transaction.id,
        kind: transaction.kind,
        status: transaction.status,
        amount: transaction.amount,
        asset_code: transaction.assetCode,
        asset_issuer: selectedAsset?.issuer,
        account: transaction.account,
        interactive_url: `${serverConfig.interactiveDomain ?? 'http://localhost:3000'}/deposit/${transaction.id}`,
        created_at: transaction.createdAt,
        updated_at: transaction.updatedAt,
      };

      // Add more_info_url only when interactive domain is configured
      if (serverConfig.interactiveDomain) {
        responseData.more_info_url = `${serverConfig.interactiveDomain}/deposit/${transaction.id}`;
      }

      sendJson(res, 200, responseData);
      return;
    }

    if (method === 'POST' && path === '/webhooks/events') {
      if (!this.checkRateLimit(req, res, 'webhook')) {
        return;
      }

      const rawBody = await readRawBody(req, this.maxBodyBytes);
      const payload = jsonParseObject(rawBody);
      const eventIdField = payload.id;
      const eventId =
        typeof eventIdField === 'string' && eventIdField.length > 0 ? eventIdField : randomUUID();
      const providerHeader = req.headers['x-webhook-provider'];
      const providerBody = payload.provider;
      const provider =
        typeof providerHeader === 'string' && providerHeader.length > 0
          ? providerHeader
          : typeof providerBody === 'string' && providerBody.length > 0
            ? providerBody
            : 'generic';
      const signatureHeader = req.headers['x-anchor-signature'];
      const signature = typeof signatureHeader === 'string' ? signatureHeader : undefined;

      try {
        const result = await this.webhookProcessor.process({
          eventId,
          provider,
          payload,
          rawBody,
          signature,
        });

        sendJson(res, 200, {
          received: true,
          duplicate: result.duplicate,
          event_id: result.eventId,
          received_at: new Date().toISOString(),
          provider,
        });
      } catch {
        sendJson(res, 400, {
          error: 'webhook_error',
          message: 'Webhook processing failed',
          event_id: eventId,
          provider,
        });
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found', message: 'Endpoint not found' });
  }

  private checkRateLimit(
    req: IncomingMessage,
    res: ServerResponse,
    endpoint: 'auth_challenge' | 'auth_token' | 'webhook' | 'deposit',
  ): boolean {
    const clientId = extractClientIdentifier(req);
    const key = `${endpoint}:${clientId}`;
    const result = this.rateLimiter.hit(key, this.rateRules[endpoint]);

    if (!result.allowed) {
      res.setHeader('retry-after', `${result.retryAfterSeconds}`);
      sendJson(res, 429, {
        error: 'rate_limited',
        message: 'Too many requests',
      });
      return false;
    }

    return true;
  }

  private authenticate(req: IncomingMessage): AuthenticatedRequestData | null {
    const token = readBearerToken(req);
    if (!token) return null;

    try {
      const decoded = jwt.verify(
        token,
        this.config.get('security').interactiveJwtSecret,
      ) as jwt.JwtPayload;
      const account = typeof decoded.sub === 'string' ? decoded.sub : null;
      const scope = typeof decoded.scope === 'string' ? decoded.scope : null;
      const typ = typeof decoded.typ === 'string' ? decoded.typ : null;
      if (!account || scope !== 'anchor_api' || typ !== 'access_token') {
        return null;
      }

      return { account };
    } catch {
      return null;
    }
  }
}
