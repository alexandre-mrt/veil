"use client";

import { useCallback, useRef, useState } from "react";
import { useDAppKit } from "@mysten/dapp-kit-react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deterministic message signed by the wallet to derive encryption key material. */
const KEY_DERIVATION_MESSAGE = "Veil encryption key v1 — sign to unlock your private state";

const PBKDF2_ITERATIONS = 100_000;

/** IndexedDB database for caching derived CryptoKeys across page reloads. */
const DB_NAME = "veil-keystore";
const STORE_NAME = "wallet-keys";

// ---------------------------------------------------------------------------
// IndexedDB helpers — cache the derived CryptoKey per wallet address
// ---------------------------------------------------------------------------

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedKey(address: string): Promise<CryptoKey | null> {
  try {
    const db = await openDB();
    try {
      return await new Promise<CryptoKey | null>((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(address);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function cacheKey(address: string, key: CryptoKey): Promise<void> {
  try {
    const db = await openDB();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put(key, address);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Caching failure is non-fatal — user will just be prompted again next session
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseWalletKeyReturn {
  /** Prompt the wallet to sign the key-derivation message, derive + cache the AES key. */
  readonly unlock: (walletAddress: string) => Promise<CryptoKey>;
  /** The derived CryptoKey, or null if not yet unlocked. */
  readonly key: CryptoKey | null;
  /** Whether the vault has been unlocked this session. */
  readonly isUnlocked: boolean;
}

/**
 * Derives a non-extractable AES-256-GCM key from a wallet signature.
 *
 * On first call per session, the user is prompted to sign a deterministic message.
 * The resulting signature (a true secret only the wallet holder can produce) is used
 * as PBKDF2 key material. The derived CryptoKey is cached in IndexedDB (non-extractable)
 * so subsequent page reloads skip the signature prompt.
 *
 * This replaces the old PBKDF2-from-address approach where the public wallet address
 * was used as key material — an XSS attacker who knew the address could trivially
 * re-derive the same key.
 */
export function useWalletKey(): UseWalletKeyReturn {
  const dAppKit = useDAppKit();
  const keyRef = useRef<CryptoKey | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);

  const unlock = useCallback(
    async (walletAddress: string): Promise<CryptoKey> => {
      // 1. Check IndexedDB cache — skip signature prompt if key already cached
      const cached = await getCachedKey(walletAddress);
      if (cached) {
        keyRef.current = cached;
        setIsUnlocked(true);
        return cached;
      }

      // 2. Prompt the wallet to sign a deterministic message
      const { signature } = await dAppKit.signPersonalMessage({
        message: new TextEncoder().encode(KEY_DERIVATION_MESSAGE),
      });

      // 3. Derive AES-256-GCM key from the signature via PBKDF2
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(signature),
        "PBKDF2",
        false,
        ["deriveKey"],
      );

      const key = await crypto.subtle.deriveKey(
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

      // 4. Cache in IndexedDB for subsequent page reloads
      await cacheKey(walletAddress, key);
      keyRef.current = key;
      setIsUnlocked(true);
      return key;
    },
    [dAppKit],
  );

  return { unlock, key: keyRef.current, isUnlocked };
}
