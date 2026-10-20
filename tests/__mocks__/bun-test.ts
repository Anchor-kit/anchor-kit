/**
 * Vitest shim for bun:test — re-exports the vitest equivalents so that
 * any test file written against bun:test works unchanged under vitest.
 */
export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi as mock,
  test,
  vi,
} from 'vitest';
