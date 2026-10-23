import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sep6 = readFileSync(new URL('../src/core/sep6/README.md', import.meta.url), 'utf8');
const sep24 = readFileSync(new URL('../src/core/sep24/README.md', import.meta.url), 'utf8');
const sep31 = readFileSync(new URL('../src/core/sep31/README.md', import.meta.url), 'utf8');
const services = readFileSync(new URL('../src/services/README.md', import.meta.url), 'utf8');
const status = readFileSync(new URL('../docs/implementation-status.md', import.meta.url), 'utf8');

describe('protocol implementation status documentation', () => {
  it('distinguishes reserved protocol engines from the implemented HTTP foundation', () => {
    for (const stub of [sep6, sep24, sep31]) {
      expect(stub).toMatch(/reserved for a future/i);
      expect(stub).toMatch(/no .* conformance claim|not evidence of complete .* conformance/i);
      expect(stub).toMatch(/shared HTTP runtime/i);
    }

    expect(sep24).toContain('POST /transactions/deposit/interactive');
    expect(services).toContain('in-memory queue');
    expect(services).toContain('transaction watcher');
    expect(status).toContain('Complete protocol engines and conformance');
    expect(status).toContain('not complete protocol implementations');
  });
});
