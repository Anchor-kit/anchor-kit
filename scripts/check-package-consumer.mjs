import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = resolve(root, 'tests/fixtures/package-consumer');
const tempDir = mkdtempSync(join(tmpdir(), 'anchor-kit-consumer-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}${result.stderr}`);
  }

  return result.stdout;
}

try {
  run('npm', ['pack', '--pack-destination', tempDir], root);
  const packageArchive = readdirSync(tempDir).find((name) => name.endsWith('.tgz'));
  if (!packageArchive) {
    throw new Error('npm pack did not create an anchor-kit package archive');
  }

  for (const entry of readdirSync(fixture)) {
    cpSync(join(fixture, entry), join(tempDir, entry), { recursive: true });
  }
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      join(tempDir, packageArchive),
      'typescript@^5',
      '@types/node@^22',
    ],
    tempDir,
  );
  run('npm', ['exec', '--', 'tsc', '--project', 'tsconfig.json'], tempDir);
  run('npm', ['exec', '--', 'node', 'consumer.mjs'], tempDir);
  console.log(
    'PASS: a clean external TypeScript consumer resolves createAnchor and public types through package exports, and the installed runtime import executes',
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
