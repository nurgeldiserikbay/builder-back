// AES-256-GCM for secrets stored in the database (repository tokens, payout IBANs). The key is base64 of 32 bytes in
// CODE_HOSTING_TOKEN_ENCRYPTION_KEY; without it such secrets cannot be saved.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function secretKey(env = process.env): Buffer | null {
  const raw = env.CODE_HOSTING_TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

export function sealSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

export function openSecret(payload: string, key: Buffer): string | null {
  const [iv, tag, data] = payload.split('.');
  if (!iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
