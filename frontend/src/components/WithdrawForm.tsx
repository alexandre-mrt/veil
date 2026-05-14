"use client";

import { useCurrentAccount } from "@mysten/dapp-kit";
import { type FormEvent, useCallback, useState } from "react";
import { useWithdraw } from "@/hooks/useWithdraw";
import { appendTx } from "@/lib/txHistory";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VEIL_DECIMALS = 6;
const SUISCAN_TX_URL = "https://suiscan.xyz/testnet/tx";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WithdrawFormProps {
  readonly onTxAppended?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WithdrawForm({ onTxAppended }: WithdrawFormProps) {
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

      const amountRaw = BigInt(Math.floor(parsed * 10 ** VEIL_DECIMALS));

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
    <form className={styles.withdrawForm} onSubmit={handleSubmit}>
      <div className={styles.withdrawFormAccent} />
      <span className={styles.withdrawTitle}>Withdraw</span>

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
        type="submit"
        className={styles.withdrawSubmitBtn}
        disabled={isDisabled}
      >
        {isPending ? "Signing..." : "Withdraw from Pool"}
      </button>

      {result && (
        <div
          className={`${styles.withdrawResult} ${
            result.success
              ? styles.withdrawResultSuccess
              : styles.withdrawResultError
          }`}
        >
          {result.success ? (
            <>
              Withdrawal confirmed.{" "}
              <a
                href={`${SUISCAN_TX_URL}/${result.digest}`}
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
    </form>
  );
}
