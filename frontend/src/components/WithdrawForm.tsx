"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { type FormEvent, useCallback, useState } from "react";
import { VEIL_DECIMALS, EXPLORER_TX_URL } from "@/lib/constants";
import { parseAmountToBigInt } from "@/lib/utils";
import type { VeilPrivateState } from "@/lib/types";
import { useWithdraw } from "@/hooks/useWithdraw";
import { appendTx } from "@/lib/txHistory";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSpending(value: bigint): string {
  const divisor = 10n ** BigInt(VEIL_DECIMALS);
  const whole = value / divisor;
  const frac = value % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(VEIL_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${fracStr.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WithdrawFormProps {
  readonly privateState?: VeilPrivateState | null;
  readonly onTxAppended?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WithdrawForm({ privateState, onTxAppended }: WithdrawFormProps) {
  const account = useCurrentAccount();
  const { withdraw, isPending } = useWithdraw();

  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [showAdminForm, setShowAdminForm] = useState(false);
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
      <span className={styles.withdrawTitle}>Withdraw</span>

      <div className={styles.withdrawTier2Banner}>
        ZK-proof withdrawal is coming in Tier 2. Private withdrawals will use zero-knowledge proofs to unshield funds without revealing the sender.
      </div>

      {privateState && (
        <div className={styles.withdrawSpendingInfo}>
          Your cumulative spending this epoch: {formatSpending(privateState.cumulativeSpending)} VEIL
        </div>
      )}

      <div className={styles.withdrawAdminNotice}>
        For emergency withdrawal, contact the pool admin. Only the admin can process withdrawals in the current version.
      </div>

      <label className={styles.withdrawAdminToggle}>
        <input
          type="checkbox"
          checked={showAdminForm}
          onChange={(e) => setShowAdminForm(e.target.checked)}
        />
        Admin Access
      </label>

      {showAdminForm && (
        <>
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
        </>
      )}
    </div>
  );
}
