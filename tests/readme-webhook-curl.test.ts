import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('README webhook curl example', () => {
  it('documents a curl example for posting webhook events', () => {
    const readmePath = new URL('../README.md', import.meta.url);
    const readme = readFileSync(readmePath, 'utf8');

    expect(readme).toContain('POST http://localhost:3000/anchor/webhooks/events');
    expect(readme).toContain('x-webhook-provider');
    expect(readme).toContain('x-anchor-signature');
    expect(readme).toContain('openssl dgst -sha256 -hmac');
  });
});
