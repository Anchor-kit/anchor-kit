import { describe, expect, it } from 'vitest';
import { createAnchor } from '@/index.ts';
import { ConfigError } from '@/core/errors.ts';

describe('AnchorInstance pre-init router access', () => {
  it('throws ConfigError with init guidance before initialization', () => {
    const anchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: 'SCZJBZ6S7HWMQVT7DM74JVHVDKCEE5P6I6T3E5M7LJM6LJM6LJM6LJM6',
        interactiveJwtSecret: 'jwt-test-secret',
        distributionAccountSecret: 'distribution-test-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
      framework: {
        database: {
          provider: 'sqlite',
          url: 'file::memory:',
        },
      },
    });

    expect(() => anchor.getExpressRouter()).toThrowError(ConfigError);
    expect(() => anchor.getExpressRouter()).toThrowError(
      'Anchor is not initialized. Call init() first.',
    );
  });
});
