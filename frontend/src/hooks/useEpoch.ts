"use client";

import { useEffect, useState } from "react";
import { EPOCH_DURATION_MS } from "@/lib/constants";

export interface EpochInfo {
  readonly currentEpoch: number;
  readonly epochEnd: number;
  readonly msRemaining: number;
  readonly daysRemaining: number;
  readonly percentElapsed: number;
}

function computeEpoch(): EpochInfo {
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
}

const UPDATE_INTERVAL_MS = 60_000;

export function useEpoch(): EpochInfo {
  const [epoch, setEpoch] = useState<EpochInfo>(computeEpoch);

  useEffect(() => {
    const interval = setInterval(() => {
      setEpoch(computeEpoch());
    }, UPDATE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  return epoch;
}
