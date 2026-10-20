import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'anchor-kit-package-smoke-'));
const consumerDirectory = join(temporaryDirectory, 'consumer');
mkdirSync(consumerDirectory);

function findBunExecutable() {
  const pathEntries = (process.env.PATH ?? '').split(delimiter);
  const executables = pathEntries.flatMap((directory) => [
    join(directory, 'bun.exe'),
    join(directory, 'node_modules', 'bun', 'bin', 'bun.exe'),
  ]);
  const executable = executables.find(existsSync);

  if (!executable) {
    throw new Error('Unable to locate the Bun executable required for the consumer smoke check');
  }

  return executable;
}

function run(command, args, cwd) {
  const isWindows = process.platform === 'win32';
  const executable =
    isWindows && command === 'npm'
      ? process.execPath
      : isWindows && command === 'bun'
        ? findBunExecutable()
        : command;
  const executableArgs =
    isWindows && command === 'npm'
      ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]
      : args;

  return execFileSync(executable, executableArgs, { cwd, encoding: 'utf8' });
}

try {
  const npmCommand = 'npm';
  const bunCommand = 'bun';
  const packOutput = run(
    npmCommand,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryDirectory],
    repositoryRoot,
  );
  const [packResult] = JSON.parse(packOutput);
  if (!packResult?.filename) {
    throw new Error('npm pack did not report a tarball filename');
  }

  const tarballPath = join(temporaryDirectory, packResult.filename);
  run(bunCommand, ['add', tarballPath], consumerDirectory);

  const smokeFile = join(consumerDirectory, 'smoke.mjs');
  writeFileSync(
    smokeFile,
    `import { createAnchor } from 'anchor-kit';

const anchor = createAnchor({
  network: { network: 'testnet' },
  server: { interactiveDomain: 'https://anchor.example.test' },
  security: {
    sep10SigningKey: 'SAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC5MY',
    interactiveJwtSecret: 'consumer-smoke-test-jwt-secret',
    distributionAccountSecret: 'SAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC5MY',
  },
  assets: { assets: [{ code: 'XLM' }] },
  framework: {
    database: { provider: 'sqlite', url: 'file::memory:' },
    watchers: { enabled: false },
  },
});

await anchor.init();
await anchor.shutdown();
console.log('Packed consumer initialized and shut down.');
`,
    'utf8',
  );

  const smokeOutput = run(bunCommand, ['run', smokeFile], consumerDirectory);
  if (!smokeOutput.includes('Packed consumer initialized and shut down.')) {
    throw new Error('Packed consumer smoke did not report successful initialization and shutdown');
  }

  console.log('Packed consumer smoke passed.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
