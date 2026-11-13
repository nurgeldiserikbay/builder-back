// Encryption of repository tokens at rest (AES-256-GCM). The key comes from CODE_HOSTING_TOKEN_ENCRYPTION_KEY (32 bytes, base64).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function tokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.CODE_HOSTING_TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

export function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

/** The token, or null when the stored value cannot be decrypted with this key (the key changed or the value is damaged). */
export function decryptToken(payload: string, key: Buffer): string | null {
  const [iv, tag, data] = payload.split('.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
