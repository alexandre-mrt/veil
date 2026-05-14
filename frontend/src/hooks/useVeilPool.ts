"use client";

import { useSuiClientQuery } from "@mysten/dapp-kit";

interface PoolFields {
  readonly balance: bigint;
  readonly threshold: bigint;
  readonly frozen: boolean;
}

interface ParsedMoveFields {
  readonly balance?: string | number;
  readonly threshold?: string | number;
  readonly frozen?: boolean;
}

interface UseVeilPoolReturn {
  readonly balance: bigint;
  readonly threshold: bigint;
  readonly frozen: boolean;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

function parsePoolFields(data: unknown): PoolFields | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as { data?: { content?: { fields?: ParsedMoveFields } } };
  const fields = obj.data?.content?.fields;
  if (!fields) return null;

  return {
    balance: BigInt(fields.balance ?? 0),
    threshold: BigInt(fields.threshold ?? 0),
    frozen: fields.frozen ?? false,
  };
}

export function useVeilPool(poolId: string): UseVeilPoolReturn {
  const { data, isLoading, error } = useSuiClientQuery(
    "getObject",
    {
      id: poolId,
      options: { showContent: true },
    },
    {
      enabled: poolId !== "0x0" && poolId.length > 3,
      refetchInterval: 10_000,
    },
  );

  const parsed = parsePoolFields(data);

  return {
    balance: parsed?.balance ?? 0n,
    threshold: parsed?.threshold ?? 0n,
    frozen: parsed?.frozen ?? false,
    isLoading,
    error: error ?? null,
  };
}
