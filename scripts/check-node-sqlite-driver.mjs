import assert from 'node:assert/strict';
import { createAnchor } from '../dist/index.js';

function makeConfig(provider) {
  return {
    network: { network: 'testnet' },
    server: { port: 3000 },
    security: {
      sep10SigningKey: 'secret-key-10',
      interactiveJwtSecret: 'jwt-secret',
      distributionAccountSecret: 'dist-secret',
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
      database: {
        provider,
        url: provider === 'postgres' ? 'postgresql://localhost:5432/anchor' : 'sqlite::memory:',
      },
    },
  };
}

const postgresAnchor = createAnchor(makeConfig('postgres'));
assert.equal(postgresAnchor.config.get('framework').database.provider, 'postgres');

const sqliteAnchor = createAnchor(makeConfig('sqlite'));
await assert.rejects(sqliteAnchor.init(), {
  message:
    'SQLite provider requires the Bun runtime and bun:sqlite. Select postgres when running under Node.js.',
});

console.log(
  'Node SDK import and PostgreSQL selection passed; unsupported SQLite is reported clearly.',
);
