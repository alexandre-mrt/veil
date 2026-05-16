"use client";

import {
  useCurrentAccount,
  useCurrentClient,
} from "@mysten/dapp-kit-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { COMPLIANCE_CONFIG_ID, POOL_ID, REQUIRED_KYC_LEVEL, VEIL_DECIMALS, EXPLORER_TX_URL } from "@/lib/constants";
import { parseAmountToBigInt } from "@/lib/utils";
import type { Credential, VeilPrivateState, ComplianceConfig, ComplianceStep } from "@/lib/types";
import { useCompliantTransfer } from "@/hooks/useCompliantTransfer";
import { appendTx } from "@/lib/txHistory";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Compliance step definitions for progress display
// ---------------------------------------------------------------------------

interface StepDef {
  readonly key: ComplianceStep;
  readonly label: string;
  readonly number: number;
}

const COMPLIANCE_STEPS: readonly StepDef[] = [
  { key: "generating-transfer-proof", label: "Generating transfer proof", number: 1 },
  { key: "generating-compliance-proof", label: "Generating compliance proof", number: 2 },
  { key: "encrypting-for-auditor", label: "Encrypting for auditor", number: 3 },
  { key: "submitting-tx", label: "Submitting transaction", number: 4 },
] as const;

const TOTAL_STEPS = COMPLIANCE_STEPS.length;
const BAR_WIDTH = 24;

function getStepIndex(current: ComplianceStep): number {
  const idx = COMPLIANCE_STEPS.findIndex((s) => s.key === current);
  if (current === "done") return COMPLIANCE_STEPS.length;
  return idx >= 0 ? idx : -1;
}

function buildBar(filled: number, total: number): string {
  const filledCount = Math.round((filled / total) * BAR_WIDTH);
  const emptyCount = BAR_WIDTH - filledCount;
  return "█".repeat(filledCount) + "░".repeat(emptyCount);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CompliantTransferFormProps {
  readonly privateState: VeilPrivateState | null;
  readonly credentials: readonly Credential[];
  readonly frozen: boolean;
  readonly onStateUpdate: (cumulativeNew: bigint, newRandomness: bigint) => void;
  readonly onTxAppended?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CompliantTransferForm({
  privateState,
  credentials,
  frozen,
  onStateUpdate,
  onTxAppended,
}: CompliantTransferFormProps) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const transfer = useCompliantTransfer();

  const [amount, setAmount] = useState("");
  const [selectedCredIdx, setSelectedCredIdx] = useState(0);
  const [result, setResult] = useState<{ success: boolean; digest?: string; error?: string } | null>(null);
  const [chainConfig, setChainConfig] = useState<{ credentialRoot: string; auditorPublicKey: Uint8Array } | null>(null);

  const hasComplianceConfig = COMPLIANCE_CONFIG_ID.length > 0;

  useEffect(() => {
    if (!hasComplianceConfig || !client) return;
    let cancelled = false;
    client.core
      .getObject({ objectId: COMPLIANCE_CONFIG_ID, include: { json: true } })
      .then((res: any) => {
        if (cancelled) return;
        const json = res.object.json as Record<string, unknown> | null;
        if (!json) return;
        const root = (json.credential_root as string) ?? "0";
        const keyArr = json.auditor_key;
        const pubKey = Array.isArray(keyArr)
          ? new Uint8Array(keyArr as number[])
          : new Uint8Array(65);
        setChainConfig({ credentialRoot: root, auditorPublicKey: pubKey });
      })
      .catch(() => { /* compliance config not available */ });
    return () => { cancelled = true; };
  }, [hasComplianceConfig, client]);
  const validCredentials = credentials.filter(
    (c) => c.kycLevel >= REQUIRED_KYC_LEVEL && c.expiry > Math.floor(Date.now() / 1000),
  );

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setResult(null);

      if (!privateState) {
        setResult({ success: false, error: "Private state not initialized" });
        return;
      }

      if (!account) {
        setResult({ success: false, error: "Wallet not connected" });
        return;
      }

      if (frozen) {
        setResult({ success: false, error: "Pool is frozen" });
        return;
      }

      const parsed = Number.parseFloat(amount);
      if (Number.isNaN(parsed) || parsed <= 0) {
        setResult({ success: false, error: "Invalid amount" });
        return;
      }

      if (validCredentials.length === 0) {
        setResult({ success: false, error: "No valid KYC credential available" });
        return;
      }

      const txAmountRaw = parseAmountToBigInt(amount, VEIL_DECIMALS);
      const saltBytes = new Uint8Array(8);
      crypto.getRandomValues(saltBytes);
      const salt = saltBytes.reduce((acc, b, i) => acc | (BigInt(b) << BigInt(i * 8)), 0n);

      const complianceConfig: ComplianceConfig = {
        configId: COMPLIANCE_CONFIG_ID,
        poolId: POOL_ID,
        credentialRoot: chainConfig?.credentialRoot ?? "0",
        requiredKycLevel: REQUIRED_KYC_LEVEL,
        auditorPublicKey: chainConfig?.auditorPublicKey ?? new Uint8Array(65),
      };

      const selectedCred = validCredentials[selectedCredIdx] ?? validCredentials[0];
      if (!selectedCred) {
        setResult({ success: false, error: "No credential selected" });
        return;
      }
      const stateWithCreds: VeilPrivateState = {
        ...privateState,
        credentials: [selectedCred],
      };

      const txResult = await transfer.executeCompliantTransfer(
        stateWithCreds,
        txAmountRaw,
        salt,
        complianceConfig,
        onStateUpdate,
      );

      setResult(txResult);
      if (txResult.success && txResult.digest) {
        appendTx({ type: "transfer", amount: txAmountRaw, digest: txResult.digest });
        onTxAppended?.();
        setAmount("");
      }
    },
    [privateState, account, frozen, amount, validCredentials, transfer, onStateUpdate, onTxAppended],
  );

  const chainConfigLoading = hasComplianceConfig && !chainConfig;

  const isDisabled =
    transfer.isPending || !account || !amount || frozen || !privateState || validCredentials.length === 0 || !hasComplianceConfig || chainConfigLoading;

  const showProgress = transfer.step !== "idle" && transfer.step !== "error";

  // -------------------------------------------------------------------------
  // Compliance Progress (inline, mirrors ProofProgress pattern)
  // -------------------------------------------------------------------------

  function renderComplianceProgress() {
    if (!showProgress) return null;

    const currentIndex = getStepIndex(transfer.step);
    const isDone = transfer.step === "done";

    return (
      <div className={styles.proofProgress}>
        {transfer.isMock && (
          <div className={styles.proofMockBanner}>
            [MOCK MODE - Circuit not compiled]
          </div>
        )}

        <div className={styles.proofSteps}>
          {COMPLIANCE_STEPS.map((s, i) => {
            const isActive = i === currentIndex;
            const isComplete = i < currentIndex || isDone;
            const barFill = isComplete
              ? BAR_WIDTH
              : isActive
                ? Math.round((transfer.progress / 100) * BAR_WIDTH)
                : 0;

            let lineClass = styles.proofStepLine;
            if (isComplete) lineClass += ` ${styles.proofStepComplete}`;
            else if (isActive) lineClass += ` ${styles.proofStepActive}`;

            return (
              <div key={s.key} className={lineClass}>
                <span className={styles.proofStepLabel}>
                  [{s.number}/{TOTAL_STEPS}] {s.label}...
                </span>
                <span className={styles.proofStepBar}>
                  {buildBar(barFill, BAR_WIDTH)}
                </span>
              </div>
            );
          })}
        </div>

        {isDone && (
          <div className={styles.proofDone}>Compliant transfer verified. Transaction submitted.</div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.transferForm}>
      <div className={styles.transferFormAccent} />
      <span className={styles.transferTitle}>
        Compliant Transfer
      </span>

      <div className={styles.compliantSubtitle}>
        For above-threshold transfers. KYC verified, amount encrypted for auditor.
      </div>

      {transfer.isMock && (
        <div className={styles.proofMockBanner}>
          [MOCK] Circuit artifacts unavailable — proofs are simulated
        </div>
      )}

      {frozen && (
        <div className={styles.transferFrozenBanner}>
          Pool is frozen. Transfers disabled.
        </div>
      )}

      {!hasComplianceConfig && (
        <div className={styles.transferWarning}>
          Compliance config not deployed on testnet. Compliant transfers unavailable.
        </div>
      )}

      {hasComplianceConfig && credentials.length === 0 && (
        <div className={styles.transferWarning}>
          No credentials imported. Import a KYC credential in the sidebar to use compliant transfers.
        </div>
      )}

      {hasComplianceConfig && credentials.length > 0 && validCredentials.length === 0 && (
        <div className={styles.transferDanger}>
          No valid credential for KYC level {REQUIRED_KYC_LEVEL}. All credentials are expired or insufficient.
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className={styles.transferInputGroup}>
          <label htmlFor="compliant-amount" className={styles.transferInputLabel}>
            Amount (VEIL)
          </label>
          <input
            id="compliant-amount"
            type="number"
            min="0"
            step="0.000001"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={styles.transferInput}
            disabled={transfer.isPending || frozen || !hasComplianceConfig}
          />
        </div>

        {validCredentials.length > 1 && (
          <div className={styles.transferInputGroup}>
            <label htmlFor="credential-select" className={styles.transferInputLabel}>
              Credential
            </label>
            <select
              id="credential-select"
              value={selectedCredIdx}
              onChange={(e) => setSelectedCredIdx(Number(e.target.value))}
              className={styles.transferInput}
              disabled={transfer.isPending}
            >
              {validCredentials.map((cred, idx) => (
                <option key={`${cred.merkleIndex}-${idx}`} value={idx}>
                  Level {cred.kycLevel} — idx #{cred.merkleIndex} — expires{" "}
                  {new Date(cred.expiry * 1000).toLocaleDateString()}
                </option>
              ))}
            </select>
          </div>
        )}

        {validCredentials.length === 1 && (
          <div className={styles.compliantCredBadge}>
            Using: Level {validCredentials[0].kycLevel} credential (idx #{validCredentials[0].merkleIndex})
          </div>
        )}

        <button
          type="submit"
          className={styles.transferSubmitBtn}
          disabled={isDisabled}
        >
          {transfer.isPending ? "Processing..." : chainConfigLoading ? "Loading compliance config..." : "Compliant Transfer"}
        </button>
      </form>

      {renderComplianceProgress()}

      {result && !showProgress && (
        <div
          className={`${styles.transferResult} ${
            result.success
              ? styles.transferResultSuccess
              : styles.transferResultError
          }`}
        >
          {result.success ? (
            <>
              Compliant transfer confirmed.{" "}
              <a
                href={`${EXPLORER_TX_URL}/${result.digest}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.transferResultLink}
              >
                View on Suiscan
              </a>
            </>
          ) : (
            result.error
          )}
        </div>
      )}
    </div>
  );
}
