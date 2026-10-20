import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      'bun:sqlite': resolve(__dirname, './tests/__mocks__/bun-sqlite.ts'),
      'bun:test': resolve(__dirname, './tests/__mocks__/bun-test.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    pool: 'threads',
  },
});
