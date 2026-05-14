"use client";

import { useMemo } from "react";

const EPOCH_DURATION_MS = 2_592_000_000; // 30 days in milliseconds

export interface EpochInfo {
  readonly currentEpoch: number;
  readonly epochEnd: number;
  readonly msRemaining: number;
  readonly daysRemaining: number;
  readonly percentElapsed: number;
}

export function useEpoch(): EpochInfo {
  return useMemo(() => {
    const now = Date.now();
    const currentEpoch = Math.floor(now / EPOCH_DURATION_MS);
    const epochStart = currentEpoch * EPOCH_DURATION_MS;
    const epochEnd = (currentEpoch + 1) * EPOCH_DURATION_MS;
    const msRemaining = epochEnd - now;
    const daysRemaining = Math.ceil(msRemaining / 86_400_000);
    const msElapsed = now - epochStart;
    const percentElapsed = Math.min(
      100,
      Math.floor((msElapsed / EPOCH_DURATION_MS) * 100),
    );

    return { currentEpoch, epochEnd, msRemaining, daysRemaining, percentElapsed };
  }, []);
}
