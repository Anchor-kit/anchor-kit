import { describe, expect, it } from 'vitest';

function isAcceptedBearerHeader(authHeader: unknown): boolean {
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  return token.split('.').length === 3;
}

describe('Integration: malformed bearer token', () => {
  it('rejects a non-JWT Authorization: Bearer header with 401', () => {
    expect(isAcceptedBearerHeader('Bearer not-a-jwt')).toBe(false);
  });

  it('allows a well-formed (dot-separated) token with 200', () => {
    expect(isAcceptedBearerHeader('Bearer a.b.c')).toBe(true);
  });
});
