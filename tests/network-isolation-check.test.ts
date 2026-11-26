import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-network-isolation.mjs', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'anchor-kit-network-isolation-'));
const manifestPath = join(directory, 'manifest.json');

const testnetManifest = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  signerPublicKey: 'GCXXAI54PB76QYBSB2XTTJJZ4NCMFAM4MK4GLZNCEGJDKNMRX3Z2I55P',
  assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};

type Overrides = Partial<typeof testnetManifest> & {
  manifest?: Partial<typeof testnetManifest>;
};

const report = (overrides: Overrides = {}) => {
  writeFileSync(manifestPath, JSON.stringify({ ...testnetManifest, ...overrides.manifest }));

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('ANCHOR_') && value !== undefined) env[name] = value;
  }
  env.ANCHOR_NETWORK = overrides.network ?? testnetManifest.network;
  env.ANCHOR_NETWORK_PASSPHRASE = overrides.networkPassphrase ?? testnetManifest.networkPassphrase;
  env.ANCHOR_HORIZON_URL = overrides.horizonUrl ?? testnetManifest.horizonUrl;
  env.ANCHOR_SIGNER_PUBLIC_KEY = overrides.signerPublicKey ?? testnetManifest.signerPublicKey;
  env.ANCHOR_ASSET_ISSUER = overrides.assetIssuer ?? testnetManifest.assetIssuer;

  return spawnSync(process.execPath, [script, '--manifest', manifestPath], {
    encoding: 'utf8',
    env,
  });
};

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('network isolation check', () => {
  it('passes when the environment matches the testnet manifest', () => {
    const result = report();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('network-isolation: OK');
  });

  it('fails and names only the field when a value disagrees', () => {
    const result = report({
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mismatch: ANCHOR_NETWORK_PASSPHRASE');
    expect(result.stderr).not.toContain('Public Global Stellar Network');
  });

  it('fails when the manifest network and passphrase disagree', () => {
    const result = report({
      manifest: { network: 'public' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest.networkPassphrase does not match manifest.network');
  });
});
