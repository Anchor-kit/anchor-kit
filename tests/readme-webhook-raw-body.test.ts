import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('README webhook raw body guidance', () => {
  it('documents Express raw body capture and webhook contract details', () => {
    const readmePath = new URL('../README.md', import.meta.url);
    const readme = readFileSync(readmePath, 'utf8');

    expect(readme).toContain('Webhook raw body capture');
    expect(readme).toContain('express.json');
    expect(readme).toContain('verify');
    expect(readme).toContain('rawBody');
    expect(readme).toContain('exact request body bytes');
    expect(readme).toContain('anchor.getExpressRouter()');
    expect(readme).toContain('Content-Type: application/json');
    expect(readme).toContain('x-anchor-signature');
    expect(readme).toContain('verifyWebhookSignatures: false');
    expect(readme).toContain('webhook_error');
    expect(readme).toContain('internal_server_error');
  });

  it('documents raw body capture in the MVP Express guide', () => {
    const guidePath = new URL('../docs/mvp-express.md', import.meta.url);
    const guide = readFileSync(guidePath, 'utf8');

    expect(guide).toContain('express.json');
    expect(guide).toContain('verify');
    expect(guide).toContain('rawBody');
    expect(guide).toContain('exact raw request body bytes');
    expect(guide).toContain('anchor.getExpressRouter()');
  });
});
