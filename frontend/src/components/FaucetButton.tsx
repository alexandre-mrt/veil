"use client";
import { useCallback, useState } from "react";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, TREASURY_CAP_ID } from "@/lib/constants";
import styles from "./FaucetButton.module.css";

export function FaucetButton() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKitInstance = useDAppKit();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFaucet = useCallback(async () => {
    if (!account || !TREASURY_CAP_ID) return;
    setLoading(true);
    setSuccess(false);
    setError(null);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::token::faucet`,
        arguments: [tx.object(TREASURY_CAP_ID)],
      });
      const txResult = await dAppKitInstance.signAndExecuteTransaction({ transaction: tx });

      if (txResult.FailedTransaction) {
        throw new Error(
          txResult.FailedTransaction.status.error?.message ?? "Transaction failed",
        );
      }

      // Wait for transaction finality
      await client.core.waitForTransaction({ digest: txResult.Transaction.digest });

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Faucet request failed";
      setError(message);
      setTimeout(() => setError(null), 5000);
    } finally {
      setLoading(false);
    }
  }, [account, client, dAppKitInstance]);

  if (!account) return null;

  return (
    <div>
      <button
        className={`${styles.btn} ${success ? styles.success : ""} ${error ? styles.error : ""}`}
        onClick={handleFaucet}
        disabled={loading || !TREASURY_CAP_ID}
      >
        {loading ? "MINTING..." : success ? "1000 VEIL RECEIVED" : "+ FAUCET"}
      </button>
      {error && <div className={styles.errorMsg}>{error}</div>}
    </div>
  );
}
