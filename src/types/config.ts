/**
 * Configuration Types for Anchor-Kit
 * Defines the complete configuration interface required to initialize an Anchor-Kit instance
 */

/**
 * Stellar network selection
 */
export type StellarNetwork = 'public' | 'testnet' | 'futurenet';

/**
 * KYC (Know-Your-Customer) level enforcement
 */
export type KycLevel = 'none' | 'basic' | 'strict';

/**
 * Postal address for operational metadata
 */
export interface OperationalAddress {
  street?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
}

/**
 * Network configuration - Stellar network and connection settings
 */
export interface NetworkConfig {
  /**
   * Stellar network to use
   * @required
   */
  network: StellarNetwork;

  /**
   * Horizon API base URL
   * Defaults to official Stellar Horizon servers if not specified
   * @optional
   */
  horizonUrl?: string;

  /**
   * Network passphrase for transaction signing
   * Automatically set based on network selection if not provided
   * @optional
   */
  networkPassphrase?: string;
}

/**
 * Server configuration - HTTP server and hosting settings
 */
export interface ServerConfig {
  /**
   * Server host address
   * @optional - defaults to '0.0.0.0'
   */
  host?: string;

  /**
   * Server port
   * @optional - defaults to 3000
   */
  port?: number;

  /**
   * Enable debug mode for verbose logging
   * @optional - defaults to false
   */
  debug?: boolean;

  /**
   * Interactive web portal domain/URL
   * Used for SEP-24 interactive flows
   * @optional
   */
  interactiveDomain?: string;

  /**
   * Allowed origins for CORS
   * @optional
   */
  corsOrigins?: string[];

  /**
   * Request timeout in milliseconds
   * @optional - defaults to 30000
   */
  requestTimeout?: number;
}

/**
 * Security configuration - Authentication and secret management
 */
export interface SecurityConfig {
  /**
   * SEP-10 challenge signing key (private key hex or base64)
   * Used to sign SEP-10 authentication challenges
   * @required
   */
  sep10SigningKey: string;

  /**
   * JWT secret for interactive flow tokens
   * Used to sign and verify SEP-24 interactive flow tokens
   * @required
   */
  interactiveJwtSecret: string;

  /**
   * Distribution account secret key
   * Used to sign and submit Stellar transactions for asset distribution
   * @required
   */
  distributionAccountSecret: string;

  /**
   * Challenge transaction time limit in seconds
   * @optional - defaults to 300
   */
  challengeExpirationSeconds?: number;

  /**
   * Enable client attribution for SEP-10
   * Requires client domain verification
   * @optional - defaults to false
   */
  enableClientAttribution?: boolean;

  /**
   * Webhook secret for payment rail providers
   * Used to verify webhook signatures from Flutterwave, Paystack, etc.
   * @optional
   */
  webhookSecret?: string;

  /**
   * Enable signature verification for webhooks
   * @optional - defaults to true
   */
  verifyWebhookSignatures?: boolean;

  /**
   * Auth token lifetime in seconds
   * @optional - defaults to 3600 (1 hour)
   */
  authTokenLifetimeSeconds?: number;
}

/**
 * Asset configuration - Supported Stellar assets
 */
export interface Asset {
  /**
   * Asset code (e.g., 'USDC', 'USDT')
   */
  code: string;

  /**
   * Asset issuer public key
   */
  issuer: string;

  /**
   * Human-readable name
   * @optional
   */
  name?: string;

  /**
   * Whether deposits are supported for this asset
   * @optional - defaults to true
   */
  deposits_enabled?: boolean;

  /**
   * Whether withdrawals are supported for this asset
   * @optional - defaults to true
   */
  withdrawals_enabled?: boolean;

  /**
   * Minimum deposit amount (in the asset's native units)
   * @optional
   */
  min_amount?: number;

  /**
   * Maximum deposit amount (in the asset's native units)
   * @optional
   */
  max_amount?: number;
}

/**
 * Assets configuration - Manages supported Stellar assets
 */
export interface AssetsConfig {
  /**
   * Array of supported assets
   * @required - at least one asset must be configured
   */
  assets: Asset[];

  /**
   * Default fiat currency code (ISO 4217).
   * Only standard three-letter uppercase fiat codes are accepted; custom or non-fiat values are not allowed.
   * @optional
   */
  defaultCurrency?: string;

  /**
   * Fiat to asset mapping for rail integration
   * Maps fiat currency codes to Stellar asset codes
   * @optional
   */
  assetMapping?: Record<string, string>;
}

/**
 * KYC configuration - Customer verification settings
 */
export interface KycConfig {
  /**
   * Required KYC level
   * @optional - defaults to 'basic'
   */
  level?: KycLevel;

  /**
   * Collect customer identity documents
   * @optional - defaults to true
   */
  requireDocuments?: boolean;

  /**
   * Require verified name
   * @optional - defaults to true
   */
  requireName?: boolean;

  /**
   * Require verified address
   * @optional - defaults to false
   */
  requireAddress?: boolean;

  /**
   * Require verified email
   * @optional - defaults to true
   */
  requireEmail?: boolean;

  /**
   * Require verified phone number
   * @optional - defaults to false
   */
  requirePhoneNumber?: boolean;

  /**
   * Require birth date
   * @optional - defaults to false
   */
  requireBirthDate?: boolean;

  /**
   * Maximum age allowed for applicants
   * @optional
   */
  maxAge?: number;

  /**
   * Minimum age required for applicants
   * @optional - defaults to 18
   */
  minAge?: number;
}

/**
 * Operational configuration - Deployment and operational settings
 */
export interface OperationalConfig {
  /**
   * Anchor's legal entity name
   * @optional
   */
  name?: string;

  /**
   * Official website URL
   * @optional
   */
  website?: string;

  /**
   * Support contact email
   * @optional
   */
  supportEmail?: string;

  /**
   * Enable webhook event processing
   * @optional
   */
  webhooksEnabled?: boolean;

  /**
   * Enable CORS for HTTP endpoints
   * @optional
   */
  corsEnabled?: boolean;

  /**
   * Operational address
   * @optional
   */
  address?: OperationalAddress;

  /**
   * Transaction retention period in days
   * @optional - defaults to 90
   */
  transactionRetentionDays?: number;
}

/**
 * Metadata configuration - SEP info and protocol metadata
 */
export interface MetadataConfig {
  /**
   * SEP-1 TOML file URL or path
   * Contains TOML configuration for the anchor
   * @optional
   */
  tomlUrl?: string;

  /**
   * Protocol versions supported
   * @optional
   */
  protocols?: {
    sep10?: boolean;
    sep24?: boolean;
    sep6?: boolean;
    sep31?: boolean;
  };

  /**
   * Feature flags for capabilities
   * @optional
   */
  features?: {
    supportsInteractiveDeposits?: boolean;
    supportsInteractiveWithdrawals?: boolean;
    supportsAsyncTransactionStatus?: boolean;
  };

  /**
   * Documentation reference URLs
   * @optional
   */
  documentationUrls?: {
    apiDocs?: string;
    support?: string;
    terms?: string;
  };
}

/**
 * Framework configuration - SDK behavior and integrations
 */
export interface FrameworkConfig {
  /**
   * Database adapter for persistent storage
   * @required
   */
  database: {
    /**
     * Database provider type
     */
    provider: 'postgres' | 'sqlite' | 'mysql';

    /**
     * Database connection URL
     */
    url: string;

    /**
     * Database schema name
     * @optional
     */
    schema?: string;
  };

  /**
   * Queue backend configuration
   * @optional - defaults to in-process memory queue
   */
  queue?: {
    /**
     * Queue backend implementation
     */
    backend: 'memory';

    /**
     * Number of worker tasks processed concurrently
     * @optional - defaults to 1
     */
    concurrency?: number;
  };

  /**
   * Watcher configuration for async lifecycle checks
   * @optional
   */
  watchers?: {
    /**
     * Enable periodic watcher checks
     * @optional - defaults to true
     */
    enabled?: boolean;

    /**
     * Poll interval in milliseconds
     * @optional - defaults to 15000
     */
    pollIntervalMs?: number;

    /**
     * Pending transaction timeout in milliseconds
     * @optional - defaults to 300000
     */
    transactionTimeoutMs?: number;

    /**
     * Retention window in days for watcher logs and operational records.
     * @optional - defaults to 90
     */
    retentionDays?: number;
  };

  /**
   * HTTP guardrails for SDK route handlers.
   * @optional
   */
  http?: {
    /**
     * Maximum accepted request body size in bytes.
     * @optional - defaults to 1048576 (1 MB)
     */
    maxBodyBytes?: number;
  };

  /**
   * In-process per-route rate limiting.
   * @optional
   */
  rateLimit?: {
    /**
     * Sliding window duration in milliseconds.
     * @optional - defaults to 60000
     */
    windowMs?: number;

    /**
     * Max requests per window for auth challenge endpoint.
     * @optional - defaults to 30
     */
    authChallengeMax?: number;

    /**
     * Max requests per window for auth token endpoint.
     * @optional - defaults to 30
     */
    authTokenMax?: number;

    /**
     * Max requests per window for webhook endpoint.
     * @optional - defaults to 120
     */
    webhookMax?: number;

    /**
     * Max requests per window for deposit endpoint.
     * @optional - defaults to 60
     */
    depositMax?: number;

    /**
     * Trust x-forwarded-for header for client IP identification.
     * Only set this to true if you're behind a trusted proxy.
     * @optional - defaults to false
     */
    trustForwardedFor?: boolean;
  };

  /**
   * Plugin system for extending functionality
   * @optional
   */
  plugins?: Array<{
    /**
     * Plugin identifier
     */
    id: string;

    /**
     * Plugin configuration
     */
    config?: Record<string, unknown>;
  }>;

  /**
   * Logging configuration
   * @optional
   */
  logging?: {
    /**
     * Log level
     */
    level?: 'debug' | 'info' | 'warn' | 'error';

    /**
     * Log format
     */
    format?: 'json' | 'text';

    /**
     * Enable file logging
     */
    file?: string;
  };

  /**
   * Monitoring and observability
   * @optional
   */
  monitoring?: {
    /**
     * Enable Sentry error tracking
     */
    sentryDsn?: string;

    /**
     * OpenTelemetry endpoint
     */
    otlpEndpoint?: string;

    /**
     * Enable metrics collection
     */
    metricsEnabled?: boolean;
  };
}

/**
 * Complete AnchorKitConfig interface
 * Represents the unified configuration specification for Anchor-Kit
 * Covers model network, server, security, assets, KYC, operational, metadata, and framework config
 */
export interface AnchorKitConfig {
  /**
   * Network configuration
   * @required
   */
  network: NetworkConfig;

  /**
   * Server configuration
   * @required
   */
  server: ServerConfig;

  /**
   * Security configuration with secrets management
   * @required
   */
  security: SecurityConfig;

  /**
   * Assets configuration
   * @required
   */
  assets: AssetsConfig;

  /**
   * KYC configuration
   * @optional
   */
  kyc?: KycConfig;

  /**
   * Required KYC fields by asset code
   * @optional
   */
  kycRequired?: Record<string, string[]>;

  /**
   * Operational configuration
   * @optional
   */
  operational?: OperationalConfig;

  /**
   * Metadata configuration
   * @optional
   */
  metadata?: MetadataConfig;

  /**
   * Framework configuration
   * @required
   */
  framework: FrameworkConfig;

  /**
   * Webhook integration configuration.
   */
  webhooks?: {
    /**
     * Called after webhook event verification and persistence.
     */
    onEvent?: (
      event: {
        id: string;
        eventId: string;
        provider: string;
        payload: Record<string, unknown>;
      },
      context: {
        receivedAt: string;
        signature?: string;
      },
    ) => Promise<void> | void;
  };
}

/**
 * Deep readonly utility type to reflect runtime deep-freeze behavior.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Array<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * Snapshot type returned by `AnchorConfig.getConfig()` — deeply readonly.
 */
export type AnchorKitConfigSnapshot = DeepReadonly<AnchorKitConfig>;
