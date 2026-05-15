"use client";

import { useCallback, useState } from "react";
import {
  PACKAGE_ID,
  POOL_ID,
  ADMIN_CAP_ID,
  COMPLIANCE_CONFIG_ID,
} from "@/lib/constants";
import type { AdminSubComponentProps } from "./types";
import styles from "../components.module.css";

// ---------------------------------------------------------------------------
// Compliance configuration: credential root, auditor key, KYC level, compliance VK
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hex to bytes helper
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): number[] {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Array.from(
    { length: cleanHex.length / 2 },
    (_, i) => Number.parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16),
  );
}

export function AdminComplianceConfig({
  txPending,
  accountConnected,
  execTx,
}: Pick<AdminSubComponentProps, "txPending" | "accountConnected" | "execTx">) {
  const [newCredentialRootHex, setNewCredentialRootHex] = useState("");
  const [newAuditorKeyHex, setNewAuditorKeyHex] = useState("");
  const [newKycLevel, setNewKycLevel] = useState("");
  const [newComplianceVkHex, setNewComplianceVkHex] = useState("");

  // -- Credential Root ------------------------------------------------------

  const handleProposeCredentialRoot = useCallback(() => {
    const hex = newCredentialRootHex.trim();
    if (hex.length === 0) return;

    execTx("Credential root update proposed", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::update_credential_root`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
          tx.pure.vector("u8", hexToBytes(hex)),
          tx.object("0x6"),
        ],
      });
    });
  }, [newCredentialRootHex, execTx]);

  const handleCancelCredentialRoot = useCallback(() => {
    execTx("Credential root update cancelled", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::cancel_credential_root_update`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
        ],
      });
    });
  }, [execTx]);

  // -- Auditor Key ----------------------------------------------------------

  const handleProposeAuditorKey = useCallback(() => {
    const hex = newAuditorKeyHex.trim();
    if (hex.length === 0) return;

    execTx("Auditor key update proposed", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::propose_auditor_key_update`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
          tx.pure.vector("u8", hexToBytes(hex)),
          tx.object("0x6"),
        ],
      });
    });
  }, [newAuditorKeyHex, execTx]);

  const handleCancelAuditorKey = useCallback(() => {
    execTx("Auditor key update cancelled", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::cancel_auditor_key_update`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
        ],
      });
    });
  }, [execTx]);

  // -- KYC Level ------------------------------------------------------------

  const handleProposeKycLevel = useCallback(() => {
    const level = Number.parseInt(newKycLevel.trim(), 10);
    if (Number.isNaN(level) || level < 0) return;

    execTx("KYC level update proposed", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::propose_kyc_level_update`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
          tx.pure.u64(level),
          tx.object("0x6"),
        ],
      });
    });
  }, [newKycLevel, execTx]);

  const handleCancelKycLevel = useCallback(() => {
    execTx("KYC level update cancelled", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::cancel_kyc_level_update`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
        ],
      });
    });
  }, [execTx]);

  // -- Compliance VK --------------------------------------------------------

  const handleProposeComplianceVk = useCallback(() => {
    const hex = newComplianceVkHex.trim();
    if (hex.length === 0) return;

    execTx("Compliance VK update proposed", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::propose_compliance_vk_update`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
          tx.pure.vector("u8", hexToBytes(hex)),
          tx.object("0x6"),
        ],
      });
    });
  }, [newComplianceVkHex, execTx]);

  const handleCancelComplianceVk = useCallback(() => {
    execTx("Compliance VK update cancelled", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::cancel_compliance_vk_update`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
        ],
      });
    });
  }, [execTx]);

  return (
    <div className={styles.adminSection}>
      <span className={styles.adminSectionTitle}>
        Compliance Configuration
      </span>

      {/* Credential Root Update */}
      <div className={styles.adminVkForm}>
        <span className={styles.adminRowLabel}>Credential Root</span>
        <input
          type="text"
          placeholder="New credential root hex (0x... 32 bytes)"
          value={newCredentialRootHex}
          onChange={(e) => setNewCredentialRootHex(e.target.value)}
          className={styles.adminInput}
          disabled={txPending}
        />
        <div className={styles.adminVkButtons}>
          <button
            type="button"
            className={styles.adminBtnAccent}
            disabled={
              txPending ||
              !accountConnected ||
              newCredentialRootHex.trim().length === 0
            }
            onClick={handleProposeCredentialRoot}
          >
            {txPending ? "Signing..." : "Propose Root Update"}
          </button>
          <button
            type="button"
            className={styles.adminBtnDanger}
            disabled={txPending || !accountConnected}
            onClick={handleCancelCredentialRoot}
          >
            Cancel Root Update
          </button>
        </div>
      </div>

      {/* Auditor Key Update */}
      <div className={styles.adminVkForm}>
        <span className={styles.adminRowLabel}>Auditor Key</span>
        <input
          type="text"
          placeholder="New auditor public key hex (0x...)"
          value={newAuditorKeyHex}
          onChange={(e) => setNewAuditorKeyHex(e.target.value)}
          className={styles.adminInput}
          disabled={txPending}
        />
        <div className={styles.adminVkButtons}>
          <button
            type="button"
            className={styles.adminBtnAccent}
            disabled={
              txPending ||
              !accountConnected ||
              newAuditorKeyHex.trim().length === 0
            }
            onClick={handleProposeAuditorKey}
          >
            {txPending ? "Signing..." : "Propose Key Update"}
          </button>
          <button
            type="button"
            className={styles.adminBtnDanger}
            disabled={txPending || !accountConnected}
            onClick={handleCancelAuditorKey}
          >
            Cancel Key Update
          </button>
        </div>
      </div>

      {/* KYC Level Update */}
      <div className={styles.adminVkForm}>
        <span className={styles.adminRowLabel}>Required KYC Level</span>
        <input
          type="number"
          min="0"
          step="1"
          placeholder="New KYC level (e.g. 1)"
          value={newKycLevel}
          onChange={(e) => setNewKycLevel(e.target.value)}
          className={styles.adminInput}
          disabled={txPending}
        />
        <div className={styles.adminVkButtons}>
          <button
            type="button"
            className={styles.adminBtnAccent}
            disabled={
              txPending ||
              !accountConnected ||
              newKycLevel.trim().length === 0
            }
            onClick={handleProposeKycLevel}
          >
            {txPending ? "Signing..." : "Propose Level Update"}
          </button>
          <button
            type="button"
            className={styles.adminBtnDanger}
            disabled={txPending || !accountConnected}
            onClick={handleCancelKycLevel}
          >
            Cancel Level Update
          </button>
        </div>
      </div>

      {/* Compliance VK Update */}
      <div className={styles.adminVkForm}>
        <span className={styles.adminRowLabel}>
          Compliance Verification Key
        </span>
        <input
          type="text"
          placeholder="New compliance VK hex (0x...)"
          value={newComplianceVkHex}
          onChange={(e) => setNewComplianceVkHex(e.target.value)}
          className={styles.adminInput}
          disabled={txPending}
        />
        <div className={styles.adminVkButtons}>
          <button
            type="button"
            className={styles.adminBtnAccent}
            disabled={
              txPending ||
              !accountConnected ||
              newComplianceVkHex.trim().length === 0
            }
            onClick={handleProposeComplianceVk}
          >
            {txPending ? "Signing..." : "Propose VK Update"}
          </button>
          <button
            type="button"
            className={styles.adminBtnDanger}
            disabled={txPending || !accountConnected}
            onClick={handleCancelComplianceVk}
          >
            Cancel VK Update
          </button>
        </div>
      </div>
    </div>
  );
}
