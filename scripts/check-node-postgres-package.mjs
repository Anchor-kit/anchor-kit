import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must point to a disposable PostgreSQL database');
}

const tempDirectory = await mkdtemp(join(tmpdir(), 'anchor-kit-node-smoke-'));

try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', tempDirectory],
    { encoding: 'utf8' },
  );
  const packJsonStart = packOutput.indexOf('[');
  if (packJsonStart < 0) {
    throw new Error('npm pack did not return JSON metadata');
  }
  const [packedPackage] = JSON.parse(packOutput.slice(packJsonStart));
  if (!packedPackage?.filename) {
    throw new Error('npm pack did not return a tarball filename');
  }

  const tarballPath = join(tempDirectory, packedPackage.filename);
  const consumerPath = join(tempDirectory, 'consumer.mjs');
  await writeFile(
    consumerPath,
    `
      import assert from 'node:assert/strict';
      import express from 'express';
      import { createAnchor } from 'anchor-kit';

      const signingKey = 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6';
      const anchor = createAnchor({
        network: { network: 'testnet' },
        server: { interactiveDomain: 'https://anchor.example.com' },
        security: {
          sep10SigningKey: signingKey,
          interactiveJwtSecret: 'node-consumer-smoke-jwt-secret',
          distributionAccountSecret: signingKey,
        },
        assets: {
          assets: [{
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          }],
        },
        framework: {
          database: { provider: 'postgres', url: process.env.DATABASE_URL },
          watchers: { enabled: false },
        },
      });

      await anchor.init();
      const app = express();
      app.use(anchor.getExpressRouter());
      const server = app.listen(0, '127.0.0.1');
      try {
        await new Promise((resolve, reject) => {
          server.once('listening', resolve);
          server.once('error', reject);
        });
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const response = await fetch(\`http://127.0.0.1:\${address.port}/health\`, {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        const health = await response.json();
        assert.equal(health.status, 'ok');
        assert.ok(typeof health.version === 'string' && health.version.length > 0);
      } finally {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        await anchor.shutdown();
      }
    `,
  );

  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], {
    cwd: tempDirectory,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [consumerPath], {
    cwd: tempDirectory,
    env: process.env,
    stdio: 'inherit',
  });
  console.log(
    'Node PostgreSQL package smoke passed: public import, migration, HTTP /health, and shutdown.',
  );
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
