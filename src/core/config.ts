import { ConfigError } from '@/core/errors.ts';
import type { AnchorKitConfig, Asset, AnchorKitConfigSnapshot } from '@/types/config.ts';
import { AnchorKitConfigSchema, DatabaseUrlSchema } from '@/utils/validation.ts';
import { Networks } from '@stellar/stellar-sdk';
import { mergeAnchorConfigWithDefaults } from './config-defaults.ts';

/**
 * AnchorConfig
 * Central configuration manager for the Anchor-Kit SDK.
 */
export class AnchorConfig {
  private config: AnchorKitConfig;

  constructor(config: Partial<AnchorKitConfig>) {
    const merged = mergeAnchorConfigWithDefaults(config || {});
    this.config = this.deepFreeze(merged);
  }

  /**
   * Deep freeze an object to produce an immutable configuration snapshot.
   */
  private deepFreeze<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    const record = obj as Record<PropertyKey, unknown>;

    // Freeze children first
    for (const key of Reflect.ownKeys(record)) {
      const value = record[key];
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        this.deepFreeze(value);
      }
    }

    return Object.freeze(obj);
  }

  /**
   * Get a specific configuration section
   */
  public get<K extends keyof AnchorKitConfig>(key: K): AnchorKitConfig[K] {
    return this.config[key];
  }

  /**
   * Return the raw configuration object
   */
  public getConfig(): AnchorKitConfigSnapshot {
    return this.config;
  }

  /**
   * Lookup an asset by its code from the configured assets.
   * The lookup is case-sensitive.
   *
   * @param code - The exact asset code to look up (e.g., 'USDC').
   * @returns The matching Asset object, or undefined if not found.
   */
  public getAsset(code: string): Asset | undefined {
    return this.config.assets?.assets?.find((asset) => asset.code === code);
  }

  /**
   * Return required KYC fields by asset code.
   * Returns an empty list when no policy exists or the asset is unmapped.
   *
   * @param code - The exact asset code to look up.
   * @returns An array of required KYC field names.
   */
  public getKycRequiredFields(code: string): string[] {
    const fields = this.config.kycRequired?.[code];
    return Array.isArray(fields) ? fields : [];
  }

  /**
   * Compare a provided passphrase against the configured network passphrase.
   * Uses network default passphrases if an explicit one is not configured.
   *
   * @param passphrase - The passphrase to check.
   * @returns boolean - True if it matches, false otherwise.
   */
  public isNetworkPassphrase(passphrase: string): boolean {
    const configuredPassphrase = this.config.network?.networkPassphrase;

    if (configuredPassphrase) {
      return passphrase === configuredPassphrase;
    }

    const network = this.config.network?.network;
    const defaultPassphrase =
      network === 'public'
        ? Networks.PUBLIC
        : network === 'testnet'
          ? Networks.TESTNET
          : network === 'futurenet'
            ? Networks.FUTURENET
            : null;

    return defaultPassphrase ? passphrase === defaultPassphrase : false;
  }

  /**
   * Validate the configuration object for required secrets,
   * URLs, network values, and basic structural invariants.
   * Throws ConfigError if validation fails.
   */
  public validate(): void {
    try {
      AnchorKitConfigSchema.validate(this.config);
    } catch (error) {
      throw new ConfigError((error as Error).message);
    }
  }

  /**
   * Helper to check for standard HTTP/HTTPS URLs
   * @deprecated Use ValidationUtils.isValidUrl instead
   */
  private isValidUrl(urlString: string): boolean {
    try {
      if (typeof URL !== 'function') return false;
      const url = new URL(urlString);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Helper to validate database connection strings or file paths
   * @deprecated Use ValidationUtils.isValidDatabaseUrl instead
   */
  private isValidDatabaseUrl(urlString: string): boolean {
    return DatabaseUrlSchema.isValid(urlString);
  }
}
