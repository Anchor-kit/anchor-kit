/**
 * check-alias-imports.mjs
 *
 * Acceptance-gate script: verifies that no unresolved @/ path-alias imports
 * remain in the built dist/ output.
 *
 * Usage:
 *   node scripts/check-alias-imports.mjs
 *
 * Exits 0 when dist/ is clean.
 * Exits 1 and prints offending lines when @/ imports are found.
 *
 * Run this after `npm run build` to confirm the acceptance criterion:
 *   "Bundled JavaScript contains no unresolved @/ imports."
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST_ROOT = 'dist';
const ALIAS_PATTERN = /@\//;

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = [];

/**
 * Recursively walk a directory.
 * @param {string} dir
 */
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    // Check .js and .d.ts files only (the two artifact types we produce).
    if (!full.endsWith('.js') && !full.endsWith('.d.ts')) {
      continue;
    }

    const lines = readFileSync(full, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (ALIAS_PATTERN.test(lines[i])) {
        violations.push({ file: full, line: i + 1, text: lines[i].trim() });
      }
    }
  }
}

walk(DIST_ROOT);

if (violations.length > 0) {
  console.error(
    `\ncheck-alias-imports: FAIL – found ${violations.length} unresolved @/ import(s) in dist/:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error(
    '\nRun `npm run build` to rebuild, then rerun this check.',
  );
  process.exit(1);
}

console.log(`check-alias-imports: OK – no @/ imports found in dist/ (${DIST_ROOT}).`);
