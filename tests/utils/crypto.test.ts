import { describe, it, expect } from 'vitest';
import { decodeJwt } from 'jose';
import { CryptoUtils } from '../../src/utils/crypto';

describe('CryptoUtils', () => {
  describe('generateRandomString', () => {
    it('should generate a string of the specified length', () => {
      const length = 32;
      const result = CryptoUtils.generateRandomString(length);
      expect(result).toHaveLength(length);
    });

    it('should generate different strings on subsequent calls', () => {
      const str1 = CryptoUtils.generateRandomString(32);
      const str2 = CryptoUtils.generateRandomString(32);
      expect(str1).not.toBe(str2);
    });

    it('should only contain characters from the default charset', () => {
      const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const result = CryptoUtils.generateRandomString(100);
      for (const char of result) {
        expect(charset).toContain(char);
      }
    });
  });

  describe('Password Hashing', () => {
    it('should hash and verify a password', async () => {
      const password = 'mySecurePassword123';
      const hash = await CryptoUtils.hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);

      const isValid = await CryptoUtils.verifyPassword(password, hash);
      expect(isValid).toBe(true);

      const isInvalid = await CryptoUtils.verifyPassword('wrongPassword', hash);
      expect(isInvalid).toBe(false);
    });
  });

  describe('JWT', () => {
    const secret = 'super-secret-key-for-testing';
    const payload = { userId: '12345', role: 'admin' };

    it('should generate and verify a JWT', async () => {
      const token = await CryptoUtils.generateJwt(payload, secret);
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');

      const decoded = await CryptoUtils.verifyJwt(token, secret);
      expect(decoded).toMatchObject(payload);
      expect(decoded.iat).toBeDefined();
    });

    it('should work with expiration time', async () => {
      const before = Math.floor(Date.now() / 1000);
      const token = await CryptoUtils.generateJwt(payload, secret, { expiresIn: '1h' });
      const after = Math.floor(Date.now() / 1000);
      const decoded = await CryptoUtils.verifyJwt(token, secret);
      expect(decoded).toMatchObject(payload);
      expect(decoded.exp).toBeDefined();
      expect(decoded.exp).toBeGreaterThanOrEqual(before + 3600);
      expect(decoded.exp).toBeLessThanOrEqual(after + 3600);
    });

    it('treats numeric expiresIn as a relative lifetime in seconds', async () => {
      const token = await CryptoUtils.generateJwt(payload, secret, { expiresIn: 60 });
      const decoded = decodeJwt(token);

      expect(decoded.exp).toBeGreaterThan(decoded.iat!);
      expect(decoded.exp! - decoded.iat!).toBe(60);
    });

    it('sets zero numeric expiresIn to the issued-at time', async () => {
      const token = await CryptoUtils.generateJwt(payload, secret, { expiresIn: 0 });
      const decoded = decodeJwt(token);

      expect(decoded.exp).toBe(decoded.iat);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid numeric expiresIn values (%s)',
      async (expiresIn) => {
        await expect(CryptoUtils.generateJwt(payload, secret, { expiresIn })).rejects.toThrow(
          'expiresIn must be a non-negative finite number or a duration string',
        );
      },
    );

    it('rejects invalid duration strings', async () => {
      await expect(
        CryptoUtils.generateJwt(payload, secret, { expiresIn: 'not-a-duration' }),
      ).rejects.toThrow();
    });

    it('should throw error for invalid secret', async () => {
      const token = await CryptoUtils.generateJwt(payload, secret);
      await expect(CryptoUtils.verifyJwt(token, 'wrong-secret')).rejects.toThrow();
    });

    it('should throw error for malformed token', async () => {
      await expect(CryptoUtils.verifyJwt('invalid-token', secret)).rejects.toThrow();
    });
  });
});
