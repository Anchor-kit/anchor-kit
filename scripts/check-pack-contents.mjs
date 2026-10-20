import { execFileSync } from 'node:child_process';

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
});
const [packResult] = JSON.parse(output);
const files = new Set(packResult?.files?.map(({ path }) => path) ?? []);

const requiredFiles = ['README.md', 'LICENSE', 'package.json', 'dist/index.js', 'dist/index.d.ts'];
const forbiddenPrefixes = ['tests/', 'src/', 'scripts/', '.github/', 'example/'];

const missingFiles = requiredFiles.filter((file) => !files.has(file));
const leakedFiles = [...files].filter((file) =>
  forbiddenPrefixes.some((prefix) => file.startsWith(prefix)),
);

if (missingFiles.length > 0 || leakedFiles.length > 0) {
  if (missingFiles.length > 0) {
    console.error(`Missing package files: ${missingFiles.join(', ')}`);
  }
  if (leakedFiles.length > 0) {
    console.error(`Workspace files leaked into package: ${leakedFiles.join(', ')}`);
  }
  process.exit(1);
}

console.log(`Package contents verified (${files.size} files).`);
