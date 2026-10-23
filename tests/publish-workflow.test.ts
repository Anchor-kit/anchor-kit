import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');

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
