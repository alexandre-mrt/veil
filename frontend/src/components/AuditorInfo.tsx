"use client";

import styles from "./AuditorInfo.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENCRYPTION_METHOD = "ECDH P-256 + AES-GCM";
const TRUNCATE_HEAD = 10;
const TRUNCATE_TAIL = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateDigest(digest: string): string {
  if (digest.length <= TRUNCATE_HEAD + TRUNCATE_TAIL + 3) return digest;
  return `${digest.slice(0, TRUNCATE_HEAD)}...${digest.slice(-TRUNCATE_TAIL)}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AuditorInfoProps {
  readonly auditorPublicKey: string | null;
  readonly lastEncryptedDigest: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditorInfo({ auditorPublicKey, lastEncryptedDigest }: AuditorInfoProps) {
  const isConfigured = auditorPublicKey !== null && auditorPublicKey.length > 0;

  return (
    <div className={styles.panel}>
      <div className={styles.accentLine} />

      <div className={styles.header}>
        <span className={styles.title}>Auditor Configuration</span>
        <div className={styles.statusBadge}>
          <span className={`${styles.dot} ${isConfigured ? styles.dotActive : styles.dotInactive}`} />
          <span className={`${styles.statusText} ${isConfigured ? styles.statusActive : styles.statusInactive}`}>
            {isConfigured ? "CONFIGURED" : "NOT SET"}
          </span>
        </div>
      </div>

      <div className={styles.rows}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Encryption</span>
          <span className={styles.rowValue}>{ENCRYPTION_METHOD}</span>
        </div>

        <div className={styles.row}>
          <span className={styles.rowLabel}>Public Key</span>
          {isConfigured ? (
            <span className={styles.rowValueMono} title={auditorPublicKey}>
              {truncateDigest(auditorPublicKey)}
            </span>
          ) : (
            <span className={styles.rowValueMuted}>—</span>
          )}
        </div>

        <div className={styles.row}>
          <span className={styles.rowLabel}>Last Encrypted Tx</span>
          {lastEncryptedDigest !== null && lastEncryptedDigest.length > 0 ? (
            <span className={styles.rowValueMono} title={lastEncryptedDigest}>
              {truncateDigest(lastEncryptedDigest)}
            </span>
          ) : (
            <span className={styles.rowValueMuted}>—</span>
          )}
        </div>
      </div>

      {!isConfigured && (
        <div className={styles.notice}>
          No auditor public key configured. Transfers will not be encrypted for compliance reporting.
        </div>
      )}
    </div>
  );
}
