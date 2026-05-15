"use client";

import type { AdminSubComponentProps } from "./types";
import { formatBalance } from "./types";
import styles from "../components.module.css";

// ---------------------------------------------------------------------------
// Pool status display: balance, frozen, compliance required, pending states
// ---------------------------------------------------------------------------

export function AdminPoolStatus({
  pool,
  isLoading,
}: Pick<AdminSubComponentProps, "pool" | "isLoading">) {
  const hasPendingVk = (pool?.pendingVk.length ?? 0) > 0;
  const hasPendingWithdrawal = pool?.pendingWithdrawalAmount != null;
  const hasPendingComplianceToggle = pool?.pendingComplianceRequired != null;

  return (
    <div className={styles.adminSection}>
      <span className={styles.adminSectionTitle}>Pool Status</span>
      <div className={styles.adminRows}>
        <div className={styles.adminRow}>
          <span className={styles.adminRowLabel}>Balance</span>
          <span className={styles.adminRowValue}>
            {isLoading
              ? "..."
              : pool
                ? `${formatBalance(pool.balance)} VEIL`
                : "---"}
          </span>
        </div>
        <div className={styles.adminRow}>
          <span className={styles.adminRowLabel}>Frozen</span>
          <span
            className={`${styles.adminRowValue} ${pool?.frozen ? styles.adminValueDanger : styles.adminValueAccent}`}
          >
            {isLoading ? "..." : pool ? (pool.frozen ? "YES" : "NO") : "---"}
          </span>
        </div>
        <div className={styles.adminRow}>
          <span className={styles.adminRowLabel}>Compliance Required</span>
          <span
            className={`${styles.adminRowValue} ${pool?.complianceRequired ? styles.adminValueAccent : ""}`}
          >
            {isLoading
              ? "..."
              : pool
                ? pool.complianceRequired
                  ? "YES"
                  : "NO"
                : "---"}
          </span>
        </div>
        {hasPendingVk && (
          <div className={styles.adminRow}>
            <span className={styles.adminRowLabel}>Pending VK Update</span>
            <span
              className={`${styles.adminRowValue} ${styles.adminValueWarning}`}
            >
              Epoch {pool?.vkUpdateEpoch}
            </span>
          </div>
        )}
        {hasPendingWithdrawal && (
          <div className={styles.adminRow}>
            <span className={styles.adminRowLabel}>Pending Withdrawal</span>
            <span
              className={`${styles.adminRowValue} ${styles.adminValueWarning}`}
            >
              {formatBalance(pool.pendingWithdrawalAmount!)} VEIL &rarr;{" "}
              {pool.pendingWithdrawalRecipient?.slice(0, 8)}... (epoch{" "}
              {pool.pendingWithdrawalEpoch})
            </span>
          </div>
        )}
        {hasPendingComplianceToggle && (
          <div className={styles.adminRow}>
            <span className={styles.adminRowLabel}>
              Pending Compliance Toggle
            </span>
            <span
              className={`${styles.adminRowValue} ${styles.adminValueWarning}`}
            >
              {pool.pendingComplianceRequired ? "Enable" : "Disable"} (epoch{" "}
              {pool.pendingComplianceEpoch})
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
