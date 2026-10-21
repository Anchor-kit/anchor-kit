import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createAnchor } from '@/index.ts';
import type { AnchorPlugin } from '@/types/plugin.ts';
import { Keypair } from '@stellar/stellar-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

async function invoke(anchor: ReturnType<typeof createAnchor>, url: string, body = '') {
  const req = Readable.from(body ? [body] : []) as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = body ? 'POST' : 'GET';
  req.url = url;
  req.headers = body ? { 'content-type': 'application/json' } : {};

  return new Promise<{ status: number; body: string }>((resolve) => {
    let statusCode = 200;
    let headersSent = false;
    let responseBody = '';
    const res = {
      get statusCode() {
        return statusCode;
      },
      set statusCode(value: number) {
        statusCode = value;
      },
      get headersSent() {
        return headersSent;
      },
      get writableEnded() {
        return responseBody.length > 0 || statusCode === 204;
      },
      setHeader() {},
      getHeader() {
        return undefined;
      },
      end(value?: string) {
        responseBody = value ?? '';
        headersSent = true;
        resolve({ status: statusCode, body: responseBody });
      },
    } as unknown as ServerResponse;
    anchor.getExpressRouter()(req, res, (error) => {
      if (error) resolve({ status: 500, body: 'handler error' });
    });
  });
}

function makeAnchor() {
  return createAnchor({
    network: { network: 'testnet' },
    server: {},
    security: {
      sep10SigningKey: Keypair.random().secret(),
      interactiveJwtSecret: 'test-jwt-secret',
      distributionAccountSecret: 'test-distribution-secret',
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
      database: { provider: 'sqlite', url: makeSqliteDbUrlForTests() },
    },
  });
}

describe('plugin routes', () => {
  it('dispatches exact paths and provides request context and JSON response semantics', async () => {
    const anchor = makeAnchor();
    const plugin: AnchorPlugin = {
      id: 'echo',
      routes: [
        {
          method: 'GET',
          path: '/plugin/echo',
          handler: ({ query, params, body, config, database }) => ({
            tags: query.tag,
            params,
            body,
            hasConfig: Boolean(config),
            hasDatabase: Boolean(database),
          }),
        },
        {
          method: 'POST',
          path: '/plugin/submit',
          handler: ({ body }) => body,
        },
      ],
    };
    anchor.use(plugin);
    await anchor.init();

    const get = await invoke(anchor, '/plugin/echo?tag=first&tag=second');
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toEqual({
      data: {
        tags: ['first', 'second'],
        params: {},
        body: {},
        hasConfig: true,
        hasDatabase: true,
      },
    });

    const post = await invoke(anchor, '/plugin/submit', JSON.stringify({ amount: 5 }));
    expect(post.status).toBe(200);
    expect(JSON.parse(post.body)).toEqual({ data: { amount: 5 } });
    await anchor.shutdown();
  });

  it('rejects duplicate and built-in route paths before initializing services', async () => {
    const anchor = makeAnchor();
    anchor.use({
      id: 'first',
      routes: [{ method: 'GET', path: '/plugin/shared', handler: () => 'first' }],
    });
    anchor.use({
      id: 'second',
      routes: [{ method: 'GET', path: '/plugin/shared', handler: () => 'second' }],
    });

    await expect(anchor.init()).rejects.toThrow(/registered by both/);
  });

  it('rejects plugin routes that shadow built-in endpoints', async () => {
    const anchor = makeAnchor();
    anchor.use({
      id: 'shadow',
      routes: [{ method: 'GET', path: '/health', handler: () => 'shadowed' }],
    });

    await expect(anchor.init()).rejects.toThrow(/conflicts with a built-in endpoint/);
  });
});
