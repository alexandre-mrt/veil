"use client";

import { useCallback, useState } from "react";
import { PACKAGE_ID, POOL_ID, ADMIN_CAP_ID } from "@/lib/constants";
import type { AdminSubComponentProps } from "./types";
import styles from "../components.module.css";

// ---------------------------------------------------------------------------
// Freeze/unfreeze, compliance toggle + cancel, VK propose/cancel
// ---------------------------------------------------------------------------

export function AdminPoolActions({
  pool,
  txPending,
  accountConnected,
  execTx,
}: Omit<AdminSubComponentProps, "isLoading">) {
  const [newVkHex, setNewVkHex] = useState("");

  const hasPendingVk = (pool?.pendingVk.length ?? 0) > 0;
  const hasPendingComplianceToggle = pool?.pendingComplianceRequired != null;

  // -- Freeze / Unfreeze ----------------------------------------------------

  const handleFreeze = useCallback(() => {
    const isFrozen = pool?.frozen ?? false;
    const target = isFrozen
      ? `${PACKAGE_ID}::pool::unfreeze_pool`
      : `${PACKAGE_ID}::pool::freeze_pool`;
    const label = isFrozen ? "Pool unfrozen" : "Pool frozen";

    execTx(label, (tx) => {
      tx.moveCall({
        target,
        arguments: [tx.object(POOL_ID), tx.object(ADMIN_CAP_ID)],
      });
    });
  }, [pool?.frozen, execTx]);

  // -- VK Update ------------------------------------------------------------

  const handleProposeVk = useCallback(() => {
    const hex = newVkHex.trim();
    if (hex.length === 0) return;

    execTx("VK update proposed", (tx) => {
      const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
      const vkBytes = Array.from(
        { length: cleanHex.length / 2 },
        (_, i) => Number.parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16),
      );

      tx.moveCall({
        target: `${PACKAGE_ID}::pool::propose_vk_update`,
        arguments: [
          tx.object(POOL_ID),
          tx.object(ADMIN_CAP_ID),
          tx.pure.vector("u8", vkBytes),
          tx.object("0x6"),
        ],
      });
    });
  }, [newVkHex, execTx]);

  const handleCancelVk = useCallback(() => {
    execTx("VK update cancelled", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::cancel_vk_update`,
        arguments: [tx.object(POOL_ID), tx.object(ADMIN_CAP_ID)],
      });
    });
  }, [execTx]);

  // -- Compliance Toggle ----------------------------------------------------

  const handleToggleCompliance = useCallback(() => {
    const current = pool?.complianceRequired ?? false;
    const label = current ? "Compliance disabled" : "Compliance enabled";

    execTx(label, (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::propose_compliance_toggle`,
        arguments: [
          tx.object(POOL_ID),
          tx.object(ADMIN_CAP_ID),
          tx.pure.bool(!current),
          tx.object("0x6"),
        ],
      });
    });
  }, [pool?.complianceRequired, execTx]);

  const handleCancelComplianceToggle = useCallback(() => {
    execTx("Compliance toggle cancelled", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::cancel_compliance_toggle`,
        arguments: [tx.object(POOL_ID), tx.object(ADMIN_CAP_ID)],
      });
    });
  }, [execTx]);

  return (
    <>
      {/* Freeze / Unfreeze */}
      <div className={styles.adminSection}>
        <span className={styles.adminSectionTitle}>Freeze Control</span>
        <button
          type="button"
          className={
            pool?.frozen ? styles.adminBtnAccent : styles.adminBtnDanger
          }
          disabled={txPending || !accountConnected}
          onClick={handleFreeze}
        >
          {txPending
            ? "Signing..."
            : pool?.frozen
              ? "Unfreeze Pool"
              : "Freeze Pool"}
        </button>
      </div>

      {/* Compliance Toggle */}
      <div className={styles.adminSection}>
        <span className={styles.adminSectionTitle}>
          Compliance Requirement
        </span>
        <div className={styles.adminVkButtons}>
          <button
            type="button"
            className={
              pool?.complianceRequired
                ? styles.adminBtnDanger
                : styles.adminBtnAccent
            }
            disabled={txPending || !accountConnected}
            onClick={handleToggleCompliance}
          >
            {txPending
              ? "Signing..."
              : pool?.complianceRequired
                ? "Disable Compliance"
                : "Enable Compliance"}
          </button>
          {hasPendingComplianceToggle && (
            <button
              type="button"
              className={styles.adminBtnDanger}
              disabled={txPending || !accountConnected}
              onClick={handleCancelComplianceToggle}
            >
              Cancel Pending Toggle
            </button>
          )}
        </div>
      </div>

      {/* VK Update */}
      <div className={styles.adminSection}>
        <span className={styles.adminSectionTitle}>
          Verification Key Update
        </span>

        {hasPendingVk && (
          <div className={styles.adminPendingVk}>
            Pending VK update — effective at epoch {pool?.vkUpdateEpoch}
          </div>
        )}

        <div className={styles.adminVkForm}>
          <input
            type="text"
            placeholder="New VK hex (0x...)"
            value={newVkHex}
            onChange={(e) => setNewVkHex(e.target.value)}
            className={styles.adminInput}
            disabled={txPending}
          />
          <div className={styles.adminVkButtons}>
            <button
              type="button"
              className={styles.adminBtnAccent}
              disabled={
                txPending || !accountConnected || newVkHex.trim().length === 0
              }
              onClick={handleProposeVk}
            >
              {txPending ? "Signing..." : "Propose VK Update"}
            </button>
            {hasPendingVk && (
              <button
                type="button"
                className={styles.adminBtnDanger}
                disabled={txPending || !accountConnected}
                onClick={handleCancelVk}
              >
                Cancel Pending VK
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
