import { SepErrorCode } from '../types/foundation.ts';

export abstract class AnchorKitError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly errorCode: string;
  public context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
  }

  toJSON() {
    return {
      error: this.errorCode,
      message: this.message,
      ...(typeof globalThis.process !== 'undefined' &&
        globalThis.process.env?.NODE_ENV === 'development' && { context: this.context }),
    };
  }
}

/**
 * Error raised when the anchor's internal configuration is invalid or incomplete.
 */
export class ConfigError extends AnchorKitError {
  public readonly statusCode = 500;
  public readonly errorCode = 'INVALID_CONFIG';

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/**
 * Error raised when a request fails validation (e.g. invalid parameters).
 */
export class ValidationError extends AnchorKitError {
  public readonly statusCode = 400;
  public readonly errorCode = 'INVALID_REQUEST';

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/**
 * Error raised when a request body exceeds the configured size limit.
 */
export class PayloadTooLargeError extends AnchorKitError {
  public readonly statusCode = 413;
  public readonly errorCode = 'PAYLOAD_TOO_LARGE';

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/**
 * Error representing a standard SEP protocol error.
 */
export class SepProtocolError extends AnchorKitError {
  public readonly statusCode = 400;
  public readonly errorCode: SepErrorCode;
  public sepErrorType?: string;

  constructor(
    message: string,
    errorCode: SepErrorCode,
    sepErrorType?: string,
    context?: Record<string, unknown>,
  ) {
    const meta = { ...context, errorCode, sepErrorType } as Record<string, unknown>;
    super(message, meta);
    this.errorCode = errorCode;
    this.sepErrorType = sepErrorType;
  }
}

export class TransactionStateError extends AnchorKitError {
  public readonly statusCode = 400;
  public readonly errorCode = 'INVALID_STATE_TRANSITION';
  public currentStatus?: string;
  public attemptedStatus?: string;

  constructor(
    message: string,
    currentStatus?: string,
    attemptedStatus?: string,
    context?: Record<string, unknown>,
  ) {
    const meta = { ...context, currentStatus, attemptedStatus } as Record<string, unknown>;
    super(message, meta);
    this.currentStatus = currentStatus;
    this.attemptedStatus = attemptedStatus;
  }
}

export class RailError extends AnchorKitError {
  public readonly statusCode = 500;
  public readonly errorCode = 'RAIL_ERROR';
  public railName?: string;

  constructor(message: string, railName?: string, context?: Record<string, unknown>) {
    const meta = { ...context, railName } as Record<string, unknown>;
    super(message, meta);
    this.railName = railName;
  }
}

/**
 * Error raised when a network request fails or upstream service is unreachable.
 */
export class NetworkError extends AnchorKitError {
  public readonly statusCode = 502;
  public readonly errorCode = 'NETWORK_ERROR';
  public httpStatusFromUpstream?: number;

  constructor(message: string, httpStatusFromUpstream?: number, context?: Record<string, unknown>) {
    const meta = { ...context, httpStatusFromUpstream } as Record<string, unknown>;
    super(message, meta);
    this.httpStatusFromUpstream = httpStatusFromUpstream;
  }
}

/**
 * Error raised when a cryptographic operation fails (e.g. signing, encryption).
 */
export class CryptoError extends AnchorKitError {
  public readonly statusCode = 500;
  public readonly errorCode = 'CRYPTO_ERROR';

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/**
 * Error raised when persisted JSON payloads are malformed or cannot be decoded into the expected object shape.
 */
export class MalformedPersistedDataError extends AnchorKitError {
  public readonly statusCode = 500;
  public readonly errorCode = 'MALFORMED_PERSISTED_DATA';

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}
