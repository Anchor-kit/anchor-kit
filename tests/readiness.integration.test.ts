import { createAnchor } from '@/index.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import { Keypair } from '@stellar/stellar-sdk';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const database = createSqlDatabaseAdapter({ provider: 'sqlite', url: 'file::memory:' });
  const anchor = createAnchor(
    {
      network: { network: 'testnet' },
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: Keypair.random().secret(),
        interactiveJwtSecret: 'test-secret',
        distributionAccountSecret: 'test-secret',
      },
      assets: { assets: [{ code: 'USDC', issuer: Keypair.random().publicKey() }] },
      framework: {
        database: { provider: 'sqlite', url: 'file::memory:' },
        watchers: { enabled: false },
      },
    },
    { databaseAdapter: database },
  );
  return { anchor, database };
}

describe('service readiness', () => {
  it('keeps liveness lightweight and checks worker and storage readiness', async () => {
    const { anchor, database } = setup();
    await anchor.init();
    const app = express();
    app.use(anchor.getExpressRouter());
    const probe = vi.spyOn(database, 'checkReadiness');
    try {
      expect((await request(app).get('/health')).status).toBe(200);
      expect(probe).not.toHaveBeenCalled();
      expect((await request(app).get('/ready')).status).toBe(503);
      await anchor.startBackgroundJobs();
      const ready = await request(app).get('/ready');
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ready' });
      expect(ready.headers['cache-control']).toBe('no-store');
      expect((await request(app).head('/ready')).status).toBe(200);
      probe.mockRejectedValueOnce(new Error('postgres://user:secret@host/database'));
      const unavailable = await request(app).get('/ready');
      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toEqual({ status: 'not_ready' });
      expect(unavailable.text).not.toContain('secret');
      expect((await request(app).get('/health')).status).toBe(200);
      await anchor.stopBackgroundJobs();
      expect((await request(app).get('/ready')).status).toBe(503);
      await anchor.startBackgroundJobs();
      await database.disconnect();
      expect((await request(app).get('/ready')).status).toBe(503);
    } finally {
      await anchor.shutdown();
    }
  });

  it('bounds a stalled storage probe and coalesces concurrent probes', async () => {
    const { anchor, database } = setup();
    await anchor.init();
    await anchor.startBackgroundJobs();
    const app = express();
    app.use(anchor.getExpressRouter());
    let release: (() => void) | undefined;
    const probe = vi.spyOn(database, 'checkReadiness').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const responses = await Promise.all([request(app).get('/ready'), request(app).get('/ready')]);
      expect(responses.map((response) => response.status)).toEqual([503, 503]);
      expect(probe).toHaveBeenCalledTimes(1);
      expect((await request(app).get('/health')).status).toBe(200);
    } finally {
      release?.();
      await anchor.shutdown();
    }
  }, 5000);
});
