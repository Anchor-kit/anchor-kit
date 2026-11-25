# Staging-to-production network isolation check

This guide describes the pre-deploy gate that stops a release when the configured Stellar
network, network passphrase, signer public key, asset issuer, or Horizon endpoint does not
belong to the environment being promoted to. It uses `scripts/check-network-isolation.mjs`,
which compares the deployment environment with an expected environment manifest. The script
makes no network calls, reads no secret values into its output, and exits non-zero on any
disagreement.

## Values that must agree

| Value              | Anchor-Kit configuration                 | Testnet value                                              | Failure when it drifts                                                                                                                            |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network name       | `network.network`                        | `testnet`                                                  | The SDK defaults the network passphrase from this value. A wrong name silently selects the wrong signing domain.                                  |
| Network passphrase | `network.networkPassphrase`              | `Test SDF Network ; September 2015`                        | Transactions signed for one network are invalid on the other. SEP-10 challenges are rejected and the published `stellar.toml` lies.               |
| Signer public key  | Public key of `security.sep10SigningKey` | `G...` (derived from the configured testnet key)           | Wallets verify the SEP-10 challenge against `SIGNING_KEY` in `stellar.toml`. A mismatch breaks authentication.                                    |
| Asset issuer       | `assets.assets[].issuer`                 | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | The anchor credits or redeems an asset from a different issuer. Trustlines are missing, balances do not reconcile, and funds can be unredeemable. |
| Horizon URL        | `network.horizonUrl` (set explicitly)    | `https://horizon-testnet.stellar.org`                      | Reads and writes hit the wrong ledger. A testnet submission can look successful while production receives nothing.                                |

The common cause is partial promotion: changing `network.network` to `public` while leaving
a staging passphrase, signer, issuer, or Horizon URL behind. Anchor-Kit computes the
passphrase only when `network.networkPassphrase` is unset, so a value copied into the
deployment overrides the default.

### Mapping configuration to the gate

The gate reads public values from environment variables. Populate them from the same
deployment configuration that builds `createAnchor`:

| Manifest field      | Environment variable        | Anchor-Kit source                                                   |
| ------------------- | --------------------------- | ------------------------------------------------------------------- |
| `network`           | `ANCHOR_NETWORK`            | `network.network`                                                   |
| `networkPassphrase` | `ANCHOR_NETWORK_PASSPHRASE` | `network.networkPassphrase` (or the value the SDK would default to) |
| `horizonUrl`        | `ANCHOR_HORIZON_URL`        | `network.horizonUrl`                                                |
| `signerPublicKey`   | `ANCHOR_SIGNER_PUBLIC_KEY`  | Public key derived from `security.sep10SigningKey`                  |
| `assetIssuer`       | `ANCHOR_ASSET_ISSUER`       | `assets.assets[].issuer` for the issued asset being promoted        |

The manifest holds only public identifiers and endpoints. Never add secret seeds, JWTs, or
webhook secrets to it. Derive the signer public key once during deployment setup without
printing the secret:

```ts
import { Keypair } from '@stellar/stellar-sdk';

const publicKey = Keypair.fromSecret(process.env.SEP10_SIGNING_KEY!).publicKey();
// Set ANCHOR_SIGNER_PUBLIC_KEY to publicKey for the gate. Do not log process.env.
```

## Testnet worked example

The values below are public testnet values. Replace the signer public key with your anchor's
own testnet key when you run the example; the account does not need to be funded for this
string comparison.

`deploy/testnet.manifest.json`:

```json
{
  "network": "testnet",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "horizonUrl": "https://horizon-testnet.stellar.org",
  "signerPublicKey": "GCXXAI54PB76QYBSB2XTTJJZ4NCMFAM4MK4GLZNCEGJDKNMRX3Z2I55P",
  "assetIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
}
```

Run the gate with the deployment environment:

```sh
export ANCHOR_NETWORK=testnet
export ANCHOR_NETWORK_PASSPHRASE='Test SDF Network ; September 2015'
export ANCHOR_HORIZON_URL=https://horizon-testnet.stellar.org
export ANCHOR_SIGNER_PUBLIC_KEY=GCXXAI54PB76QYBSB2XTTJJZ4NCMFAM4MK4GLZNCEGJDKNMRX3Z2I55P
export ANCHOR_ASSET_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

node scripts/check-network-isolation.mjs --manifest deploy/testnet.manifest.json
```

Expected output:

```text
network-isolation: OK (5 values match the expected manifest)
```

If the passphrase belongs to mainnet, the gate exits `1` and names the field without echoing
the value:

```text
network-isolation: FAIL
  mismatch: ANCHOR_NETWORK_PASSPHRASE
network-isolation: deployment must not proceed.
```

PowerShell users set the same variables with `$env:ANCHOR_NETWORK = 'testnet'` and run the
same `node` command.

## Production checklist (no real keys)

Do not put production keys, seeds, or tokens in the manifest or in this repository. Fill the
placeholders from the deployment's secret store and configuration, then run the gate in the
promotion job.

- [ ] `ANCHOR_NETWORK` is `public`.
- [ ] `ANCHOR_NETWORK_PASSPHRASE` is exactly `Public Global Stellar Network ; September 2015`.
- [ ] `ANCHOR_HORIZON_URL` is `https://horizon.stellar.org`, or the approved production
      endpoint with the reason for the custom URL recorded in the release ticket.
- [ ] `ANCHOR_SIGNER_PUBLIC_KEY` was derived from the production `SEP10_SIGNING_KEY` and
      matches the `SIGNING_KEY` published in the production `stellar.toml`.
- [ ] `ANCHOR_ASSET_ISSUER` is the production issuance account, matches the asset record,
      and is not a testnet issuer. `G...` and other placeholders are replaced.
- [ ] Staging and production use separate signer keys, secrets, and Horizon credentials.
- [ ] The promotion job runs the gate and has no `continue-on-error`, `|| true`, or skipped
      step for it.
- [ ] The gate output is attached to the release record before approval.
- [ ] No secret value appears in the manifest, CI logs, or the recorded evidence.

Production manifest template (replace every `G...` from the secret store; the passphrase and
Horizon URL are the public defaults):

```json
{
  "network": "public",
  "networkPassphrase": "Public Global Stellar Network ; September 2015",
  "horizonUrl": "https://horizon.stellar.org",
  "signerPublicKey": "G...",
  "assetIssuer": "G..."
}
```

## Stopping a rollout when values disagree

The gate is a fail-closed pre-deploy step. A non-zero exit must stop promotion, not warn:

```yaml
- name: Check network isolation
  run: node scripts/check-network-isolation.mjs --manifest deploy/production.manifest.json
```

1. **Before deploy.** Let the promotion job fail. Do not override, retry with changed
   environment values, or promote the same artifact. Keep the previous release serving.
2. **After deploy.** Halt promotion and traffic shifts, then roll back to the last
   known-good release. If a transaction may have been signed or submitted on the wrong
   network or with the wrong issuer, open an incident and reconcile the affected accounts
   on the intended network before resuming.
3. **Who decides.** The release manager or on-call engineer owns the stop. Only the
   incident commander may approve an exception, and the approval is recorded with the
   release; nobody may silence the gate to unblock a deploy.
4. **Evidence to record.** Commit SHA, manifest path and hash, the gate's output (field
   names only), environment name, timestamp, the rollback target, and the person who
   approved the stop or rollback. Never include secrets in the record.

The check compares configured strings only. It does not contact Horizon, prove that the
signer controls the key, or verify on-chain issuer authorization and trustlines. Follow it
with the read-only production smoke check for the release and confirm the account and asset
exist on the intended network.
