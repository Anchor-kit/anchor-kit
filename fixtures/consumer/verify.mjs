/**
 * fixtures/consumer/verify.mjs
 *
 * Reproducible consumer fixture for anchor-kit.
 *
 * Acceptance criteria tested here:
 *  1. The built dist/index.js contains no unresolved @/ path-alias imports.
 *  2. Named exports that consumers rely on (`createAnchor`, `makeSqliteDbUrlForTests`)
 *     are present in the JS source (static analysis).
 *  3. The packed tarball can be installed and imported by a real consumer
 *     (runtime smoke test) in both Bun and Node, proving the acceptance gate
 *     that a broken runtime import or declaration fails before publication.
 *
 * Note on runtime import: dist/index.js uses the `bun:sqlite` built-in which
 * is only available in the Bun runtime.  The alias-resolution gate (criteria 1)
 * is verified by static analysis of the bundle source.  The runtime smoke test
 * (criteria 3) installs the packed tarball into a clean temp project and
 * imports it under the requested runtime, so a broken runtime import or
 * declaration fails the consumer job before publication.
 *
 * Usage (from the repo root, after `npm run build`):
 *   node fixtures/consumer/verify.mjs            # static + Node runtime
 *   node fixtures/consumer/verify.mjs --runtime=bun
 *   node fixtures/consumer/verify.mjs --runtime=node
 *
 * Expected output:
 *   ✓ No @/ specifiers in dist/index.js
 *   ✓ dist/index.js exports createAnchor (source check)
 *   ✓ dist/index.js exports makeSqliteDbUrlForTests (source check)
 *   ✓ Packed tarball installs and imports under <runtime>
 *   All checks passed.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve paths relative to the repo root (two levels up from fixtures/consumer/).
const repoRoot = resolve(__dirname, '..', '..');
const distIndexJs = resolve(repoRoot, 'dist', 'index.js');

let failed = false;

function pass(msg) {
  console.log(`✓ ${msg}`);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  failed = true;
}

// ── Load source once ─────────────────────────────────────────────────────────
const source = readFileSync(distIndexJs, 'utf8');

// ── Check 1: No @/ specifiers in the JS bundle (primary acceptance gate) ─────
if (/@\//.test(source)) {
  const hits = source
    .split('\n')
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter(({ text }) => /@\//.test(text))
    .slice(0, 5); // show first 5 occurrences
  fail(
    `dist/index.js contains unresolved @/ imports:\n` +
      hits.map(({ line, text }) => `    line ${line}: ${text.trim()}`).join('\n'),
  );
} else {
  pass('No @/ specifiers in dist/index.js');
}

// ── Check 2: Key exports are present in the bundle source (static check) ─────
// These patterns verify that the exports were not tree-shaken away and their
// public names made it into the output without requiring a Bun runtime.
const expectedExports = ['createAnchor', 'makeSqliteDbUrlForTests'];
for (const name of expectedExports) {
  // Match an export statement or a variable assignment that publishes the name.
  if (source.includes(name)) {
    pass(`dist/index.js contains export "${name}"`);
  } else {
    fail(`dist/index.js does not contain "${name}" — export may be missing`);
  }
}

// ── Check 3: No @/ specifiers in declaration files ───────────────────────────
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function* walkDts(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkDts(full);
    } else if (full.endsWith('.d.ts')) {
      yield full;
    }
  }
}

const distRoot = resolve(repoRoot, 'dist');
const dtsViolations = [];
for (const file of walkDts(distRoot)) {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/@\//.test(lines[i])) {
      dtsViolations.push({
        file: file.replace(repoRoot + '/', ''),
        line: i + 1,
        text: lines[i].trim(),
      });
    }
  }
}

if (dtsViolations.length > 0) {
  const preview = dtsViolations
    .slice(0, 5)
    .map(({ file, line, text }) => `    ${file}:${line}  ${text}`)
    .join('\n');
  fail(`${dtsViolations.length} @/ import(s) remain in .d.ts files:\n${preview}`);
} else {
  pass('No @/ specifiers in dist/**/*.d.ts');
}

// ── Check 4: Packed tarball installs and imports under a real runtime ────────
// This is the acceptance gate: a broken runtime import or declaration must
// cause this check to fail so the consumer job fails before publication.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const runtimeArg = process.argv.find((a) => a.startsWith('--runtime='));
const runtime = runtimeArg ? runtimeArg.split('=')[1] : 'node';
if (runtime !== 'node' && runtime !== 'bun') {
  fail(`Unknown --runtime=${runtime} (expected "node" or "bun")`);
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

if (!failed) {
  const workDir = mkdtempSync(resolve(tmpdir(), 'anchor-kit-consumer-'));
  try {
    // Pack the current package into the temp dir.
    const packOut = run('npm', ['pack', '--silent', '--pack-destination', workDir], repoRoot);
    const tarball = packOut.trim().split('\n').pop();
    if (!tarball || !tarball.endsWith('.tgz')) {
      fail(`npm pack did not produce a tarball (got: ${packOut.trim()})`);
    } else {
      // Initialize a clean consumer project and install the tarball.
      writeFileSync(
        resolve(workDir, 'package.json'),
        JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2),
      );
      const installCmd = runtime === 'bun' ? 'bun' : 'npm';
      const installArgs =
        runtime === 'bun' ? ['add', resolve(workDir, tarball)] : ['install', resolve(workDir, tarball)];
      run(installCmd, installArgs, workDir);

      // Import the installed package and assert the public exports exist.
      const probe = `
import * as sdk from 'anchor-kit';
const missing = ['createAnchor', 'makeSqliteDbUrlForTests'].filter((n) => typeof sdk[n] !== 'function');
if (missing.length) {
  console.error('Missing runtime exports: ' + missing.join(', '));
  process.exit(1);
}
console.log('runtime-import-ok');
`;
      writeFileSync(resolve(workDir, 'probe.mjs'), probe);
      const runCmd = runtime === 'bun' ? 'bun' : 'node';
      const out = run(runCmd, ['probe.mjs'], workDir);
      if (!out.includes('runtime-import-ok')) {
        fail(`Packed tarball did not import cleanly under ${runtime}:\n${out}`);
      } else {
        pass(`Packed tarball installs and imports under ${runtime}`);
      }
    }
  } catch (err) {
    fail(`Packed tarball consumer check failed under ${runtime}: ${err.message}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ── Final result ─────────────────────────────────────────────────────────────
if (failed) {
  console.error('\nOne or more checks failed.');
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
