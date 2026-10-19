/**
 * fix-dts-imports.mjs
 *
 * After `tsc -p tsconfig.types.json` emits declaration files into dist/,
 * each file may still contain `@/…` path-alias imports because TypeScript
 * preserves them verbatim when `declarationMap` is false and no path-rewrite
 * plugin is active.
 *
 * This script walks every *.d.ts file under dist/ and rewrites every
 *   `from '@/some/path'`  or  `from '@/some/path.ts'`
 * to a correct relative import from that file's location, stripping any
 * trailing `.ts` extension so the declaration file matches the JS output.
 *
 * Example:
 *   dist/src/core/factory.d.ts  contains  from '@/types/config.ts'
 *   → replaced with             from '../types/config'
 *
 * The root dist/index.d.ts re-exports `./src/index` (no @/ aliases) and is
 * left unchanged.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The directory where tsc places its declaration output.  TypeScript mirrors
 * the source tree rooted at the project root, so src/core/factory.ts becomes
 * dist/src/core/factory.d.ts.  The @/ alias maps to src/, which after emit
 * lives at dist/src/ inside the dist tree.
 */
const DIST_ROOT = resolve('dist');
/** dist/src/ is where @/ resolves inside the emitted declaration tree. */
const ALIAS_ROOT = join(DIST_ROOT, 'src');

/**
 * Convert an @/ specifier found in `fromFile` to a relative path.
 *
 * @param {string} fromFile  Absolute path to the .d.ts file containing the import.
 * @param {string} specifier The raw specifier, e.g. '@/types/config.ts'
 * @returns {string}         Relative specifier with no .ts extension, e.g. '../types/config'
 */
function resolveAlias(fromFile, specifier) {
  // Strip the @/ prefix and any trailing .ts extension.
  const withoutPrefix = specifier.slice(2); // remove '@/'
  const withoutExt = withoutPrefix.replace(/\.ts$/, '');

  // Absolute path to the target inside the dist/src tree.
  const targetAbs = join(ALIAS_ROOT, withoutExt);

  // Relative path from the importing file's directory to the target.
  const fromDir = dirname(fromFile);
  let rel = relative(fromDir, targetAbs);

  // Ensure the path starts with ./ so it is a valid relative specifier.
  if (!rel.startsWith('.')) {
    rel = `./${rel}`;
  }

  return rel;
}

/** Recursively walk a directory, yielding absolute paths to *.d.ts files. */
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

let filesChanged = 0;
let importsReplaced = 0;

for (const file of walkDts(DIST_ROOT)) {
  const original = readFileSync(file, 'utf8');

  // Match both single- and double-quoted @/ imports.
  // Handles:  from '@/path'  from '@/path.ts'  import('@/path')  /// <reference ... '@/path' />
  const replaced = original.replace(
    /(['"])@\/([^'"]+)\1/g,
    (match, quote, rest) => {
      const specifier = `@/${rest}`;
      const rel = resolveAlias(file, specifier);
      importsReplaced++;
      return `${quote}${rel}${quote}`;
    },
  );

  if (replaced !== original) {
    writeFileSync(file, replaced, 'utf8');
    filesChanged++;
  }
}

console.log(
  `fix-dts-imports: rewrote ${importsReplaced} @/ import(s) across ${filesChanged} file(s).`,
);
