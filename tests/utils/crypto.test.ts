import { describe, it, expect } from 'vitest';
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
      const token = await CryptoUtils.generateJwt(payload, secret, { expiresIn: '1h' });
      const decoded = await CryptoUtils.verifyJwt(token, secret);
      expect(decoded).toMatchObject(payload);
      expect(decoded.exp).toBeDefined();
    });

    it('should treat expiresIn: 0 as an immediate expiry (not unlimited)', async () => {
      const token = await CryptoUtils.generateJwt(payload, secret, { expiresIn: 0 });
      await expect(CryptoUtils.verifyJwt(token, secret)).rejects.toThrow();
    });

    it('should throw error for invalid secret', async () => {
      const token = await CryptoUtils.generateJwt(payload, secret);
      await expect(CryptoUtils.verifyJwt(token, 'wrong-secret')).rejects.toThrow();
    });

    it('should throw error for malformed token', async () => {
      await expect(CryptoUtils.verifyJwt('invalid-token', secret)).rejects.toThrow();
    });

    it('should reject an expired token', async () => {
      // generate a token that expires in 1 second
      const token = await CryptoUtils.generateJwt(payload, secret, { expiresIn: 1 });

      // wait just over 1 second to ensure expiration (keeps test fast)
      await new Promise((r) => setTimeout(r, 1100));

      await expect(CryptoUtils.verifyJwt(token, secret)).rejects.toThrow();
    });
  });
});
