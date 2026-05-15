"use client";

import type { Credential, PrivacyTier } from "@/lib/types";
import styles from "./ComplianceStatus.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VEIL_DECIMALS = 6n;
const THRESHOLD_WARNING_PCT = 70;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(value: bigint): string {
  const divisor = 10n ** VEIL_DECIMALS;
  const whole = value / divisor;
  return whole.toString();
}

function computePercentage(spending: bigint, threshold: bigint): number {
  if (threshold === 0n) return 100;
  const pct = Number((spending * 10000n) / threshold) / 100;
  return Math.min(pct, 100);
}

function getRemainingAllowance(spending: bigint, threshold: bigint): bigint {
  if (spending >= threshold) return 0n;
  return threshold - spending;
}

type TierInfo = {
  tier: PrivacyTier;
  label: string;
  dotClass: string;
  labelClass: string;
};

function getTierInfo(
  spending: bigint,
  threshold: bigint,
  hasValidCredential: boolean,
): TierInfo {
  if (hasValidCredential) {
    return {
      tier: "anonymous",
      label: "KYC VERIFIED",
      dotClass: styles.dotBlue,
      labelClass: styles.labelBlue,
    };
  }

  if (threshold === 0n || spending >= threshold) {
    return {
      tier: "kyc-required",
      label: "KYC REQUIRED",
      dotClass: styles.dotDanger,
      labelClass: styles.labelDanger,
    };
  }

  const pct = computePercentage(spending, threshold);
  if (pct >= THRESHOLD_WARNING_PCT) {
    return {
      tier: "kyc-required",
      label: "KYC REQUIRED",
      dotClass: styles.dotWarning,
      labelClass: styles.labelWarning,
    };
  }

  return {
    tier: "anonymous",
    label: "ANONYMOUS",
    dotClass: styles.dotAnonymous,
    labelClass: styles.labelAnonymous,
  };
}

function isCredentialValid(credential: Credential): boolean {
  const nowEpoch = Math.floor(Date.now() / 1000);
  return credential.expiry > nowEpoch;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ComplianceStatusProps {
  readonly cumulativeSpending: bigint;
  readonly threshold: bigint;
  readonly credentials: readonly Credential[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ComplianceStatus({
  cumulativeSpending,
  threshold,
  credentials,
}: ComplianceStatusProps) {
  const hasValidCredential = credentials.some(isCredentialValid);
  const info = getTierInfo(cumulativeSpending, threshold, hasValidCredential);
  const remaining = getRemainingAllowance(cumulativeSpending, threshold);
  const pct = computePercentage(cumulativeSpending, threshold);

  return (
    <div className={styles.panel}>
      <div className={`${styles.accentLine} ${info.dotClass === styles.dotBlue ? styles.accentBlue : info.dotClass === styles.dotWarning ? styles.accentWarning : info.dotClass === styles.dotDanger ? styles.accentDanger : styles.accentAnonymous}`} />

      <div className={styles.header}>
        <span className={styles.title}>Compliance Status</span>
        <div className={styles.badge}>
          <span className={`${styles.dot} ${info.dotClass}`} />
          <span className={`${styles.statusLabel} ${info.labelClass}`}>
            {info.label}
          </span>
        </div>
      </div>

      <div className={styles.progressTrack}>
        <div
          className={`${styles.progressFill} ${info.dotClass === styles.dotBlue ? styles.fillBlue : info.dotClass === styles.dotWarning ? styles.fillWarning : info.dotClass === styles.dotDanger ? styles.fillDanger : styles.fillAnonymous}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className={styles.metaRow}>
        <span className={styles.metaText}>
          {formatAmount(cumulativeSpending)} / {formatAmount(threshold)} VEIL ({pct.toFixed(1)}%)
        </span>
        {!hasValidCredential && remaining > 0n && (
          <span className={styles.remaining}>
            {formatAmount(remaining)} VEIL remaining
          </span>
        )}
        {hasValidCredential && (
          <span className={styles.remainingBlue}>Unlimited transfers</span>
        )}
      </div>
    </div>
  );
}
