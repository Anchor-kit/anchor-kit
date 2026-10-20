import { describe, it, expect, afterEach } from 'vitest';
import {
  TransactionStateError,
  RailError,
  ConfigError,
  ValidationError,
  PayloadTooLargeError,
  SepProtocolError,
  NetworkError,
  CryptoError,
} from '@/core/errors.ts';
import { AnchorKitError } from '../../src/core/errors';

// Test subclass since AnchorKitError is abstract
class TestError extends AnchorKitError {
  public readonly statusCode = 400;
  public readonly errorCode = 'TEST_ERROR';

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

describe('AnchorKitError', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('should create an error with basic properties', () => {
    const error = new TestError('This is a test');

    expect(error.message).toBe('This is a test');
    expect(error.statusCode).toBe(400);
    expect(error.errorCode).toBe('TEST_ERROR');
    expect(error.context).toBeUndefined();
    expect(error.name).toBe('TestError');
  });

  it('should include context when provided', () => {
    const context = { details: 'More info' };
    const error = new TestError('Error with context', context);

    expect(error.context).toEqual(context);
  });

  describe('toJSON()', () => {
    it('should format output correctly in non-dev environment', () => {
      process.env.NODE_ENV = 'production';
      const error = new TestError('Production error', { secret: 'hidden' });

      const json = error.toJSON();

      expect(json).toEqual({
        error: 'TEST_ERROR',
        message: 'Production error',
      });
      // Context should not be exposed in production
      expect(json).not.toHaveProperty('context');
    });

    it('should include context in dev environment', () => {
      process.env.NODE_ENV = 'development';
      const context = { debugInfo: 'stuff' };
      const error = new TestError('Dev error', context);

      const json = error.toJSON();

      expect(json).toEqual({
        error: 'TEST_ERROR',
        message: 'Dev error',
        context: { debugInfo: 'stuff' },
      });
    });
  });
});

describe('ConfigError', () => {
  it('maps statusCode and errorCode', () => {
    const err = new ConfigError('missing secret');
    expect(err.statusCode).toBe(500);
    expect(err.errorCode).toBe('INVALID_CONFIG');
  });
});

describe('ValidationError', () => {
  it('maps statusCode and errorCode', () => {
    const err = new ValidationError('invalid parameter');
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe('INVALID_REQUEST');
  });
});

describe('PayloadTooLargeError', () => {
  it('maps statusCode and errorCode', () => {
    const err = new PayloadTooLargeError('request body too large');
    expect(err.statusCode).toBe(413);
    expect(err.errorCode).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('SepProtocolError', () => {
  it('maps statusCode and errorCode correctly', () => {
    const err = new SepProtocolError('customer not found', 'customer_info_needed');
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe('customer_info_needed');
  });

  it('preserves optional sepErrorType and context', () => {
    const err = new SepProtocolError('bad request', 'bad_request', 'invalid_field', {
      field: 'amount',
    });

    expect(err.sepErrorType).toBe('invalid_field');
    expect(err.context).toEqual({
      errorCode: 'bad_request',
      sepErrorType: 'invalid_field',
      field: 'amount',
    });
  });
});

describe('TransactionStateError', () => {
  it('maps statusCode and errorCode and exposes transition metadata', () => {
    const err = new TransactionStateError('invalid transition', 'pending', 'completed', {
      reason: 'test',
    });

    expect(err).toBeInstanceOf(TransactionStateError);
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe('INVALID_STATE_TRANSITION');
    expect(err.currentStatus).toBe('pending');
    expect(err.attemptedStatus).toBe('completed');
    expect(err.context).toEqual(
      expect.objectContaining({
        currentStatus: 'pending',
        attemptedStatus: 'completed',
        reason: 'test',
      }),
    );
  });
});

describe('RailError', () => {
  it('maps statusCode and errorCode and exposes rail metadata', () => {
    const err = new RailError('rail failure', 'ACH', { reason: 'network down' });

    expect(err).toBeInstanceOf(RailError);
    expect(err.statusCode).toBe(500);
    expect(err.errorCode).toBe('RAIL_ERROR');
    expect(err.railName).toBe('ACH');
    expect(err.context).toEqual(
      expect.objectContaining({
        railName: 'ACH',
        reason: 'network down',
      }),
    );
  });

  it('handles optional railName', () => {
    const err = new RailError('generic rail failure');

    expect(err).toBeInstanceOf(RailError);
    expect(err.statusCode).toBe(500);
    expect(err.errorCode).toBe('RAIL_ERROR');
    expect(err.railName).toBeUndefined();
  });
});

describe('NetworkError', () => {
  it('maps statusCode and errorCode correctly', () => {
    const err = new NetworkError('service unreachable');

    expect(err).toBeInstanceOf(NetworkError);
    expect(err.statusCode).toBe(502);
    expect(err.errorCode).toBe('NETWORK_ERROR');
  });

  it('supports optional httpStatusFromUpstream', () => {
    const err = new NetworkError('upstream service error', 503);

    expect(err).toBeInstanceOf(NetworkError);
    expect(err.statusCode).toBe(502);
    expect(err.errorCode).toBe('NETWORK_ERROR');
    expect(err.httpStatusFromUpstream).toBe(503);
    expect(err.context).toEqual({
      httpStatusFromUpstream: 503,
    });
  });

  it('preserves additional context alongside upstream status', () => {
    const err = new NetworkError('timeout connecting to oracle', 504, { service: 'price-oracle' });

    expect(err).toBeInstanceOf(NetworkError);
    expect(err.statusCode).toBe(502);
    expect(err.errorCode).toBe('NETWORK_ERROR');
    expect(err.httpStatusFromUpstream).toBe(504);
    expect(err.context).toEqual({
      service: 'price-oracle',
      httpStatusFromUpstream: 504,
    });
  });

  it('handles missing optional httpStatusFromUpstream', () => {
    const err = new NetworkError('connection refused', undefined, { retry: true });

    expect(err).toBeInstanceOf(NetworkError);
    expect(err.statusCode).toBe(502);
    expect(err.errorCode).toBe('NETWORK_ERROR');
    expect(err.httpStatusFromUpstream).toBeUndefined();
    expect(err.context).toEqual({
      retry: true,
      httpStatusFromUpstream: undefined,
    });
  });
});

describe('CryptoError', () => {
  it('maps statusCode and errorCode', () => {
    const err = new CryptoError('encryption failed');
    expect(err.statusCode).toBe(500);
    expect(err.errorCode).toBe('CRYPTO_ERROR');
  });

  it('correctly inherits from AnchorKitError', () => {
    const err = new CryptoError('bad key');
    expect(err).toBeInstanceOf(CryptoError);
    expect(err).toBeInstanceOf(AnchorKitError);
  });
});
