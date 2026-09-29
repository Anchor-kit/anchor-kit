import { describe, expect, it } from 'vitest';
import { AnchorConfig } from '@/core/config.ts';
import { ConfigError } from '@/core/errors.ts';
import { createAnchor } from '@/core/factory.ts';
import type { AnchorKitConfig, ServerConfig } from '@/types/config.ts';
import { SecurityConfigSchema, ServerConfigSchema } from '@/utils/validation.ts';

const baseConfig: AnchorKitConfig = {
  network: { network: 'testnet' },
  server: {},
  security: {
    sep10SigningKey: 'secret-key-10',
    interactiveJwtSecret: 'jwt-secret',
    distributionAccountSecret: 'dist-secret',
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
      provider: 'postgres',
      url: 'postgresql://localhost:5432/anchor',
    },
  },
};

function configWithServer(server: ServerConfig): AnchorKitConfig {
  return { ...baseConfig, server };
}

describe('server config validation', () => {
  it('accepts partial server settings without adding or changing values', () => {
    const server = { host: 'localhost' };
    const config = new AnchorConfig(configWithServer(server));

    expect(() => config.validate()).not.toThrow();
    expect(config.get('server')).toEqual(server);
  });

  it('accepts complete server settings unchanged', () => {
    const server: ServerConfig = {
      host: '127.0.0.1',
      port: 65535,
      debug: false,
      interactiveDomain: 'https://anchor.example',
      corsOrigins: ['https://app.example'],
      requestTimeout: 30000,
    };
    const config = new AnchorConfig(configWithServer(server));

    expect(() => config.validate()).not.toThrow();
    expect(config.get('server')).toEqual(server);
  });

  it('rejects invalid non-port server settings during anchor creation', () => {
    expect(() => createAnchor(configWithServer({ host: '' }))).toThrow(ConfigError);
    expect(() => createAnchor(configWithServer({ debug: 'false' as unknown as boolean }))).toThrow(
      /debug: invalid value/,
    );
  });

  it.each([1, 65535])('accepts valid server port %i', (port) => {
    expect(ServerConfigSchema.port.validate(port)).toBe(true);
    expect(() => new AnchorConfig(configWithServer({ port })).validate()).not.toThrow();
  });

  it.each([0, -1, 1.5, 65536, NaN, Infinity, '3000'])('rejects invalid server port %s', (port) => {
    expect(ServerConfigSchema.port.validate(port)).toBe(false);
    expect(() => createAnchor(configWithServer({ port: port as number }))).toThrow(ConfigError);
  });

  it('accepts positive safe-integer request timeouts and preserves the snapshot', () => {
    for (const requestTimeout of [1, Number.MAX_SAFE_INTEGER]) {
      const config = new AnchorConfig(configWithServer({ requestTimeout }));
      expect(() => config.validate()).not.toThrow();
      expect(config.get('server').requestTimeout).toBe(requestTimeout);
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid request timeout %s',
    (requestTimeout) => {
      expect(ServerConfigSchema.requestTimeout.validate(requestTimeout)).toBe(false);
      expect(() => createAnchor(configWithServer({ requestTimeout }))).toThrow(ConfigError);
    },
  );

  it('accepts omitted security flags and both boolean values', () => {
    expect(() => SecurityConfigSchema.validate(baseConfig.security)).not.toThrow();

    for (const value of [true, false]) {
      expect(() =>
        SecurityConfigSchema.validate({ ...baseConfig.security, enableClientAttribution: value }),
      ).not.toThrow();
      expect(() =>
        SecurityConfigSchema.validate({ ...baseConfig.security, verifyWebhookSignatures: value }),
      ).not.toThrow();
    }
  });

  it.each(['true', 1])('rejects non-boolean security flags (%s)', (value) => {
    for (const key of ['enableClientAttribution', 'verifyWebhookSignatures'] as const) {
      expect(() => SecurityConfigSchema.validate({ ...baseConfig.security, [key]: value })).toThrow(
        `security.${key} must be a boolean`,
      );
      expect(() =>
        createAnchor({
          ...baseConfig,
          security: { ...baseConfig.security, [key]: value },
        }),
      ).toThrow(`security.${key} must be a boolean`);
    }
  });
});
