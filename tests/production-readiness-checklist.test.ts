import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '..');
const roadmapPath = resolve(repositoryRoot, 'ROADMAP.md');
const roadmapContent = readFileSync(roadmapPath, 'utf8');

describe('operational checklist for production readiness reviews (#816)', () => {
  it('turns the production-readiness gate into a maintainer review checklist in ROADMAP.md', () => {
    expect(roadmapContent).toContain('## Production readiness review checklist');
    expect(roadmapContent).toMatch(/Production readiness:\*\* next gate is completing the/i);
  });

  it('requires explicit review items for all five operational areas', () => {
    const requiredAreas = [
      'Protocol interoperability assessment',
      'Settlement assessment',
      'Security review assessment',
      'Recovery assessment',
      'Release evidence assessment',
    ];

    for (const area of requiredAreas) {
      expect(roadmapContent).toContain(area);
      // Ensure each item is an open checklist item, not checked off
      expect(roadmapContent).toContain(`- [ ] **${area}**`);
    }
  });

  it('leaves each item as an explicit assessment without declaring production ready', () => {
    const checklistSection =
      roadmapContent.split('## Production readiness review checklist')[1] ?? '';
    expect(checklistSection).toBeTruthy();

    // Must explicitly forbid declaring the project production ready
    expect(checklistSection).toMatch(/(?:do|must) not declare the project production ready/i);

    const assessments = checklistSection.match(/Maintainer assessment:\*\*\s*(.+)/g);
    expect(assessments).not.toBeNull();
    expect(assessments?.length).toBe(5);

    for (const assessment of assessments!) {
      expect(assessment).toMatch(/Open \/ Unverified/i);
      expect(assessment).toMatch(/Do not declare production ready/i);
    }

    // Ensure no production-readiness checklist item is checked
    const checkedItems = checklistSection.match(/- \[x\]/g);
    expect(checkedItems).toBeNull();
  });

  it('links each checklist item to valid evidence files in the repository', () => {
    const checklistSection =
      roadmapContent.split('## Production readiness review checklist')[1] ?? '';

    // Verify key evidence links are referenced
    const requiredEvidenceFiles = [
      './docs/implementation-status.md',
      './docs/acceptance-checks.md',
      './docs/interactive-completion-status.md',
      './tests/runtime/interactive-session-revocation.test.ts',
      './docs/testnet-deposit-evidence.md',
      './docs/issue-acceptance-checks.md',
      './src/runtime/settlement/recipient-readiness.ts',
      './tests/recipient-readiness.test.ts',
      './docs/database-migrations.md',
      './docs/local-signer-secrets.md',
      './docs/webhook-secret-rotation.md',
      './docs/auth-token-response.md',
      './docs/trusted-proxy-rate-limits.md',
      './docs/configuration-reference.md',
      './docs/idempotency-reservation-recovery.md',
      './docs/postgres-backup-restore.md',
      './docs/queue-retries.md',
      './tests/runtime/webhooks/operation-recovery.integration.test.ts',
      './docs/bun-deployment-status.md',
      './docs/releasing.md',
      './tests/publish-workflow.test.ts',
      './scripts/check-package-consumer.mjs',
      './scripts/check-package-smoke.mjs',
      './scripts/check-pack-contents.mjs',
      './scripts/check-doc-acceptance.mjs',
    ];

    for (const fileRef of requiredEvidenceFiles) {
      expect(checklistSection).toContain(fileRef);
      const cleanPath = fileRef.replace(/^\.\//, '');
      const absolutePath = resolve(repositoryRoot, cleanPath);
      expect(existsSync(absolutePath)).toBe(true);
    }
  });
});
