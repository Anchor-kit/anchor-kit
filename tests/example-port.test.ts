import { describe, expect, it } from 'vitest';
import { parsePort } from '../example/express-app.ts';

describe('example/express-app parsePort', () => {
  it('defaults PORT to 3000', () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort('')).toBe(3000);
  });

  it.each(['0', '-1', '65536', '3000.5', 'not-a-port'])(
    'rejects invalid PORT value %s',
    (value) => {
      expect(() => parsePort(value)).toThrow('PORT must be an integer between 1 and 65535');
    },
  );

  it.each(['1', '3000', '65535'])('accepts PORT value %s', (value) => {
    expect(parsePort(value)).toBe(Number(value));
  });
});
