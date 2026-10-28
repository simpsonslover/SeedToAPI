// Encrypted-at-rest storage for the seed phrase.
//
// The mnemonic is encrypted with AES-256-GCM using a key derived from a
// user-chosen passphrase via scrypt. The vault file never contains the seed in
// plaintext, and the API key is stored only as a SHA-256 hash.

import { randomBytes, scrypt, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const VAULT_VERSION = 1;
// N=2^17 costs ~128 MiB and a fraction of a second; strong against offline
// guessing of a stolen vault file.
const DEFAULT_KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, keyLen: 32 };

export const MIN_PASSPHRASE_LENGTH = 12;

async function deriveKey(passphrase, salt, kdf) {
  return scryptAsync(passphrase.normalize('NFKC'), salt, kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r + 1024 * 1024,
  });
}

export function hashApiKey(apiKey) {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function apiKeyMatches(candidate, storedHash) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(hashApiKey(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateApiKey() {
  return 'sk_' + randomBytes(32).toString('base64url');
}

/**
 * Encrypt a secret payload ({ mnemonic, bip39Passphrase }) into a vault object.
 */
export async function sealVault({ secret, passphrase, apiKeyHash, kdf = DEFAULT_KDF }) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // Bind the API key hash to the ciphertext so it cannot be swapped without the passphrase.
  cipher.setAAD(Buffer.from(apiKeyHash, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(secret), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);
  key.fill(0);
  return {
    version: VAULT_VERSION,
    kdf: { ...kdf, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
    ciphertext: ciphertext.toString('base64'),
    apiKeyHash,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Decrypt a vault object. Throws WrongPassphraseError if the passphrase is wrong
 * (or the file was tampered with).
 */
export async function openVault(vault, passphrase) {
  if (vault.version !== VAULT_VERSION) throw new Error(`Unsupported vault version ${vault.version}`);
  const salt = Buffer.from(vault.kdf.salt, 'base64');
  const key = await deriveKey(passphrase, salt, vault.kdf);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(vault.cipher.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(vault.cipher.tag, 'base64'));
  decipher.setAAD(Buffer.from(vault.apiKeyHash, 'utf8'));
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(vault.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw new WrongPassphraseError();
  } finally {
    key.fill(0);
  }
  const secret = JSON.parse(plaintext.toString('utf8'));
  plaintext.fill(0);
  return secret;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase');
    this.name = 'WrongPassphraseError';
  }
}

export function vaultExists(path) {
  return existsSync(path);
}

export async function readVault(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeVault(path, vault) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(vault, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
