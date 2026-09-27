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
