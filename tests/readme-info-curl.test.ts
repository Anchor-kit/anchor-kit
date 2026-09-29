import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('README /info curl example', () => {
  it('documents a curl example for GET /info', () => {
    const readmePath = new URL('../README.md', import.meta.url);
    const readme = readFileSync(readmePath, 'utf8');

    expect(readme).toContain('curl -s http://localhost:3000/anchor/info');
    expect(readme).toContain('GET /info');
  });
});
