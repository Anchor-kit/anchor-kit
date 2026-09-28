import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('plugin lifecycle documentation', () => {
  it('documents registration timing, failure handling, and a typed example', () => {
    const guide = readFileSync(new URL('../docs/plugin-lifecycle.md', import.meta.url), 'utf8');

    expect(guide).toContain('AnchorInstance.use before initialization');
    expect(guide).toContain('registering the same id twice throws');
    expect(guide).toContain('If a callback throws');
    expect(guide).toContain('interface AuditPluginConfig');
    expect(guide).toContain('anchor.use(auditPlugin)');
  });
});
