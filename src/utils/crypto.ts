import * as jose from 'jose';
import type { JWTPayload } from 'jose';
import bcrypt from 'bcryptjs';

/**
 * Utility class for cryptographic operations.
 */
export const CryptoUtils = {
  /**
   * Generates a cryptographically secure random string of the specified length.
   *
   * @param length The length of the string to generate.
   * @returns A secure random string.
   */
  generateRandomString(length: number): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomValues = new Uint32Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
      result += charset[randomValues[i] % charset.length];
    }
    return result;
  },

  /**
   * Hashes a password using bcrypt.
   *
   * @param password The password to hash.
   * @returns A promise that resolves to the hashed password.
   */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  },

  /**
   * Verifies a password against a bcrypt hash.
   *
   * @param password The password to verify.
   * @param hash The hash to verify against.
   * @returns A promise that resolves to true if the password matches the hash, false otherwise.
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  },

  /**
   * Generates a JSON Web Token (JWT).
   *
   * @param payload The payload to include in the token.
   * @param secret The secret key to sign the token with.
   * @param options Additional options for token generation (e.g., expiration).
   * @returns A promise that resolves to the generated JWT.
   */
  async generateJwt(
    payload: JWTPayload,
    secret: string,
    options: { expiresIn?: string | number } = {},
  ): Promise<string> {
    const secretKey = new TextEncoder().encode(secret);
    const builder = new jose.SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt();

    // Honor an explicit expiresIn of 0 (immediate expiry). Only skip when option omitted.
    if (options.expiresIn !== undefined) {
      builder.setExpirationTime(options.expiresIn);
    }

    return builder.sign(secretKey);
  },

  /**
   * Verifies a JSON Web Token (JWT).
   *
   * @param token The token to verify.
   * @param secret The secret key to verify the token with.
   * @returns A promise that resolves to the decoded payload if the token is valid.
   * @throws Error if the token is invalid or expired.
   */
  async verifyJwt(token: string, secret: string): Promise<JWTPayload> {
    const secretKey = new TextEncoder().encode(secret);
    const { payload } = await jose.jwtVerify(token, secretKey);
    return payload;
  },
};
