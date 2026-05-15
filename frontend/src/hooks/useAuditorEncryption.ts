"use client";

import { useCallback, useState } from "react";
import type { AuditorCiphertext } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditorPayload {
  readonly txAmount: string;
  readonly salt: string;
}

interface UseAuditorEncryptionReturn {
  readonly encryptForAuditor: (
    auditorPublicKey: Uint8Array,
    payload: AuditorPayload,
  ) => Promise<AuditorCiphertext | null>;
  readonly isEncrypting: boolean;
  readonly error: string | null;
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDITOR_P256_KEY_LENGTH = 65; // uncompressed P-256 public key
const AES_GCM_IV_LENGTH = 12;
const HKDF_INFO = "veil-auditor-v1";

// ---------------------------------------------------------------------------
// Encryption helpers (Web Crypto API)
// ---------------------------------------------------------------------------

/**
 * Imports an auditor's raw P-256 public key for ECDH key agreement.
 */
async function importAuditorPublicKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.length !== AUDITOR_P256_KEY_LENGTH) {
    throw new Error(
      `Invalid auditor public key length: expected ${AUDITOR_P256_KEY_LENGTH}, got ${rawKey.length}`,
    );
  }
  // Copy into a fresh ArrayBuffer to satisfy strict TS typing
  // (Uint8Array.buffer is ArrayBufferLike which includes SharedArrayBuffer)
  const keyBuffer = new ArrayBuffer(rawKey.length);
  new Uint8Array(keyBuffer).set(rawKey);
  return crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

/**
 * Generates an ephemeral P-256 keypair for one-time ECDH.
 */
async function generateEphemeralKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
}

/**
 * Derives a shared secret via ECDH, then stretches it with HKDF-SHA256
 * into an AES-GCM-256 key.
 */
async function deriveAesKey(
  ephemeralPrivateKey: CryptoKey,
  auditorPublicKey: CryptoKey,
): Promise<CryptoKey> {
  // ECDH: derive 256-bit shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: auditorPublicKey },
    ephemeralPrivateKey,
    256,
  );

  // Import shared secret as HKDF base key
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  // HKDF-SHA256 -> AES-GCM-256 key
  const encoder = new TextEncoder();
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32), // empty salt (32 zero bytes)
      info: encoder.encode(HKDF_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
}

/**
 * Encrypts plaintext with AES-GCM-256, returning iv and ciphertext.
 */
async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
  // Copy plaintext into a fresh ArrayBuffer for strict TS typing
  const plaintextBuffer = new ArrayBuffer(plaintext.length);
  new Uint8Array(plaintextBuffer).set(plaintext);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintextBuffer,
  );
  return { iv, ciphertext: new Uint8Array(ciphertextBuffer) };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuditorEncryption(): UseAuditorEncryptionReturn {
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setIsEncrypting(false);
    setError(null);
  }, []);

  const encryptForAuditor = useCallback(
    async (
      auditorPublicKey: Uint8Array,
      payload: AuditorPayload,
    ): Promise<AuditorCiphertext | null> => {
      try {
        setError(null);
        setIsEncrypting(true);

        // 1. Import auditor's P-256 public key (raw, 65 bytes uncompressed)
        const auditorKey = await importAuditorPublicKey(auditorPublicKey);

        // 2. Generate ephemeral P-256 keypair
        const ephemeralKeypair = await generateEphemeralKeypair();

        // 3. ECDH + HKDF -> AES-GCM-256 key
        const aesKey = await deriveAesKey(
          ephemeralKeypair.privateKey,
          auditorKey,
        );

        // 4. Encrypt payload
        const encoder = new TextEncoder();
        const plaintext = encoder.encode(JSON.stringify(payload));
        const { iv, ciphertext } = await aesGcmEncrypt(aesKey, plaintext);

        // 5. Export ephemeral public key (raw, 65 bytes)
        const ephemeralPublicKeyBuffer = await crypto.subtle.exportKey(
          "raw",
          ephemeralKeypair.publicKey,
        );
        const ephemeralPublicKey = new Uint8Array(ephemeralPublicKeyBuffer);

        // 6. Build combined: [ephemeralPublicKey(65) | iv(12) | ciphertext]
        const combined = new Uint8Array(
          ephemeralPublicKey.length + iv.length + ciphertext.length,
        );
        combined.set(ephemeralPublicKey, 0);
        combined.set(iv, ephemeralPublicKey.length);
        combined.set(ciphertext, ephemeralPublicKey.length + iv.length);

        setIsEncrypting(false);
        return { ephemeralPublicKey, iv, ciphertext, combined };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Auditor encryption failed";
        setError(message);
        setIsEncrypting(false);
        return null;
      }
    },
    [],
  );

  return { encryptForAuditor, isEncrypting, error, reset };
}
