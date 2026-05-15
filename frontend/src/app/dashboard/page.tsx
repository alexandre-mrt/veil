"use client";

import { useCallback, useEffect, useState } from "react";
import { POOL_ID, THRESHOLD } from "@/lib/constants";
import type { Credential } from "@/lib/types";
import { usePrivateState } from "@/hooks/usePrivateState";
import { useVeilPool } from "@/hooks/useVeilPool";
import { Header } from "@/components/Header";
import { BalanceDisplay } from "@/components/BalanceDisplay";
import { DepositForm } from "@/components/DepositForm";
import { TransferForm } from "@/components/TransferForm";
import { WithdrawForm } from "@/components/WithdrawForm";
import { TransactionHistory } from "@/components/TransactionHistory";
import { ComplianceStatus } from "@/components/ComplianceStatus";
import { EpochDisplay } from "@/components/EpochDisplay";
import { AuditorInfo } from "@/components/AuditorInfo";
import { FaucetButton } from "@/components/FaucetButton";
import { CredentialManager } from "@/components/CredentialManager";
import { CompliantTransferForm } from "@/components/CompliantTransferForm";
import { AdminPanel } from "@/components/AdminPanel";
import { AuditorEventBrowser } from "@/components/AuditorEventBrowser";
import componentStyles from "@/components/components.module.css";
import styles from "./page.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = "deposit" | "transfer" | "compliant" | "withdraw" | "history" | "admin";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "deposit", label: "Deposit" },
  { id: "transfer", label: "Transfer" },
  { id: "compliant", label: "Compliant Transfer" },
  { id: "withdraw", label: "Withdraw" },
  { id: "history", label: "History" },
  { id: "admin", label: "Admin" },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { state, isInitialized, updateAfterTransfer } = usePrivateState();
  const { frozen } = useVeilPool(POOL_ID);

  const [activeTab, setActiveTab] = useState<Tab>("deposit");
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [credentials, setCredentials] = useState<Credential[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem("veil_credentials");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Array<{
        leaf: string;
        kycLevel: number;
        expiry: number;
        merkleProof: string[];
        merkleIndex: number;
      }>;
      return parsed.map((c) => ({
        leaf: BigInt(c.leaf),
        kycLevel: c.kycLevel,
        expiry: c.expiry,
        merkleProof: c.merkleProof.map((p) => BigInt(p)),
        merkleIndex: c.merkleIndex,
      }));
    } catch {
      return [];
    }
  });

  const spending = state?.cumulativeSpending ?? 0n;

  // Persist credentials to localStorage
  useEffect(() => {
    try {
      const serialized = credentials.map((c) => ({
        leaf: c.leaf.toString(),
        kycLevel: c.kycLevel,
        expiry: c.expiry,
        merkleProof: c.merkleProof.map((p) => p.toString()),
        merkleIndex: c.merkleIndex,
      }));
      localStorage.setItem("veil_credentials", JSON.stringify(serialized));
    } catch {
      // Storage quota exceeded — ignore
    }
  }, [credentials]);

  const handleStateUpdate = useCallback(
    (cumulativeNew: bigint, newRandomness: bigint) => {
      if (updateAfterTransfer) {
        updateAfterTransfer(cumulativeNew, newRandomness);
      }
    },
    [updateAfterTransfer],
  );

  const handleTxAppended = useCallback(() => {
    setHistoryRefreshKey((k) => k + 1);
  }, []);

  const handleCredentialImport = useCallback((credential: Credential) => {
    setCredentials((prev) => [...prev, credential]);
  }, []);

  const handleCredentialRemove = useCallback((index: number) => {
    setCredentials((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <div className={styles.dashboard}>
      <Header />

      <main className={styles.content}>
        <BalanceDisplay privateState={state} />

        <div className={styles.layout}>
          {/* Sidebar */}
          <aside className={styles.sidebar}>
            {isInitialized && (
              <ComplianceStatus
                cumulativeSpending={spending}
                threshold={THRESHOLD}
                credentials={credentials}
              />
            )}

            <EpochDisplay />

            <AuditorInfo />

            <FaucetButton />

            <CredentialManager
              credentials={credentials}
              onImport={handleCredentialImport}
              onRemove={handleCredentialRemove}
            />
          </aside>

          {/* Main panel */}
          <div className={styles.mainPanel}>
            <div className={styles.tabPanel}>
              <nav className={componentStyles.tabNav} aria-label="Actions">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`${componentStyles.tabBtn} ${
                      activeTab === tab.id ? componentStyles.tabBtnActive : ""
                    }`}
                    onClick={() => setActiveTab(tab.id)}
                    aria-current={activeTab === tab.id ? "page" : undefined}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              {activeTab === "deposit" && (
                <div className={styles.singlePanel}>
                  <DepositForm privateState={state} onTxAppended={handleTxAppended} />
                </div>
              )}

              {activeTab === "transfer" && (
                <div className={styles.singlePanel}>
                  <TransferForm
                    privateState={state}
                    frozen={frozen}
                    onStateUpdate={handleStateUpdate}
                    onTxAppended={handleTxAppended}
                  />
                </div>
              )}

              {activeTab === "compliant" && (
                <div className={styles.singlePanel}>
                  <CompliantTransferForm
                    privateState={state}
                    credentials={credentials}
                    frozen={frozen}
                    onStateUpdate={handleStateUpdate}
                    onTxAppended={handleTxAppended}
                  />
                </div>
              )}

              {activeTab === "withdraw" && (
                <div className={styles.singlePanel}>
                  <WithdrawForm privateState={state} onTxAppended={handleTxAppended} />
                </div>
              )}

              {activeTab === "history" && (
                <TransactionHistory refreshKey={historyRefreshKey} />
              )}

              {activeTab === "admin" && (
                <div className={styles.adminTabLayout}>
                  <AdminPanel />
                  <AuditorEventBrowser />
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        Built for Sui Overflow 2026 — DeFi &amp; Payments Track
      </footer>
    </div>
  );
}
