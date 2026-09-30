import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createAnchor, type AnchorInstance } from '@/index.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { createHmac } from 'node:crypto';
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
  headers?: Record<string, string | string[]>;
  body?: Record<string, unknown>;
}

function createMountedInvoker(anchor: AnchorInstance) {
  const middleware = anchor.getExpressRouter();

  return async (options: TestRequestOptions): Promise<TestResponse> => {
    const serializedBody = options.body ? JSON.stringify(options.body) : '';

    const req = Readable.from(serializedBody ? [serializedBody] : []) as IncomingMessage & {
      method: string;
      url: string;
      headers: Record<string, string | string[]>;
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
      const res = {
        get headersSent(): boolean {
          return false;
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
      middleware(req, res, () => {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
      });
    });

    return response;
  };
}

describe('Webhook Provider Fallback', () => {
  const sep10ServerKeypair = Keypair.random();
  const dbUrl = makeSqliteDbUrlForTests();
  const dbPath = dbUrl.startsWith('file:') ? dbUrl.slice('file:'.length) : dbUrl;

  let lastProvider = '';
  let anchor: AnchorInstance;
  let invoke: (options: TestRequestOptions) => Promise<TestResponse>;

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
      },
      assets: {
        assets: [
          { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        ],
      },
      framework: {
        database: { provider: 'sqlite', url: dbUrl },
      },
      webhooks: {
        onEvent: async (event) => {
          lastProvider = event.provider;
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
      // ignore
    }
  });

  it('Header present: should use provider from x-webhook-provider header', async () => {
    const payload = { id: 'evt_header', type: 'test' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'header-provider',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('header-provider');
  });

  it('Header missing, body provider present: should fallback to provider from JSON body', async () => {
    const payload = { id: 'evt_body', type: 'test', provider: 'body-provider' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('body-provider');
  });

  it('Header present AND body provider present: header should win', async () => {
    const payload = { id: 'evt_both', type: 'test', provider: 'body-provider' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'header-provider',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('header-provider');
  });

  it('Neither present: should fall back to generic', async () => {
    const payload = { id: 'evt_none', type: 'test' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('generic');
  });

  it('Header is empty string: should fallback to body provider', async () => {
    const payload = { id: 'evt_empty_header', type: 'test', provider: 'body-provider' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': '',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('body-provider');
  });

  it('Whitespace-only header falls back to body provider', async () => {
    const payload = { id: 'evt_whitespace_header', type: 'test', provider: 'body-provider' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': '   ',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('body-provider');
  });

  it('Whitespace-only header and body values fall back to generic', async () => {
    const payload = { id: 'evt_blank_both', type: 'test', provider: '   ' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': '   ',
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('generic');
  });

  it('Array-style provider headers use the first non-empty value', async () => {
    const payload = { id: 'evt_array_provider', type: 'test' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': ['', '   ', 'array-provider'],
        'x-anchor-signature': signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('array-provider');
  });

  it('Array-style signature headers are accepted when they contain a value', async () => {
    const payload = { id: 'evt_array_signature', type: 'test' };
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    const response = await invoke({
      method: 'POST',
      path: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-provider': 'generic',
        'x-anchor-signature': [signature],
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(lastProvider).toBe('generic');
  });
});
