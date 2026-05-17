"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import type { VeilPrivateState } from "@/lib/types";
import { VEIL_DECIMALS } from "@/lib/constants";
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

export function WithdrawForm({ privateState }: WithdrawFormProps) {
  const account = useCurrentAccount();

  return (
    <div className={styles.withdrawForm}>
      <div className={styles.withdrawFormAccent} />
      <span className={styles.withdrawTitle}>ZK Withdrawal</span>

      <div className={styles.withdrawSpendingInfo}>
        Withdraw funds from the shielded pool using a zero-knowledge proof.
        Your commitment is consumed and a change commitment is created for the remaining balance.
        The withdrawal is bound to your address via the proof — no front-running possible.
      </div>

      {privateState && (
        <div className={styles.withdrawSpendingInfo}>
          Cumulative spending this epoch: {formatSpending(privateState.cumulativeSpending)} VEIL
        </div>
      )}

      <div style={{
        padding: 16, background: "#141414", border: "1px solid #1f1f1f",
        color: "#808080", fontSize: 12, lineHeight: 1.8, marginTop: 8,
      }}>
        <span style={{ color: "#00ff88", fontWeight: 700 }}>How it works:</span>
        <br />
        1. The withdraw circuit proves you own a commitment (Poseidon identity binding)
        <br />
        2. The proof binds to your recipient address (Poseidon tag 8) — cannot be redirected
        <br />
        3. A change commitment is created for remaining balance (partial withdrawal supported)
        <br />
        4. The on-chain contract verifies the Groth16 proof, consumes the UTXO, and transfers tokens
        <br /><br />
        <span style={{ color: "#ffaa00" }}>
          The pool admin must set the withdraw verification key before ZK withdrawals are enabled.
          {!account && " Connect your wallet to check the pool status."}
        </span>
      </div>
    </div>
  );
}
