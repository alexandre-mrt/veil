"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { type FormEvent, useCallback, useState } from "react";
import { THRESHOLD, VEIL_DECIMALS, EXPLORER_TX_URL } from "@/lib/constants";
import { parseAmountToBigInt } from "@/lib/utils";
import type { VeilPrivateState } from "@/lib/types";
import { useShieldedTransfer } from "@/hooks/useShieldedTransfer";
import type { TransferResult } from "@/hooks/useShieldedTransfer";
import { appendTx } from "@/lib/txHistory";
import { ProofProgress } from "./ProofProgress";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THRESHOLD_WARNING_PCT = 70n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeThresholdPct(spending: bigint, threshold: bigint): bigint {
  if (threshold === 0n) return 100n;
  return (spending * 100n) / threshold;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TransferFormProps {
  readonly privateState: VeilPrivateState | null;
  readonly frozen: boolean;
  readonly onStateUpdate: (cumulativeNew: bigint, newRandomness: bigint) => void;
  readonly onTxAppended?: () => void;
  readonly onSwitchTab?: (tab: "deposit" | "transfer" | "compliant" | "withdraw" | "history" | "admin") => void;
}

export function TransferForm({ privateState, frozen, onStateUpdate, onTxAppended, onSwitchTab }: TransferFormProps) {
  const account = useCurrentAccount();
  const transfer = useShieldedTransfer();

  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<TransferResult | null>(null);

  const spending = privateState?.cumulativeSpending ?? 0n;

  // Check if this transfer would push cumulative over threshold
  const parsedAmount = Number.parseFloat(amount || "0");
  const txAmountRaw = parsedAmount > 0 ? parseAmountToBigInt(amount || "0", VEIL_DECIMALS) : 0n;
  const projectedSpending = spending + txAmountRaw;
  const projectedPct = computeThresholdPct(projectedSpending, THRESHOLD);
  const isApproachingThreshold = projectedPct >= THRESHOLD_WARNING_PCT && projectedPct < 100n;
  const isOverThreshold = projectedPct >= 100n;

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setResult(null);

      if (!privateState) {
        setResult({ success: false, error: "Private state not initialized" });
        return;
      }

      if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
        setResult({ success: false, error: "Invalid amount" });
        return;
      }

      if (!account) {
        setResult({ success: false, error: "Wallet not connected" });
        return;
      }

      if (frozen) {
        setResult({ success: false, error: "Pool is frozen" });
        return;
      }

      if (isOverThreshold) {
        setResult({ success: false, error: "threshold-exceeded" });
        return;
      }

      const txResult = await transfer.executeTransfer(
        privateState,
        txAmountRaw,
        onStateUpdate,
      );

      setResult(txResult);
      if (txResult.success && txResult.digest) {
        appendTx({ type: "transfer", amount: txAmountRaw, digest: txResult.digest });
        onTxAppended?.();
        setAmount("");
      }
    },
    [privateState, parsedAmount, account, frozen, transfer, txAmountRaw, onStateUpdate, onTxAppended],
  );

  const isDisabled =
    transfer.isPending || !account || !amount || frozen || !privateState;

  const showProgress = transfer.step !== "idle" && transfer.step !== "error";

  return (
    <div className={styles.transferForm}>
      <div className={styles.transferFormAccent} />
      <span className={styles.transferTitle}>Shielded Transfer</span>

      {transfer.isMock && (
        <div className={styles.proofMockBanner}>
          [MOCK] Circuit artifacts unavailable — proofs are simulated
        </div>
      )}

      {frozen && (
        <div className={styles.transferFrozenBanner}>
          Pool is frozen. Transfers disabled.
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className={styles.transferInputGroup}>
          <label htmlFor="transfer-amount" className={styles.transferInputLabel}>
            Amount (VEIL)
          </label>
          <input
            id="transfer-amount"
            type="number"
            min="0"
            step="0.000001"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={styles.transferInput}
            disabled={transfer.isPending || frozen}
          />
        </div>

        {isApproachingThreshold && txAmountRaw > 0n && (
          <div className={styles.transferWarning}>
            This transfer will bring you to {projectedPct.toString()}% of the epoch threshold.
            KYC may be required soon.
          </div>
        )}

        {isOverThreshold && txAmountRaw > 0n && (
          <div className={styles.transferDanger}>
            This transfer exceeds the epoch threshold. KYC will be required.{" "}
            <button
              type="button"
              className={styles.switchTabLink}
              onClick={() => onSwitchTab?.("compliant")}
            >
              Switch to Compliant Transfer
            </button>
          </div>
        )}

        <button
          type="submit"
          className={styles.transferSubmitBtn}
          disabled={isDisabled}
        >
          {transfer.isPending ? "Generating Proof..." : "Generate Proof & Transfer"}
        </button>
      </form>

      {showProgress && (
        <ProofProgress
          step={transfer.step}
          progress={transfer.progress}
          isMock={transfer.isMock}
          error={transfer.error}
        />
      )}

      {result && !showProgress && (
        <div
          className={`${styles.transferResult} ${
            result.success
              ? styles.transferResultSuccess
              : styles.transferResultError
          }`}
        >
          {result.success ? (
            <>
              Shielded transfer confirmed.{" "}
              <a
                href={`${EXPLORER_TX_URL}/${result.digest}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.transferResultLink}
              >
                View on Suiscan
              </a>
            </>
          ) : result.error === "threshold-exceeded" ? (
            <>
              Threshold exceeded. Import a KYC credential and use Compliant Transfer mode.{" "}
              <button
                type="button"
                className={styles.switchTabLink}
                onClick={() => onSwitchTab?.("compliant")}
              >
                Switch to Compliant Transfer
              </button>
            </>
          ) : (
            result.error
          )}
        </div>
      )}
    </div>
  );
}
