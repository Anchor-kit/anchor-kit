import type { AnchorConfig } from '@/core/config.ts';
import { ConfigError, PayloadTooLargeError, ValidationError } from '@/core/errors.ts';
import { InMemoryRateLimiter, type RateLimitRule } from '@/runtime/http/rate-limiter.ts';
import type {
  AccountSigner,
  DatabaseAdapter,
  InteractiveTransactionIdentifier,
  InteractiveTransactionRecord,
  KycVerificationProvider,
  Sep10AccountLookup,
  Sep10AccountSigners,
  WebhookProcessor,
} from '@/runtime/interfaces.ts';
import type { Customer } from '@/types/customer.ts';
import type { KycData } from '@/types/foundation.ts';
import type { PluginRouteContext, RouteDefinition } from '@/types/foundation.ts';
import type { AnchorPluginHooks, DepositRequestBody } from '@/types/plugin.ts';
import { IdempotencyUtils } from '../../utils/idempotency.ts';
import { createInteractiveInitiationResponse } from '@/core/sep24/interactive-response.ts';
import { createInteractiveSession } from '@/utils/interactive-session.ts';
import Big from 'big.js';
import {
  Account,
  Keypair,
  Memo,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { version } from '../../../package.json';
import { extractClientIdentifier } from './client-identifier.ts';

const SEP10_AUTH_OPERATION_SUFFIX = ' auth';

/**
 * Stable issuer for bearer access tokens minted by the anchor API.
 * Tokens issued by a different service must not be accepted here, even when
 * they are signed with the same shared secret.
 */
export const ACCESS_TOKEN_ISSUER = 'anchor-kit';

/**
 * Stable audience for bearer access tokens minted by the anchor API.
 * Verification requires this exact audience so a valid token minted for an
 * unintended service is rejected.
 */
export const ACCESS_TOKEN_AUDIENCE = 'anchor-api';

export interface ExpressRouterContext {
  config: AnchorConfig;
  database: DatabaseAdapter;
  isReady: () => boolean;
  webhookProcessor: WebhookProcessor;
  kycVerificationProvider?: KycVerificationProvider;
  sep10ServerKeypair: Keypair;
  networkPassphrase: string;
  maxBodyBytes: number;
  corsOrigins: string[] | undefined;
  requestTimeout: number;
  rateLimiter: InMemoryRateLimiter;
  rateRules: Record<
    'auth_challenge' | 'auth_token' | 'webhook' | 'deposit' | 'customer',
    RateLimitRule
  >;
  depositRequestHooks?: NonNullable<AnchorPluginHooks['onDepositRequest']>[];
  sep10ChallengeHooks?: NonNullable<AnchorPluginHooks['onSep10Challenge']>[];
  sep10AccountLookup?: Sep10AccountLookup;
  pluginRoutes?: Array<{ pluginId: string; route: RouteDefinition }>;
}

interface AuthenticatedRequestData {
  account: string;
}

interface Sep10AccountIdentity {
  address: string;
  signer: string;
  subject: string;
  memo?: string;
}

type RawBodyValue = string | Buffer | Uint8Array;
type IncomingRequestWithRawBody = IncomingMessage & {
  rawBody?: RawBodyValue;
  body?: unknown;
  deadlineSignal?: AbortSignal;
};

const timedOutResponses = new WeakSet<ServerResponse>();

function deadlineSignal(req: IncomingMessage): AbortSignal {
  const signal = (req as IncomingRequestWithRawBody).deadlineSignal;
  if (!signal) throw new ConfigError('Request deadline signal is unavailable');
  return signal;
}

function throwIfRequestAborted(req: IncomingMessage): void {
  if (deadlineSignal(req).aborted) throw new Error('Request deadline exceeded');
}

function firstNonEmptyString(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  method = 'GET',
): void {
  if (timedOutResponses.has(res) || res.writableEnded) return;
  const payload = JSON.stringify(body);
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-length', String(Buffer.byteLength(payload, 'utf8')));
  }
  if (method === 'HEAD') {
    res.end();
  } else {
    res.end(payload);
  }
}

function sendStellarToml(context: ExpressRouterContext, res: ServerResponse, method: string): void {
  const server = context.config.get('server');
  const lines = [
    `SIGNING_KEY = ${JSON.stringify(context.sep10ServerKeypair.publicKey())}`,
    `NETWORK_PASSPHRASE = ${JSON.stringify(context.networkPassphrase)}`,
  ];

  if (server.webAuthEndpoint) {
    lines.push(`WEB_AUTH_ENDPOINT = ${JSON.stringify(server.webAuthEndpoint)}`);
  }
  if (server.transferServerSep24) {
    lines.push(`TRANSFER_SERVER_SEP0024 = ${JSON.stringify(server.transferServerSep24)}`);
  }

  const body = `${lines.join('\n')}\n`;
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(method === 'HEAD' ? undefined : body);
}

function setCorsHeaders(
  res: ServerResponse,
  origin: string | undefined,
  corsOrigins: string[] | undefined,
): void {
  if (!res.headersSent) {
    if (corsOrigins) {
      const existingVary = res.getHeader('Vary');
      const varyValues = Array.isArray(existingVary)
        ? existingVary
        : typeof existingVary === 'string'
          ? existingVary.split(',').map((value) => value.trim())
          : [];
      if (!varyValues.some((value) => value.toLowerCase() === 'origin')) {
        res.setHeader('Vary', [...varyValues, 'Origin'].filter(Boolean).join(', '));
      }
    }
    if (origin && corsOrigins && corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Anchor-Signature, X-Webhook-Provider',
      );
    }
  }
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
  if (timedOutResponses.has(res) || res.writableEnded) return;
  if (!res.headersSent) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.setHeader('WWW-Authenticate', 'Bearer');
  }
  res.end(JSON.stringify(body));
}

function sendJsonTimeout(res: ServerResponse): void {
  if (!res.headersSent) {
    res.statusCode = 504;
    res.setHeader('content-type', 'application/json');
  }
  res.end(
    JSON.stringify({
      error: 'gateway_timeout',
      message: 'Request timeout',
    }),
  );
  timedOutResponses.add(res);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      onTimeout();
      reject(new Error('Request timeout'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
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
  const iterator = req.iterator({ destroyOnReturn: false });
  while (true) {
    const { done, value: chunk } = await iterator.next();
    if (done) break;

    const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += chunkBuffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      req.pause();
      await iterator.return?.();
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

async function parseCustomerBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<Record<string, unknown> | null> {
  const contentType = firstNonEmptyString(req.headers['content-type']);
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  const request = req as IncomingRequestWithRawBody;
  if (request.body !== undefined && request.body !== null && request.rawBody === undefined) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Raw request body is required for customer submissions',
    });
    return null;
  }

  if (mediaType !== 'application/json' && mediaType !== 'application/x-www-form-urlencoded') {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Content-Type must be application/json or application/x-www-form-urlencoded',
    });
    return null;
  }

  let rawBody: RawBodyValue;
  try {
    rawBody = await readRawBody(req, maxBodyBytes);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: 'payload_too_large', message: error.message });
      return null;
    }
    throw error;
  }

  if (mediaType === 'application/json') {
    try {
      return jsonParseObject(rawBody);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(res, 400, { error: 'invalid_request', message: error.message });
        return null;
      }
      throw error;
    }
  }

  const params = new URLSearchParams(toUtf8String(rawBody));
  const body: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(body, key)) {
      sendJson(res, 400, {
        error: 'invalid_request',
        message: `Duplicate customer field: ${key}`,
      });
      return null;
    }
    body[key] = value;
  }
  return body;
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

/** JSON.parse accepts duplicate object keys, so check the top-level deposit fields too. */
function hasDuplicateDepositJsonKeys(rawBody: RawBodyValue): boolean {
  const text = toUtf8String(rawBody);
  let index = text.indexOf('{') + 1;
  const seen = new Set<string>();
  const whitespace = () => {
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
  };
  const skipString = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index++] === '"') return text.slice(start, index);
    }
    throw new Error('invalid JSON string');
  };
  while (index < text.length) {
    whitespace();
    if (text[index] === '}') break;
    const key = JSON.parse(skipString()) as string;
    if (seen.has(key)) return true;
    seen.add(key);
    whitespace();
    index++; // colon; syntax has already been validated by JSON.parse
    let depth = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        skipString();
        continue;
      }
      if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        if (depth === 0) break;
        depth--;
      } else if (char === ',' && depth === 0) break;
      index++;
    }
    if (text[index] === ',') index++;
  }
  return false;
}

/** Parse deposit fields only after enforcing the raw byte limit and duplicate checks. */
async function parseDepositRequestBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<{
  rawBody: RawBodyValue;
  body: Record<string, unknown>;
  isStandardSep24: boolean;
} | null> {
  const contentType = firstNonEmptyString(req.headers['content-type']);
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'application/json') {
    const request = req as IncomingRequestWithRawBody;
    if (
      request.rawBody === undefined &&
      request.body !== undefined &&
      typeof request.body !== 'string'
    ) {
      sendJson(res, 400, {
        error: 'invalid_request',
        message: 'Raw JSON body is required',
      });
      return null;
    }
    const parsed = await parsePostJsonBody(req, res, maxBodyBytes);
    if (parsed && hasDuplicateDepositJsonKeys(parsed.rawBody)) {
      sendJson(res, 400, { error: 'invalid_request', message: 'Duplicate deposit fields' });
      return null;
    }
    return parsed ? { ...parsed, isStandardSep24: false } : null;
  }
  if (mediaType !== 'application/x-www-form-urlencoded' && mediaType !== 'multipart/form-data') {
    sendJson(res, 400, { error: 'invalid_request', message: 'Unsupported deposit Content-Type' });
    return null;
  }
  // Framework-parsed objects have lost duplicate fields and their original byte size.
  const request = req as IncomingRequestWithRawBody;
  if (
    request.rawBody === undefined &&
    request.body !== undefined &&
    typeof request.body !== 'string'
  ) {
    sendJson(res, 400, { error: 'invalid_request', message: 'Raw form body is required' });
    return null;
  }
  // URL encoded and multipart forms preserve the raw field list for duplicate checks.
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
    const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
    const body: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (mediaType === 'application/x-www-form-urlencoded') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // URLSearchParams tolerates invalid escapes; reject them before normalization.
      for (const part of text.split('&')) {
        for (const field of part.split('=')) decodeURIComponent(field.replace(/\+/g, ' '));
      }
      for (const [key, value] of new URLSearchParams(text)) {
        if (Object.hasOwn(body, key)) throw new Error('duplicate');
        body[key] = value;
      }
    } else {
      const form = await new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': contentType! },
        body: new Uint8Array(bytes),
      }).formData();
      form.forEach((value, key) => {
        if (Object.hasOwn(body, key) || typeof value !== 'string') throw new Error('invalid field');
        body[key] = value;
      });
    }
    return { rawBody, body, isStandardSep24: true };
  } catch {
    sendJson(res, 400, { error: 'invalid_request', message: 'Invalid or duplicate form fields' });
    return null;
  }
}

async function createStandardSep24Initiation(
  context: ExpressRouterContext,
  interactiveDomain: string,
  account: string,
  transactionId: string,
) {
  const session = await createInteractiveSession(
    { account, transactionId, actions: ['deposit'] },
    context.config.get('security').interactiveJwtSecret,
  );
  const url = new URL(buildInteractiveUrl(interactiveDomain, transactionId));
  url.searchParams.set('token', session);
  return createInteractiveInitiationResponse({
    id: transactionId,
    url: url.toString(),
  });
}
function sha256(input: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function readBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  const normalizedHeader = Array.isArray(authHeader)
    ? authHeader.length === 1
      ? authHeader[0]
      : null
    : authHeader;
  if (typeof normalizedHeader !== 'string' || normalizedHeader.length === 0) return null;

  const match = normalizedHeader.match(/^(\S+)\s+(\S+)$/);
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

/**
 * Detects numbers JavaScript cannot represent exactly. Integers above
 * `Number.MAX_SAFE_INTEGER` and fractions with a magnitude that large are
 * rounded during JSON parsing, which can silently change the amount.
 */
function isUnsafeAmountNumber(value: number): boolean {
  return !Number.isFinite(value) || !Number.isSafeInteger(Math.trunc(value));
}

function buildInteractiveUrl(interactiveDomain: string, transactionId: string): string {
  const normalizedDomain = interactiveDomain.endsWith('/')
    ? interactiveDomain.slice(0, -1)
    : interactiveDomain;
  return `${normalizedDomain}/deposit/${encodeURIComponent(transactionId)}`;
}

function endpointPath(req: IncomingMessage): string {
  return parseUrl(req).pathname;
}

const BUILT_IN_PATHS = new Set([
  '/health',
  '/ready',
  '/info',
  '/auth',
  '/auth/challenge',
  '/auth/token',
  '/customer',
  '/transactions/deposit/interactive',
  '/transaction',
  '/webhooks/events',
]);
const BUILT_IN_TRANSACTION_PATH = /^\/transactions\/[^/]+$/;

export function validatePluginRoutes(
  routes: Array<{ pluginId: string; route: RouteDefinition }>,
): void {
  const registrations = new Map<string, string>();
  for (const { pluginId, route } of routes) {
    if (
      !route.path.startsWith('/') ||
      (route.path !== '/' && route.path.endsWith('/')) ||
      route.path.includes('?') ||
      route.path.includes('#') ||
      route.path.includes('//') ||
      route.path.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      throw new ConfigError(
        `Plugin "${pluginId}" route path "${route.path}" must be an absolute normalized path without query or fragment`,
      );
    }
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(route.method)) {
      throw new ConfigError(
        `Plugin "${pluginId}" route for "${route.path}" has unsupported method "${route.method}"`,
      );
    }
    if (BUILT_IN_PATHS.has(route.path) || BUILT_IN_TRANSACTION_PATH.test(route.path)) {
      throw new ConfigError(
        `Plugin "${pluginId}" route "${route.method} ${route.path}" conflicts with a built-in endpoint`,
      );
    }
    const routeKey = `${route.method} ${route.path}`;
    const existingPlugin = registrations.get(routeKey);
    if (existingPlugin) {
      throw new ConfigError(
        `Plugin route "${routeKey}" is registered by both "${existingPlugin}" and "${pluginId}"`,
      );
    }
    registrations.set(routeKey, pluginId);
  }
}

function buildPluginRouteContext(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  signal: AbortSignal,
): PluginRouteContext {
  const query: Record<string, string | Array<string>> = {};
  for (const [key, value] of parseUrl(req).searchParams) {
    const current = query[key];
    if (current === undefined) query[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else query[key] = [current, value];
  }
  return {
    request: req,
    response: res,
    signal,
    params: {},
    query,
    body,
    config: context.config,
    database: context.database,
  };
}

async function handlePluginRoute(
  context: ExpressRouterContext,
  registeredRoute: { pluginId: string; route: RouteDefinition },
  req: IncomingMessage,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  let body: Record<string, unknown> = {};
  if (registeredRoute.route.method !== 'GET') {
    const parsedBody = await parsePostJsonBody(req, res, context.maxBodyBytes);
    if (!parsedBody || signal.aborted) return;
    body = parsedBody.body;
  }

  const result = await registeredRoute.route.handler(
    buildPluginRouteContext(context, req, res, body, signal),
  );
  if (signal.aborted || res.writableEnded || res.headersSent) return;
  if (result === undefined) {
    res.statusCode = 204;
    res.end();
    return;
  }
  sendJson(res, 200, { data: result }, (req.method ?? 'GET').toUpperCase());
}

export function isAuthChallengeExpired(expiresAt: string, nowMs = Date.now()): boolean {
  const expirationMs = Date.parse(expiresAt);
  return !Number.isFinite(expirationMs) || nowMs >= expirationMs;
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

/** Verify unique authorized account signers meet a SEP-10 signing threshold. */
export function hasSufficientSignerWeight(
  transaction: Transaction,
  signers: readonly AccountSigner[],
  threshold: number,
): boolean {
  if (!Number.isSafeInteger(threshold) || threshold <= 0 || threshold > 255) return false;

  const signerWeights = new Map<string, number>();
  for (const signer of signers) {
    if (
      !Number.isSafeInteger(signer.weight) ||
      signer.weight <= 0 ||
      signer.weight > 255 ||
      signerWeights.has(signer.publicKey)
    ) {
      return false;
    }
    signerWeights.set(signer.publicKey, signer.weight);
  }

  const hash = transaction.hash();
  const countedSigners = new Set<string>();
  let totalWeight = 0;
  for (const signature of transaction.signatures) {
    for (const [publicKey, weight] of signerWeights) {
      if (countedSigners.has(publicKey)) continue;
      try {
        if (Keypair.fromPublicKey(publicKey).verify(hash, signature.signature())) {
          countedSigners.add(publicKey);
          totalWeight += weight;
          if (totalWeight >= threshold) return true;
          break;
        }
      } catch {
        // Ignore malformed signer keys and invalid signature entries.
      }
    }
  }

  return false;
}

function countValidSignatures(transaction: Transaction, publicKey: string): number {
  const keypair = Keypair.fromPublicKey(publicKey);
  const hash = transaction.hash();
  let count = 0;

  for (const signature of transaction.signatures) {
    try {
      if (keypair.verify(hash, signature.signature())) {
        count += 1;
      }
    } catch {
      // Ignore malformed signature entries.
    }
  }

  return count;
}

/**
 * SEP-10 requires every signature on a challenge to belong to a key the anchor
 * can account for: the server account, an authorized account signer, or the
 * configured client-domain signing key. Unaccounted or malformed entries reject.
 */
export function hasOnlyAuthorizedSep10Signatures(
  transaction: Transaction,
  authorizedKeys: readonly string[],
): boolean {
  const hash = transaction.hash();
  const keypairs: Keypair[] = [];
  for (const key of authorizedKeys) {
    if (!StrKey.isValidEd25519PublicKey(key)) continue;
    try {
      keypairs.push(Keypair.fromPublicKey(key));
    } catch {
      // Ignore malformed signer keys; they cannot produce a valid signature.
    }
  }

  for (const signature of transaction.signatures) {
    const matched = keypairs.some((keypair) => {
      try {
        return keypair.verify(hash, signature.signature());
      } catch {
        return false;
      }
    });
    if (!matched) return false;
  }

  return true;
}

/**
 * SEP-10 nonexistent-account branch: the signed challenge must carry exactly one
 * valid master-key signature for the client account, and no signature from a key
 * outside `authorizedKeys`. Extra, duplicated, or invalid signatures reject.
 */
export function hasSingleMasterSignature(
  transaction: Transaction,
  account: string,
  authorizedKeys: readonly string[],
): boolean {
  if (!StrKey.isValidEd25519PublicKey(account)) return false;
  if (countValidSignatures(transaction, account) !== 1) return false;
  return hasOnlyAuthorizedSep10Signatures(transaction, [account, ...authorizedKeys]);
}

export type Sep10AccountAuthorization = 'authorized' | 'rejected' | 'lookup_failed';

/**
 * Resolve the client account's signing requirements and verify the challenge
 * against them.
 *
 * The lookup is optional for backwards compatibility: without one, the anchor
 * keeps its legacy single-key check. With a lookup, a `null` result selects the
 * SEP-10 nonexistent-account branch (one master-key signature, using the
 * protocol's implicit weight and threshold of 1), while a thrown lookup error is
 * reported as `lookup_failed` so transport outages are never mistaken for a
 * missing account.
 */
export async function authorizeSep10AccountSignatures(
  transaction: Transaction,
  input: {
    account: string;
    serverPublicKey: string;
    lookup?: Sep10AccountLookup;
    additionalSigners?: readonly string[];
  },
): Promise<Sep10AccountAuthorization> {
  const additionalSigners = (input.additionalSigners ?? []).filter((key) =>
    StrKey.isValidEd25519PublicKey(key),
  );

  if (!input.lookup) {
    return hasValidSignature(transaction, input.account) ? 'authorized' : 'rejected';
  }

  let account: Sep10AccountSigners | null;
  try {
    account = await input.lookup.load(input.account);
  } catch {
    return 'lookup_failed';
  }

  if (account === null) {
    return hasSingleMasterSignature(transaction, input.account, [
      input.serverPublicKey,
      ...additionalSigners,
    ])
      ? 'authorized'
      : 'rejected';
  }

  if (!hasSufficientSignerWeight(transaction, account.signers, account.thresholds.medium)) {
    return 'rejected';
  }

  return hasOnlyAuthorizedSep10Signatures(transaction, [
    input.serverPublicKey,
    ...additionalSigners,
    ...account.signers.map((signer) => signer.publicKey),
  ])
    ? 'authorized'
    : 'rejected';
}

function hasValidClientDomainSignature(
  transaction: Transaction,
  clientDomain: string,
  signingKey: string,
): boolean {
  const operations = transaction.operations.filter(
    (operation): operation is Operation.ManageData =>
      operation.type === 'manageData' && operation.name === 'client_domain',
  );
  if (operations.length !== 1) return false;

  const operation = operations[0];
  return (
    operation?.source === signingKey &&
    operation.value?.toString('utf8') === clientDomain &&
    hasValidSignature(transaction, signingKey)
  );
}

function extractNonceFromChallenge(transaction: Transaction, homeDomain: string): string | null {
  const authOperationName = `${homeDomain}${SEP10_AUTH_OPERATION_SUFFIX}`;
  for (const operation of transaction.operations) {
    if (operation.type !== 'manageData') {
      continue;
    }

    const manageDataOp = operation as unknown as { name?: unknown; value?: unknown };
    if (manageDataOp.name !== authOperationName) {
      continue;
    }

    const value = manageDataOp.value;
    if (value instanceof Buffer) return value.toString('utf8');
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    if (typeof value === 'string') return value;
  }

  return null;
}

function sep10Identity(address: string, memo?: string): Sep10AccountIdentity | null {
  if (StrKey.isValidMed25519PublicKey(address)) {
    if (memo !== undefined) return null;
    const muxed = StrKey.decodeMed25519PublicKey(address);
    return {
      address,
      signer: StrKey.encodeEd25519PublicKey(muxed.subarray(0, 32)),
      subject: address,
    };
  }
  if (!StrKey.isValidEd25519PublicKey(address)) return null;
  if (memo === undefined) return { address, signer: address, subject: address };
  if (!/^(0|[1-9][0-9]*)$/.test(memo)) return null;
  try {
    if (BigInt(memo) > 0xffff_ffff_ffff_ffffn) return null;
  } catch {
    return null;
  }
  return { address, signer: address, subject: `${address}:${memo}`, memo };
}

function sep10Subject(subject: string): Sep10AccountIdentity | null {
  const separator = subject.indexOf(':');
  const address = separator === -1 ? subject : subject.slice(0, separator);
  const memo = separator === -1 ? undefined : subject.slice(separator + 1);
  if (memo === '') return null;
  const identity = sep10Identity(address, memo);
  return identity?.subject === subject ? identity : null;
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
    const issuer = typeof decoded.iss === 'string' ? decoded.iss : null;
    const audience = typeof decoded.aud === 'string' ? decoded.aud : null;
    if (
      !account ||
      !sep10Subject(account) ||
      scope !== 'anchor_api' ||
      typ !== 'access_token' ||
      issuer !== ACCESS_TOKEN_ISSUER ||
      audience !== ACCESS_TOKEN_AUDIENCE
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

  res.setHeader('RateLimit-Limit', `${result.limit}`);
  res.setHeader('RateLimit-Remaining', `${result.remaining}`);
  res.setHeader('RateLimit-Reset', `${result.resetSeconds}`);

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

async function handleHealth(res: ServerResponse, method = 'GET'): Promise<void> {
  sendJson(res, 200, { status: 'ok', version }, method);
}

const READINESS_TIMEOUT_MS = 1000;
const readinessProbes = new WeakMap<DatabaseAdapter, Promise<boolean>>();

async function handleReadiness(
  context: ExpressRouterContext,
  res: ServerResponse,
  method: string,
): Promise<void> {
  let ready = false;
  if (context.isReady() && context.database.checkReadiness) {
    let probe = readinessProbes.get(context.database);
    if (!probe) {
      probe = Promise.resolve()
        .then(() => context.database.checkReadiness!())
        .then(
          () => true,
          () => false,
        );
      readinessProbes.set(context.database, probe);
      void probe.then(() => {
        if (readinessProbes.get(context.database) === probe)
          readinessProbes.delete(context.database);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      ready = await Promise.race([
        probe,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS);
        }),
      ]);
      ready = ready && context.isReady();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  res.setHeader('cache-control', 'no-store');
  sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' }, method);
}

async function handleInfo(context: ExpressRouterContext, res: ServerResponse): Promise<void> {
  const fullConfig = context.config.getConfig();
  const metadata = fullConfig.metadata;
  const responseBody: Record<string, unknown> = {
    name: fullConfig.operational?.name ?? 'Anchor-Kit Anchor',
    network: fullConfig.network.network,
    network_passphrase: context.networkPassphrase,
    assets: fullConfig.assets.assets,
    version,
    metadata: {
      ...(metadata?.tomlUrl === undefined ? {} : { tomlUrl: metadata.tomlUrl }),
      ...(metadata?.protocols === undefined
        ? {}
        : {
            protocols: {
              ...(metadata.protocols.sep10 === undefined
                ? {}
                : { sep10: metadata.protocols.sep10 }),
              ...(metadata.protocols.sep24 === undefined
                ? {}
                : { sep24: metadata.protocols.sep24 }),
              ...(metadata.protocols.sep6 === undefined ? {} : { sep6: metadata.protocols.sep6 }),
              ...(metadata.protocols.sep31 === undefined
                ? {}
                : { sep31: metadata.protocols.sep31 }),
            },
          }),
      ...(metadata?.features === undefined
        ? {}
        : {
            features: {
              ...(metadata.features.supportsInteractiveDeposits === undefined
                ? {}
                : { supportsInteractiveDeposits: metadata.features.supportsInteractiveDeposits }),
              ...(metadata.features.supportsInteractiveWithdrawals === undefined
                ? {}
                : {
                    supportsInteractiveWithdrawals:
                      metadata.features.supportsInteractiveWithdrawals,
                  }),
              ...(metadata.features.supportsAsyncTransactionStatus === undefined
                ? {}
                : {
                    supportsAsyncTransactionStatus:
                      metadata.features.supportsAsyncTransactionStatus,
                  }),
            },
          }),
      ...(metadata?.documentationUrls === undefined
        ? {}
        : {
            documentationUrls: {
              ...(metadata.documentationUrls.apiDocs === undefined
                ? {}
                : { apiDocs: metadata.documentationUrls.apiDocs }),
              ...(metadata.documentationUrls.support === undefined
                ? {}
                : { support: metadata.documentationUrls.support }),
              ...(metadata.documentationUrls.terms === undefined
                ? {}
                : { terms: metadata.documentationUrls.terms }),
            },
          }),
    },
  };

  if (fullConfig.server.interactiveDomain) {
    responseBody.interactive_domain = fullConfig.server.interactiveDomain;
  }

  if (fullConfig.assets.defaultCurrency) {
    responseBody.default_currency = fullConfig.assets.defaultCurrency;
  }

  if (fullConfig.operational?.supportEmail) {
    responseBody.support_email = fullConfig.operational.supportEmail;
  }

  if (fullConfig.operational?.website) {
    responseBody.website = fullConfig.operational.website;
  }

  sendJson(res, 200, responseBody);
}

function allowedMethodsForPath(path: string): readonly string[] | undefined {
  if (path === '/auth') return ['GET', 'POST'];
  if (
    path === '/health' ||
    path === '/ready' ||
    path === '/info' ||
    path === '/auth/challenge' ||
    path === '/transaction'
  )
    return ['GET'];
  if (path === '/customer') return ['GET', 'PUT'];
  if (
    path === '/auth/token' ||
    path === '/transactions/deposit/interactive' ||
    path === '/webhooks/events'
  ) {
    return ['POST'];
  }
  if (/^\/transactions\/[^/]+$/.test(path)) return ['GET'];
  return undefined;
}

function handleCorsPreflight(
  context: ExpressRouterContext,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const allowedMethods = allowedMethodsForPath(path);
  if (!allowedMethods) return false;

  const requestedMethodHeader = req.headers['access-control-request-method'];
  if (requestedMethodHeader === undefined) {
    res.statusCode = 204;
    res.end();
    return true;
  }

  const originHeader = req.headers.origin;
  const requestedMethod =
    typeof requestedMethodHeader === 'string' ? requestedMethodHeader.toUpperCase() : '';
  const requestedHeadersHeader = req.headers['access-control-request-headers'];
  const requestedHeaders =
    typeof requestedHeadersHeader === 'string'
      ? requestedHeadersHeader
          .split(',')
          .map((header) => header.trim())
          .filter(Boolean)
      : [];
  const allowedHeaders = new Map([
    ['authorization', 'Authorization'],
    ['content-type', 'Content-Type'],
    ['idempotency-key', 'Idempotency-Key'],
    ['x-anchor-signature', 'X-Anchor-Signature'],
    ['x-webhook-provider', 'X-Webhook-Provider'],
  ]);
  const corsOrigins = context.config.get('server').corsOrigins ?? [];

  if (
    typeof originHeader !== 'string' ||
    !corsOrigins.includes(originHeader) ||
    !allowedMethods.includes(requestedMethod) ||
    requestedHeaders.some((header) => !allowedHeaders.has(header.toLowerCase()))
  ) {
    sendJson(res, 403, {
      error: 'cors_preflight_denied',
      message: 'CORS preflight request is not allowed',
    });
    return true;
  }

  res.statusCode = 204;
  res.setHeader('access-control-allow-origin', originHeader);
  res.setHeader('access-control-allow-methods', requestedMethod);
  if (requestedHeaders.length > 0) {
    res.setHeader(
      'access-control-allow-headers',
      requestedHeaders
        .map((header) => allowedHeaders.get(header.toLowerCase()))
        .filter((header): header is string => header !== undefined)
        .join(', '),
    );
  }
  res.setHeader('vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  res.end();
  return true;
}

async function handleAuthChallenge(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
  standardResponse = false,
): Promise<void> {
  if (!checkRateLimit(context, req, res, 'auth_challenge')) {
    return;
  }

  // Accept canonical Stellar account addresses and treat surrounding whitespace as non-semantic.
  const accountParams = parseUrl(req).searchParams.getAll('account');
  const memoParams = parseUrl(req).searchParams.getAll('memo');
  if (accountParams.length === 0) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Query param account is required',
    });
    return;
  }

  if (accountParams.length !== 1) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Query param account must be provided exactly once',
    });
    return;
  }

  const account = accountParams[0].trim();
  if (!account) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Query param account is required',
    });
    return;
  }

  if (memoParams.length > 1) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Query param memo must be provided at most once',
    });
    return;
  }
  const memo = memoParams.length === 1 ? memoParams[0] : undefined;
  const identity = sep10Identity(account, memo);
  if (!identity) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message:
        'account must be a valid Stellar public or muxed account; memo must be a uint64 ID for classic accounts',
    });
    return;
  }

  const nonce = randomBytes(48).toString('base64');
  const now = Math.floor(Date.now() / 1000);
  const expirationSeconds = context.config.get('security').challengeExpirationSeconds ?? 300;
  const expiresAtUnix = now + expirationSeconds;

  const challengeBuilder = new TransactionBuilder(
    new Account(context.sep10ServerKeypair.publicKey(), '0'),
    {
      fee: '100',
      networkPassphrase: context.networkPassphrase,
    },
  )
    .addOperation(
      Operation.manageData({
        name: `${context.config.get('server').homeDomain}${SEP10_AUTH_OPERATION_SUFFIX}`,
        value: nonce,
        source: identity.address,
      }),
    )
    .setTimebounds(now, expiresAtUnix);
  if (identity.memo !== undefined) challengeBuilder.addMemo(Memo.id(identity.memo));

  const securityConfig = context.config.get('security');
  if (securityConfig.enableClientAttribution) {
    challengeBuilder.addOperation(
      Operation.manageData({
        name: 'client_domain',
        value: securityConfig.clientDomain!,
        source: securityConfig.clientDomainSigningKey!,
      }),
    );
  }

  const challengeTx = challengeBuilder.build();

  let hookedChallengeTx = challengeTx;
  try {
    for (const hook of context.sep10ChallengeHooks ?? []) {
      hookedChallengeTx = await hook(hookedChallengeTx);
    }
  } catch {
    sendJson(res, 500, {
      error: 'challenge_hook_failed',
      message: 'SEP-10 challenge hook failed',
    });
    return;
  }

  if (
    extractNonceFromChallenge(hookedChallengeTx, context.config.get('server').homeDomain) !== nonce
  ) {
    sendJson(res, 500, {
      error: 'challenge_hook_failed',
      message: 'SEP-10 challenge hook returned an invalid transaction',
    });
    return;
  }

  hookedChallengeTx.sign(context.sep10ServerKeypair);
  const challengeXdr = hookedChallengeTx.toXDR();
  const expiresAt = new Date(expiresAtUnix * 1000).toISOString();

  throwIfRequestAborted(req);
  await context.database.insertAuthChallenge({
    id: randomUUID(),
    account: identity.subject,
    challenge: nonce,
    expiresAt,
  });

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    [standardResponse ? 'transaction' : 'challenge']: challengeXdr,
    network_passphrase: context.networkPassphrase,
    expires_at: expiresAt,
    expires_in: expirationSeconds,
  });
}

function extractAccountFromChallenge(transaction: Transaction, homeDomain: string): string | null {
  const authOperationName = `${homeDomain}${SEP10_AUTH_OPERATION_SUFFIX}`;
  for (const operation of transaction.operations) {
    if (operation.type !== 'manageData') {
      continue;
    }

    const manageDataOp = operation as unknown as { name?: unknown; source?: unknown };
    if (manageDataOp.name === authOperationName && typeof manageDataOp.source === 'string') {
      return manageDataOp.source;
    }
  }

  return null;
}

async function handleAuthToken(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
  standardRequest = false,
): Promise<void> {
  if (!checkRateLimit(context, req, res, 'auth_token')) {
    return;
  }

  const parsedBody = await parsePostJsonBody(req, res, context.maxBodyBytes);
  if (!parsedBody) {
    return;
  }

  let account = typeof parsedBody.body.account === 'string' ? parsedBody.body.account.trim() : '';
  const signedChallenge = standardRequest
    ? typeof parsedBody.body.transaction === 'string'
      ? parsedBody.body.transaction
      : ''
    : typeof parsedBody.body.challenge === 'string'
      ? parsedBody.body.challenge
      : '';
  if ((!standardRequest && !account) || !signedChallenge) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: standardRequest
        ? 'Body must include transaction'
        : 'Body must include account and challenge',
    });
    return;
  }

  if (!standardRequest && !sep10Identity(account)) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'account must be a valid Stellar public or muxed account',
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

  const challengeAccount =
    extractAccountFromChallenge(transaction, context.config.get('server').homeDomain) ?? '';
  const challengeMemo =
    transaction.memo.type === 'id' && typeof transaction.memo.value === 'string'
      ? transaction.memo.value
      : undefined;
  const identity = sep10Identity(challengeAccount, challengeMemo);
  if (!identity || (transaction.memo.type !== 'none' && transaction.memo.type !== 'id')) {
    sendJson(res, 401, {
      error: 'invalid_challenge',
      message: 'Challenge account or memo is invalid',
    });
    return;
  }
  const requestIdentity = standardRequest ? identity : sep10Identity(account);
  if (!requestIdentity) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'account must be a valid Stellar public or muxed account',
    });
    return;
  }
  if (!standardRequest && requestIdentity.address !== identity.address) {
    sendJson(res, 401, { error: 'invalid_challenge', message: 'Challenge not found' });
    return;
  }
  account = identity.subject;

  if (transaction.source !== context.sep10ServerKeypair.publicKey()) {
    sendJson(res, 401, {
      error: 'invalid_challenge',
      message: 'Challenge source account mismatch',
    });
    return;
  }

  const nonce = extractNonceFromChallenge(transaction, context.config.get('server').homeDomain);
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

  const securityConfig = context.config.get('security');
  const accountAuthorization = await authorizeSep10AccountSignatures(transaction, {
    account: identity.signer,
    serverPublicKey: context.sep10ServerKeypair.publicKey(),
    lookup: context.sep10AccountLookup,
    additionalSigners:
      securityConfig.enableClientAttribution && securityConfig.clientDomainSigningKey
        ? [securityConfig.clientDomainSigningKey]
        : [],
  });
  if (accountAuthorization === 'lookup_failed') {
    sendJson(res, 502, {
      error: 'account_lookup_failed',
      message: 'Client account signer lookup failed',
    });
    return;
  }
  if (accountAuthorization !== 'authorized') {
    sendJson(res, 401, {
      error: 'invalid_challenge',
      message: 'Challenge is missing account signature',
    });
    return;
  }

  if (
    securityConfig.enableClientAttribution &&
    (!securityConfig.clientDomain ||
      !securityConfig.clientDomainSigningKey ||
      !hasValidClientDomainSignature(
        transaction,
        securityConfig.clientDomain,
        securityConfig.clientDomainSigningKey,
      ))
  ) {
    sendJson(res, 401, {
      error: 'invalid_challenge',
      message: 'Challenge is missing a valid client domain signature',
    });
    return;
  }

  const stored = await context.database.getAuthChallengeByChallenge(nonce);
  if (!stored || stored.account !== identity.subject) {
    sendJson(res, 401, { error: 'invalid_challenge', message: 'Challenge not found' });
    return;
  }

  if (stored.consumedAt) {
    sendJson(res, 401, { error: 'invalid_challenge', message: 'Challenge already used' });
    return;
  }

  if (isAuthChallengeExpired(stored.expiresAt)) {
    sendJson(res, 401, { error: 'invalid_challenge', message: 'Challenge expired' });
    return;
  }

  let consumed: boolean;
  try {
    throwIfRequestAborted(req);
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
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
      scope: 'anchor_api',
      typ: 'access_token',
      ...(securityConfig.enableClientAttribution
        ? { client_domain: securityConfig.clientDomain }
        : {}),
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

  const parsedBody = await parseDepositRequestBody(req, res, context.maxBodyBytes);
  if (!parsedBody) {
    return;
  }

  const assetCode =
    typeof parsedBody.body.asset_code === 'string' ? parsedBody.body.asset_code : '';
  const amountRaw = parsedBody.body.amount;
  const amount =
    typeof amountRaw === 'number'
      ? Number.isFinite(amountRaw)
        ? new Big(amountRaw).toFixed()
        : `${amountRaw}`
      : typeof amountRaw === 'string'
        ? amountRaw
        : '';

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

  if (typeof amountRaw === 'number' && isUnsafeAmountNumber(numericAmount)) {
    sendJson(res, 400, {
      error: 'invalid_amount',
      message:
        'Amount must be a positive number. Unsafe numeric amounts must be sent as decimal strings to avoid precision loss',
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

  const depositHookContext = {
    config: context.config.getConfig(),
    db: context.database,
    params: {},
    query: {},
    body: parsedBody.body as DepositRequestBody,
    account: auth.account,
    asset: selectedAsset,
    signal: deadlineSignal(req),
  };

  try {
    for (const hook of context.depositRequestHooks ?? []) {
      throwIfRequestAborted(req);
      await hook(depositHookContext);
      throwIfRequestAborted(req);
    }
  } catch {
    sendJson(res, 400, {
      error: 'deposit_rejected',
      message: 'Deposit request was rejected by a plugin',
    });
    return;
  }

  const idempotencyKey = IdempotencyUtils.extractIdempotencyHeader(req.headers, 'idempotency-key');

  const IDEMPOTENCY_KEY_MAX_BYTES = 255;
  if (
    typeof idempotencyKey === 'string' &&
    Buffer.byteLength(idempotencyKey, 'utf8') > IDEMPOTENCY_KEY_MAX_BYTES
  ) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: `Idempotency-Key must not exceed ${IDEMPOTENCY_KEY_MAX_BYTES} bytes`,
    });
    return;
  }

  const scope = `deposit:${auth.account}`;
  const requestHash = sha256(JSON.stringify({ assetCode, amount }));

  if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
    const idempotencyId = randomUUID();
    throwIfRequestAborted(req);
    const reservation = await context.database.reserveIdempotencyRecord({
      id: idempotencyId,
      scope,
      idempotencyKey,
      requestHash,
    });
    const idempotencyRecord = reservation.record;

    if (!reservation.inserted) {
      if (idempotencyRecord.requestHash !== requestHash) {
        sendJson(res, 409, {
          error: 'idempotency_conflict',
          message: 'Idempotency key was already used with a different request body',
        });
        return;
      }

      if (idempotencyRecord.status === 'pending') {
        res.setHeader('Retry-After', '1');
        sendJson(res, 409, {
          error: 'idempotency_in_progress',
          message: 'A request with this idempotency key is still being processed',
        });
        return;
      }

      let responseBody: Record<string, unknown>;
      try {
        const parsed = JSON.parse(idempotencyRecord.responseBody) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Invalid idempotency response body');
        }
        responseBody = parsed as Record<string, unknown>;
      } catch {
        res.setHeader('Retry-After', '1');
        sendJson(res, 503, {
          error: 'idempotency_response_unavailable',
          message: 'The saved response is unavailable; retry this request',
        });
        return;
      }

      if (parsedBody.isStandardSep24) {
        if (typeof responseBody.id !== 'string') {
          res.setHeader('Retry-After', '1');
          sendJson(res, 503, {
            error: 'idempotency_response_unavailable',
            message: 'The saved response is unavailable; retry this request',
          });
          return;
        }
        try {
          const standardResponse = await createStandardSep24Initiation(
            context,
            serverConfig.interactiveDomain,
            auth.account,
            responseBody.id,
          );
          res.setHeader('Cache-Control', 'no-store');
          sendJson(res, 200, { ...standardResponse });
        } catch {
          sendJson(res, 500, {
            error: 'server_misconfigured',
            message: 'SEP-24 interactive sessions could not be created',
          });
        }
        return;
      }

      sendJson(res, idempotencyRecord.statusCode, {
        ...responseBody,
        idempotency_replay: true,
      });
      return;
    }

    const transactionId = randomUUID();
    const createdAt = new Date().toISOString();
    const legacyResponseBody = {
      id: transactionId,
      kind: 'deposit',
      status: 'incomplete',
      amount,
      asset_code: assetCode,
      asset_issuer: selectedAsset.issuer,
      account: auth.account,
      interactive_url: buildInteractiveUrl(serverConfig.interactiveDomain, transactionId),
      created_at: createdAt,
      updated_at: createdAt,
    };
    let responseBody: Record<string, unknown> = legacyResponseBody;

    try {
      if (parsedBody.isStandardSep24) {
        responseBody = {
          ...(await createStandardSep24Initiation(
            context,
            serverConfig.interactiveDomain,
            auth.account,
            transactionId,
          )),
        };
      }
      throwIfRequestAborted(req);
      await context.database.createDepositWithIdempotency({
        transaction: {
          id: transactionId,
          account: auth.account,
          kind: 'deposit',
          assetCode,
          amount,
          status: 'incomplete',
          createdAt,
        },
        idempotency: {
          scope,
          idempotencyKey,
          requestHash,
          statusCode: parsedBody.isStandardSep24 ? 200 : 201,
          responseBody: JSON.stringify(responseBody),
        },
      });
    } catch (error) {
      await context.database
        .deletePendingIdempotencyRecord(scope, idempotencyKey, requestHash)
        .catch(() => undefined);
      throw error;
    }

    if (parsedBody.isStandardSep24) res.setHeader('Cache-Control', 'no-store');
    sendJson(res, parsedBody.isStandardSep24 ? 200 : 201, responseBody);
    return;
  }

  const transactionId = randomUUID();
  let standardResponse: ReturnType<typeof createInteractiveInitiationResponse> | null = null;
  if (parsedBody.isStandardSep24) {
    try {
      standardResponse = await createStandardSep24Initiation(
        context,
        serverConfig.interactiveDomain,
        auth.account,
        transactionId,
      );
    } catch {
      sendJson(res, 500, {
        error: 'server_misconfigured',
        message: 'SEP-24 interactive sessions could not be created',
      });
      return;
    }
  }
  throwIfRequestAborted(req);
  const created = await context.database.insertInteractiveTransaction({
    id: transactionId,
    account: auth.account,
    kind: 'deposit',
    assetCode,
    amount,
    status: 'incomplete',
  });

  const legacyResponseBody = {
    id: created.id,
    kind: created.kind,
    status: created.status,
    amount: created.amount,
    asset_code: created.assetCode,
    asset_issuer: selectedAsset.issuer,
    account: created.account,
    interactive_url: buildInteractiveUrl(serverConfig.interactiveDomain, created.id),
    created_at: created.createdAt,
    updated_at: created.updatedAt,
  };
  if (standardResponse) {
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { ...standardResponse });
  } else {
    sendJson(res, 201, legacyResponseBody);
  }
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
    res.setHeader('Cache-Control', 'no-store');
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

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, responseData);
}

const SEP12_CONTROL_FIELDS = new Set([
  'account',
  'id',
  'memo',
  'memo_type',
  'transaction_id',
  'type',
  'fields',
]);
const SEP12_KNOWN_FIELDS = new Set([
  'birth_date',
  'email_address',
  'first_name',
  'id_number',
  'id_type',
  'last_name',
  'nationality',
  'phone_number',
]);

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function kycFieldValue(data: KycData | undefined, field: string): string | undefined {
  if (!data) return undefined;
  if (field === 'birth_date') return data.birth_date;
  if (field === 'email_address') return data.email_address;
  if (field === 'first_name') return data.first_name;
  if (field === 'id_number') return data.id_number;
  if (field === 'id_type') return data.id_type;
  if (field === 'last_name') return data.last_name;
  if (field === 'nationality') return data.nationality;
  if (field === 'phone_number') return data.phone_number;
  return data.additional_fields?.[field];
}

function customerResponse(
  customer: Customer | null,
  requiredFields: string[],
): Record<string, unknown> {
  const kycData = customer?.kyc_data;
  const missingFields = requiredFields.filter(
    (field) => !asNonEmptyString(kycFieldValue(kycData, field)),
  );
  const providedFields: Record<string, { type: 'string'; status: string }> = {};
  if (kycData) {
    const storedFields = [
      'birth_date',
      'email_address',
      'first_name',
      'id_number',
      'id_type',
      'last_name',
      'nationality',
      'phone_number',
      ...Object.keys(kycData.additional_fields ?? {}),
    ];
    const fieldStatus =
      kycData.status === 'approved'
        ? 'ACCEPTED'
        : kycData.status === 'rejected'
          ? 'REJECTED'
          : 'PROCESSING';
    for (const field of storedFields) {
      if (asNonEmptyString(kycFieldValue(kycData, field))) {
        providedFields[field] = { type: 'string', status: fieldStatus };
      }
    }
  }

  const status = missingFields.length
    ? 'NEEDS_INFO'
    : kycData?.status === 'approved'
      ? 'ACCEPTED'
      : kycData?.status === 'rejected'
        ? 'REJECTED'
        : 'PROCESSING';
  return {
    ...(customer ? { id: customer.id } : {}),
    status,
    ...(missingFields.length
      ? { fields: Object.fromEntries(missingFields.map((field) => [field, { type: 'string' }])) }
      : {}),
    ...(Object.keys(providedFields).length ? { provided_fields: providedFields } : {}),
    ...(status === 'REJECTED' ? { message: 'Customer verification was rejected' } : {}),
  };
}

async function loadSep12Transaction(
  context: ExpressRouterContext,
  res: ServerResponse,
  account: string,
  transactionId: string,
): Promise<InteractiveTransactionRecord | null> {
  const transaction = await context.database.getInteractiveTransactionById(transactionId);
  if (!transaction) {
    sendJson(res, 404, { error: 'not_found', message: 'Transaction not found' });
    return null;
  }
  if (transaction.account !== account) {
    sendJson(res, 403, { error: 'forbidden', message: 'Transaction belongs to another account' });
    return null;
  }
  return transaction;
}

async function handleCustomerGet(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!checkRateLimit(context, req, res, 'customer')) return;
  const auth = authenticate(context, req);
  if (!auth) {
    sendJsonUnauthorized(res, {
      error: 'unauthorized',
      message: 'Missing or invalid bearer token',
    });
    return;
  }
  const url = parseUrl(req);
  const transactionId = asNonEmptyString(url.searchParams.get('transaction_id'));
  const type = asNonEmptyString(url.searchParams.get('type'));
  const customerId = asNonEmptyString(url.searchParams.get('id'));
  if (!transactionId || !type) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'transaction_id and type are required for customer status lookup',
    });
    return;
  }

  const transaction = await loadSep12Transaction(context, res, auth.account, transactionId);
  if (!transaction) return;
  const requiredFields = context.config.getKycRequiredFields(transaction.assetCode);
  const customer = await context.database.getCustomerByAccountId(auth.account);
  if (customerId && customer?.id !== customerId) {
    sendJson(res, 404, { error: 'not_found', message: 'Customer not found' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, customerResponse(customer, requiredFields));
}

async function handleCustomerPut(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!checkRateLimit(context, req, res, 'customer')) return;
  const auth = authenticate(context, req);
  if (!auth) {
    sendJsonUnauthorized(res, {
      error: 'unauthorized',
      message: 'Missing or invalid bearer token',
    });
    return;
  }

  const body = await parseCustomerBody(req, res, context.maxBodyBytes);
  if (!body) return;
  const transactionId = asNonEmptyString(body.transaction_id);
  const type = asNonEmptyString(body.type);
  const requestedId = asNonEmptyString(body.id);
  if (!transactionId || !type) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'transaction_id and type are required for customer submission',
    });
    return;
  }
  if (body.account !== undefined && body.account !== auth.account) {
    sendJson(res, 403, {
      error: 'forbidden',
      message: 'account must match the authenticated account',
    });
    return;
  }
  if (body.id !== undefined && !requestedId) {
    sendJson(res, 400, { error: 'invalid_request', message: 'id must be a non-empty string' });
    return;
  }

  const transaction = await loadSep12Transaction(context, res, auth.account, transactionId);
  if (!transaction) return;
  const requiredFields = context.config.getKycRequiredFields(transaction.assetCode);

  const submitted: Record<string, string> = {};
  const nestedFields = body.fields;
  if (nestedFields !== undefined) {
    if (!nestedFields || typeof nestedFields !== 'object' || Array.isArray(nestedFields)) {
      sendJson(res, 400, { error: 'invalid_request', message: 'fields must be an object' });
      return;
    }
    for (const [field, value] of Object.entries(nestedFields)) {
      if (typeof value !== 'string' || value.length > 4096) {
        sendJson(res, 400, {
          error: 'invalid_request',
          message: `Invalid customer field: ${field}`,
        });
        return;
      }
      submitted[field] = value;
    }
  }
  for (const [field, value] of Object.entries(body)) {
    if (SEP12_CONTROL_FIELDS.has(field)) continue;
    if (typeof value !== 'string' || value.length > 4096 || Object.hasOwn(submitted, field)) {
      sendJson(res, 400, { error: 'invalid_request', message: `Invalid customer field: ${field}` });
      return;
    }
    submitted[field] = value;
  }
  for (const field of Object.keys(submitted)) {
    if (
      !/^[a-z][a-z0-9_.]{0,127}$/.test(field) ||
      (!SEP12_KNOWN_FIELDS.has(field) && !requiredFields.includes(field))
    ) {
      sendJson(res, 400, {
        error: 'invalid_request',
        message: `Unsupported customer field: ${field}`,
      });
      return;
    }
  }

  const existing = await context.database.getCustomerByAccountId(auth.account);
  if (requestedId && (!existing || existing.id !== requestedId)) {
    sendJson(res, 404, { error: 'not_found', message: 'Customer not found' });
    return;
  }

  const customer =
    existing ??
    (await context.database.insertOrGetCustomer({
      id: randomUUID(),
      account_id: auth.account,
      kyc_data: { status: 'pending' },
    }));

  const previous = customer.kyc_data;
  const kycData: KycData = {
    ...(previous ?? { status: 'pending' as const }),
    status: 'pending',
    additional_fields: { ...(previous?.additional_fields ?? {}) },
  };
  for (const [field, value] of Object.entries(submitted)) {
    if (SEP12_KNOWN_FIELDS.has(field)) {
      if (field === 'birth_date') kycData.birth_date = value;
      else if (field === 'email_address') kycData.email_address = value;
      else if (field === 'first_name') kycData.first_name = value;
      else if (field === 'id_number') kycData.id_number = value;
      else if (field === 'id_type') kycData.id_type = value;
      else if (field === 'last_name') kycData.last_name = value;
      else if (field === 'nationality') kycData.nationality = value;
      else if (field === 'phone_number') kycData.phone_number = value;
    } else {
      kycData.additional_fields![field] = value;
    }
  }

  const missingFields = requiredFields.filter(
    (field) => !asNonEmptyString(kycFieldValue(kycData, field)),
  );
  const saved = await context.database.updateCustomer({
    id: customer.id,
    account_id: auth.account,
    email_address: kycData.email_address,
    phone_number: kycData.phone_number,
    kyc_data: kycData,
  });
  if (!saved) {
    sendJson(res, 404, { error: 'not_found', message: 'Customer not found' });
    return;
  }

  if (missingFields.length === 0 && context.kycVerificationProvider) {
    const operationKey = sha256(
      JSON.stringify({
        account: auth.account,
        customerId: customer.id,
        transactionId,
        type,
        fields: Object.fromEntries(
          Object.entries(submitted).sort(([left], [right]) => left.localeCompare(right)),
        ),
      }),
    );
    let decision;
    try {
      decision = await context.kycVerificationProvider.verify({
        customerId: customer.id,
        operationKey,
        data: kycData,
      });
    } catch {
      sendJson(res, 502, { error: 'verification_unavailable', message: 'KYC verification failed' });
      return;
    }
    if (
      decision.customerId !== customer.id ||
      decision.operationKey !== operationKey ||
      !['pending', 'approved', 'rejected'].includes(decision.status)
    ) {
      sendJson(res, 502, {
        error: 'verification_unavailable',
        message: 'KYC provider returned an invalid decision',
      });
      return;
    }
    kycData.status = decision.status;
    await context.database.updateCustomer({
      id: customer.id,
      account_id: auth.account,
      email_address: kycData.email_address,
      phone_number: kycData.phone_number,
      kyc_data: kycData,
    });
  }

  const updatedCustomer = await context.database.getCustomerByAccountId(auth.account);
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, customerResponse(updatedCustomer, requiredFields));
}

async function handleSep24Transaction(
  context: ExpressRouterContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const auth = authenticate(context, req);
  if (!auth) {
    sendJsonUnauthorized(res, {
      error: 'unauthorized',
      message: 'Missing or invalid bearer token',
    });
    return;
  }
  const params = parseUrl(req).searchParams;
  const identifiers = ['id', 'stellar_transaction_id', 'external_transaction_id'] as const;
  const supplied = identifiers.flatMap((kind) =>
    params.getAll(kind).map((value) => ({ kind, value })),
  );
  if (
    supplied.length !== 1 ||
    !supplied[0].value.trim() ||
    Buffer.byteLength(supplied[0].value, 'utf8') > 256 ||
    Array.from(supplied[0].value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    supplied[0].value !== supplied[0].value.trim()
  ) {
    sendJson(res, 400, {
      error: 'invalid_request',
      message: 'Provide exactly one non-empty transaction identifier',
    });
    return;
  }
  const identifier: InteractiveTransactionIdentifier = supplied[0];
  const transaction = await context.database.findInteractiveTransaction({
    account: auth.account,
    identifier,
  });
  if (!transaction || transaction.account !== auth.account) {
    sendJson(res, 404, { error: 'not_found', message: 'Transaction not found' });
    return;
  }
  const interactiveDomain = context.config.get('server').interactiveDomain;
  sendJson(res, 200, {
    transaction: {
      id: transaction.id,
      kind: transaction.kind,
      status: transaction.status,
      started_at: transaction.createdAt,
      ...(transaction.amountIn == null ? {} : { amount_in: transaction.amountIn }),
      ...(transaction.amountOut == null ? {} : { amount_out: transaction.amountOut }),
      ...(transaction.amountFee == null ? {} : { amount_fee: transaction.amountFee }),
      ...(transaction.stellarTransactionHash == null
        ? {}
        : { stellar_transaction_id: transaction.stellarTransactionHash }),
      ...(transaction.railReference == null
        ? {}
        : { external_transaction_id: transaction.railReference }),
      ...(interactiveDomain
        ? { more_info_url: buildInteractiveUrl(interactiveDomain, transaction.id) }
        : {}),
    },
  });
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
  if (context.config.get('operational')?.webhooksEnabled === false) {
    sendJson(res, 503, {
      error: 'webhooks_disabled',
      message: 'Webhook processing is disabled',
    });
    return;
  }

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

    const response: Record<string, unknown> = {
      received: true,
      duplicate: result.duplicate,
      event_id: result.eventId,
      received_at: new Date().toISOString(),
      provider: result.provider,
    };
    if (result.duplicate && result.status) response.status = result.status;
    sendJson(res, 200, response);
  } catch {
    sendJson(res, 400, {
      error: 'webhook_error',
      message: 'Webhook processing failed',
      event_id: eventId,
      provider,
    });
  }
}

const TRANSACTION_PATH_RE = /^\/transactions\/([^/]*)$/;

const KNOWN_ROUTES: Record<string, string[]> = {
  '/health': ['GET'],
  '/ready': ['GET'],
  '/info': ['GET'],
  '/transaction': ['GET'],
  '/customer': ['GET', 'PUT'],
  '/auth': ['GET', 'POST'],
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
  const origin = firstNonEmptyString(req.headers.origin);
  const deadlineController = new AbortController();
  (req as IncomingRequestWithRawBody).deadlineSignal = deadlineController.signal;

  // Set CORS headers for all responses
  setCorsHeaders(res, origin, context.corsOrigins);

  if (method === 'OPTIONS') {
    if (!handleCorsPreflight(context, path, req, res)) {
      res.statusCode = 204;
      res.end();
    }
    return;
  }

  // Skip timeout for health endpoint (should always respond quickly)
  if ((method === 'GET' || method === 'HEAD') && path === '/health') {
    await handleHealth(res, method);
    return;
  }

  if ((method === 'GET' || method === 'HEAD') && path === '/ready') {
    await handleReadiness(context, res, method);
    return;
  }

  if ((method === 'GET' || method === 'HEAD') && path === '/.well-known/stellar.toml') {
    sendStellarToml(context, res, method);
    return;
  }

  // Wrap all other requests with timeout
  let timedOut = false;
  await withTimeout(
    (async () => {
      if (method === 'GET' && path === '/info') {
        await handleInfo(context, res);
        return;
      }

      if (method === 'GET' && path === '/auth') {
        await handleAuthChallenge(context, req, res, true);
        return;
      }

      if (method === 'POST' && path === '/auth') {
        await handleAuthToken(context, req, res, true);
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

      if (method === 'GET' && path === '/transaction') {
        await handleSep24Transaction(context, req, res);
        return;
      }

      if (path === '/customer' && method === 'GET') {
        await handleCustomerGet(context, req, res);
        return;
      }

      if (path === '/customer' && method === 'PUT') {
        await handleCustomerPut(context, req, res);
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

        if (transactionId.trim().length === 0) {
          sendJson(res, 400, {
            error: 'invalid_request',
            message: 'Transaction id must not be empty',
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

      const pluginRoutes = (context.pluginRoutes ?? []).filter(({ route }) => route.path === path);
      if (pluginRoutes.length > 0) {
        const pluginRoute = pluginRoutes.find(({ route }) => route.method === method);
        if (pluginRoute) {
          await handlePluginRoute(context, pluginRoute, req, res, deadlineController.signal);
        } else {
          sendMethodNotAllowed(res, pluginRoutes.map(({ route }) => route.method).sort());
        }
        return;
      }

      const allowedMethods = getAllowedMethods(path);
      if (allowedMethods) {
        sendMethodNotAllowed(res, allowedMethods);
        return;
      }

      sendJson(res, 404, { error: 'not_found', message: 'Endpoint not found' });
    })(),
    context.requestTimeout,
    () => {
      timedOut = true;
      sendJsonTimeout(res);
      deadlineController.abort(new Error('Request deadline exceeded'));
    },
  ).catch((error: unknown) => {
    if (!timedOut) {
      throw error;
    }
  });
}
