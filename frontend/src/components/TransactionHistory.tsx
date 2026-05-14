"use client";

import { useEffect, useState } from "react";
import { loadTxHistory, type TxRecord, type TxType } from "@/lib/txHistory";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VEIL_DECIMALS = 6;
const SUISCAN_TX_URL = "https://suiscan.xyz/testnet/tx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(raw: bigint): string {
  const divisor = BigInt(10 ** VEIL_DECIMALS);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(VEIL_DECIMALS, "0").replace(/0+$/, "") || "0";
  return `${whole}.${fracStr}`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date} ${time}`;
}

function truncateDigest(digest: string): string {
  if (digest.length <= 16) return digest;
  return `${digest.slice(0, 8)}...${digest.slice(-6)}`;
}

function txTypeLabel(type: TxType): string {
  switch (type) {
    case "deposit": return "DEPOSIT";
    case "transfer": return "TRANSFER";
    case "withdraw": return "WITHDRAW";
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TransactionHistoryProps {
  // Increment to trigger a reload from localStorage
  readonly refreshKey?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TransactionHistory({ refreshKey = 0 }: TransactionHistoryProps) {
  const [records, setRecords] = useState<TxRecord[]>([]);

  useEffect(() => {
    setRecords(loadTxHistory());
  }, [refreshKey]);

  return (
    <div className={styles.historyPanel}>
      <div className={styles.historyPanelAccent} />
      <div className={styles.historyHeader}>
        <span className={styles.historyTitle}>Transaction History</span>
        <span className={styles.historyCount}>{records.length} / 20</span>
      </div>

      {records.length === 0 ? (
        <div className={styles.historyEmpty}>
          No transactions yet.
        </div>
      ) : (
        <div className={styles.historyTableWrapper}>
          <table className={styles.historyTable}>
            <thead>
              <tr>
                <th className={styles.historyTh}>Type</th>
                <th className={styles.historyTh}>Amount</th>
                <th className={styles.historyTh}>Time</th>
                <th className={styles.historyTh}>Tx Hash</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className={styles.historyRow}>
                  <td className={`${styles.historyTd} ${styles[`historyType_${r.type}`]}`}>
                    {txTypeLabel(r.type)}
                  </td>
                  <td className={styles.historyTd}>
                    {formatAmount(r.amount)} VEIL
                  </td>
                  <td className={`${styles.historyTd} ${styles.historyTimestamp}`}>
                    {formatTimestamp(r.timestamp)}
                  </td>
                  <td className={styles.historyTd}>
                    <a
                      href={`${SUISCAN_TX_URL}/${r.digest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.historyDigestLink}
                      title={r.digest}
                    >
                      {truncateDigest(r.digest)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
