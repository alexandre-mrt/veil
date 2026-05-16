"use client";

import { useEffect, useState } from "react";
import { useCurrentClient } from "@mysten/dapp-kit-react";
import { REFETCH_INTERVAL_MS } from "@/lib/constants";

interface PoolFields {
  readonly balance: bigint;
  readonly threshold: bigint;
  readonly frozen: boolean;
  readonly nextLeafIndex: number;
}

interface UseVeilPoolReturn {
  readonly balance: bigint;
  readonly threshold: bigint;
  readonly frozen: boolean;
  readonly nextLeafIndex: number;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

function parsePoolJson(json: Record<string, unknown> | null | undefined): PoolFields | null {
  if (!json) return null;
  return {
    balance: BigInt((json.balance as string | number) ?? 0),
    threshold: BigInt((json.threshold as string | number) ?? 0),
    frozen: (json.frozen as boolean) ?? false,
    nextLeafIndex: Number((json.next_leaf_index as string | number) ?? 0),
  };
}

export function useVeilPool(poolId: string): UseVeilPoolReturn {
  const client = useCurrentClient();

  const [poolFields, setPoolFields] = useState<PoolFields | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const enabled = poolId !== "0x0" && poolId.length > 3;

  useEffect(() => {
    if (!enabled || !client) return;

    let cancelled = false;

    async function fetchPool() {
      setIsLoading(true);
      try {
        const result = await client.core.getObject({
          objectId: poolId,
          include: { json: true },
        });
        if (cancelled) return;
        const parsed = parsePoolJson(result.object.json as Record<string, unknown> | null);
        setPoolFields(parsed);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error("Failed to fetch pool"));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchPool();
    const interval = setInterval(fetchPool, REFETCH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, poolId, client]);

  return {
    balance: poolFields?.balance ?? 0n,
    threshold: poolFields?.threshold ?? 0n,
    frozen: poolFields?.frozen ?? false,
    nextLeafIndex: poolFields?.nextLeafIndex ?? 0,
    isLoading,
    error,
  };
}
