import type { AnchorConfig } from '@/core/config.ts';
import { PayloadTooLargeError, ValidationError } from '@/core/errors.ts';
import { InMemoryRateLimiter, type RateLimitRule } from '@/runtime/http/rate-limiter.ts';
import type { DatabaseAdapter, WebhookProcessor } from '@/runtime/interfaces.ts';
import { IdempotencyUtils } from '@/utils/idempotency.ts';
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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { version } from '../../../package.json';
import { extractClientIdentifier } from './client-identifier.ts';

const SEP10_NONCE_OP = 'anchor_auth';

export interface ExpressRouterContext {
  config: AnchorConfig;
  database: DatabaseAdapter;
  webhookProcessor: WebhookProcessor;
  sep10ServerKeypair: Keypair;
  networkPassphrase: string;
  maxBodyBytes: number;
  rateLimiter: InMemoryRateLimiter;
  rateRules: Record<'auth_challenge' | 'auth_token' | 'webhook' | 'deposit', RateLimitRule>;
}

interface AuthenticatedRequestData {
  account: string;
}

type RawBodyValue = string | Buffer | Uint8Array;
type IncomingRequestWithRawBody = IncomingMessage & { rawBody?: RawBodyValue; body?: unknown };

function firstNonEmptyString(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
  }
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(res: ServerResponse, allowedMethods: string[]): void {
  if (!res.headersSent) {
    res.setHeader('Allow', allowedMethods.join(', '));
  }
  sendJson(res, 405, {
    error: 'method_not_allowed',
    message: 'Method not allowed',
  });
}

function sendJsonUnauthorized(res: ServerResponse, body: Record<string, unknown>): void {
  if (!res.headersSent) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.setHeader('WWW-Authenticate', 'Bearer');
  }
  res.end(JSON.stringify(body));
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

function getBodyByteLength(value: RawBodyValue): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
}

function toUtf8String(value: RawBodyValue): string {
  return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
}

async function readRawBody(req: IncomingMessage, maxBodyBytes: number): Promise<RawBodyValue> {
  const reqWithRaw = req as IncomingRequestWithRawBody;
  if (reqWithRaw.rawBody !== undefined) {
    const rawBody = reqWithRaw.rawBody;
    if (getBodyByteLength(rawBody) > maxBodyBytes) {
      throw new PayloadTooLargeError(`Request body too large. Max ${maxBodyBytes} bytes`);
    }
    return rawBody;
  }

  const bodyFromFramework = (req as IncomingRequestWithRawBody).body;
  if (bodyFromFramework !== undefined) {
    const serialized =
      typeof bodyFromFramework === 'string' ? bodyFromFramework : JSON.stringify(bodyFromFramework);
    if (getBodyByteLength(serialized) > maxBodyBytes) {
      throw new PayloadTooLargeError(`Request body too large. Max ${maxBodyBytes} bytes`);
    }
    return serialized;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += chunkBuffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new PayloadTooLargeError(`Request body too large. Max ${maxBodyBytes} bytes`);
    }
    chunks.push(chunkBuffer);
  }

  return Buffer.concat(chunks);
}

function jsonParseObject(rawBody: RawBodyValue): Record<string, unknown> {
  const utf8Text = toUtf8String(rawBody);
  if (!utf8Text) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Text);
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Request JSON body must be an object');
  }

  return parsed as Record<string, unknown>;
}

async function parsePostJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<{ rawBody: RawBodyValue; body: Record<string, unknown> } | null> {
  const contentType = firstNonEmptyString(req.headers['content-type']);
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Content-Type must be application/json',
    });
    return null;
  }

  let rawBody: RawBodyValue;
  try {
    rawBody = await readRawBody(req, maxBodyBytes);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, {
        error: 'payload_too_large',
        message: error.message,
      });
      return null;
    }
    throw error;
  }

  try {
    return { rawBody, body: jsonParseObject(rawBody) };
  } catch (error) {
    if (error instanceof ValidationError) {
      sendJson(res, 400, {
        error: 'invalid_request',
        message: error.message,
      });
      return null;
    }
    throw error;
  }
}

function sha256(input: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function readBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || authHeader.length === 0) return null;

  const match = authHeader.match(/^(\S+)\s+(\S+)$/);
  if (!match) return null;

  const [, scheme, token] = match;
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) {
    return null;
  }

  return token;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isPlainDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
}

function buildInteractiveUrl(interactiveDomain: string, transactionId: string): string {
  const normalizedDomain = interactiveDomain.endsWith('/')
    ? interactiveDomain.slice(0, -1)
    : interactiveDomain;
  return `${normalizedDomain}/deposit/${transactionId}`;
}

function endpointPath(req: IncomingMessage): string {
  return parseUrl(req).pathname;
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

    const manageDataOp = operation as unknown as { name?: unknown; value?: unknown };
    if (manageDataOp.name !== SEP10_NONCE_OP) {
      continue;
    }

    const value = manageDataOp.value;
    if (value instanceof Buffer) return value.toString('utf8');
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    if (typeof value === 'string') return value;
  }

  return null;
}

function authenticate(
  context: ExpressRouterContext,
  req: IncomingMessage,
): AuthenticatedRequestData | null {
  const token = readBearerToken(req);
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, context.config.get('security').interactiveJwtSecret, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    const account = typeof decoded.sub === 'string' ? decoded.sub : null;
    const scope = typeof decoded.scope === 'string' ? decoded.scope : null;
    const typ = typeof decoded.typ === 'string' ? decoded.typ : null;
    if (
      !account ||
      !StrKey.isValidEd25519PublicKey(account) ||
      scope !== 'anchor_api' ||
      typ !== 'access_token'
    ) {
      return null;
    }

    return { account };
  } catch {
    return null;
  }
}

function checkRateLimit(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: keyof ExpressRouterContext['rateRules'],
): boolean {
  const trustForwardedFor = context.config.get('framework')?.rateLimit?.trustForwardedFor ?? false;
  const clientId = extractClientIdentifier(
    req.socket?.remoteAddress,
    req.headers['x-forwarded-for'],
    trustForwardedFor,
  );
  const key = `${endpoint}:${clientId}`;
  const result = context.rateLimiter.hit(key, context.rateRules[endpoint]);

  if (!result.allowed) {
    res.setHeader('retry-after', `${result.retryAfterSeconds}`);
    sendJson(res, 429, {
      error: 'rate_limited',
      message: 'Too many requests',
      retry_after_seconds: result.retryAfterSeconds,
    });
    return false;
  }

  return true;
}

async function handleHealth(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { status: 'ok', version });
}

async function handleInfo(context: ExpressRouterContext, res: ServerResponse): Promise<void> {
  const fullConfig = context.config.getConfig();
  const responseBody: Record<string, unknown> = {
    name: fullConfig.operational?.name ?? 'Anchor-Kit Anchor',
    network: fullConfig.network.network,
    network_passphrase: context.networkPassphrase,
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
}

async function handleAuthChallenge(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!checkRateLimit(context, req, res, 'auth_challenge')) {
    return;
  }

  // Accept canonical Stellar public keys and treat surrounding whitespace as non-semantic.
  const account = parseUrl(req).searchParams.get('account')?.trim() ?? '';
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
  const expirationSeconds = context.config.get('security').challengeExpirationSeconds ?? 300;
  const expiresAtUnix = now + expirationSeconds;

  const challengeTx = new TransactionBuilder(
    new Account(context.sep10ServerKeypair.publicKey(), '0'),
    {
      fee: '100',
      networkPassphrase: context.networkPassphrase,
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

  challengeTx.sign(context.sep10ServerKeypair);
  const challengeXdr = challengeTx.toXDR();
  const expiresAt = new Date(expiresAtUnix * 1000).toISOString();

  await context.database.insertAuthChallenge({
    id: randomUUID(),
    account,
    challenge: nonce,
    expiresAt,
  });

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    challenge: challengeXdr,
    network_passphrase: context.networkPassphrase,
    expires_at: expiresAt,
    expires_in: expirationSeconds,
  });
}

async function handleAuthToken(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!checkRateLimit(context, req, res, 'auth_token')) {
    return;
  }

  const parsedBody = await parsePostJsonBody(req, res, context.maxBodyBytes);
  if (!parsedBody) {
    return;
  }

  const account = typeof parsedBody.body.account === 'string' ? parsedBody.body.account.trim() : '';
  const signedChallenge =
    typeof parsedBody.body.challenge === 'string' ? parsedBody.body.challenge : '';
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
    transaction = new Transaction(signedChallenge, context.networkPassphrase);
  } catch {
    sendJson(res, 401, {
      error: 'invalid_challenge',
      message: 'Challenge transaction is invalid',
    });
    return;
  }

  if (transaction.source !== context.sep10ServerKeypair.publicKey()) {
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

  if (!hasValidSignature(transaction, context.sep10ServerKeypair.publicKey())) {
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

  const stored = await context.database.getAuthChallengeByChallenge(nonce);
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

  let consumed: boolean;
  try {
    consumed = await context.database.markAuthChallengeConsumed(stored.id);
  } catch {
    sendJson(res, 500, {
      error: 'server_error',
      message: 'Failed to record challenge consumption',
    });
    return;
  }

  if (!consumed) {
    sendJson(res, 401, { error: 'invalid_challenge', message: 'Challenge already used' });
    return;
  }

  const tokenLifetime = context.config.get('security').authTokenLifetimeSeconds ?? 3600;
  const expiresAt = new Date((Math.floor(Date.now() / 1000) + tokenLifetime) * 1000).toISOString();
  const token = jwt.sign(
    {
      sub: account,
      scope: 'anchor_api',
      typ: 'access_token',
    },
    context.config.get('security').interactiveJwtSecret,
    { expiresIn: tokenLifetime },
  );

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    token,
    account,
    expires_in: tokenLifetime,
    expires_at: expiresAt,
    token_type: 'Bearer',
  });
}

async function handleDepositInteractive(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!checkRateLimit(context, req, res, 'deposit')) {
    return;
  }

  const auth = authenticate(context, req);
  if (!auth) {
    sendJsonUnauthorized(res, {
      error: 'unauthorized',
      message: 'Missing or invalid bearer token',
    });
    return;
  }

  const serverConfig = context.config.get('server');
  if (!serverConfig.interactiveDomain) {
    sendJson(res, 500, {
      error: 'server_misconfigured',
      message: 'server.interactiveDomain must be configured for interactive flows',
    });
    return;
  }

  const parsedBody = await parsePostJsonBody(req, res, context.maxBodyBytes);
  if (!parsedBody) {
    return;
  }

  const assetCode =
    typeof parsedBody.body.asset_code === 'string' ? parsedBody.body.asset_code : '';
  const amountRaw = parsedBody.body.amount;
  const amount =
    typeof amountRaw === 'number' || typeof amountRaw === 'string' ? `${amountRaw}` : '';

  if (!assetCode || !amount) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Body must include asset_code and amount',
    });
    return;
  }

  const selectedAsset = context.config.getAsset(assetCode);
  if (!selectedAsset || selectedAsset.deposits_enabled === false) {
    sendJson(res, 400, { error: 'invalid_asset', message: 'Unsupported or disabled asset' });
    return;
  }

  const numericAmount =
    typeof amountRaw === 'number'
      ? toNumber(amountRaw)
      : isPlainDecimalString(amountRaw)
        ? toNumber(amountRaw)
        : NaN;

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
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

  const idempotencyKey = IdempotencyUtils.extractIdempotencyHeader(req.headers, 'idempotency-key');
  const scope = `deposit:${auth.account}`;
  const requestHash = sha256(JSON.stringify({ assetCode, amount }));

  if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
    const idempotencyId = randomUUID();
    const idempotencyRecord = await context.database.insertOrGetIdempotencyRecord({
      id: idempotencyId,
      scope,
      idempotencyKey,
      requestHash,
      statusCode: 201,
      responseBody: '{}',
    });

    if (idempotencyRecord.id === idempotencyId) {
      const transactionId = randomUUID();
      const created = await context.database.insertInteractiveTransaction({
        id: transactionId,
        account: auth.account,
        kind: 'deposit',
        assetCode,
        amount,
        status: 'pending_user_transfer_start',
      });

      const responseBody = {
        id: created.id,
        kind: created.kind,
        status: created.status,
        amount: created.amount,
        asset_code: created.assetCode,
        asset_issuer: selectedAsset.issuer,
        account: created.account,
        interactive_url: buildInteractiveUrl(serverConfig.interactiveDomain, created.id),
        created_at: created.createdAt,
      };

      await context.database.updateIdempotencyRecord({
        scope,
        idempotencyKey,
        statusCode: 201,
        responseBody: JSON.stringify(responseBody),
      });

      sendJson(res, 201, responseBody);
      return;
    }

    if (idempotencyRecord.requestHash !== requestHash) {
      sendJson(res, 409, {
        error: 'idempotency_conflict',
        message: 'Idempotency key was already used with a different request body',
      });
      return;
    }

    sendJson(res, idempotencyRecord.statusCode, {
      ...(JSON.parse(idempotencyRecord.responseBody) as Record<string, unknown>),
      idempotency_replay: true,
    });
    return;
  }

  const transactionId = randomUUID();
  const created = await context.database.insertInteractiveTransaction({
    id: transactionId,
    account: auth.account,
    kind: 'deposit',
    assetCode,
    amount,
    status: 'pending_user_transfer_start',
  });

  sendJson(res, 201, {
    id: created.id,
    kind: created.kind,
    status: created.status,
    amount: created.amount,
    asset_code: created.assetCode,
    asset_issuer: selectedAsset.issuer,
    account: created.account,
    interactive_url: buildInteractiveUrl(serverConfig.interactiveDomain, created.id),
    created_at: created.createdAt,
  });
}

async function handleTransaction(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
  transactionId: string,
): Promise<void> {
  const auth = authenticate(context, req);
  if (!auth) {
    sendJsonUnauthorized(res, {
      error: 'unauthorized',
      message: 'Missing or invalid bearer token',
    });
    return;
  }

  const transaction = await context.database.getInteractiveTransactionById(transactionId);
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

  const selectedAsset = context.config.getAsset(transaction.assetCode);
  const serverConfig = context.config.get('server');
  const responseData: Record<string, unknown> & {
    interactive_url?: string;
    more_info_url?: string;
  } = {
    id: transaction.id,
    kind: transaction.kind,
    status: transaction.status,
    amount: transaction.amount,
    asset_code: transaction.assetCode,
    asset_issuer: selectedAsset?.issuer,
    account: transaction.account,
    created_at: transaction.createdAt,
    updated_at: transaction.updatedAt,
  };

  if (serverConfig.interactiveDomain) {
    responseData.interactive_url = buildInteractiveUrl(
      serverConfig.interactiveDomain,
      transaction.id,
    );
    responseData.more_info_url = buildInteractiveUrl(
      serverConfig.interactiveDomain,
      transaction.id,
    );
  }

  sendJson(res, 200, responseData);
}

const MAX_PROVIDER_IDENTIFIER_LENGTH = 64;

function normalizeProviderIdentifier(value: unknown): string | null {
  const normalized = firstNonEmptyString(value);
  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_PROVIDER_IDENTIFIER_LENGTH) {
    throw new ValidationError(
      `Webhook provider identifier must be ${MAX_PROVIDER_IDENTIFIER_LENGTH} characters or fewer`,
    );
  }

  return normalized;
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

async function handleWebhook(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!checkRateLimit(context, req, res, 'webhook')) {
    return;
  }

  const parsedBody = await parsePostJsonBody(req, res, context.maxBodyBytes);
  if (!parsedBody) {
    return;
  }

  const { rawBody, body: payload } = parsedBody;
  let provider: string;

  try {
    const providerHeader = req.headers['x-webhook-provider'];
    const providerBody = payload.provider;
    provider =
      normalizeProviderIdentifier(providerHeader) ??
      normalizeProviderIdentifier(providerBody) ??
      'generic';
  } catch (error) {
    if (error instanceof ValidationError) {
      sendJson(res, 400, {
        error: 'invalid_request',
        message: error.message,
      });
      return;
    }
    throw error;
  }

  const eventIdField = payload.id;
  const eventId =
    typeof eventIdField === 'string' && eventIdField.trim().length > 0
      ? eventIdField
      : randomUUID();
  const signatureHeader = req.headers['x-anchor-signature'];
  const signature = firstNonEmptyString(signatureHeader);

  try {
    const result = await context.webhookProcessor.process({
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
      provider: result.provider,
    });
  } catch {
    sendJson(res, 400, {
      error: 'webhook_error',
      message: 'Webhook processing failed',
      event_id: eventId,
    });
  }
}

const TRANSACTION_PATH_RE = /^\/transactions\/([^/]+)$/;

const KNOWN_ROUTES: Record<string, string[]> = {
  '/health': ['GET'],
  '/info': ['GET'],
  '/auth/challenge': ['GET'],
  '/auth/token': ['POST'],
  '/transactions/deposit/interactive': ['POST'],
  '/webhooks/events': ['POST'],
};

function getAllowedMethods(path: string): string[] | null {
  const exactMatch = KNOWN_ROUTES[path];
  if (exactMatch) return exactMatch;
  if (TRANSACTION_PATH_RE.test(path)) return ['GET'];
  return null;
}

export async function handleExpressRouterRequest(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = endpointPath(req);
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET' && path === '/health') {
    await handleHealth(res);
    return;
  }

  if (method === 'GET' && path === '/info') {
    await handleInfo(context, res);
    return;
  }

  if (method === 'GET' && path === '/auth/challenge') {
    await handleAuthChallenge(context, req, res);
    return;
  }

  if (method === 'POST' && path === '/auth/token') {
    await handleAuthToken(context, req, res);
    return;
  }

  if (method === 'POST' && path === '/transactions/deposit/interactive') {
    await handleDepositInteractive(context, req, res);
    return;
  }

  const transactionMatch = TRANSACTION_PATH_RE.exec(path);
  if (method === 'GET' && transactionMatch) {
    const transactionIdRaw = transactionMatch[1];
    let transactionId: string;
    try {
      transactionId = decodeURIComponent(transactionIdRaw);
    } catch {
      sendJson(res, 400, {
        error: 'invalid_request',
        message: 'Transaction id contains malformed percent-encoding',
      });
      return;
    }

    if (hasPathSeparator(transactionId)) {
      sendJson(res, 400, {
        error: 'invalid_request',
        message: 'Transaction id must not contain path separators',
      });
      return;
    }

    await handleTransaction(context, req, res, transactionId);
    return;
  }

  if (method === 'POST' && path === '/webhooks/events') {
    await handleWebhook(context, req, res);
    return;
  }

  const allowedMethods = getAllowedMethods(path);
  if (allowedMethods) {
    sendMethodNotAllowed(res, allowedMethods);
    return;
  }

  sendJson(res, 404, { error: 'not_found', message: 'Endpoint not found' });
}
