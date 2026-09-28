import type { AnchorKitConfig, Asset, NetworkConfig, SecurityConfig } from '@/types/config.ts';
import { StrKey } from '@stellar/stellar-sdk';
import DOMPurify from 'isomorphic-dompurify';
import type { ServerConfig } from '../types/config.ts';

const validNetworkNames = ['public', 'testnet', 'futurenet'] as const;
const supportedDatabaseSchemes = ['postgresql:', 'postgres:', 'sqlite:', 'file:'] as const;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isFinitePositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidIso4217CurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function isSafePositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value) && value > 0
  );
}

function isValidUrlString(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDatabaseUrlString(urlString: unknown): boolean {
  return (
    isString(urlString) &&
    supportedDatabaseSchemes.some(
      (scheme) => urlString.startsWith(scheme) && urlString.slice(scheme.length).trim().length > 0,
    )
  );
}

function isValidStellarAssetCode(code: string): boolean {
  return /^[a-zA-Z0-9]{1,12}$/.test(code);
}

function isValidAssetAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateAssetAmountRange(asset: { min_amount?: number; max_amount?: number }): boolean {
  if (asset.min_amount !== undefined && asset.max_amount !== undefined) {
    return asset.min_amount <= asset.max_amount;
  }

  return true;
}

function validateFrameworkDatabase(framework: AnchorKitConfig['framework']): boolean {
  if (!framework?.database || !framework.database.provider || !framework.database.url) {
    throw new Error('Missing required database configuration in framework.database');
  }

  if (framework.database.provider === 'mysql') {
    throw new Error(
      'MySQL is not currently supported in this MVP. Please use "postgres" or "sqlite".',
    );
  }

  if (!DatabaseUrlSchema.isValid(framework.database.url)) {
    throw new Error('Invalid database URL format');
  }

  // Match URL scheme to configured provider
  const url = framework.database.url;
  const provider = framework.database.provider;
  const isSqliteUrl = url.startsWith('sqlite:') || url.startsWith('file:');
  const isPostgresUrl = url.startsWith('postgresql:') || url.startsWith('postgres:');

  if (provider === 'sqlite' && !isSqliteUrl) {
    throw new Error(
      `Database URL scheme does not match provider "sqlite". Expected "sqlite:" or "file:" scheme, got: ${url.slice(0, url.indexOf(':') + 1)}`,
    );
  }

  if (provider === 'postgres' && !isPostgresUrl) {
    throw new Error(
      `Database URL scheme does not match provider "postgres". Expected "postgres:" or "postgresql:" scheme, got: ${url.slice(0, url.indexOf(':') + 1)}`,
    );
  }

  return true;
}

function validateFrameworkNumbers(framework: AnchorKitConfig['framework']): boolean {
  if (
    framework.queue?.concurrency !== undefined &&
    (!Number.isInteger(framework.queue.concurrency) || framework.queue.concurrency < 1)
  ) {
    throw new Error('framework.queue.concurrency must be a finite integer >= 1');
  }

  const watchersEnabled = framework.watchers?.enabled;
  if (watchersEnabled !== undefined && typeof watchersEnabled !== 'boolean') {
    throw new Error('framework.watchers.enabled must be a boolean');
  }

  const pollIntervalMs = framework.watchers?.pollIntervalMs;
  if (
    pollIntervalMs !== undefined &&
    (typeof pollIntervalMs !== 'number' || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 10)
  ) {
    throw new Error('framework.watchers.pollIntervalMs must be a finite integer >= 10');
  }

  if (
    framework.watchers?.transactionTimeoutMs !== undefined &&
    !isPositiveSafeInteger(framework.watchers.transactionTimeoutMs)
  ) {
    throw new Error('framework.watchers.transactionTimeoutMs must be a positive safe integer');
  }

  if (
    framework.watchers?.retentionDays !== undefined &&
    !isFinitePositiveNumber(framework.watchers.retentionDays)
  ) {
    throw new Error('framework.watchers.retentionDays must be a finite number > 0');
  }

  if (
    framework.http?.maxBodyBytes !== undefined &&
    (typeof framework.http.maxBodyBytes !== 'number' ||
      !Number.isFinite(framework.http.maxBodyBytes) ||
      !Number.isInteger(framework.http.maxBodyBytes) ||
      framework.http.maxBodyBytes < 1024)
  ) {
    throw new Error('framework.http.maxBodyBytes must be a finite integer >= 1024');
  }

  return true;
}

function validateFrameworkRateLimit(framework: AnchorKitConfig['framework']): boolean {
  if (!framework.rateLimit) {
    return true;
  }

  const numericKeys = [
    'windowMs',
    'authChallengeMax',
    'authTokenMax',
    'webhookMax',
    'depositMax',
  ] as const;

  for (const key of numericKeys) {
    const value = framework.rateLimit[key];
    if (value === undefined) continue;
    if (!isPositiveSafeInteger(value)) {
      throw new Error(`framework.rateLimit.${key} must be a positive safe integer`);
    }
  }

  const trustForwardedFor = framework.rateLimit.trustForwardedFor;
  if (trustForwardedFor !== undefined && typeof trustForwardedFor !== 'boolean') {
    throw new Error('framework.rateLimit.trustForwardedFor must be a boolean');
  }

  return true;
}

function validateFrameworkUrls(
  metadata: AnchorKitConfig['metadata'],
  server: AnchorKitConfig['server'],
  operational: AnchorKitConfig['operational'],
): boolean {
  if (server.interactiveDomain && !isValidUrlString(server.interactiveDomain)) {
    throw new Error('Invalid URL format for server.interactiveDomain');
  }

  if (metadata?.tomlUrl && !isValidUrlString(metadata.tomlUrl)) {
    throw new Error('Invalid URL format for metadata.tomlUrl');
  }

  if (operational?.website && !isValidUrlString(operational.website)) {
    throw new Error('Invalid URL format for operational.website');
  }

  if (
    operational?.supportEmail !== undefined &&
    !ValidationUtils.isValidEmail(operational.supportEmail)
  ) {
    throw new Error('Invalid email format for operational.supportEmail');
  }

  return true;
}

function validateOperationalNumbers(operational: AnchorKitConfig['operational']): boolean {
  const retentionDays = operational?.transactionRetentionDays;
  if (retentionDays !== undefined && (!Number.isSafeInteger(retentionDays) || retentionDays <= 0)) {
    throw new Error('operational.transactionRetentionDays must be a positive safe integer');
  }

  return true;
}

function validateFrameworkConfig(
  framework: AnchorKitConfig['framework'],
  server: AnchorKitConfig['server'],
  metadata: AnchorKitConfig['metadata'],
  operational: AnchorKitConfig['operational'],
): boolean {
  validateFrameworkDatabase(framework);
  validateFrameworkNumbers(framework);
  validateFrameworkRateLimit(framework);
  validateFrameworkUrls(metadata, server, operational);
  validateOperationalNumbers(operational);
  return true;
}

function validateAsset(asset: unknown): asset is Asset {
  if (!asset || typeof asset !== 'object') return false;
  const a = asset as Record<string, unknown>;

  if (!isNonEmptyString(a.code) || !isValidStellarAssetCode(a.code)) return false;
  if (!isString(a.issuer) || !ValidationUtils.isValidStellarAddress(a.issuer)) return false;

  if (a.name !== undefined && !isString(a.name)) return false;
  if (a.deposits_enabled !== undefined && typeof a.deposits_enabled !== 'boolean') return false;
  if (a.withdrawals_enabled !== undefined && typeof a.withdrawals_enabled !== 'boolean')
    return false;

  if (a.min_amount !== undefined && !isValidAssetAmount(a.min_amount)) return false;
  if (a.max_amount !== undefined && !isValidAssetAmount(a.max_amount)) return false;

  return validateAssetAmountRange(a as { min_amount?: number; max_amount?: number });
}

/**
 * ValidationUtils helper object
 * Provides standard validation for common fields used in SEPs.
 */
export const ValidationUtils = {
  isValidEmail(email: string): boolean {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
  },

  isValidPhoneNumber(phone: string): boolean {
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    return phoneRegex.test(phone);
  },

  isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },

  sanitizeInput(input: string): string {
    if (!input) return '';
    return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).trim();
  },

  isDecimal(value: string): boolean {
    if (!value) return false;
    return /^-?\d+(\.\d+)?$/.test(value);
  },

  isValidStellarAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    // The shape regex alone lets 56-character values with an invalid StrKey
    // checksum through, so verify the checksum via the Stellar SDK as well.
    return StrKey.isValidEd25519PublicKey(address);
  },

  isValidDatabaseUrl(urlString: string): boolean {
    return DatabaseUrlSchema.isValid(urlString);
  },
};

/**
 * AssetSchema
 * Validation schema for individual Asset entries.
 */
export const AssetSchema = {
  isValid(asset: unknown): boolean {
    return validateAsset(asset);
  },
};

/**
 * DatabaseUrlSchema
 * Restricts database URLs to supported schemes (postgres, sqlite).
 */
export const DatabaseUrlSchema = {
  isValid(urlString: string): boolean {
    return isValidDatabaseUrlString(urlString);
  },
};

/**
 * NetworkConfigSchema - Public validation helper for nested network configuration.
 */
export const NetworkConfigSchema = {
  validate(config: NetworkConfig): void {
    if (!config) throw new Error('Missing required field: network');
    if (!validNetworkNames.includes(config.network)) {
      throw new Error(
        `Invalid network: ${config.network}. Must be one of: ${validNetworkNames.join(', ')}`,
      );
    }
    if (config.horizonUrl && !ValidationUtils.isValidUrl(config.horizonUrl)) {
      throw new Error('Invalid URL format for network.horizonUrl');
    }
    if (config.networkPassphrase !== undefined && config.networkPassphrase !== null) {
      if (typeof config.networkPassphrase !== 'string' || config.networkPassphrase.length === 0) {
        throw new Error('Invalid network.networkPassphrase: must be a non-empty string');
      }
    }
  },
};

/**
 * SecurityConfigSchema - Public validation helper for security configuration.
 */
export const SecurityConfigSchema = {
  validate(config: SecurityConfig): void {
    if (!config) throw new Error('Missing required field: security');
    if (!config.sep10SigningKey)
      throw new Error('Missing required secret: security.sep10SigningKey');
    if (!config.interactiveJwtSecret)
      throw new Error('Missing required secret: security.interactiveJwtSecret');
    if (!config.distributionAccountSecret)
      throw new Error('Missing required secret: security.distributionAccountSecret');
    if (
      config.challengeExpirationSeconds !== undefined &&
      !isSafePositiveInteger(config.challengeExpirationSeconds)
    ) {
      throw new Error('security.challengeExpirationSeconds must be a safe positive integer');
    }
    if (
      config.authTokenLifetimeSeconds !== undefined &&
      !isSafePositiveInteger(config.authTokenLifetimeSeconds)
    ) {
      throw new Error('security.authTokenLifetimeSeconds must be a safe positive integer');
    }
  },
};

/**
 * AnchorKitConfigSchema - Public validation helper for the top-level configuration object.
 */
export const AnchorKitConfigSchema = {
  validate(config: AnchorKitConfig): void {
    validateAnchorKitConfig(config);
  },
};

function validateKycConfig(kyc: AnchorKitConfig['kyc']): boolean {
  if (!kyc) return true;

  const { minAge, maxAge } = kyc;

  if (minAge !== undefined) {
    if (
      typeof minAge !== 'number' ||
      !Number.isFinite(minAge) ||
      minAge < 0 ||
      !Number.isInteger(minAge)
    ) {
      throw new Error('kyc.minAge must be a finite non-negative integer');
    }
  }

  if (maxAge !== undefined) {
    if (
      typeof maxAge !== 'number' ||
      !Number.isFinite(maxAge) ||
      maxAge < 0 ||
      !Number.isInteger(maxAge)
    ) {
      throw new Error('kyc.maxAge must be a finite non-negative integer');
    }
  }

  if (minAge !== undefined && maxAge !== undefined && minAge > maxAge) {
    throw new Error('kyc.minAge must be less than or equal to kyc.maxAge');
  }

  return true;
}

function validateAnchorKitConfig(config: AnchorKitConfig): boolean {
  if (!config) throw new Error('Configuration object is missing');

  const { network, server, security, assets, framework, metadata, operational, kyc } = config;

  if (!network) throw new Error('Missing required top-level field: network');
  if (!server) throw new Error('Missing required top-level field: server');
  if (!security) throw new Error('Missing required top-level field: security');
  if (!assets) throw new Error('Missing required top-level field: assets');
  if (!framework) throw new Error('Missing required top-level field: framework');

  NetworkConfigSchema.validate(network);
  SecurityConfigSchema.validate(security);

  if (!assets.assets || !Array.isArray(assets.assets) || assets.assets.length === 0) {
    throw new Error('At least one asset must be configured in assets.assets');
  }

  if (assets.defaultCurrency !== undefined && !isValidIso4217CurrencyCode(assets.defaultCurrency)) {
    throw new Error('assets.defaultCurrency must be a three-letter uppercase ISO 4217 code');
  }

  const seenCodes = new Set<string>();
  for (let i = 0; i < assets.assets.length; i++) {
    const asset = assets.assets[i];
    if (!AssetSchema.isValid(asset)) {
      const code = (asset as unknown as Record<string, unknown>)?.code;
      const codeStr = typeof code === 'string' && code ? ` (code: "${code}")` : '';
      throw new Error(
        `Invalid asset at index ${i}${codeStr}: asset.code must be a non-empty string and asset.issuer must be a valid Stellar public key.`,
      );
    }
    const code = asset.code;
    if (seenCodes.has(code)) {
      throw new Error(`Duplicate asset code detected: ${code}`);
    }
    seenCodes.add(code);
  }

  validateFrameworkConfig(framework, server, metadata, operational);
  validateKycConfig(kyc);

  return true;
}

// ---------------------------------------------------------------------------
// ServerConfigSchema
// ---------------------------------------------------------------------------

export interface SchemaField {
  type: string;
  required: boolean;
  description: string;
  validate: (value: unknown) => boolean;
}

/**
 * ServerConfigSchema
 * Runtime schema for validating partial ServerConfig objects.
 *
 * @example
 * import { ServerConfigSchema } from 'anchor-kit';
 * ServerConfigSchema.port.validate(3000); // true
 */
export const ServerConfigSchema: Record<keyof Required<ServerConfig>, SchemaField> = {
  host: {
    type: 'string',
    required: false,
    description: 'Server host address. Defaults to 0.0.0.0',
    validate: (value) => typeof value === 'string' && value.length > 0,
  },
  port: {
    type: 'number',
    required: false,
    description: 'Server port number. Defaults to 3000.',
    validate: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535,
  },
  debug: {
    type: 'boolean',
    required: false,
    description: 'Enable debug mode for verbose logging. Defaults to false.',
    validate: (value) => typeof value === 'boolean',
  },
  interactiveDomain: {
    type: 'string',
    required: false,
    description: 'Interactive web portal domain/URL for SEP-24 flows.',
    validate: (value) => {
      if (typeof value !== 'string' || value.length === 0) return false;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
  },
  corsOrigins: {
    type: 'string[]',
    required: false,
    description: 'Allowed origins for CORS.',
    validate: (value) =>
      Array.isArray(value) &&
      value.every((origin) => typeof origin === 'string' && origin.length > 0),
  },
  requestTimeout: {
    type: 'number',
    required: false,
    description: 'Request timeout in milliseconds. Defaults to 30000.',
    validate: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  },
};

/**
 * validateServerConfig
 * Validates a partial ServerConfig object. Returns array of error strings.
 *
 * @example
 * validateServerConfig({ port: -1 }); // ['port: invalid value']
 */
export function validateServerConfig(config: Partial<ServerConfig>): string[] {
  const errors: string[] = [];
  for (const [key, field] of Object.entries(ServerConfigSchema) as [
    keyof ServerConfig,
    SchemaField,
  ][]) {
    const value = config[key];
    if (value === undefined || value === null) {
      if (field.required) errors.push(`${key}: is required`);
      continue;
    }
    if (!field.validate(value)) errors.push(`${key}: invalid value`);
  }
  return errors;
}
