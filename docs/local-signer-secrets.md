# Local Signer Secret Handling

This guide covers the trust boundary, configuration, and operational practices for the `LocalKeypairSigner` used by Anchor-Kit to sign Stellar transactions.

## Trust Boundary

| Concern                | Anchor-Kit Responsibility                                       | Host Responsibility                                                             |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Secret storage         | None — secret is held only in process memory after construction | Provide the secret at startup; choose source (env var, secret manager, HSM)     |
| Secret logging         | Never logs the secret or derived keypair material               | Ensure your logging pipeline never captures the secret                          |
| Transaction submission | **Does not submit** — only returns signed XDR                   | Submit signed transactions to Horizon; handle retries and sequencing            |
| Key rotation           | Not implemented — signer instance is created once at `init()`   | Plan and execute rotation; rebuild the signer with a new secret                 |
| Remote signing         | Not bundled — `StellarTransactionSigner` is an interface        | Implement a remote signer (HSM, KMS, hosted service) against the same interface |

**Key custody and access control are entirely the host's responsibility.** Anchor-Kit does not persist, rotate, or enforce policies on the distribution account secret.

## Configuration

The secret is supplied through the required `security.distributionAccountSecret` field:

```typescript
import { createAnchor } from 'anchor-kit';

const anchor = createAnchor({
  // ... other config
  security: {
    sep10SigningKey: process.env.SEP10_SIGNING_KEY!,
    interactiveJwtSecret: process.env.INTERACTIVE_JWT_SECRET!,
    distributionAccountSecret: process.env.DISTRIBUTION_ACCOUNT_SECRET!, // ← LocalKeypairSigner secret
    // ...
  },
});
```

### Supplying the Secret

Do not hardcode the secret. Load it at runtime from a source you control:

| Source                                                                          | Example                                                              |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Environment variable                                                            | `process.env.DISTRIBUTION_ACCOUNT_SECRET`                            |
| Cloud secret manager (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault) | Fetch at startup, inject into config                                 |
| HashiCorp Vault                                                                 | Read from Vault path during app initialization                       |
| File (dev only)                                                                 | `fs.readFileSync('/run/secrets/distribution-secret', 'utf8').trim()` |

The secret must be a valid Stellar Ed25519 secret seed (starts with `S` and is 56 characters). Anchor-Kit validates the format at startup and throws `CryptoError` if invalid.

### Example: Loading from a Secret Manager

```typescript
async function loadSecrets() {
  const [distributionSecret, sep10Key, jwtSecret] = await Promise.all([
    secretManager.getSecretValue('anchor/distribution-account-secret'),
    secretManager.getSecretValue('anchor/sep10-signing-key'),
    secretManager.getSecretValue('anchor/interactive-jwt-secret'),
  ]);

  return {
    distributionAccountSecret: distributionSecret,
    sep10SigningKey: sep10Key,
    interactiveJwtSecret: jwtSecret,
  };
}

const secrets = await loadSecrets();

const anchor = createAnchor({
  network: { network: 'testnet' },
  server: { homeDomain: 'anchor.example.com', interactiveDomain: 'https://anchor.example.com' },
  security: {
    ...secrets,
    webhookSecret: process.env.WEBHOOK_SECRET,
  },
  assets: { assets: [{ code: 'USDC', issuer: 'GBBD...', deposits_enabled: true }] },
  framework: {
    database: { provider: 'postgres', url: process.env.DATABASE_URL! },
    queue: { backend: 'memory', concurrency: 5 },
    watchers: { enabled: true },
  },
});
```

## Operational Practices

### 1. Never Log the Secret

The SDK does not log the secret. Ensure your application does not either:

```typescript
// BAD — secret appears in logs
console.log('Starting with distribution secret:', process.env.DISTRIBUTION_ACCOUNT_SECRET);

// GOOD — only log that initialization succeeded
logger.info('Anchor initialized', { network: 'testnet', hasDistributionSecret: true });
```

### 2. Restrict Process Access

- Run the anchor process with a dedicated service account
- Limit filesystem permissions (no access to unrelated secrets)
- Use container runtime security (read-only root filesystem, dropped capabilities)

### 3. Memory Handling

The secret is held in the `LocalKeypairSigner`'s private `#keypair` field for the process lifetime. There is no API to zero it. If your threat model requires memory-zeroing on rotation, you must replace the entire process (see Rotation below).

## Key Rotation

Anchor-Kit does not implement automatic rotation. To rotate the distribution account secret:

1. **Generate a new Stellar keypair** offline or via a secure tool:

   ```bash
   # Example using stellar-sdk CLI (not included in anchor-kit)
   npx @stellar/stellar-sdk gen-keypair
   ```

2. **Update the secret in your secret store** (Secrets Manager, Vault, etc.)

3. **Restart the anchor process** so it loads the new secret and constructs a fresh `LocalKeypairSigner`

4. **Update the on-chain distribution account** (if applicable) to use the new public key as signer

5. **Verify** the new signer works by initiating a test deposit and confirming the transaction is signed correctly

### Rotation Checklist

- [ ] New keypair generated in a secure environment
- [ ] Public key added as signer to the distribution account on-chain (if required by your setup)
- [ ] Secret stored in secret manager with restricted access
- [ ] Old secret revoked/removed from secret manager after successful rollout
- [ ] Application restarted with new secret
- [ ] End-to-end test deposit confirms signing works
- [ ] Monitoring alerts for signing failures configured

## Planning for a Remote Signer

The `LocalKeypairSigner` implements the `StellarTransactionSigner` interface:

```typescript
export interface StellarTransactionSigner {
  signTransaction(transactionXdr: string, networkPassphrase: string): Promise<string>;
}
```

A remote signer (HSM, cloud KMS, hosted signing service) can be implemented against this same interface. When you are ready to migrate:

1. **Implement the interface** with your remote signer client
2. **Pass the implementation** to Anchor-Kit instead of `LocalKeypairSigner`
3. **Remove `distributionAccountSecret`** from config (no longer needed)

### Remote Signer Interface Contract

```typescript
import type { StellarTransactionSigner } from 'anchor-kit';

class RemoteHsmSigner implements StellarTransactionSigner {
  async signTransaction(transactionXdr: string, networkPassphrase: string): Promise<string> {
    // 1. Send transactionXdr + networkPassphrase to HSM/KMS
    // 2. Receive signed XDR
    // 3. Return signed XDR
  }
}

// Usage
const anchor = createAnchor({
  // ... config without distributionAccountSecret
  // Provide custom signer via plugin or direct construction when supported
});
```

### Migration Considerations

| Aspect         | Local Signer                 | Remote Signer                         |
| -------------- | ---------------------------- | ------------------------------------- |
| Latency        | Sub-millisecond (in-process) | Network round-trip (ms to 100s of ms) |
| Availability   | Tied to process uptime       | Depends on HSM/KMS SLA                |
| Audit trail    | Application logs only        | HSM/KMS native audit logs             |
| Key extraction | Possible from memory dump    | Not possible (keys never leave HSM)   |
| Cost           | Free                         | Per-operation or dedicated hardware   |

Design your transaction flow to tolerate signer latency (e.g., async signing, queue buffering). The SDK's `signTransaction` is already `async`; no signature change is needed.

## Summary

- **Anchor-Kit** holds the secret only in memory during the process lifetime, validates format, and never logs it.
- **You** supply the secret at startup, control its source, rotate it by restarting the process, and secure the host environment.
- **Remote signing** is supported via the `StellarTransactionSigner` interface; no SDK changes are required when you implement one.
- **Key custody and access control are the host's responsibility.**
