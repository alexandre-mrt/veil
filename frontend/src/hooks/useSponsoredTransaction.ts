"use client";

import { useCallback, useState } from "react";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SponsoredStep = "idle" | "building" | "sponsoring" | "signing" | "submitting";

interface SponsorResponse {
  readonly txBytes: string;
  readonly sponsor: string;
}

interface SubmitResponse {
  readonly digest: string;
  readonly success: boolean;
  readonly error?: string;
}

export interface SponsoredResult {
  readonly success: boolean;
  readonly digest?: string;
  readonly error?: string;
}

interface UseSponsoredTransactionReturn {
  /**
   * Execute a transaction via the relayer for sender privacy.
   * The relayer pays gas and submits on behalf of the user.
   *
   * @param buildTx Callback that adds Move calls to the transaction (no gas setup needed)
   */
  readonly execute: (buildTx: (tx: Transaction) => void) => Promise<SponsoredResult>;
  readonly step: SponsoredStep;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Relayer server URL. In production, this would be a hosted service.
 * For the hackathon demo, point to the local relayer or leave as placeholder.
 */
const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:3001";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for submitting Veil transactions via the sponsored relayer.
 *
 * This hides the sender's address on-chain: the relayer's address appears
 * as the gas payer / submitter, while the user retains Move-level authorization
 * via their signature.
 *
 * Flow:
 *   1. User builds TransactionKind (Move calls only, no gas)
 *   2. Frontend sends kindBytes to relayer → relayer wraps with gas payment
 *   3. User signs the full TransactionData via wallet
 *   4. Frontend sends txBytes + signature to relayer → relayer co-signs + submits
 *
 * Requires the relayer server running at RELAYER_URL (see scripts/src/relayer.ts).
 */
export function useSponsoredTransaction(): UseSponsoredTransactionReturn {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();

  const [step, setStep] = useState<SponsoredStep>("idle");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep("idle");
    setIsPending(false);
    setError(null);
  }, []);

  const execute = useCallback(
    async (buildTx: (tx: Transaction) => void): Promise<SponsoredResult> => {
      if (!account) {
        return { success: false, error: "Wallet not connected" };
      }

      setIsPending(true);
      setError(null);

      try {
        // Step 1: Build TransactionKind (user's intended operations, no gas)
        setStep("building");
        const tx = new Transaction();
        buildTx(tx);

        const kindBytes = await tx.build({
          client: client.core,
          onlyTransactionKind: true,
        });
        const kindBytesBase64 = toBase64(kindBytes);

        // Step 2: Send to relayer for sponsorship (relayer adds gas payment)
        setStep("sponsoring");
        const sponsorRes = await fetch(`${RELAYER_URL}/sponsor`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kindBytes: kindBytesBase64,
            sender: account.address,
          }),
        });

        if (!sponsorRes.ok) {
          const errBody = await sponsorRes.json().catch(() => ({ error: "Relayer unavailable" }));
          throw new Error(errBody.error ?? `Relayer returned ${sponsorRes.status}`);
        }

        const { txBytes } = (await sponsorRes.json()) as SponsorResponse;

        // Step 3: User signs the full TransactionData via wallet
        setStep("signing");
        const { signature } = await dAppKit.signTransaction({
          transaction: txBytes, // base64 bytes accepted by signTransaction
        });

        // Step 4: Send signed tx to relayer for co-signing + submission
        setStep("submitting");
        const submitRes = await fetch(`${RELAYER_URL}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            txBytes,
            userSignature: signature,
          }),
        });

        if (!submitRes.ok) {
          const errBody = await submitRes.json().catch(() => ({ error: "Submit failed" }));
          throw new Error(errBody.error ?? `Submit returned ${submitRes.status}`);
        }

        const result = (await submitRes.json()) as SubmitResponse;

        if (!result.success) {
          throw new Error(result.error ?? "Transaction execution failed");
        }

        // Wait for finality
        await client.core.waitForTransaction({ digest: result.digest });

        setStep("idle");
        setIsPending(false);
        return { success: true, digest: result.digest };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Sponsored transaction failed";
        setError(message);
        setStep("idle");
        setIsPending(false);
        return { success: false, error: message };
      }
    },
    [account, client, dAppKit],
  );

  return { execute, step, isPending, error, reset };
}
