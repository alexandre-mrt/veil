import { describe, test, expect } from "vitest";

/**
 * Tests for the wallet key derivation logic used in useWalletKey.
 *
 * These test the PBKDF2 key derivation properties using the Web Crypto API
 * available in the jsdom/Node.js test environment.
 */

const PBKDF2_ITERATIONS = 100_000;

/** Derive a test AES-256-GCM key from a simulated wallet signature via PBKDF2. */
async function deriveKeyFromSignature(
  signature: string,
  walletAddress: string,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signature),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(`veil-${walletAddress}`),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

describe("useWalletKey key derivation", () => {
  test("PBKDF2 derives consistent key from same signature", async () => {
    const signature = "mock-signature-base64-abcdef123456";
    const address = "0x1234abcd";

    const key1 = await deriveKeyFromSignature(signature, address);
    const key2 = await deriveKeyFromSignature(signature, address);

    // Both keys should decrypt each other's ciphertext (deterministic derivation)
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode("test-determinism");

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key1,
      plaintext,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key2,
      ciphertext,
    );

    expect(new TextDecoder().decode(decrypted)).toBe("test-determinism");
  });

  test("different signatures produce different keys", async () => {
    const address = "0xsame-address";
    const key1 = await deriveKeyFromSignature("signature-alpha", address);
    const key2 = await deriveKeyFromSignature("signature-beta", address);

    // Encrypt with key1, decrypt with key2 should fail (different keys)
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key1,
      new TextEncoder().encode("secret"),
    );

    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, ciphertext),
    ).rejects.toThrow();
  });

  test("different addresses produce different keys from same signature", async () => {
    const signature = "same-signature-for-both";
    const key1 = await deriveKeyFromSignature(signature, "0xaddress1");
    const key2 = await deriveKeyFromSignature(signature, "0xaddress2");

    // Salt differs (veil-0xaddress1 vs veil-0xaddress2), so keys differ
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key1,
      new TextEncoder().encode("data"),
    );

    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, ciphertext),
    ).rejects.toThrow();
  });

  test("derived key is non-extractable", async () => {
    const key = await deriveKeyFromSignature("test-sig", "0xtest");
    expect(key.extractable).toBe(false);
  });

  test("derived key supports AES-GCM encrypt and decrypt", async () => {
    const key = await deriveKeyFromSignature("test-sig-ops", "0xops");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM" });
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });
});
