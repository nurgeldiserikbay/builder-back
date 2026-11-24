import { secretKey } from '../common/secret-box.js';

/**
 * The key that seals two-step secrets: ACCOUNT_SECRET_KEY (32 bytes, base64), or the code-hosting token key when only that
 * one is set. Without a key two-step sign-in cannot be switched on, and the settings page says so.
 */
export function accountSecretKey(env = process.env): Buffer | null {
  return secretKey({ CODE_HOSTING_TOKEN_ENCRYPTION_KEY: env.ACCOUNT_SECRET_KEY || env.CODE_HOSTING_TOKEN_ENCRYPTION_KEY });
}
