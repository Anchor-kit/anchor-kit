import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('README version badge', () => {
  it('matches the version in package.json', () => {
    const readmePath = new URL('../README.md', import.meta.url);
    const packageJsonPath = new URL('../package.json', import.meta.url);

    const readme = readFileSync(readmePath, 'utf8');
    const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      version: string;
    };

    const badgeVersion = version.replace(/-/g, '--');
    expect(readme).toContain(
      `![Version](https://img.shields.io/badge/version-${badgeVersion}-orange.svg)`,
    );
  });
});
