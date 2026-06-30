/**
 * AES-256-GCM encryption / decryption using the Web Crypto API.
 *
 * - The encryption key is derived from the user's password via PBKDF2.
 * - A random 16-byte salt is stored alongside the encrypted data (per vault).
 * - A random 12-byte IV is generated per encryption and stored with the ciphertext.
 * - The GCM auth tag (16 bytes) is automatically appended to the ciphertext by the API.
 * - All data stored on S3 is in the form: salt(16) || iv(12) || ciphertext+tag
 */

import { fromBase64, toBase64 } from "./utils";

/** Magic header bytes to identify encrypted content. */
const MAGIC = new Uint8Array([0x53, 0x4f, 0x45, 0x31]); // "SOE1" = SynObsidian Encrypt v1

/** PBKDF2 iteration count. */
const PBKDF2_ITERATIONS = 600_000;

/** Salt length in bytes. */
const SALT_LENGTH = 16;

/** AES-GCM IV length in bytes. */
const IV_LENGTH = 12;

/**
 * Derive an AES-256-GCM key from a password and salt.
 * The same password + salt always produces the same key.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Generate a new random salt for key derivation.
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Returns the ciphertext bytes packed as:
 *   MAGIC(4) || salt(16) || iv(12) || ciphertext+authTag
 */
export async function encrypt(
  plaintext: string,
  key: CryptoKey,
  salt: Uint8Array
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const enc = new TextEncoder();
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );

  // Pack: magic + salt + iv + ciphertext
  const result = new Uint8Array(
    MAGIC.length + salt.length + iv.length + cipherBuf.byteLength
  );
  let offset = 0;
  result.set(MAGIC, offset); offset += MAGIC.length;
  result.set(salt, offset); offset += salt.length;
  result.set(iv, offset); offset += iv.length;
  result.set(new Uint8Array(cipherBuf), offset);

  return result.buffer;
}

/**
 * Decrypt ciphertext produced by `encrypt()`.
 *
 * Expects the input to have: MAGIC(4) || salt(16) || iv(12) || ciphertext+authTag
 * Returns the plaintext string, or null if decryption fails.
 */
export async function decrypt(
  encryptedData: ArrayBuffer | ArrayBufferView,
  password: string
): Promise<string | null> {
  const buf = "buffer" in encryptedData && encryptedData instanceof Uint8Array
    ? encryptedData
    : new Uint8Array(encryptedData as ArrayBuffer);

  // Validate magic bytes
  if (
    buf.length < MAGIC.length + SALT_LENGTH + IV_LENGTH + 1 ||
    buf[0] !== MAGIC[0] ||
    buf[1] !== MAGIC[1] ||
    buf[2] !== MAGIC[2] ||
    buf[3] !== MAGIC[3]
  ) {
    return null; // Not encrypted or corrupted
  }

  let offset = MAGIC.length;
  const salt = buf.slice(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = buf.slice(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const ciphertext = buf.slice(offset);

  try {
    const key = await deriveKey(password, salt);
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    const dec = new TextDecoder();
    return dec.decode(plainBuf);
  } catch {
    // Wrong password or corrupted data
    return null;
  }
}

/**
 * Check if an ArrayBuffer appears to be encrypted by this plugin.
 */
export function isEncrypted(data: ArrayBuffer | ArrayBufferView): boolean {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  if (buf.length < MAGIC.length) return false;
  return (
    buf[0] === MAGIC[0] &&
    buf[1] === MAGIC[1] &&
    buf[2] === MAGIC[2] &&
    buf[3] === MAGIC[3]
  );
}

/**
 * Derive a deterministic salt from a seed string.
 * Used so the same vault + password always uses the same salt.
 */
export async function deriveSaltFromSeed(seed: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(seed));
  return new Uint8Array(hash.slice(0, SALT_LENGTH));
}
