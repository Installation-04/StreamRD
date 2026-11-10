import crypto from "node:crypto";
import { config } from "./config";

/**
 * Encryption of stored credentials (debrid keys and similar) with AES-256-GCM.
 * Values are stored as "enc:v1:" + base64url(iv | tag | ciphertext). Anything without the prefix is
 * treated as a legacy plaintext value, which the startup migration re-encrypts.
 * The key is DATA_ENCRYPTION_KEY when set (the container generates one under /config/secrets),
 * otherwise it is derived from JWT_SECRET, so a split install gets protection without new settings.
 */
const PREFIX = "enc:v1:";
const INFO = "streamrd-data-v1";
let cached: Buffer | null = null;
function key(): Buffer {
  if (cached) return cached;
  const supplied = process.env.DATA_ENCRYPTION_KEY?.trim();
  cached = supplied
    ? crypto.createHash("sha256").update(supplied).digest()
    : Buffer.from(crypto.hkdfSync("sha256", config.jwtSecret, "", INFO, 32));
  return cached;
}
export function isEncrypted(value: string): boolean { return value.startsWith(PREFIX); }
export function encryptSecret(plain: string): string {
  if (!plain || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
/** Plaintext for a stored value; null when an encrypted value cannot be read (wrong key or tampering). */
export function decryptSecret(stored: string): string | null;
export function decryptSecret(stored: string | null): string | null;
export function decryptSecret(stored: string | null): string | null {
  if (stored === null || !isEncrypted(stored)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch { return null; }
}
