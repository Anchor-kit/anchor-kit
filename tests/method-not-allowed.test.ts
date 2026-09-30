import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createAnchor, type AnchorInstance } from '@/index.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface TestResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface TestRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function createMountedInvoker(anchor: AnchorInstance) {
  const middleware = anchor.getExpressRouter();

  return async (options: TestRequestOptions): Promise<TestResponse> => {
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

    return new Promise<TestResponse>((resolve) => {
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
            headers: responseHeaders,
            body,
          });
        },
      } as unknown as ServerResponse;

      middleware(req, res, () => {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
      });
    });
  };
}

describe('HTTP Method Not Allowed (405) with Allow header', () => {
  let anchor: AnchorInstance;
  let invoke: ReturnType<typeof createMountedInvoker>;
  let dbPath: string;

  beforeAll(async () => {
    const sep10ServerKeypair = Keypair.random();
    dbPath = `/tmp/anchor-kit-method-not-allowed-test-${Date.now()}.sqlite`;

    anchor = createAnchor({
      network: { network: 'testnet' },
      server: {
        interactiveDomain: 'http://localhost:3000',
      },
      security: {
        sep10SigningKey: sep10ServerKeypair.secret(),
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
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
          url: makeSqliteDbUrlForTests(),
        },
        queue: {
          backend: 'memory',
          concurrency: 2,
        },
        watchers: {
          enabled: false,
          pollIntervalMs: 15000,
          transactionTimeoutMs: 300000,
        },
      },
    });

    await anchor.init();
    invoke = createMountedInvoker(anchor);
  });

  afterAll(async () => {
    await anchor.shutdown();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  describe('/health', () => {
    it('returns 405 with Allow: GET when called with POST', async () => {
      const response = await invoke({ method: 'POST', path: '/health' });
      expect(response.status).toBe(405);
      expect(response.body.error).toBe('method_not_allowed');
      expect(response.headers['allow']).toBe('GET');
    });

    it('returns 405 with Allow: GET when called with DELETE', async () => {
      const response = await invoke({ method: 'DELETE', path: '/health' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('GET');
    });

    it('returns 405 with Allow: GET when called with PUT', async () => {
      const response = await invoke({ method: 'PUT', path: '/health' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('GET');
    });

    it('returns 200 when called with GET', async () => {
      const response = await invoke({ method: 'GET', path: '/health' });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });
  });

  describe('/info', () => {
    it('returns 405 with Allow: GET when called with POST', async () => {
      const response = await invoke({ method: 'POST', path: '/info' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('GET');
    });

    it('returns 200 when called with GET', async () => {
      const response = await invoke({ method: 'GET', path: '/info' });
      expect(response.status).toBe(200);
    });
  });

  describe('/auth/challenge', () => {
    it('returns 405 with Allow: GET when called with POST', async () => {
      const response = await invoke({ method: 'POST', path: '/auth/challenge' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('GET');
    });

    it('returns 405 with Allow: GET when called with DELETE', async () => {
      const response = await invoke({ method: 'DELETE', path: '/auth/challenge' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('GET');
    });
  });

  describe('/auth/token', () => {
    it('returns 405 with Allow: POST when called with GET', async () => {
      const response = await invoke({ method: 'GET', path: '/auth/token' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    });

    it('returns 405 with Allow: POST when called with DELETE', async () => {
      const response = await invoke({ method: 'DELETE', path: '/auth/token' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    });
  });

  describe('/transactions/deposit/interactive', () => {
    it('returns 405 with Allow: POST when called with GET', async () => {
      const response = await invoke({ method: 'GET', path: '/transactions/deposit/interactive' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    });

    it('returns 405 with Allow: POST when called with DELETE', async () => {
      const response = await invoke({
        method: 'DELETE',
        path: '/transactions/deposit/interactive',
      });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    });
  });

  describe('/transactions/:id', () => {
    it('returns 405 with Allow: GET when called with POST', async () => {
      const response = await invoke({
        method: 'POST',
        path: '/transactions/some-transaction-id',
      });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('GET');
    });

    it('returns 405 with Allow: GET when called with DELETE', async () => {
      const response = await invoke({
        method: 'DELETE',
        path: '/transactions/some-transaction-id',
      });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('GET');
    });
  });

  describe('/webhooks/events', () => {
    it('returns 405 with Allow: POST when called with GET', async () => {
      const response = await invoke({ method: 'GET', path: '/webhooks/events' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    });

    it('returns 405 with Allow: POST when called with DELETE', async () => {
      const response = await invoke({ method: 'DELETE', path: '/webhooks/events' });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    });
  });

  describe('unknown paths', () => {
    it('returns 404 for unknown paths', async () => {
      const response = await invoke({ method: 'GET', path: '/nonexistent' });
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    });

    it('returns 404 for unknown paths with any method', async () => {
      const response = await invoke({ method: 'POST', path: '/nonexistent' });
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    });

    it('returns 404 for unknown paths with DELETE', async () => {
      const response = await invoke({ method: 'DELETE', path: '/some/unknown/path' });
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    });
  });
});
