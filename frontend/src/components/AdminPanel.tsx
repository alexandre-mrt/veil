"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { parseAmountToBigInt } from "@/lib/utils";
import {
  PACKAGE_ID,
  POOL_ID,
  ADMIN_CAP_ID,
  COMPLIANCE_CONFIG_ID,
  VEIL_DECIMALS,
  EXPLORER_TX_URL,
  REFETCH_INTERVAL_MS,
} from "@/lib/constants";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Pool admin fields (superset of useVeilPool — reads extra admin-relevant data)
// ---------------------------------------------------------------------------

interface PoolAdminFields {
  readonly balance: bigint;
  readonly frozen: boolean;
  readonly complianceRequired: boolean;
  readonly pendingVk: number[];
  readonly vkUpdateEpoch: number;
}

function parsePoolAdminJson(
  json: Record<string, unknown> | null | undefined,
): PoolAdminFields | null {
  if (!json) return null;
  const pendingVkRaw = json.pending_vk;
  const pendingVk = Array.isArray(pendingVkRaw)
    ? (pendingVkRaw as number[])
    : [];

  return {
    balance: BigInt((json.balance as string | number) ?? 0),
    frozen: (json.frozen as boolean) ?? false,
    complianceRequired: (json.compliance_required as boolean) ?? false,
    pendingVk,
    vkUpdateEpoch: Number((json.vk_update_epoch as string | number) ?? 0),
  };
}

function formatBalance(value: bigint): string {
  const divisor = 10n ** BigInt(VEIL_DECIMALS);
  const whole = value / divisor;
  const frac = value % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac
    .toString()
    .padStart(VEIL_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${whole}.${fracStr.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminPanel() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();

  const [pool, setPool] = useState<PoolAdminFields | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [txPending, setTxPending] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    digest?: string;
  } | null>(null);

  // VK update form
  const [newVkHex, setNewVkHex] = useState("");

  // Emergency withdraw form
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawRecipient, setWithdrawRecipient] = useState("");

  // Compliance config forms
  const [newCredentialRootHex, setNewCredentialRootHex] = useState("");
  const [newAuditorKeyHex, setNewAuditorKeyHex] = useState("");
  const [newKycLevel, setNewKycLevel] = useState("");

  // -----------------------------------------------------------------------
  // Fetch pool data
  // -----------------------------------------------------------------------

  const fetchPool = useCallback(async () => {
    if (!client) return;
    setIsLoading(true);
    try {
      const res = await client.core.getObject({
        objectId: POOL_ID,
        include: { json: true },
      });
      const parsed = parsePoolAdminJson(
        res.object.json as Record<string, unknown> | null,
      );
      setPool(parsed);
    } catch {
      // ignore — pool fetch failure is non-fatal
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    fetchPool();
    const interval = setInterval(fetchPool, REFETCH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchPool]);

  // -----------------------------------------------------------------------
  // Transaction helpers
  // -----------------------------------------------------------------------

  const execTx = useCallback(
    async (label: string, buildTx: (tx: Transaction) => void) => {
      if (!account) {
        setResult({ success: false, message: "Wallet not connected" });
        return;
      }
      setTxPending(true);
      setResult(null);

      try {
        const tx = new Transaction();
        buildTx(tx);
        const txResult = await dAppKit.signAndExecuteTransaction({
          transaction: tx,
        });

        if (txResult.FailedTransaction) {
          throw new Error(
            txResult.FailedTransaction.status.error?.message ??
              "Transaction failed",
          );
        }

        const digest = txResult.Transaction.digest;
        await client.core.waitForTransaction({ digest });
        setResult({ success: true, message: `${label} confirmed`, digest });
        fetchPool();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : `${label} failed`;
        setResult({ success: false, message });
      } finally {
        setTxPending(false);
      }
    },
    [account, client, dAppKit, fetchPool],
  );

  // -----------------------------------------------------------------------
  // Admin actions
  // -----------------------------------------------------------------------

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

  const handleProposeVk = useCallback(() => {
    const hex = newVkHex.trim();
    if (hex.length === 0) {
      setResult({ success: false, message: "VK hex cannot be empty" });
      return;
    }

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
          tx.object("0x6"), // Clock
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

  const handleEmergencyWithdraw = useCallback(() => {
    const parsed = Number.parseFloat(withdrawAmount);
    if (Number.isNaN(parsed) || parsed <= 0) {
      setResult({ success: false, message: "Invalid withdraw amount" });
      return;
    }
    const rawAmount = parseAmountToBigInt(withdrawAmount, VEIL_DECIMALS);
    const recipient = withdrawRecipient.trim() || account?.address;
    if (!recipient) {
      setResult({ success: false, message: "No recipient address" });
      return;
    }

    execTx("Emergency withdraw", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::emergency_withdraw`,
        arguments: [
          tx.object(POOL_ID),
          tx.object(ADMIN_CAP_ID),
          tx.pure.u64(rawAmount),
          tx.pure.address(recipient),
        ],
      });
    });
  }, [withdrawAmount, withdrawRecipient, account?.address, execTx]);

  // -----------------------------------------------------------------------
  // Compliance config actions
  // -----------------------------------------------------------------------

  const handleProposeCredentialRoot = useCallback(() => {
    const hex = newCredentialRootHex.trim();
    if (hex.length === 0) {
      setResult({ success: false, message: "Credential root hex cannot be empty" });
      return;
    }

    execTx("Credential root update proposed", (tx) => {
      const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
      const rootBytes = Array.from(
        { length: cleanHex.length / 2 },
        (_, i) => Number.parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16),
      );

      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::update_credential_root`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
          tx.pure.vector("u8", rootBytes),
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

  const handleProposeAuditorKey = useCallback(() => {
    const hex = newAuditorKeyHex.trim();
    if (hex.length === 0) {
      setResult({ success: false, message: "Auditor key hex cannot be empty" });
      return;
    }

    execTx("Auditor key update proposed", (tx) => {
      const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
      const keyBytes = Array.from(
        { length: cleanHex.length / 2 },
        (_, i) => Number.parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16),
      );

      tx.moveCall({
        target: `${PACKAGE_ID}::compliance::propose_auditor_key_update`,
        arguments: [
          tx.object(COMPLIANCE_CONFIG_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object(POOL_ID),
          tx.pure.vector("u8", keyBytes),
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

  const handleProposeKycLevel = useCallback(() => {
    const level = Number.parseInt(newKycLevel.trim(), 10);
    if (Number.isNaN(level) || level < 0) {
      setResult({ success: false, message: "KYC level must be a non-negative integer" });
      return;
    }

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

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const hasPendingVk = (pool?.pendingVk.length ?? 0) > 0;

  return (
    <div className={styles.adminPanel}>
      <div className={styles.adminPanelAccent} />
      <span className={styles.adminTitle}>Admin Controls</span>

      {/* Warning banner */}
      <div className={styles.adminWarning}>
        Admin actions require the AdminCap. Only the pool deployer can execute
        these operations.
      </div>

      {/* Pool Status */}
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
              <span className={`${styles.adminRowValue} ${styles.adminValueWarning}`}>
                Epoch {pool?.vkUpdateEpoch}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Freeze / Unfreeze */}
      <div className={styles.adminSection}>
        <span className={styles.adminSectionTitle}>Freeze Control</span>
        <button
          type="button"
          className={
            pool?.frozen ? styles.adminBtnAccent : styles.adminBtnDanger
          }
          disabled={txPending || !account}
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
        <span className={styles.adminSectionTitle}>Compliance Requirement</span>
        <button
          type="button"
          className={
            pool?.complianceRequired
              ? styles.adminBtnDanger
              : styles.adminBtnAccent
          }
          disabled={txPending || !account}
          onClick={handleToggleCompliance}
        >
          {txPending
            ? "Signing..."
            : pool?.complianceRequired
              ? "Disable Compliance"
              : "Enable Compliance"}
        </button>
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
              disabled={txPending || !account || newVkHex.trim().length === 0}
              onClick={handleProposeVk}
            >
              {txPending ? "Signing..." : "Propose VK Update"}
            </button>
            {hasPendingVk && (
              <button
                type="button"
                className={styles.adminBtnDanger}
                disabled={txPending || !account}
                onClick={handleCancelVk}
              >
                Cancel Pending VK
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Compliance Configuration */}
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
              disabled={txPending || !account || newCredentialRootHex.trim().length === 0}
              onClick={handleProposeCredentialRoot}
            >
              {txPending ? "Signing..." : "Propose Root Update"}
            </button>
            <button
              type="button"
              className={styles.adminBtnDanger}
              disabled={txPending || !account}
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
              disabled={txPending || !account || newAuditorKeyHex.trim().length === 0}
              onClick={handleProposeAuditorKey}
            >
              {txPending ? "Signing..." : "Propose Key Update"}
            </button>
            <button
              type="button"
              className={styles.adminBtnDanger}
              disabled={txPending || !account}
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
              disabled={txPending || !account || newKycLevel.trim().length === 0}
              onClick={handleProposeKycLevel}
            >
              {txPending ? "Signing..." : "Propose Level Update"}
            </button>
            <button
              type="button"
              className={styles.adminBtnDanger}
              disabled={txPending || !account}
              onClick={handleCancelKycLevel}
            >
              Cancel Level Update
            </button>
          </div>
        </div>
      </div>

      {/* Emergency Withdraw */}
      <div className={styles.adminSection}>
        <span className={styles.adminSectionTitle}>Emergency Withdraw</span>
        <div className={styles.adminVkForm}>
          <input
            type="number"
            min="0"
            step="0.000001"
            placeholder="Amount (VEIL)"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            className={styles.adminInput}
            disabled={txPending}
          />
          <input
            type="text"
            placeholder={account?.address ?? "Recipient address (0x...)"}
            value={withdrawRecipient}
            onChange={(e) => setWithdrawRecipient(e.target.value)}
            className={styles.adminInput}
            disabled={txPending}
          />
          <button
            type="button"
            className={styles.adminBtnDanger}
            disabled={
              txPending ||
              !account ||
              !withdrawAmount ||
              Number.parseFloat(withdrawAmount) <= 0
            }
            onClick={handleEmergencyWithdraw}
          >
            {txPending ? "Signing..." : "Emergency Withdraw"}
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div
          className={`${styles.adminResult} ${
            result.success
              ? styles.adminResultSuccess
              : styles.adminResultError
          }`}
        >
          {result.message}
          {result.digest && (
            <>
              {" "}
              <a
                href={`${EXPLORER_TX_URL}/${result.digest}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.adminResultLink}
              >
                View on Suiscan
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
