import { describe, test, expect } from "vitest";

/**
 * Tests for the crypto utilities (AES-GCM encrypt/decrypt).
 *
 * These test the encryption/decryption logic using the Web Crypto API
 * available in the jsdom/Node.js test environment. We use PBKDF2-derived
 * keys since IndexedDB is not available in the test environment.
 */

const APP_SALT = new TextEncoder().encode("veil-privacy-protocol-v1");
const IV_LENGTH = 12;

/** Derive a test key using PBKDF2 (same algorithm as the PBKDF2 fallback in crypto.ts) */
async function deriveTestKey(walletAddress: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(walletAddress),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: APP_SALT,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt plaintext with AES-GCM, returning base64 string (iv + ciphertext) */
async function encryptData(
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

/** Decrypt base64-encoded AES-GCM ciphertext (iv + ciphertext) back to plaintext */
async function decryptData(
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

describe("crypto", () => {
  test("encrypt and decrypt roundtrip", async () => {
    const key = await deriveTestKey("0xabc123");
    const original = '{"userSecret":"12345","cumulativeSpending":"100"}';
    const encrypted = await encryptData(original, key);

    // Encrypted output should be base64 and different from original
    expect(encrypted).not.toBe(original);
    expect(typeof encrypted).toBe("string");

    const decrypted = await decryptData(encrypted, key);
    expect(decrypted).toBe(original);
  });

  test("different keys produce different ciphertext", async () => {
    const key1 = await deriveTestKey("0xaddress1");
    const key2 = await deriveTestKey("0xaddress2");
    const plaintext = "sensitive data";

    const encrypted1 = await encryptData(plaintext, key1);
    const encrypted2 = await encryptData(plaintext, key2);

    // Different keys should produce different ciphertext
    // (also different IVs, but key difference is the important part)
    expect(encrypted1).not.toBe(encrypted2);

    // Each key can only decrypt its own ciphertext
    const decrypted1 = await decryptData(encrypted1, key1);
    expect(decrypted1).toBe(plaintext);

    const decrypted2 = await decryptData(encrypted2, key2);
    expect(decrypted2).toBe(plaintext);
  });

  test("corrupted ciphertext fails decryption", async () => {
    const key = await deriveTestKey("0xcorrupt_test");
    const encrypted = await encryptData("test payload", key);

    // Decode, corrupt a byte in the ciphertext portion, re-encode
    const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    // Corrupt a byte past the IV (index 12+)
    const corruptIndex = IV_LENGTH + 1;
    combined[corruptIndex] = combined[corruptIndex] ^ 0xff;
    const corrupted = btoa(String.fromCharCode(...combined));

    // AES-GCM should reject corrupted ciphertext (authentication tag mismatch)
    await expect(decryptData(corrupted, key)).rejects.toThrow();
  });

  test("wrong key fails decryption", async () => {
    const key1 = await deriveTestKey("0xright_key");
    const key2 = await deriveTestKey("0xwrong_key");
    const encrypted = await encryptData("secret message", key1);

    // Decrypting with wrong key should fail (GCM auth tag mismatch)
    await expect(decryptData(encrypted, key2)).rejects.toThrow();
  });

  test("same key encrypts to different ciphertext each time (random IV)", async () => {
    const key = await deriveTestKey("0xiv_test");
    const plaintext = "identical plaintext";

    const encrypted1 = await encryptData(plaintext, key);
    const encrypted2 = await encryptData(plaintext, key);

    // Random IV means different ciphertext each time
    expect(encrypted1).not.toBe(encrypted2);

    // But both decrypt to the same plaintext
    expect(await decryptData(encrypted1, key)).toBe(plaintext);
    expect(await decryptData(encrypted2, key)).toBe(plaintext);
  });

  test("handles empty string encryption", async () => {
    const key = await deriveTestKey("0xempty_test");
    const encrypted = await encryptData("", key);
    const decrypted = await decryptData(encrypted, key);
    expect(decrypted).toBe("");
  });

  test("handles large payload encryption", async () => {
    const key = await deriveTestKey("0xlarge_test");
    // Simulate a large VeilPrivateState with credentials
    const largePayload = JSON.stringify({
      userSecret: "123456789012345678901234567890",
      currentEpoch: 42,
      cumulativeSpending: "999999999999",
      randomness: "987654321098765432109876543210",
      credentials: Array.from({ length: 10 }, (_, i) => ({
        leaf: `leaf_${i}_${"x".repeat(100)}`,
        kycLevel: 2,
        expiry: 1000000 + i,
        merkleProof: Array.from({ length: 20 }, (_, j) => `proof_${j}`),
        merkleIndex: i,
      })),
    });

    const encrypted = await encryptData(largePayload, key);
    const decrypted = await decryptData(encrypted, key);
    expect(decrypted).toBe(largePayload);
  });

  test("PBKDF2 key derivation is deterministic for same input", async () => {
    const key1 = await deriveTestKey("0xdeterministic");
    const key2 = await deriveTestKey("0xdeterministic");

    // Both keys should decrypt each other's ciphertext
    const encrypted = await encryptData("test determinism", key1);
    const decrypted = await decryptData(encrypted, key2);
    expect(decrypted).toBe("test determinism");
  });
});
