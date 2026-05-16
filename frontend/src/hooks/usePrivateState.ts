"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import type { VeilPrivateState } from "@/lib/types";
import { EPOCH_DURATION_MS } from "@/lib/constants";

function computeCurrentEpoch(): number {
  return Math.floor(Date.now() / EPOCH_DURATION_MS);
}

const STORAGE_KEY = "veil-state";
const APP_SALT = new TextEncoder().encode("veil-privacy-protocol-v1");

// ---------------------------------------------------------------------------
// Crypto helpers — AES-GCM encryption keyed per wallet
// ---------------------------------------------------------------------------

async function deriveKey(walletAddress: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(walletAddress),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: APP_SALT, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptState(state: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(state),
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptState(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Serialization helpers (plain JSON, no encoding)
// ---------------------------------------------------------------------------

function generateRandomBigInt(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return bytes.reduce(
    (acc, byte, i) => acc | (BigInt(byte) << BigInt(i * 8)),
    0n,
  );
}

function serializeState(state: VeilPrivateState): string {
  return JSON.stringify({
    userSecret: state.userSecret.toString(),
    currentEpoch: state.currentEpoch,
    cumulativeSpending: state.cumulativeSpending.toString(),
    randomness: state.randomness.toString(),
    credentials: state.credentials.map((c) => ({
      leaf: c.leaf.toString(),
      kycLevel: c.kycLevel,
      expiry: c.expiry,
      merkleProof: c.merkleProof.map((p) => p.toString()),
      merkleIndex: c.merkleIndex,
    })),
  });
}

function deserializeState(json: string): VeilPrivateState {
  const parsed = JSON.parse(json);
  return {
    userSecret: BigInt(parsed.userSecret),
    currentEpoch: parsed.currentEpoch,
    cumulativeSpending: BigInt(parsed.cumulativeSpending),
    randomness: BigInt(parsed.randomness),
    credentials: parsed.credentials.map(
      (c: {
        leaf: string;
        kycLevel: number;
        expiry: number;
        merkleProof: string[];
        merkleIndex: number;
      }) => ({
        leaf: BigInt(c.leaf),
        kycLevel: c.kycLevel,
        expiry: c.expiry,
        merkleProof: c.merkleProof.map((p: string) => BigInt(p)),
        merkleIndex: c.merkleIndex,
      }),
    ),
  };
}

/** Legacy decode: plaintext base64 (pre-encryption migration) */
function decodeLegacyState(encoded: string): VeilPrivateState {
  return deserializeState(atob(encoded));
}

function createInitialState(): VeilPrivateState {
  return {
    userSecret: generateRandomBigInt(),
    currentEpoch: computeCurrentEpoch(),
    cumulativeSpending: 0n,
    randomness: 0n, // Genesis commitment uses randomness=0; updated after first transfer
    credentials: [],
  };
}

// ---------------------------------------------------------------------------
// Async storage operations
// ---------------------------------------------------------------------------

async function loadState(key: CryptoKey): Promise<VeilPrivateState | null> {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;

  try {
    // Try encrypted decryption first
    const json = await decryptState(stored, key);
    return deserializeState(json);
  } catch {
    // Fallback: legacy plaintext base64 — migrate by re-encrypting
    try {
      const legacy = decodeLegacyState(stored);
      const encrypted = await encryptState(serializeState(legacy), key);
      localStorage.setItem(STORAGE_KEY, encrypted);
      return legacy;
    } catch {
      return null;
    }
  }
}

async function saveState(state: VeilPrivateState, key: CryptoKey): Promise<void> {
  const encrypted = await encryptState(serializeState(state), key);
  localStorage.setItem(STORAGE_KEY, encrypted);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UsePrivateStateReturn {
  readonly state: VeilPrivateState | null;
  readonly isInitialized: boolean;
  readonly updateCumulative: (amount: bigint) => void;
  readonly updateAfterTransfer: (cumulativeNew: bigint, newRandomness: bigint) => void;
}

export function usePrivateState(): UsePrivateStateReturn {
  const account = useCurrentAccount();
  const walletAddress = account?.address;

  const [state, setState] = useState<VeilPrivateState | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const cryptoKeyRef = useRef<CryptoKey | null>(null);

  useEffect(() => {
    if (!walletAddress) {
      setState(null);
      setIsInitialized(false);
      return;
    }

    let cancelled = false;

    async function init(address: string) {
      try {
        const key = await deriveKey(address);
        if (cancelled) return;
        cryptoKeyRef.current = key;

        const loaded = await loadState(key);
        if (cancelled) return;

        if (loaded) {
          const onchainEpoch = computeCurrentEpoch();
          if (loaded.currentEpoch !== onchainEpoch) {
            const reset: VeilPrivateState = {
              ...loaded,
              currentEpoch: onchainEpoch,
              cumulativeSpending: 0n,
              // DO NOT reset randomness — it must match the on-chain commitment
            };
            await saveState(reset, key);
            if (!cancelled) setState(reset);
          } else {
            setState(loaded);
          }
        } else {
          const initial = createInitialState();
          await saveState(initial, key);
          if (!cancelled) setState(initial);
        }
      } catch {
        if (!cancelled) {
          const initial = createInitialState();
          try {
            const key = await deriveKey(address);
            cryptoKeyRef.current = key;
            await saveState(initial, key);
          } catch {
            // If crypto fails entirely, store nothing — don't leak plaintext
          }
          setState(initial);
        }
      }
      if (!cancelled) setIsInitialized(true);
    }

    init(walletAddress);
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  const persist = useCallback(
    async (updated: VeilPrivateState) => {
      setState(updated);
      const key = cryptoKeyRef.current;
      if (key) {
        await saveState(updated, key);
      }
    },
    [],
  );

  const updateCumulative = useCallback(
    (amount: bigint) => {
      if (!state) return;
      const updated: VeilPrivateState = {
        ...state,
        cumulativeSpending: state.cumulativeSpending + amount,
      };
      persist(updated);
    },
    [state, persist],
  );

  const updateAfterTransfer = useCallback(
    (cumulativeNew: bigint, newRandomness: bigint) => {
      if (!state) return;
      const updated: VeilPrivateState = {
        ...state,
        cumulativeSpending: cumulativeNew,
        randomness: newRandomness,
      };
      persist(updated);
    },
    [state, persist],
  );

  return { state, isInitialized, updateCumulative, updateAfterTransfer };
}
