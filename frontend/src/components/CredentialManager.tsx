"use client";

import { useState } from "react";
import type { Credential } from "@/lib/types";
import { DEMO_CREDENTIAL } from "@/lib/demoCredential";
import { EPOCH_DURATION_MS } from "@/lib/constants";
import { useEpoch } from "@/hooks/useEpoch";
import styles from "./CredentialManager.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KYC_LEVEL_LABELS: Record<number, string> = {
  1: "Basic",
  2: "Enhanced",
  3: "Institutional",
};

/** Number of epochs before expiry to show "expiring soon" warning */
const EXPIRY_WARNING_EPOCHS = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatExpiry(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isExpired(epochSeconds: number): boolean {
  return epochSeconds <= Math.floor(Date.now() / 1000);
}

function kycLevelLabel(level: number): string {
  return KYC_LEVEL_LABELS[level] ?? `Level ${level}`;
}

type ExpiryStatus = "valid" | "expiring-soon" | "expired";

function getExpiryStatus(expirySeconds: number, currentEpoch: number): ExpiryStatus {
  const expiryEpoch = Math.floor((expirySeconds * 1000) / EPOCH_DURATION_MS);
  if (expiryEpoch <= currentEpoch) return "expired";
  if (expiryEpoch <= currentEpoch + EXPIRY_WARNING_EPOCHS) return "expiring-soon";
  return "valid";
}

function parseCredentialJson(raw: string): Credential | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("kycLevel" in parsed) ||
      !("expiry" in parsed) ||
      !("merkleIndex" in parsed) ||
      !("leaf" in parsed) ||
      !("merkleProof" in parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    return {
      leaf: BigInt(String(obj.leaf)),
      kycLevel: Number(obj.kycLevel),
      expiry: Number(obj.expiry),
      issuerId: obj.issuerId != null ? Number(obj.issuerId) : undefined,
      merkleProof: (obj.merkleProof as unknown[]).map((x) => BigInt(String(x))),
      merkleIndex: Number(obj.merkleIndex),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CredentialManagerProps {
  readonly credentials: readonly Credential[];
  readonly onImport: (credential: Credential) => void;
  readonly onRemove: (index: number) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CredentialManager({
  credentials,
  onImport,
  onRemove,
}: CredentialManagerProps) {
  const epoch = useEpoch();
  const [jsonInput, setJsonInput] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  function handleImport() {
    setImportError(null);
    setImportSuccess(false);

    const trimmed = jsonInput.trim();
    if (!trimmed) {
      setImportError("Paste credential JSON before importing.");
      return;
    }

    const parsed = parseCredentialJson(trimmed);
    if (parsed === null) {
      setImportError("Invalid credential JSON. Check required fields: leaf, kycLevel, expiry, merkleProof, merkleIndex.");
      return;
    }

    onImport(parsed);
    setJsonInput("");
    setImportSuccess(true);
    setTimeout(() => setImportSuccess(false), 3000);
  }

  return (
    <div className={styles.panel}>
      <div className={styles.accentLine} />

      <div className={styles.header}>
        <span className={styles.title}>Credential Manager</span>
        <span className={styles.count}>{credentials.length} credential{credentials.length !== 1 ? "s" : ""}</span>
      </div>

      {credentials.length === 0 ? (
        <div className={styles.empty}>No credentials stored. Import a KYC credential below.</div>
      ) : (
        <div className={styles.list}>
          {credentials.map((cred, idx) => {
            const expired = isExpired(cred.expiry);
            const expiryStatus = getExpiryStatus(cred.expiry, epoch.currentEpoch);
            return (
              <div key={`${cred.merkleIndex}-${idx}`} className={`${styles.credRow} ${expired ? styles.credRowExpired : ""}`}>
                <div className={styles.credInfo}>
                  <div className={styles.credLevelRow}>
                    <span className={`${styles.credLevel} ${expired ? styles.credLevelExpired : styles.credLevelActive}`}>
                      {kycLevelLabel(cred.kycLevel)}
                    </span>
                    {expiryStatus === "valid" && (
                      <span className={styles.badgeValid}>Valid</span>
                    )}
                    {expiryStatus === "expiring-soon" && (
                      <span className={styles.badgeExpiringSoon}>Expiring soon</span>
                    )}
                    {expiryStatus === "expired" && (
                      <span className={styles.badgeExpired}>Expired</span>
                    )}
                  </div>
                  <span className={styles.credMeta}>
                    idx #{cred.merkleIndex} &middot; {expired ? "expired" : `expires ${formatExpiry(cred.expiry)}`}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => onRemove(idx)}
                  aria-label={`Remove credential at index ${cred.merkleIndex}`}
                >
                  REMOVE
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.importSection}>
        <div className={styles.importLabel}>Import Credential (JSON)</div>
        <textarea
          className={styles.jsonInput}
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
          placeholder={'{\n  "leaf": "...",\n  "kycLevel": 1,\n  "expiry": 1234567890,\n  "merkleProof": [],\n  "merkleIndex": 0\n}'}
          rows={6}
          spellCheck={false}
        />
        {importError !== null && (
          <div className={styles.importError}>{importError}</div>
        )}
        {importSuccess && (
          <div className={styles.importSuccess}>Credential imported successfully.</div>
        )}
        <button
          type="button"
          className={styles.importBtn}
          onClick={handleImport}
          disabled={!jsonInput.trim()}
        >
          Import Credential
        </button>

        <button
          type="button"
          className={styles.demoBtn}
          onClick={() => {
            onImport(DEMO_CREDENTIAL);
          }}
        >
          [Demo] Load Pre-computed Credential
        </button>
        <span className={styles.demoNote}>For testnet demo only</span>
      </div>
    </div>
  );
}
