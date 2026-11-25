import { createInteractiveInitiationResponse } from '@/core/sep24/interactive-response.ts';
import { describe, expect, it } from 'vitest';

describe('SEP-24 interactive initiation response', () => {
  it('preserves a host-provided scoped URL and transaction ID in the standard shape', () => {
    const url = 'https://anchor.example.com/deposit/txn-1?session=signed-token';
    expect(createInteractiveInitiationResponse({ id: 'txn-1', url })).toEqual({
      type: 'interactive_customer_info_needed',
      url,
      id: 'txn-1',
    });
  });
  it.each([
    '',
    '/deposit/txn-1',
    'http://anchor.example.com/deposit',
    'https://user:password@anchor.example.com/',
  ])('rejects an unsafe URL without echoing it: %s', (url) => {
    expect(() => createInteractiveInitiationResponse({ id: 'txn-1', url })).toThrow(TypeError);
  });
  it('rejects an empty transaction ID', () => {
    expect(() =>
      createInteractiveInitiationResponse({ id: ' ', url: 'https://anchor.example.com/' }),
    ).toThrow(TypeError);
  });
});
