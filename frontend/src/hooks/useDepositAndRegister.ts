"use client";

import { useCallback, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClientQuery,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, POOL_ID, TOKEN_TYPE } from "@/lib/constants";
import type { VeilPrivateState } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DepositStep =
  | "idle"
  | "computing-commitment"
  | "submitting-tx"
  | "done"
  | "error";

export interface DepositResult {
  readonly success: boolean;
  readonly digest?: string;
  readonly error?: string;
}

interface UseDepositAndRegisterReturn {
  readonly executeDeposit: (
    privateState: VeilPrivateState,
    amount: bigint,
  ) => Promise<DepositResult>;
  readonly step: DepositStep;
  readonly isPending: boolean;
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUI_CLOCK_OBJECT_ID = "0x6";
const DOMAIN_COMMITMENT = 1n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamically imports a module by name, bypassing webpack static analysis.
 * This prevents build failures when optional dependencies are not installed.
 */
async function dynamicRequire(moduleName: string): Promise<unknown> {
  // Using Function constructor to create a dynamic import that webpack cannot
  // statically analyze, allowing optional dependencies to be missing at build time.
  // eslint-disable-next-line no-new-func
  const importFn = new Function("m", "return import(m)") as (
    m: string,
  ) => Promise<unknown>;
  return importFn(moduleName);
}

/**
 * Converts a bigint to a 32-byte little-endian Uint8Array.
 * Matches the encoding used on-chain (same as proof-converter bigintToLE32).
 */
function bigintToLE32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

interface PoseidonInstance {
  (inputs: bigint[]): unknown;
  F: { toObject: (v: unknown) => bigint };
}

/**
 * Computes the genesis commitment: Poseidon(DOMAIN_COMMITMENT, 0, 0, userSecret).
 * This is the initial commitment for a fresh private state (cumulativeSpending=0, randomness=0).
 */
async function computeGenesisCommitment(
  userSecret: bigint,
): Promise<Uint8Array> {
  const circomlibjs = (await dynamicRequire("circomlibjs")) as {
    buildPoseidon: () => Promise<PoseidonInstance>;
  };

  const poseidon: PoseidonInstance = await circomlibjs.buildPoseidon();
  const F = poseidon.F;

  // Genesis commitment: Poseidon(1, 0, 0, userSecret)
  // domain=1 (DOMAIN_COMMITMENT), cumulativeSpending=0, randomness=0, userSecret
  const commitmentField = F.toObject(
    poseidon([DOMAIN_COMMITMENT, 0n, 0n, userSecret]),
  );

  return bigintToLE32(commitmentField);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDepositAndRegister(): UseDepositAndRegisterReturn {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [step, setStep] = useState<DepositStep>("idle");
  const [isPending, setIsPending] = useState(false);

  const { data: tokenCoins } = useSuiClientQuery(
    "getCoins",
    { owner: account?.address ?? "", coinType: TOKEN_TYPE },
    { enabled: !!account },
  );

  const reset = useCallback(() => {
    setStep("idle");
    setIsPending(false);
  }, []);

  const executeDeposit = useCallback(
    async (
      privateState: VeilPrivateState,
      amount: bigint,
    ): Promise<DepositResult> => {
      if (!account) {
        return { success: false, error: "Wallet not connected" };
      }

      const tokenCoinId = tokenCoins?.data?.[0]?.coinObjectId;
      if (!tokenCoinId) {
        return {
          success: false,
          error: "No VEIL tokens found. Use the faucet first.",
        };
      }

      setIsPending(true);
      setStep("computing-commitment");

      try {
        // Step 1: Compute genesis commitment
        const commitmentBytes = await computeGenesisCommitment(
          privateState.userSecret,
        );

        // Step 2: Build and submit PTB
        setStep("submitting-tx");

        const tx = new Transaction();
        const coin = tx.splitCoins(tx.object(tokenCoinId), [
          tx.pure.u64(amount),
        ]);

        tx.moveCall({
          target: `${PACKAGE_ID}::pool::deposit_and_register`,
          arguments: [
            tx.object(POOL_ID),
            coin[0],
            tx.pure.vector("u8", Array.from(commitmentBytes)),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
        });

        const txResult = await signAndExecute({ transaction: tx });

        setStep("done");
        setIsPending(false);

        return { success: true, digest: txResult.digest };
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Deposit transaction failed";
        setStep("error");
        setIsPending(false);
        return { success: false, error: message };
      }
    },
    [account, signAndExecute, tokenCoins],
  );

  return { executeDeposit, step, isPending, reset };
}
