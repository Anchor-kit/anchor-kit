import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const baselinePath = resolve(repoRoot, 'ci/fallow-health-baseline.json');

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const result = spawnSync(
  'bunx',
  ['fallow', 'health', '--score', '--hotspots', '--report-only', '--format', 'json', '--quiet'],
  {
    cwd: repoRoot,
    encoding: 'utf8',
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout);
const currentScore = Math.round(Number(report.health_score?.score ?? 0));
const currentHotspotCount = Array.isArray(report.hotspots) ? report.hotspots.length : 0;

const problems = [];
if (currentScore < baseline.healthScore) {
  problems.push(`health score regressed from ${baseline.healthScore} to ${currentScore}`);
}

if (currentHotspotCount > baseline.hotspotCount) {
  problems.push(`hotspot count regressed from ${baseline.hotspotCount} to ${currentHotspotCount}`);
}

if (problems.length > 0) {
  console.error('Fallow health regression detected:');
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

console.log(
  `Fallow health OK: score ${currentScore}, hotspots ${currentHotspotCount} (baseline ${baseline.healthScore}/${baseline.hotspotCount})`,
);
