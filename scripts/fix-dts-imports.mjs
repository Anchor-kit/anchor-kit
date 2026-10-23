import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve('dist');

function relativeDeclarationImport(fromFile, aliasPath) {
  const targetPath = resolve(root, 'src', aliasPath.replace(/\.ts$/, ''));
  return makeRelativeSpecifier(fromFile, targetPath);
}

function makeRelativeSpecifier(fromFile, targetPath) {
  let specifier = relative(dirname(fromFile), targetPath).split(sep).join('/');
  if (!specifier.startsWith('.')) {
    specifier = `./${specifier}`;
  }
  return `${specifier}.js`;
}

function walk(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
      continue;
    }

    if (!full.endsWith('.d.ts')) {
      continue;
    }

    const original = readFileSync(full, 'utf8');
    const aliasesReplaced = original.replace(
      /((?:from\s+|import\()\s*['"])@\/([^'"]+)(['"])/g,
      (_match, prefix, aliasPath, suffix) =>
        `${prefix}${relativeDeclarationImport(full, aliasPath)}${suffix}`,
    );
    const replaced = aliasesReplaced.replace(
      /((?:from\s+|import\()\s*['"])(\.{1,2}\/[^'"]+)(['"])/g,
      (_match, prefix, specifier, suffix) => {
        if (/\.(?:[cm]?js|json)$/.test(specifier)) {
          return `${prefix}${specifier}${suffix}`;
        }

        const normalizedSpecifier = specifier.replace(/\.ts$/, '');
        const targetPath = resolve(dirname(full), normalizedSpecifier);
        if (existsSync(join(targetPath, 'index.d.ts'))) {
          return `${prefix}${normalizedSpecifier}/index.js${suffix}`;
        }

        return `${prefix}${normalizedSpecifier}.js${suffix}`;
      },
    );

    if (replaced !== original) {
      writeFileSync(full, replaced);
    }
  }
}

walk(root);
