"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { type FormEvent, useCallback, useState } from "react";
import { VEIL_DECIMALS, EXPLORER_TX_URL } from "@/lib/constants";
import { parseAmountToBigInt } from "@/lib/utils";
import type { VeilPrivateState } from "@/lib/types";
import { useWithdraw } from "@/hooks/useWithdraw";
import { appendTx } from "@/lib/txHistory";
import styles from "./components.module.css";

function formatSpending(value: bigint): string {
  const divisor = 10n ** BigInt(VEIL_DECIMALS);
  const whole = value / divisor;
  const frac = value % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(VEIL_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${fracStr.slice(0, 4)}`;
}

interface WithdrawFormProps {
  readonly privateState?: VeilPrivateState | null;
  readonly onTxAppended?: () => void;
}

export function WithdrawForm({ privateState, onTxAppended }: WithdrawFormProps) {
  const account = useCurrentAccount();
  const { withdraw, isPending } = useWithdraw();

  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [result, setResult] = useState<{ success: boolean; digest?: string; error?: string } | null>(null);

  const effectiveRecipient = recipient.trim() || account?.address || "";

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setResult(null);

      if (!account) {
        setResult({ success: false, error: "Wallet not connected" });
        return;
      }

      const parsed = Number.parseFloat(amount);
      if (Number.isNaN(parsed) || parsed <= 0) {
        setResult({ success: false, error: "Invalid amount" });
        return;
      }

      if (!effectiveRecipient) {
        setResult({ success: false, error: "No recipient address" });
        return;
      }

      const amountRaw = parseAmountToBigInt(amount, VEIL_DECIMALS);

      const txResult = await withdraw(amountRaw, effectiveRecipient);
      setResult(txResult);

      if (txResult.success && txResult.digest) {
        appendTx({ type: "withdraw", amount: amountRaw, digest: txResult.digest });
        onTxAppended?.();
        setAmount("");
        setRecipient("");
      }
    },
    [account, amount, effectiveRecipient, withdraw, onTxAppended],
  );

  const isDisabled = isPending || !account || !amount;

  return (
    <div className={styles.withdrawForm}>
      <div className={styles.withdrawFormAccent} />
      <span className={styles.withdrawTitle}>ZK Withdrawal</span>

      <div className={styles.withdrawSpendingInfo}>
        Withdraw funds from the shielded pool using a zero-knowledge proof.
        Your commitment is consumed and tokens are sent to the specified recipient.
        {privateState && (
          <> Cumulative spending this epoch: {formatSpending(privateState.cumulativeSpending)} VEIL</>
        )}
      </div>

      <div className={styles.withdrawInputGroup}>
        <label htmlFor="withdraw-amount" className={styles.withdrawInputLabel}>
          Amount (VEIL)
        </label>
        <input
          id="withdraw-amount"
          type="number"
          min="0"
          step="0.000001"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={styles.withdrawInput}
          disabled={isPending}
        />
      </div>

      <div className={styles.withdrawInputGroup}>
        <label htmlFor="withdraw-recipient" className={styles.withdrawInputLabel}>
          Recipient address (default: your wallet)
        </label>
        <input
          id="withdraw-recipient"
          type="text"
          placeholder={account?.address ?? "0x..."}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          className={styles.withdrawInput}
          disabled={isPending}
        />
      </div>

      <button
        type="button"
        className={styles.withdrawSubmitBtn}
        disabled={isDisabled}
        onClick={(e) => handleSubmit(e as unknown as FormEvent)}
      >
        {isPending ? "Generating proof..." : "Withdraw"}
      </button>

      {result && (
        <div
          className={`${styles.withdrawResult} ${
            result.success ? styles.withdrawResultSuccess : styles.withdrawResultError
          }`}
        >
          {result.success ? (
            <>
              Withdrawal confirmed.{" "}
              <a
                href={`${EXPLORER_TX_URL}/${result.digest}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.withdrawResultLink}
              >
                View on Suiscan
              </a>
            </>
          ) : (
            result.error
          )}
        </div>
      )}
    </div>
  );
}
