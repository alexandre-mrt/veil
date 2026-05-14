"use client";

import { useCallback, useEffect, useState } from "react";
import type { VeilPrivateState } from "@/lib/types";

const STORAGE_KEY = "veil-state";

function generateRandomBigInt(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes.reduce(
    (acc, byte, i) => acc | (BigInt(byte) << BigInt(i * 8)),
    0n,
  );
}

function encodeState(state: VeilPrivateState): string {
  const serializable = {
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
  };
  return btoa(JSON.stringify(serializable));
}

function decodeState(encoded: string): VeilPrivateState {
  const parsed = JSON.parse(atob(encoded));
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

function createInitialState(): VeilPrivateState {
  return {
    userSecret: generateRandomBigInt(),
    currentEpoch: 0,
    cumulativeSpending: 0n,
    randomness: generateRandomBigInt(),
    credentials: [],
  };
}

export interface UsePrivateStateReturn {
  readonly state: VeilPrivateState | null;
  readonly isInitialized: boolean;
  readonly updateCumulative: (amount: bigint) => void;
  readonly resetEpoch: (newEpoch: number) => void;
}

export function usePrivateState(): UsePrivateStateReturn {
  const [state, setState] = useState<VeilPrivateState | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setState(decodeState(stored));
      } else {
        const initial = createInitialState();
        localStorage.setItem(STORAGE_KEY, encodeState(initial));
        setState(initial);
      }
    } catch {
      const initial = createInitialState();
      localStorage.setItem(STORAGE_KEY, encodeState(initial));
      setState(initial);
    }
    setIsInitialized(true);
  }, []);

  const persist = useCallback((updated: VeilPrivateState) => {
    setState(updated);
    localStorage.setItem(STORAGE_KEY, encodeState(updated));
  }, []);

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

  const resetEpoch = useCallback(
    (newEpoch: number) => {
      if (!state) return;
      const updated: VeilPrivateState = {
        ...state,
        currentEpoch: newEpoch,
        cumulativeSpending: 0n,
        randomness: generateRandomBigInt(),
      };
      persist(updated);
    },
    [state, persist],
  );

  return { state, isInitialized, updateCumulative, resetEpoch };
}
