"use client";

import { useCallback, useState } from "react";
import { VEIL_DECIMALS, EXPLORER_TX_URL } from "@/lib/constants";
import { useDepositAndRegister } from "@/hooks/useDepositAndRegister";
import type { VeilPrivateState } from "@/lib/types";
import { appendTx } from "@/lib/txHistory";
import styles from "./components.module.css";

interface Denomination {
  readonly label: string;
  readonly raw: bigint;
}

const DENOMINATIONS: readonly Denomination[] = [
  { label: "100", raw: 100_000_000n },
  { label: "500", raw: 500_000_000n },
  { label: "1000", raw: 1_000_000_000n },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TxResult {
  readonly success: boolean;
  readonly digest?: string;
  readonly error?: string;
}

interface DepositFormProps {
  readonly privateState: VeilPrivateState | null;
  readonly onTxAppended?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DepositForm({ privateState, onTxAppended }: DepositFormProps) {
  const { executeDeposit, step, isPending, reset } =
    useDepositAndRegister();

  const [selectedDenom, setSelectedDenom] = useState<bigint>(
    DENOMINATIONS[0].raw,
  );
  const [result, setResult] = useState<TxResult | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setResult(null);
      reset();

      if (!privateState) {
        setResult({ success: false, error: "Private state not initialized" });
        return;
      }

      const depositResult = await executeDeposit(privateState, selectedDenom);

      if (depositResult.success && depositResult.digest) {
        appendTx({
          type: "deposit",
          amount: selectedDenom,
          digest: depositResult.digest,
        });
        onTxAppended?.();
      }

      setResult(depositResult);
    },
    [privateState, selectedDenom, executeDeposit, reset, onTxAppended],
  );

  const isDisabled = isPending || !privateState;

  const stepLabel = (): string => {
    switch (step) {
      case "computing-commitment":
        return "Computing commitment...";
      case "submitting-tx":
        return "Signing transaction...";
      case "done":
        return "Done";
      default:
        return "Deposit & Register";
    }
  };

  const displayAmount = (raw: bigint): string => {
    const str = raw.toString().padStart(VEIL_DECIMALS + 1, "0");
    const whole = str.slice(0, -VEIL_DECIMALS);
    const frac = str.slice(-VEIL_DECIMALS).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  };

  return (
    <form className={styles.depositForm} onSubmit={handleSubmit}>
      <div className={styles.depositFormAccent} />
      <span className={styles.depositTitle}>Deposit & Register</span>

      <div className={styles.depositInputGroup}>
        <label className={styles.depositInputLabel}>
          Amount (VEIL) — standard denominations only
        </label>
        <div className={styles.denomSelector}>
          {DENOMINATIONS.map((d) => (
            <button
              key={d.label}
              type="button"
              className={`${styles.denomBtn} ${
                selectedDenom === d.raw ? styles.denomBtnActive : ""
              }`}
              onClick={() => setSelectedDenom(d.raw)}
              disabled={isPending}
            >
              {displayAmount(d.raw)} VEIL
            </button>
          ))}
        </div>
      </div>

      {step !== "idle" && step !== "done" && step !== "error" && (
        <div className={styles.depositStepIndicator}>
          {stepLabel()}
        </div>
      )}

      <button
        type="submit"
        className={styles.depositSubmitBtn}
        disabled={isDisabled}
      >
        {isPending ? stepLabel() : "Deposit & Register"}
      </button>

      {result && (
        <div
          className={`${styles.depositResult} ${
            result.success
              ? styles.depositResultSuccess
              : styles.depositResultError
          }`}
        >
          {result.success ? (
            <>
              Deposit confirmed — genesis commitment registered.{" "}
              <a
                href={`${EXPLORER_TX_URL}/${result.digest}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.depositResultLink}
              >
                View on Suiscan
              </a>
            </>
          ) : (
            result.error
          )}
        </div>
      )}
    </form>
  );
}
