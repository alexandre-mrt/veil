/**
 * Shared AES-GCM encryption helpers for localStorage data.
 * Uses PBKDF2 key derivation from wallet address.
 *
 * Extracted from usePrivateState.ts for reuse in credential storage.
 */

const APP_SALT = new TextEncoder().encode("veil-privacy-protocol-v1");
const PBKDF2_ITERATIONS = 100_000;
const IV_LENGTH = 12;

/**
 * Derive an AES-256-GCM key from a wallet address using PBKDF2.
 */
export async function deriveKey(walletAddress: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(walletAddress),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: APP_SALT, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a plaintext string with AES-GCM, returning a base64 string (iv + ciphertext).
 */
export async function encryptData(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded AES-GCM ciphertext (iv + ciphertext) back to plaintext.
 */
export async function decryptData(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
