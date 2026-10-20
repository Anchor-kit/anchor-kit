import type { AnchorConfig } from '@/core/config.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Foundation types for unified spec
 * Includes KYC/customer related types used across SEPs
 */

/** Allowed KYC status values as used in unified spec */
export type KycStatus = 'not_provided' | 'pending' | 'approved' | 'rejected';

/** Postal address fields commonly used for KYC */
export interface PostalAddress {
  street_address?: string;
  locality?: string; // city
  region?: string; // state/province
  postal_code?: string;
  country?: string; // ISO 3166-1 alpha-2
}

/** Minimal representation of a submitted identity document */
export interface IdentityDocument {
  id?: string;
  type?: string;
  issuing_country?: string;
  status?: KycStatus;
}

/**
 * KycData represents the customer KYC information surfaced in the unified spec.
 * Fields are intentionally optional where SEP-12 allows them to be absent.
 */
export interface KycData {
  id?: string;
  status: KycStatus;

  // Basic identity fields
  first_name?: string;
  last_name?: string;
  email_address?: string;
  phone_number?: string;
  birth_date?: string; // ISO 8601 date (YYYY-MM-DD)

  // Address and nationality
  address?: PostalAddress;
  nationality?: string; // ISO 3166-1 alpha-2

  // Government ID / document references
  id_number?: string;
  id_type?: string;
  documents?: IdentityDocument[];

  // Timestamps
  created_at?: number;
  updated_at?: number;
}

export type { KycData as CustomerKycData };

/**
 * Common error codes used across Stellar Ecosystem Proposals (SEPs).
 */
export type SepErrorCode =
  | 'bad_request'
  | 'transaction_not_found'
  | 'customer_info_needed'
  | 'verification_required'
  | 'not_found'
  | 'invalid_asset'
  | 'unsupported_asset'
  | 'invalid_request'
  | 'forbidden'
  | string;

/**
 * RouteDefinition - Defines an API route to be injected by a plugin.
 */
export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: (ctx: PluginRouteContext) => Promise<unknown> | unknown;
}

/**
 * Context supplied to plugin handlers. Paths are exact and static, so params
 * is empty. Returned values become `{ data }` JSON responses; undefined means
 * 204. A handler may write directly to response to choose its own status/body.
 */
export interface PluginRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  params: Record<string, string>;
  query: Record<string, string | Array<string>>;
  body: Record<string, unknown>;
  config: AnchorConfig;
  database: DatabaseAdapter;
}

/**
 * SchemaDefinition - Defines database schema extensions for a plugin.
 */
export interface SchemaDefinition {
  name: string;
  tables: unknown[];
}
