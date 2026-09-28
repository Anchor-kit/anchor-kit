import type { AnchorKitConfig, NetworkConfig } from '@/types/config.ts';
import { Networks } from '@stellar/stellar-sdk';

const defaultNetworkPassphrases: Record<string, string> = {
  public: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

function buildNetworkConfig(input: Partial<AnchorKitConfig>): NetworkConfig | undefined {
  const hasNetworkProp = Object.prototype.hasOwnProperty.call(input, 'network');
  const networkInput = input.network as Partial<NetworkConfig> | undefined;

  if (hasNetworkProp && typeof networkInput === 'undefined') {
    return undefined;
  }

  const network = networkInput?.network || 'testnet';

  return {
    network,
    horizonUrl: networkInput?.horizonUrl,
    networkPassphrase: networkInput?.networkPassphrase || defaultNetworkPassphrases[network],
  };
}

function buildOperationalConfig(input: Partial<AnchorKitConfig>): AnchorKitConfig['operational'] {
  const operationalInput = input.operational;

  return {
    name: operationalInput?.name,
    website: operationalInput?.website,
    supportEmail: operationalInput?.supportEmail,
    address: operationalInput?.address,
    transactionRetentionDays: operationalInput?.transactionRetentionDays ?? 90,
  } as AnchorKitConfig['operational'];
}

function buildFrameworkConfig(
  input: Partial<AnchorKitConfig>,
): AnchorKitConfig['framework'] | undefined {
  if (!input.framework) {
    return undefined;
  }

  return {
    ...input.framework,
    queue: {
      backend: input.framework.queue?.backend ?? 'memory',
      concurrency: input.framework.queue?.concurrency ?? 1,
    },
    watchers: {
      enabled: input.framework.watchers?.enabled ?? true,
      pollIntervalMs: input.framework.watchers?.pollIntervalMs ?? 15000,
      transactionTimeoutMs: input.framework.watchers?.transactionTimeoutMs ?? 300000,
      retentionDays: input.framework.watchers?.retentionDays ?? 90,
    },
    http: {
      maxBodyBytes: input.framework.http?.maxBodyBytes ?? 1024 * 1024,
    },
    rateLimit: {
      windowMs: input.framework.rateLimit?.windowMs ?? 60000,
      authChallengeMax: input.framework.rateLimit?.authChallengeMax ?? 30,
      authTokenMax: input.framework.rateLimit?.authTokenMax ?? 30,
      webhookMax: input.framework.rateLimit?.webhookMax ?? 120,
      depositMax: input.framework.rateLimit?.depositMax ?? 60,
      trustForwardedFor: input.framework.rateLimit?.trustForwardedFor ?? false,
    },
  };
}

/**
 * Merge a partial AnchorKitConfig with the framework defaults used by the SDK.
 * Required top-level sections are preserved as-is so validation can report
 * missing values instead of silently fabricating them.
 */
export function mergeAnchorConfigWithDefaults(input: Partial<AnchorKitConfig>): AnchorKitConfig {
  return {
    network: buildNetworkConfig(input),
    server: input.server,
    security: input.security,
    assets: input.assets,
    kyc: input.kyc,
    kycRequired: input.kycRequired,
    operational: buildOperationalConfig(input),
    metadata: input.metadata,
    framework: buildFrameworkConfig(input),
    webhooks: input.webhooks,
  } as AnchorKitConfig;
}
