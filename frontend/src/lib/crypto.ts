/**
 * Shared AES-GCM encryption helpers for localStorage data.
 *
 * Key derivation is handled by useWalletKey (wallet-signature-derived).
 * This module only provides encrypt/decrypt given an external CryptoKey.
 */

const IV_LENGTH = 12;

// ---------------------------------------------------------------------------
// Encrypt / Decrypt -- AES-GCM with iv prepended
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string with AES-GCM, returning a base64 string (iv + ciphertext).
 */
export async function encryptData(
  plaintext: string,
  key: CryptoKey,
): Promise<string> {
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
export async function decryptData(
  encrypted: string,
  key: CryptoKey,
): Promise<string> {
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
