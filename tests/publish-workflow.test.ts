import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

describe('npm publish repository guard', () => {
  it('allows published releases in Anchor-kit/anchor-kit and excludes unrelated repositories', () => {
    expect(workflow).toMatch(/^\s+release:\r?\n\s+types:\s+\[published\]\s*$/m);

    const guard = workflow.match(/^\s+if:\s*github\.repository\s*==\s*'([^']+)'\s*$/m)?.[1];
    expect(guard).toBe('Anchor-kit/anchor-kit');

    const repositoryMatchesGuard = (repository: string): boolean =>
      repository.toLowerCase() === guard?.toLowerCase();

    expect(repositoryMatchesGuard('Anchor-kit/anchor-kit')).toBe(true);
    expect(repositoryMatchesGuard('0xNgoo/anchor-kit')).toBe(false);
    expect(repositoryMatchesGuard('Anchor-kit/another-repository')).toBe(false);
    expect(repositoryMatchesGuard('another-owner/anchor-kit')).toBe(false);
  });
});

describe('pinned Bun version', () => {
  const pinnedBunVersion = (source: string): string | undefined =>
    source.match(/^\s+BUN_VERSION:\s*'([^']+)'\s*$/m)?.[1];

  it('records a supported Bun version in CI and publish workflows', () => {
    const ciVersion = pinnedBunVersion(ciWorkflow);
    const publishVersion = pinnedBunVersion(workflow);

    expect(ciVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(publishVersion).toBe(ciVersion);
  });

  it('uses the pinned Bun version for the build and package smoke', () => {
    expect(ciWorkflow).toMatch(/^\s+uses:\s*oven-sh\/setup-bun@[^\n]+\n\s+with:\s*\n\s+bun-version:\s*\$\{\{\s*env\.BUN_VERSION\s*\}\}\s*$/m);
    expect(workflow).toMatch(/^\s+uses:\s*oven-sh\/setup-bun@[^\n]+\n\s+with:\s*\n\s+bun-version:\s*\$\{\{\s*env\.BUN_VERSION\s*\}\}\s*$/m);
  });
});
