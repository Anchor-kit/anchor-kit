/**
 * Rolldown build configuration for anchor-kit.
 *
 * Replaces `bun build` as the JS bundler so that @/ path-alias imports are
 * resolved at bundle time.  All npm dependencies remain external (matching
 * the original `bun build --packages external` behaviour).
 */
import { defineConfig } from 'rolldown';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

/**
 * All declared dependencies stay external – only src/ files are inlined.
 *
 * Note: @/ is the internal path alias and must NOT be listed as external;
 * rolldown will resolve it via `resolve.alias` below.  We match scoped
 * npm packages with a regex that explicitly excludes the @/ prefix.
 */
const external = [
  // Node built-ins (both bare and node: protocol forms).
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  // Explicit package names from package.json.
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  // Any remaining scoped package (@scope/name) that is NOT the @/ alias.
  // This catches transitive scoped imports not explicitly listed above.
  /^@(?!\/).+/,
];

export default defineConfig({
  input: 'src/index.ts',
  output: {
    file: 'dist/index.js',
    format: 'esm',
  },
  resolve: {
    /**
     * Map @/ → <root>/src/ so every internal cross-module import is resolved
     * and inlined rather than emitted as an unresolvable bare specifier.
     */
    alias: {
      '@': './src',
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  external,
  platform: 'node',
});
