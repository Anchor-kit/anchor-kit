import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function readRepositoryFile(path) {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

const releaseGuide = readRepositoryFile('docs/releasing.md');
for (const requiredText of [
  'Anchor-kit/anchor-kit',
  '.github/workflows/publish.yml',
  '`npm-publish`',
  '`anchor-kit` package',
  'Trusted Publisher',
  'OIDC',
  '`NPM_TOKEN`',
  'Do not run `npm publish`',
  'node scripts/check-doc-acceptance.mjs',
  'Documentation acceptance checks passed.',
]) {
  assert.ok(releaseGuide.includes(requiredText), `Release guide must include: ${requiredText}`);
}

const roadmap = readRepositoryFile('ROADMAP.md');
for (const requiredText of [
  'Completed infrastructure',
  'bun test tests/exports.test.ts',
  'bun test tests/mvp-express.integration.test.ts',
  'bun test tests/runtime',
  'Installable SDK',
  'Interoperable deposit',
  'Testnet settlement',
  'Open and deferred work',
  'next gate',
]) {
  assert.ok(roadmap.includes(requiredText), `Roadmap must include: ${requiredText}`);
}

const architecture = readRepositoryFile('ARCHITECTURE.md');
for (const requiredText of [
  'Express-compatible runtime',
  'host owns the HTTP server',
  'SEP-10 challenge',
  'deposit record',
  'Webhook',
  'queue and watcher',
  'not implemented end to end',
  'does not submit a Stellar payment',
]) {
  assert.ok(architecture.includes(requiredText), `Architecture must include: ${requiredText}`);
}

console.log('Documentation acceptance checks passed.');
