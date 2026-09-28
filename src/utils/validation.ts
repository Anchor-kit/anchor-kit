import type { AnchorKitConfig, NetworkConfig, SecurityConfig } from '@/types/config.ts';
import DOMPurify from 'isomorphic-dompurify';

/**
 * ValidationUtils helper object
 * Provides standard validation for common fields used in SEPs.
 */
export const ValidationUtils = {
  /**
   * Validates if the given string is a valid email address.
   * Uses a standard regex pattern for common email verification.
   *
   * @param email The email address to validate.
   * @returns true if valid, false otherwise.
   */
  isValidEmail(email: string): boolean {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
  },

  /**
   * Validates if the given string is a valid E.164 phone number.
   * Example: +1234567890
   *
   * @param phone The phone number to validate.
   * @returns true if valid, false otherwise.
   */
  isValidPhoneNumber(phone: string): boolean {
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    return phoneRegex.test(phone);
  },

  /**
   * Validates if the given string is a valid URL.
   *
   * @param url The URL string to validate.
   * @returns true if valid, false otherwise.
   */
  isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Sanitizes input string by removing HTML tags and scripts.
   * Uses DOMPurify for robust XSS prevention.
   *
   * @param input The raw input string.
   * @returns Sanitized string.
   */
  sanitizeInput(input: string): string {
    if (!input) return '';
    return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).trim();
  },

  /**
   * Validates if a string is a valid decimal number.
   *
   * @param value The string to validate.
   * @returns true if valid, false otherwise.
   */
  isDecimal(value: string): boolean {
    if (!value) return false;
    return /^-?\d+(\.\d+)?$/.test(value);
  },

  /**
   * Validates if a string is a valid Stellar public key (starting with 'G').
   *
   * @param address The address to validate.
   * @returns true if valid, false otherwise.
   */
  isValidStellarAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    // Basic format check to avoid loading full SDK if obviously wrong
    if (!/^G[A-Z2-7]{55}$/.test(address)) return false;
    return true;
  },

  /**
   * Validates database connection strings or file paths loosely.
   *
   * @param urlString The database URL.
   * @returns true if valid, false otherwise.
   */
  isValidDatabaseUrl(urlString: string): boolean {
    return DatabaseUrlSchema.isValid(urlString);
  },
};

/**
 * AssetSchema
 * Validation schema for individual Asset entries.
 */
export const AssetSchema = {
  /**
   * Validates if the given object is a valid Asset entry.
   *
   * @param asset The asset object to validate.
   * @returns true if valid, false otherwise.
   */
  isValid(asset: unknown): boolean {
    if (!asset || typeof asset !== 'object') return false;
    const a = asset as Record<string, unknown>;

    // Required fields: code, issuer
    if (typeof a.code !== 'string' || a.code.length === 0) return false;
    if (typeof a.issuer !== 'string' || !ValidationUtils.isValidStellarAddress(a.issuer)) {
      return false;
    }

    // Optional fields if provided must have correct type
    if (a.name !== undefined && typeof a.name !== 'string') return false;
    if (a.deposits_enabled !== undefined && typeof a.deposits_enabled !== 'boolean') return false;
    if (a.withdrawals_enabled !== undefined && typeof a.withdrawals_enabled !== 'boolean')
      return false;

    // min_amount, if provided, must be a finite, non-negative number
    if (a.min_amount !== undefined) {
      if (typeof a.min_amount !== 'number') return false;
      if (!Number.isFinite(a.min_amount) || a.min_amount < 0) return false;
    }

    // max_amount, if provided, must be a finite, non-negative number
    if (a.max_amount !== undefined) {
      if (typeof a.max_amount !== 'number') return false;
      if (!Number.isFinite(a.max_amount) || a.max_amount < 0) return false;
    }

    // Relationship check: min_amount must not exceed max_amount when both are present
    if (a.min_amount !== undefined && a.max_amount !== undefined && a.min_amount > a.max_amount) {
      return false;
    }

    return true;
  },
};

/**
 * DatabaseUrlSchema
 * Restricts database URLs to supported schemes (postgres, sqlite).
 */
export const DatabaseUrlSchema = {
  /**
   * Validates if the given string is a supported database URL.
   * Acceptable schemes: postgresql:, postgres:, sqlite:, file:
   *
   * @param urlString The database URL string.
   * @returns true if supported, false otherwise.
   */
  isValid(urlString: string): boolean {
    if (!urlString || typeof urlString !== 'string') return false;

    const validSchemes = ['postgresql:', 'postgres:', 'sqlite:', 'file:'];
    return validSchemes.some((scheme) => urlString.startsWith(scheme));
  },
};

/**
 * NetworkConfigSchema - Public validation helper for nested network configuration.
 */
export const NetworkConfigSchema = {
  /**
   * Validates a NetworkConfig object.
   * Throws an error if validation fails.
   *
   * @param config The NetworkConfig object to validate.
   */
  validate(config: NetworkConfig): void {
    if (!config) throw new Error('Missing required field: network');
    const validNetworks = ['public', 'testnet', 'futurenet'];
    if (!validNetworks.includes(config.network)) {
      throw new Error(
        `Invalid network: ${config.network}. Must be one of: ${validNetworks.join(', ')}`,
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
  /**
   * Validates a SecurityConfig object.
   * Throws an error if validation fails.
   *
   * @param config The SecurityConfig object to validate.
   */
  validate(config: SecurityConfig): void {
    if (!config) throw new Error('Missing required field: security');
    if (!config.sep10SigningKey)
      throw new Error('Missing required secret: security.sep10SigningKey');
    if (!config.interactiveJwtSecret)
      throw new Error('Missing required secret: security.interactiveJwtSecret');
    if (!config.distributionAccountSecret)
      throw new Error('Missing required secret: security.distributionAccountSecret');
    if (
      config.enableClientAttribution !== undefined &&
      typeof config.enableClientAttribution !== 'boolean'
    ) {
      throw new Error('security.enableClientAttribution must be a boolean');
    }
    if (
      config.verifyWebhookSignatures !== undefined &&
      typeof config.verifyWebhookSignatures !== 'boolean'
    ) {
      throw new Error('security.verifyWebhookSignatures must be a boolean');
    }
    if (
      config.authTokenLifetimeSeconds !== undefined &&
      (typeof config.authTokenLifetimeSeconds !== 'number' ||
        !Number.isFinite(config.authTokenLifetimeSeconds) ||
        config.authTokenLifetimeSeconds <= 0)
    ) {
      throw new Error('security.authTokenLifetimeSeconds must be > 0');
    }
  },
};

/**
 * AnchorKitConfigSchema - Public validation helper for the top-level configuration object.
 */
export const AnchorKitConfigSchema = {
  /**
   * Validates the complete AnchorKitConfig object.
   * Throws an error if validation fails.
   *
   * @param config The AnchorKitConfig object to validate.
   */
  validate(config: AnchorKitConfig): void {
    if (!config) throw new Error('Configuration object is missing');

    const { network, server, security, assets, framework, metadata } = config;

    // Validate Sections
    if (!network) throw new Error('Missing required top-level field: network');
    if (!server) throw new Error('Missing required top-level field: server');
    if (!security) throw new Error('Missing required top-level field: security');
    if (!assets) throw new Error('Missing required top-level field: assets');
    if (!framework) throw new Error('Missing required top-level field: framework');

    // Network Section
    NetworkConfigSchema.validate(network);

    if (server.interactiveDomain && !ValidationUtils.isValidUrl(server.interactiveDomain)) {
      throw new Error('Invalid URL format for server.interactiveDomain');
    }
    const serverErrors = validateServerConfig(server);
    if (serverErrors.length > 0) {
      throw new Error(`Invalid server configuration: ${serverErrors.join(', ')}`);
    }

    // Security Section
    SecurityConfigSchema.validate(security);

    // Assets Section
    if (!assets.assets || !Array.isArray(assets.assets) || assets.assets.length === 0) {
      throw new Error('At least one asset must be configured in assets.assets');
    }

    // Framework Database config
    if (!framework.database || !framework.database.provider || !framework.database.url) {
      throw new Error('Missing required database configuration in framework.database');
    }

    if (framework.database.provider === 'mysql') {
      throw new Error(
        'MySQL is not currently supported in this MVP. Please use "postgres" or "sqlite".',
      );
    }

    if (!ValidationUtils.isValidDatabaseUrl(framework.database.url)) {
      throw new Error('Invalid database URL format');
    }

    // Framework Numbers
    if (framework.queue?.concurrency !== undefined && framework.queue.concurrency < 1) {
      throw new Error('framework.queue.concurrency must be >= 1');
    }
    if (
      framework.watchers?.pollIntervalMs !== undefined &&
      framework.watchers.pollIntervalMs < 10
    ) {
      throw new Error('framework.watchers.pollIntervalMs must be >= 10');
    }
    if (
      framework.watchers?.transactionTimeoutMs !== undefined &&
      (typeof framework.watchers.transactionTimeoutMs !== 'number' ||
        !isFinite(framework.watchers.transactionTimeoutMs) ||
        framework.watchers.transactionTimeoutMs <= 0)
    ) {
      throw new Error('framework.watchers.transactionTimeoutMs must be a finite number > 0');
    }
    if (
      framework.watchers?.retentionDays !== undefined &&
      (typeof framework.watchers.retentionDays !== 'number' ||
        !isFinite(framework.watchers.retentionDays) ||
        framework.watchers.retentionDays <= 0)
    ) {
      throw new Error('framework.watchers.retentionDays must be a finite number > 0');
    }
    if (framework.http?.maxBodyBytes !== undefined && framework.http.maxBodyBytes < 1024) {
      throw new Error('framework.http.maxBodyBytes must be >= 1024');
    }

    if (framework.rateLimit) {
      const numericKeys = [
        'windowMs',
        'authChallengeMax',
        'authTokenMax',
        'webhookMax',
        'depositMax',
      ];
      for (const key of numericKeys) {
        const value = (framework.rateLimit as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`framework.rateLimit.${key} must be a finite number`);
        }
        if (value <= 0) {
          throw new Error('framework.rateLimit values must be > 0');
        }
      }
    }

    // Other URLs
    if (metadata?.tomlUrl && !ValidationUtils.isValidUrl(metadata.tomlUrl)) {
      throw new Error('Invalid URL format for metadata.tomlUrl');
    }
  },
};

// ---------------------------------------------------------------------------
// ServerConfigSchema
// ---------------------------------------------------------------------------

import type { ServerConfig } from '../types/config.ts';

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
