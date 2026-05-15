"use client";
import { useCallback, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, TREASURY_CAP_ID } from "@/lib/constants";
import styles from "./FaucetButton.module.css";

export function FaucetButton() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleFaucet = useCallback(async () => {
    if (!account || !TREASURY_CAP_ID) return;
    setLoading(true);
    setSuccess(false);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::token::faucet`,
        arguments: [tx.object(TREASURY_CAP_ID)],
      });
      await signAndExecute({ transaction: tx });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      console.error("Faucet error:", e);
    } finally {
      setLoading(false);
    }
  }, [account, signAndExecute]);

  if (!account) return null;

  return (
    <button
      className={`${styles.btn} ${success ? styles.success : ""}`}
      onClick={handleFaucet}
      disabled={loading || !TREASURY_CAP_ID}
    >
      {loading ? "MINTING..." : success ? "1000 VEIL RECEIVED" : "+ FAUCET"}
    </button>
  );
}
