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

function isValidClientDomain(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(
      value,
    )
  );
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
  return code === code.trim() && /^[a-zA-Z0-9]{1,12}$/.test(code);
}

function isValidAssetAmount(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  if (Number.isSafeInteger(value)) return true;
  if (value > Number.MAX_SAFE_INTEGER) return false;

  // Accept decimal bounds only when 15 significant digits reproduce the same number.
  return Number(value.toPrecision(15)) === value;
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

  if (String(framework.database.provider) === 'mysql') {
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

function validateKycConfig(kyc: AnchorKitConfig['kyc']): boolean {
  if (kyc === undefined) return true;
  if (!kyc || typeof kyc !== 'object' || Array.isArray(kyc)) {
    throw new Error('kyc must be an object');
  }

  if (kyc.level !== undefined && !['none', 'basic', 'strict'].includes(kyc.level)) {
    throw new Error('kyc.level must be one of: none, basic, strict');
  }

  const booleanKeys = [
    'requireDocuments',
    'requireName',
    'requireAddress',
    'requireEmail',
    'requirePhoneNumber',
    'requireBirthDate',
  ] as const;

  for (const key of booleanKeys) {
    const value = kyc[key];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`kyc.${key} must be a boolean`);
    }
  }

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

  if (
    metadata?.documentationUrls?.apiDocs &&
    !isValidUrlString(metadata.documentationUrls.apiDocs)
  ) {
    throw new Error('Invalid URL format for metadata.documentationUrls.apiDocs');
  }

  if (
    metadata?.documentationUrls?.support &&
    !isValidUrlString(metadata.documentationUrls.support)
  ) {
    throw new Error('Invalid URL format for metadata.documentationUrls.support');
  }

  if (metadata?.documentationUrls?.terms && !isValidUrlString(metadata.documentationUrls.terms)) {
    throw new Error('Invalid URL format for metadata.documentationUrls.terms');
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

function validateMetadataFeatures(metadata: AnchorKitConfig['metadata']): boolean {
  const features = metadata?.features;
  if (!features) return true;

  for (const key of [
    'supportsInteractiveDeposits',
    'supportsInteractiveWithdrawals',
    'supportsAsyncTransactionStatus',
  ] as const) {
    const value = features[key];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`metadata.features.${key} must be a boolean`);
    }
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

function validateOperationalBooleans(operational: AnchorKitConfig['operational']): boolean {
  const webhooksEnabled = operational?.webhooksEnabled;
  if (webhooksEnabled !== undefined && typeof webhooksEnabled !== 'boolean') {
    throw new Error('operational.webhooksEnabled must be a boolean');
  }

  const corsEnabled = operational?.corsEnabled;
  if (corsEnabled !== undefined && typeof corsEnabled !== 'boolean') {
    throw new Error('operational.corsEnabled must be a boolean');
  }

  return true;
}

function validateFrameworkConfig(
  framework: AnchorKitConfig['framework'],
  server: AnchorKitConfig['server'],
  metadata: AnchorKitConfig['metadata'],
  operational: AnchorKitConfig['operational'],
): boolean {
  validateFrameworkPlugins(framework.plugins);
  validateFrameworkDatabase(framework);
  validateFrameworkNumbers(framework);
  validateFrameworkRateLimit(framework);
  validateFrameworkUrls(metadata, server, operational);
  validateMetadataFeatures(metadata);
  validateOperationalNumbers(operational);
  validateOperationalBooleans(operational);
  return true;
}

function validateFrameworkPlugins(plugins: unknown): boolean {
  if (plugins === undefined) return true;
  if (!Array.isArray(plugins)) {
    throw new Error('framework.plugins must be an array');
  }

  const seenIds = new Set<string>();
  for (const [index, plugin] of plugins.entries()) {
    if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)) {
      throw new Error(`framework.plugins[${index}] must be an object`);
    }

    const pluginId = (plugin as Record<string, unknown>).id;
    if (typeof pluginId !== 'string' || pluginId.length === 0 || pluginId.trim() !== pluginId) {
      throw new Error(`framework.plugins[${index}].id must be a non-empty trimmed string`);
    }

    if (seenIds.has(pluginId)) {
      throw new Error(`framework.plugins[${index}].id duplicates "${pluginId}"`);
    }
    seenIds.add(pluginId);
  }

  return true;
}

function validateAsset(asset: unknown): asset is Asset {
  if (!asset || typeof asset !== 'object') return false;
  const a = asset as Record<string, unknown>;

  if (!isNonEmptyString(a.code) || !isValidStellarAssetCode(a.code)) return false;
  if (a.code === 'XLM') {
    if (a.issuer !== undefined) return false;
  } else if (!isString(a.issuer) || !StrKey.isValidEd25519PublicKey(a.issuer)) {
    return false;
  }

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
    if (!emailRegex.test(email)) return false;

    const [localPart, domain] = email.split('@');
    if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
      return false;
    }

    return !domain.startsWith('.') && !domain.endsWith('.') && !domain.includes('..');
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
    // Account addresses may be classic Ed25519 keys or muxed account addresses.
    return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidMed25519PublicKey(address);
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
type RequiredSecuritySecret =
  | 'sep10SigningKey'
  | 'interactiveJwtSecret'
  | 'distributionAccountSecret';

type SecurityConfigSchemaDefinition = Record<RequiredSecuritySecret, SchemaField> & {
  validate(config: SecurityConfig): void;
};

export const SecurityConfigSchema: SecurityConfigSchemaDefinition = {
  sep10SigningKey: {
    type: 'string',
    required: true,
    description: 'SEP-10 server signing secret.',
    validate: (value) => typeof value === 'string' && value.trim().length > 0,
  },
  interactiveJwtSecret: {
    type: 'string',
    required: true,
    description: 'Secret used to sign interactive JWTs.',
    validate: (value) => typeof value === 'string' && value.trim().length > 0,
  },
  distributionAccountSecret: {
    type: 'string',
    required: true,
    description: 'Distribution account secret.',
    validate: (value) => typeof value === 'string' && value.trim().length > 0,
  },
  validate(config: SecurityConfig): void {
    if (!config) throw new Error('Missing required field: security');
    if (!SecurityConfigSchema.sep10SigningKey.validate(config.sep10SigningKey))
      throw new Error('Missing required secret: security.sep10SigningKey');
    if (!SecurityConfigSchema.interactiveJwtSecret.validate(config.interactiveJwtSecret))
      throw new Error('Missing required secret: security.interactiveJwtSecret');
    if (!SecurityConfigSchema.distributionAccountSecret.validate(config.distributionAccountSecret))
      throw new Error('Missing required secret: security.distributionAccountSecret');
    if (
      config.enableClientAttribution !== undefined &&
      typeof config.enableClientAttribution !== 'boolean'
    ) {
      throw new Error('security.enableClientAttribution must be a boolean');
    }
    if (config.clientDomain !== undefined && !isValidClientDomain(config.clientDomain)) {
      throw new Error(
        'security.clientDomain must be a valid DNS hostname of at most 64 characters',
      );
    }
    if (
      config.clientDomainSigningKey !== undefined &&
      !ValidationUtils.isValidStellarAddress(config.clientDomainSigningKey)
    ) {
      throw new Error('security.clientDomainSigningKey must be a valid Stellar public key');
    }
    if (config.enableClientAttribution) {
      if (!config.clientDomain) {
        throw new Error(
          'security.clientDomain is required when security.enableClientAttribution is true',
        );
      }
      if (!config.clientDomainSigningKey) {
        throw new Error(
          'security.clientDomainSigningKey is required when security.enableClientAttribution is true',
        );
      }
    }
    if (
      config.verifyWebhookSignatures !== undefined &&
      typeof config.verifyWebhookSignatures !== 'boolean'
    ) {
      throw new Error('security.verifyWebhookSignatures must be a boolean');
    }
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
  if (security.enableClientAttribution) {
    const expectedOrigin = `https://${security.clientDomain?.toLowerCase()}`;
    if (!Array.isArray(server.corsOrigins) || !server.corsOrigins.includes(expectedOrigin)) {
      throw new Error(
        `server.corsOrigins must include "${expectedOrigin}" when security.enableClientAttribution is true`,
      );
    }
  }
  validateKycConfig(config.kyc);

  for (const key of ['host', 'corsOrigins'] as const) {
    const value = server[key];
    if (value !== undefined && value !== null && !ServerConfigSchema[key].validate(value)) {
      throw new Error(`server.${key}: invalid value`);
    }
  }

  for (const [protocol, value] of Object.entries(metadata?.protocols ?? {})) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`metadata.protocols.${protocol} must be a boolean`);
    }
  }

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
        `Invalid asset at index ${i}${codeStr}: native XLM must omit asset.issuer and issued assets must provide a valid Stellar public key issuer.`,
      );
    }
    const assetCode = asset.code;
    if (seenCodes.has(assetCode)) {
      throw new Error(`Duplicate asset code detected: ${assetCode}`);
    }
    seenCodes.add(assetCode);
  }

  validateFrameworkConfig(framework, server, metadata, operational);
  const serverErrors = validateServerConfig(server);
  if (serverErrors.length > 0) {
    throw new Error(`Invalid server configuration: ${serverErrors.join(', ')}`);
  }
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
    validate: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
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
