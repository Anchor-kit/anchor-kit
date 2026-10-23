import { ConfigError } from './errors.ts';
import type {
  AnchorKitConfig,
  Asset,
  AnchorKitConfigSnapshot,
  KycPolicyResolution,
  KycRequiredField,
} from '@/types/config.ts';
import { AnchorKitConfigSchema, DatabaseUrlSchema } from '../utils/validation.ts';
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
   * Return resolved KYC fields for an asset, including global KYC flags.
   *
   * @param code - The exact asset code to look up.
   * @returns An array of required KYC field names.
   */
  public getKycRequiredFields(code: string): string[] {
    return this.resolveKycRequirements(code).requiredFields;
  }

  /**
   * Resolve asset-specific KYC fields together with explicitly enabled global KYC flags.
   *
   * With no KYC config, absent asset fields resolve to no requirements. When KYC config
   * exists, its documented flag defaults apply. Asset fields and flags are combined in
   * stable order with duplicates removed. A `none` level overrides fields for the asset;
   * malformed policy values are returned in `errors`.
   *
   * @param code - The exact asset code to resolve.
   */
  public resolveKycRequirements(code: string): KycPolicyResolution {
    const errors: string[] = [];
    const fields: KycRequiredField[] = [];
    const seen = new Set<string>();
    const policies: unknown = this.config.kycRequired;

    if (
      policies !== undefined &&
      (!policies || typeof policies !== 'object' || Array.isArray(policies))
    ) {
      return {
        requiredFields: [],
        errors: ['kycRequired must be an object mapping asset codes to field arrays'],
      };
    }

    const configuredFields: unknown = this.config.kycRequired?.[code];

    if (configuredFields !== undefined && !Array.isArray(configuredFields)) {
      errors.push(`kycRequired.${code} must be an array of non-empty strings`);
    } else if (Array.isArray(configuredFields)) {
      configuredFields.forEach((field: unknown, index: number) => {
        if (typeof field !== 'string' || field.trim().length === 0) {
          errors.push(`kycRequired.${code}[${index}] must be a non-empty string`);
          return;
        }

        const normalizedField = field.trim();
        if (!seen.has(normalizedField)) {
          seen.add(normalizedField);
          fields.push(normalizedField);
        }
      });
    }

    const configuredKyc: unknown = this.config.kyc;
    if (
      configuredKyc !== undefined &&
      (!configuredKyc || typeof configuredKyc !== 'object' || Array.isArray(configuredKyc))
    ) {
      errors.push('kyc must be an object');
      return { requiredFields: fields, errors };
    }

    const kyc = this.config.kyc;
    if (!kyc) {
      return { requiredFields: fields, errors };
    }

    if (
      kyc.level !== undefined &&
      (typeof kyc.level !== 'string' || !['none', 'basic', 'strict'].includes(kyc.level))
    ) {
      errors.push('kyc.level must be one of: none, basic, strict');
    }

    if (kyc.level === 'none') {
      return { requiredFields: [], errors };
    }

    const flagFields: Array<
      [
        keyof Pick<
          NonNullable<AnchorKitConfig['kyc']>,
          | 'requireDocuments'
          | 'requireName'
          | 'requireAddress'
          | 'requireEmail'
          | 'requirePhoneNumber'
          | 'requireBirthDate'
        >,
        boolean,
        KycRequiredField[],
      ]
    > = [
      ['requireDocuments', true, ['documents']],
      ['requireName', true, ['first_name', 'last_name']],
      ['requireAddress', false, ['address']],
      ['requireEmail', true, ['email_address']],
      ['requirePhoneNumber', false, ['phone_number']],
      ['requireBirthDate', false, ['birth_date']],
    ];

    for (const [flag, defaultRequired, requiredFields] of flagFields) {
      const configuredFlag: unknown = kyc[flag];
      if (configuredFlag !== undefined && typeof configuredFlag !== 'boolean') {
        errors.push(`kyc.${flag} must be a boolean`);
        continue;
      }
      if ((configuredFlag ?? defaultRequired) !== true) continue;
      for (const field of requiredFields) {
        if (!seen.has(field)) {
          seen.add(field);
          fields.push(field);
        }
      }
    }

    return { requiredFields: fields, errors };
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
      const kycRequired: unknown = this.config.kycRequired;
      if (
        kycRequired !== undefined &&
        (!kycRequired || typeof kycRequired !== 'object' || Array.isArray(kycRequired))
      ) {
        throw new Error('kycRequired must be an object mapping asset codes to field arrays');
      }
      for (const code of Object.keys(this.config.kycRequired ?? {})) {
        const { errors } = this.resolveKycRequirements(code);
        if (errors.length > 0) {
          throw new Error(errors.join('; '));
        }
      }
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
