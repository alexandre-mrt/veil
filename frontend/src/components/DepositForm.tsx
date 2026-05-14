"use client";

import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { type FormEvent, useCallback, useState } from "react";
import { PACKAGE_ID, POOL_ID } from "@/lib/constants";
import { appendTx } from "@/lib/txHistory";
import styles from "./components.module.css";

const VEIL_DECIMALS = 6;
const SUISCAN_TX_URL = "https://suiscan.xyz/testnet/tx";

interface TxResult {
  readonly success: boolean;
  readonly digest?: string;
  readonly error?: string;
}

interface DepositFormProps {
  readonly onTxAppended?: () => void;
}

export function DepositForm({ onTxAppended }: DepositFormProps) {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute, isPending } =
    useSignAndExecuteTransaction();
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<TxResult | null>(null);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setResult(null);

      const parsed = Number.parseFloat(amount);
      if (Number.isNaN(parsed) || parsed <= 0) {
        setResult({ success: false, error: "Invalid amount" });
        return;
      }

      if (!account) {
        setResult({ success: false, error: "Wallet not connected" });
        return;
      }

      const amountRaw = BigInt(Math.floor(parsed * 10 ** VEIL_DECIMALS));

      try {
        const tx = new Transaction();

        // REVIEW: deposit takes Coin<TOKEN>, not Coin<SUI>.
        // Once PACKAGE_ID is deployed and users have TOKEN coins, replace
        // tx.gas with a split from the user's TOKEN coin objects.
        // For MVP scaffolding we build the PTB structure correctly.
        const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountRaw)]);
        tx.moveCall({
          target: `${PACKAGE_ID}::pool::deposit`,
          arguments: [tx.object(POOL_ID), depositCoin],
        });

        const txResult = await signAndExecute({ transaction: tx });

        appendTx({ type: "deposit", amount: amountRaw, digest: txResult.digest });
        onTxAppended?.();
        setResult({ success: true, digest: txResult.digest });
        setAmount("");
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Transaction failed";
        setResult({ success: false, error: message });
      }
    },
    [amount, account, signAndExecute, onTxAppended],
  );

  const isDisabled = isPending || !account || !amount;

  return (
    <form className={styles.depositForm} onSubmit={handleSubmit}>
      <div className={styles.depositFormAccent} />
      <span className={styles.depositTitle}>Deposit</span>

      <div className={styles.depositInputGroup}>
        <label htmlFor="deposit-amount" className={styles.depositInputLabel}>
          Amount (VEIL)
        </label>
        <input
          id="deposit-amount"
          type="number"
          min="0"
          step="0.000001"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={styles.depositInput}
          disabled={isPending}
        />
      </div>

      <button
        type="submit"
        className={styles.depositSubmitBtn}
        disabled={isDisabled}
      >
        {isPending ? "Signing..." : "Deposit to Pool"}
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
              Transaction confirmed.{" "}
              <a
                href={`${SUISCAN_TX_URL}/${result.digest}`}
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
