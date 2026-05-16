"use client";

import { useCallback, useEffect, useState } from "react";
import { useCurrentClient } from "@mysten/dapp-kit-react";
import { EPOCH_DURATION_MS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpochInfo {
  readonly currentEpoch: number;
  readonly epochEnd: number;
  readonly msRemaining: number;
  readonly daysRemaining: number;
  readonly percentElapsed: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sui shared Clock object ID */
const CLOCK_OBJECT_ID = "0x6";

function computeEpochFromTimestamp(timestampMs: number): EpochInfo {
  const currentEpoch = Math.floor(timestampMs / EPOCH_DURATION_MS);
  const epochStart = currentEpoch * EPOCH_DURATION_MS;
  const epochEnd = (currentEpoch + 1) * EPOCH_DURATION_MS;
  const msRemaining = epochEnd - timestampMs;
  const daysRemaining = Math.ceil(msRemaining / 86_400_000);
  const msElapsed = timestampMs - epochStart;
  const percentElapsed = Math.min(
    100,
    Math.floor((msElapsed / EPOCH_DURATION_MS) * 100),
  );

  return { currentEpoch, epochEnd, msRemaining, daysRemaining, percentElapsed };
}

function computeEpochLocal(): EpochInfo {
  return computeEpochFromTimestamp(Date.now());
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const UPDATE_INTERVAL_MS = 60_000;

export function useEpoch(): EpochInfo {
  const client = useCurrentClient();
  const [epoch, setEpoch] = useState<EpochInfo>(computeEpochLocal);

  const fetchOnChainEpoch = useCallback(async () => {
    if (!client) {
      setEpoch(computeEpochLocal());
      return;
    }

    try {
      const clockObj = await client.core.getObject({
        objectId: CLOCK_OBJECT_ID,
        include: { json: true },
      });
      const json = clockObj.object.json as Record<string, unknown> | null;
      const timestampMs = json?.timestamp_ms;
      if (timestampMs != null) {
        setEpoch(computeEpochFromTimestamp(Number(timestampMs)));
        return;
      }
    } catch {
      // Fallback to local time on any RPC error
    }

    setEpoch(computeEpochLocal());
  }, [client]);

  useEffect(() => {
    fetchOnChainEpoch();
    const interval = setInterval(fetchOnChainEpoch, UPDATE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchOnChainEpoch]);

  return epoch;
}
