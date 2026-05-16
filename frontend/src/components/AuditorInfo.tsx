"use client";

import { useEffect, useState } from "react";
import { useCurrentClient } from "@mysten/dapp-kit-react";
import { COMPLIANCE_CONFIG_ID } from "@/lib/constants";
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

function extractAuditorKey(json: Record<string, unknown> | null | undefined): string | null {
  if (!json) return null;
  const key = json.auditor_key;
  if (!key) return null;

  if (typeof key === "string") return key;
  if (Array.isArray(key)) {
    return (
      "0x" +
      (key as number[]).map((b) => b.toString(16).padStart(2, "0")).join("")
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AuditorInfoProps {
  readonly lastEncryptedDigest?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditorInfo({ lastEncryptedDigest }: AuditorInfoProps) {
  const hasConfig = COMPLIANCE_CONFIG_ID.length > 0;
  const client = useCurrentClient();

  const [auditorPublicKey, setAuditorPublicKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!hasConfig || !client) return;

    let cancelled = false;
    setIsLoading(true);

    client.core
      .getObject({ objectId: COMPLIANCE_CONFIG_ID, include: { json: true } })
      .then((result: any) => {
        if (cancelled) return;
        const key = extractAuditorKey(result.object.json as Record<string, unknown> | null);
        setAuditorPublicKey(key);
      })
      .catch(() => {
        if (!cancelled) setAuditorPublicKey(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasConfig, client]);

  const isConfigured = auditorPublicKey !== null && auditorPublicKey.length > 0;

  if (!hasConfig) {
    return (
      <div className={styles.panel}>
        <div className={styles.accentLine} />
        <div className={styles.header}>
          <span className={styles.title}>Auditor Configuration</span>
          <div className={styles.statusBadge}>
            <span className={`${styles.dot} ${styles.dotInactive}`} />
            <span className={`${styles.statusText} ${styles.statusInactive}`}>
              NOT DEPLOYED
            </span>
          </div>
        </div>
        <div className={styles.notice}>
          Compliance config not deployed on testnet. Auditor features unavailable.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.accentLine} />

      <div className={styles.header}>
        <span className={styles.title}>Auditor Configuration</span>
        <div className={styles.statusBadge}>
          <span className={`${styles.dot} ${isConfigured ? styles.dotActive : styles.dotInactive}`} />
          <span className={`${styles.statusText} ${isConfigured ? styles.statusActive : styles.statusInactive}`}>
            {isLoading ? "LOADING..." : isConfigured ? "CONFIGURED" : "NOT SET"}
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
            <span className={styles.rowValueMuted}>{isLoading ? "..." : "---"}</span>
          )}
        </div>

        <div className={styles.row}>
          <span className={styles.rowLabel}>Last Encrypted Tx</span>
          {lastEncryptedDigest !== null && lastEncryptedDigest !== undefined && lastEncryptedDigest.length > 0 ? (
            <span className={styles.rowValueMono} title={lastEncryptedDigest}>
              {truncateDigest(lastEncryptedDigest)}
            </span>
          ) : (
            <span className={styles.rowValueMuted}>{"---"}</span>
          )}
        </div>
      </div>

      {!isConfigured && !isLoading && (
        <div className={styles.notice}>
          No auditor public key configured. Transfers will not be encrypted for compliance reporting.
        </div>
      )}
    </div>
  );
}
