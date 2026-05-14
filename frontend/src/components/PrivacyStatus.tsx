"use client";

import type { PrivacyTier } from "@/lib/types";
import styles from "./components.module.css";

interface PrivacyStatusProps {
  readonly cumulativeSpending: bigint;
  readonly threshold: bigint;
}

function computePercentage(spending: bigint, threshold: bigint): number {
  if (threshold === 0n) return 100;
  const pct = Number((spending * 10000n) / threshold) / 100;
  return Math.min(pct, 100);
}

// Re-check the tier logic more precisely:
// < 70% → anonymous, 70-99% → approaching, >= 100% → kyc-required
function getTierInfo(spending: bigint, threshold: bigint) {
  if (threshold === 0n) {
    return {
      tier: "kyc-required" as PrivacyTier,
      label: "KYC Required",
      dotClass: styles.statusDotDanger,
      labelClass: styles.statusLabelDanger,
      barClass: styles.progressBarDanger,
    };
  }
  const pct = computePercentage(spending, threshold);
  if (pct >= 100) {
    return {
      tier: "kyc-required" as PrivacyTier,
      label: "KYC Required",
      dotClass: styles.statusDotDanger,
      labelClass: styles.statusLabelDanger,
      barClass: styles.progressBarDanger,
    };
  }
  if (pct >= 70) {
    return {
      tier: "anonymous" as PrivacyTier,
      label: "Approaching Limit",
      dotClass: styles.statusDotWarning,
      labelClass: styles.statusLabelWarning,
      barClass: styles.progressBarWarning,
    };
  }
  return {
    tier: "anonymous" as PrivacyTier,
    label: "Anonymous",
    dotClass: styles.statusDotAnonymous,
    labelClass: styles.statusLabelAnonymous,
    barClass: styles.progressBarAnonymous,
  };
}

/** Compact inline status indicator (for header) */
export function PrivacyStatusBadge({
  cumulativeSpending,
  threshold,
}: PrivacyStatusProps) {
  const info = getTierInfo(cumulativeSpending, threshold);

  return (
    <div className={styles.privacyStatus}>
      <span className={`${styles.statusDot} ${info.dotClass}`} />
      <span className={`${styles.statusLabel} ${info.labelClass}`}>
        {info.label}
      </span>
    </div>
  );
}

/** Expanded panel with progress bar (for dashboard) */
export function PrivacyStatusPanel({
  cumulativeSpending,
  threshold,
}: PrivacyStatusProps) {
  const info = getTierInfo(cumulativeSpending, threshold);
  const pct = computePercentage(cumulativeSpending, threshold);
  const spendingDisplay = formatAmount(cumulativeSpending);
  const thresholdDisplay = formatAmount(threshold);

  return (
    <div className={styles.privacyPanel}>
      <div
        className={styles.privacyPanelAccent}
        style={{ backgroundColor: getAccentColor(info.tier, pct) }}
      />
      <div className={styles.privacyPanelHeader}>
        <span className={styles.privacyPanelTitle}>Spending Tracker</span>
        <PrivacyStatusBadge
          cumulativeSpending={cumulativeSpending}
          threshold={threshold}
        />
      </div>
      <div className={styles.progressBarTrack}>
        <div
          className={`${styles.progressBarFill} ${info.barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={styles.progressText}>
        {spendingDisplay}/{thresholdDisplay} VEIL ({pct.toFixed(1)}%)
      </span>
    </div>
  );
}

function getAccentColor(_tier: PrivacyTier, pct: number): string {
  if (pct >= 100) return "var(--danger)";
  if (pct >= 70) return "var(--warning)";
  return "var(--accent)";
}

/** Format bigint amount assuming 6 decimals */
function formatAmount(value: bigint): string {
  const DECIMALS = 6n;
  const divisor = 10n ** DECIMALS;
  const whole = value / divisor;
  return whole.toString();
}

