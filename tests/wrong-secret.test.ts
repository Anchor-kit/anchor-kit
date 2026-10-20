import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createAnchor, type AnchorInstance } from '@/index.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

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
          let body: Record<string, unknown> = {};
          if (contentType.includes('application/json') && bodyText) {
            try {
              body = JSON.parse(bodyText) as Record<string, unknown>;
            } catch {
              body = { raw: bodyText };
            }
          }
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

describe('Bearer token signed with wrong secret', () => {
  const sep10ServerKeypair = Keypair.random();
  const dbUrl = makeSqliteDbUrlForTests();
  const dbPath = dbUrl.startsWith('file:') ? fileURLToPath(dbUrl) : dbUrl;
  let anchor: AnchorInstance;
  let invoke: (options: TestRequestOptions) => Promise<TestResponse>;

  beforeAll(async () => {
    anchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'jwt-test-secret',
        distributionAccountSecret: 'dist-secret',
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
        database: { provider: 'sqlite', url: dbUrl },
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
    });

    await anchor.init();
    await anchor.startBackgroundJobs();
    invoke = createMountedInvoker(anchor);
  });

  afterAll(async () => {
    if (anchor) {
      await anchor.stopBackgroundJobs();
      await anchor.shutdown();
    }
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('should reject missing token (control test)', async () => {
    const response = await invoke({
      method: 'POST',
      path: '/transactions/deposit/interactive',
      headers: { 'content-type': 'application/json' },
      body: { asset_code: 'USDC', amount: '10' },
    });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('should reject token signed with wrong secret', async () => {
    const account = Keypair.random().publicKey();
    const badToken = jwt.sign(
      { sub: account, scope: 'anchor_api', typ: 'access_token' },
      'wrong-jwt-secret',
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
});
