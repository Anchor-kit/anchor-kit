/**
 * check-network-isolation.mjs
 *
 * Pre-deploy gate: compares the deployment environment's Stellar network
 * values with an expected environment manifest.
 *
 * Usage:
 *   node scripts/check-network-isolation.mjs --manifest deploy/testnet.manifest.json
 *
 * Actual values are read from these environment variables:
 *   ANCHOR_NETWORK, ANCHOR_NETWORK_PASSPHRASE, ANCHOR_HORIZON_URL,
 *   ANCHOR_SIGNER_PUBLIC_KEY, ANCHOR_ASSET_ISSUER
 *
 * Exit 0 when every value matches the manifest. Exit 1 on a malformed
 * manifest, a missing value, or a mismatch. The output names fields only; it
 * never prints configured values. No network calls are made.
 */

import { readFileSync } from 'node:fs';

const FIELDS = [
  { key: 'network', env: 'ANCHOR_NETWORK' },
  { key: 'networkPassphrase', env: 'ANCHOR_NETWORK_PASSPHRASE' },
  { key: 'horizonUrl', env: 'ANCHOR_HORIZON_URL' },
  { key: 'signerPublicKey', env: 'ANCHOR_SIGNER_PUBLIC_KEY' },
  { key: 'assetIssuer', env: 'ANCHOR_ASSET_ISSUER' },
];

const NETWORK_PASSPHRASES = {
  testnet: 'Test SDF Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

const PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

function usage(message) {
  console.error(`network-isolation: ${message}`);
  console.error(
    'usage: node scripts/check-network-isolation.mjs --manifest <expected-manifest.json>',
  );
  process.exit(1);
}

function manifestPathFromArgs(args) {
  const index = args.indexOf('--manifest');
  if (index !== -1) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith('--manifest='));
  return inline?.slice('--manifest='.length);
}

function fail(lines) {
  console.error('network-isolation: FAIL');
  for (const line of lines) console.error(`  ${line}`);
  console.error('network-isolation: deployment must not proceed.');
  process.exit(1);
}

function validateManifest(manifest) {
  const problems = [];

  for (const { key } of FIELDS) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
      problems.push(`manifest.${key} is missing`);
    }
  }
  if (problems.length > 0) return problems;

  const passphrase = NETWORK_PASSPHRASES[manifest.network];
  if (!passphrase) {
    problems.push('manifest.network is not testnet, public, or futurenet');
  } else if (manifest.networkPassphrase !== passphrase) {
    problems.push('manifest.networkPassphrase does not match manifest.network');
  }

  for (const key of ['signerPublicKey', 'assetIssuer']) {
    if (!PUBLIC_KEY_PATTERN.test(manifest[key])) {
      problems.push(`manifest.${key} is not a Stellar public key`);
    }
  }

  let horizon;
  try {
    horizon = new URL(manifest.horizonUrl);
  } catch {
    problems.push('manifest.horizonUrl is not a URL');
  }
  if (horizon && !['http:', 'https:'].includes(horizon.protocol)) {
    problems.push('manifest.horizonUrl must be HTTP(S)');
  }

  return problems;
}

const manifestPath = manifestPathFromArgs(process.argv.slice(2));
if (!manifestPath) usage('missing --manifest');

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  usage(`cannot read manifest: ${error.message}`);
}

if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
  fail(['manifest must be a JSON object']);
}

const manifestProblems = validateManifest(manifest);
if (manifestProblems.length > 0) fail(manifestProblems);

const problems = [];
for (const { key, env } of FIELDS) {
  const actual = process.env[env];
  if (typeof actual !== 'string' || actual.trim() === '') {
    problems.push(`missing: ${env}`);
  } else if (actual !== manifest[key]) {
    problems.push(`mismatch: ${env}`);
  }
}

if (problems.length > 0) fail(problems);

console.log(`network-isolation: OK (${FIELDS.length} values match the expected manifest)`);
