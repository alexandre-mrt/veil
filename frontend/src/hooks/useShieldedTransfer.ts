"use client";

import { useCallback, useState } from "react";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, POOL_ID, THRESHOLD, EPOCH_DURATION_MS } from "@/lib/constants";
import type { VeilPrivateState } from "@/lib/types";
import { useProofGeneration } from "./useProofGeneration";
import type { ProofStep } from "./useProofGeneration";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransferStep = ProofStep | "submitting-tx";

export interface TransferResult {
  readonly success: boolean;
  readonly digest?: string;
  readonly error?: string;
}

interface UseShieldedTransferReturn {
  readonly executeTransfer: (
    privateState: VeilPrivateState,
    txAmount: bigint,
    onStateUpdate: (cumulativeNew: bigint, newRandomness: bigint) => void,
  ) => Promise<TransferResult>;
  readonly step: TransferStep;
  readonly progress: number;
  readonly error: string | null;
  readonly isMock: boolean;
  readonly isPending: boolean;
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUI_CLOCK_OBJECT_ID = "0x6";

function getCurrentEpochId(): bigint {
  return BigInt(Math.floor(Date.now() / Number(EPOCH_DURATION_MS)));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useShieldedTransfer(): UseShieldedTransferReturn {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKitInstance = useDAppKit();
  const proofGen = useProofGeneration();

  const [txStep, setTxStep] = useState<TransferStep>("idle");
  const [isPending, setIsPending] = useState(false);

  // Derive step: show proof gen steps, then tx submission step
  const currentStep: TransferStep =
    txStep === "submitting-tx" ? "submitting-tx" : proofGen.step;

  const currentProgress =
    txStep === "submitting-tx" ? 90 : proofGen.progress;

  const reset = useCallback(() => {
    proofGen.reset();
    setTxStep("idle");
    setIsPending(false);
  }, [proofGen]);

  const executeTransfer = useCallback(
    async (
      privateState: VeilPrivateState,
      txAmount: bigint,
      onStateUpdate: (cumulativeNew: bigint, newRandomness: bigint) => void,
    ): Promise<TransferResult> => {
      if (!account) {
        return { success: false, error: "Wallet not connected" };
      }

      setIsPending(true);
      setTxStep("idle");

      try {
        // Step 1: Generate ZK proof
        const proofResult = await proofGen.generateTransferProof(
          privateState,
          txAmount,
          getCurrentEpochId(),
          THRESHOLD,
        );

        if (!proofResult) {
          setIsPending(false);
          return {
            success: false,
            error: proofGen.error ?? "Proof generation failed",
          };
        }

        // Step 2: Build and submit PTB
        setTxStep("submitting-tx");

        const tx = new Transaction();
        tx.moveCall({
          target: `${PACKAGE_ID}::pool::shielded_transfer`,
          arguments: [
            tx.object(POOL_ID),
            tx.pure.vector("u8", Array.from(proofResult.proof)),
            tx.pure.vector("u8", Array.from(proofResult.publicInputs)),
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
        });

        const txResult = await dAppKitInstance.signAndExecuteTransaction({ transaction: tx });

        if (txResult.FailedTransaction) {
          throw new Error(
            txResult.FailedTransaction.status.error?.message ?? "Transaction failed",
          );
        }

        const digest = txResult.Transaction.digest;

        // Wait for transaction finality before updating state
        await client.core.waitForTransaction({ digest });

        // Step 3: Update private state on success
        onStateUpdate(proofResult.cumulativeNew, proofResult.newRandomness);

        setTxStep("idle");
        setIsPending(false);

        return { success: true, digest };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Transfer failed";
        setTxStep("idle");
        setIsPending(false);
        return { success: false, error: message };
      }
    },
    [account, client, dAppKitInstance, proofGen],
  );

  return {
    executeTransfer,
    step: currentStep,
    progress: currentProgress,
    error: proofGen.error,
    isMock: proofGen.isMock,
    isPending,
    reset,
  };
}
