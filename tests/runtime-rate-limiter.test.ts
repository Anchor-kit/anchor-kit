import { InMemoryRateLimiter } from '@/runtime/http/rate-limiter.ts';
import { extractClientIdentifier } from '@/runtime/http/client-identifier.ts';
import { describe, expect, it } from 'vitest';

describe('InMemoryRateLimiter', () => {
  it('blocks requests after limit within window', () => {
    const limiter = new InMemoryRateLimiter();
    const rule = { windowMs: 60000, max: 2 };

    const first = limiter.hit('auth:127.0.0.1', rule);
    const second = limiter.hit('auth:127.0.0.1', rule);
    const third = limiter.hit('auth:127.0.0.1', rule);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows requests again after the window resets', () => {
    const limiter = new InMemoryRateLimiter();
    const rule = { windowMs: 100, max: 1 };

    const first = limiter.hit('auth:127.0.0.1', rule);
    expect(first.allowed).toBe(true);

    const blocked = limiter.hit('auth:127.0.0.1', rule);
    expect(blocked.allowed).toBe(false);

    // Advance time past the window by stubbing Date.now
    const originalNow = Date.now;
    Date.now = () => originalNow() + 150;
    try {
      const afterReset = limiter.hit('auth:127.0.0.1', rule);
      expect(afterReset.allowed).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  it('isolates rate limits per key', () => {
    const limiter = new InMemoryRateLimiter();
    const rule = { windowMs: 60000, max: 1 };

    const firstKey = limiter.hit('auth:127.0.0.1', rule);
    const firstKeyBlocked = limiter.hit('auth:127.0.0.1', rule);
    const secondKey = limiter.hit('auth:192.168.1.1', rule);

    expect(firstKey.allowed).toBe(true);
    expect(firstKeyBlocked.allowed).toBe(false);
    expect(secondKey.allowed).toBe(true);
  });
});

describe('extractClientIdentifier', () => {
  it('uses the left-most forwarded address from string headers when trusted', () => {
    const clientId = extractClientIdentifier('203.0.113.10', '10.0.0.1, 10.0.0.2', true);

    expect(clientId).toBe('10.0.0.1');
  });

  it('uses the first forwarded address from array headers when trusted', () => {
    const clientId = extractClientIdentifier(
      '203.0.113.10',
      ['10.0.0.5, 10.0.0.6', '10.0.0.7'],
      true,
    );

    expect(clientId).toBe('10.0.0.5');
  });

  it('falls back to the socket address when forwarded headers are absent or untrusted', () => {
    expect(extractClientIdentifier('203.0.113.10', undefined, true)).toBe('203.0.113.10');
    expect(extractClientIdentifier('203.0.113.10', ['10.0.0.1'], false)).toBe('203.0.113.10');
  });
});

describe('extractClientIdentifier address normalization', () => {
  it('normalizes IPv4 and collapses an IPv4 port suffix', () => {
    expect(extractClientIdentifier('203.0.113.10', '198.51.100.7', true)).toBe('198.51.100.7');
    expect(extractClientIdentifier('203.0.113.10', '198.51.100.7:8443', true)).toBe('198.51.100.7');
    // The left-most entry is still selected before normalization.
    expect(extractClientIdentifier('203.0.113.10', '198.51.100.7:8443, 10.0.0.1', true)).toBe(
      '198.51.100.7',
    );
  });

  it('maps bracketed IPv6 and IPv6-with-port to the same identity', () => {
    expect(extractClientIdentifier('203.0.113.10', '[2001:db8::1]', true)).toBe('2001:db8::1');
    expect(extractClientIdentifier('203.0.113.10', '[2001:db8::1]:443', true)).toBe('2001:db8::1');
    expect(extractClientIdentifier('203.0.113.10', '2001:db8::1', true)).toBe('2001:db8::1');
  });

  it('canonicalizes equivalent IPv6 forms to a single key', () => {
    const forms = [
      '[2001:DB8::1]:8443',
      '[2001:0db8:0000:0000:0000:0000:0000:0001]',
      '2001:db8:0:0:0:0:0:1',
    ];

    const identifiers = forms.map((form) => extractClientIdentifier('203.0.113.10', form, true));

    expect(new Set(identifiers).size).toBe(1);
    expect(identifiers[0]).toBe('2001:db8::1');
  });

  it('falls back to the socket address for malformed forwarded values', () => {
    const malformed = [
      'not-an-ip',
      'localhost',
      '[2001:db8::1',
      '[2001:db8::1]evil',
      '198.51.100.7:notaport',
      '999.1.1.1',
      '',
    ];

    for (const value of malformed) {
      expect(extractClientIdentifier('203.0.113.10', value, true)).toBe('203.0.113.10');
    }
  });

  it('does not treat malformed forwarded values as a trusted identity', () => {
    expect(extractClientIdentifier(undefined, 'not-an-ip', true)).toBe('unknown');
    expect(extractClientIdentifier('203.0.113.10', 'not-an-ip', false)).toBe('203.0.113.10');
  });
});
