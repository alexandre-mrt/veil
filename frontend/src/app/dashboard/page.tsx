"use client";

import { useCallback, useState } from "react";
import { POOL_ID, THRESHOLD } from "@/lib/constants";
import { usePrivateState } from "@/hooks/usePrivateState";
import { useVeilPool } from "@/hooks/useVeilPool";
import { Header } from "@/components/Header";
import { BalanceDisplay } from "@/components/BalanceDisplay";
import { DepositForm } from "@/components/DepositForm";
import { TransferForm } from "@/components/TransferForm";
import { WithdrawForm } from "@/components/WithdrawForm";
import { TransactionHistory } from "@/components/TransactionHistory";
import { PrivacyStatusPanel } from "@/components/PrivacyStatus";
import componentStyles from "@/components/components.module.css";
import styles from "./page.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = "deposit" | "transfer" | "withdraw" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "deposit", label: "Deposit" },
  { id: "transfer", label: "Transfer" },
  { id: "withdraw", label: "Withdraw" },
  { id: "history", label: "History" },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { state, isInitialized, updateAfterTransfer } = usePrivateState();
  const { frozen } = useVeilPool(POOL_ID);

  const [activeTab, setActiveTab] = useState<Tab>("deposit");
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const spending = state?.cumulativeSpending ?? 0n;

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

  return (
    <div className={styles.dashboard}>
      <Header />

      <main className={styles.content}>
        <BalanceDisplay />

        {isInitialized && (
          <PrivacyStatusPanel
            cumulativeSpending={spending}
            threshold={THRESHOLD}
          />
        )}

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
              <DepositForm />
            </div>
          )}

          {activeTab === "transfer" && (
            <div className={styles.singlePanel}>
              <TransferForm
                privateState={state}
                frozen={frozen}
                onStateUpdate={handleStateUpdate}
              />
            </div>
          )}

          {activeTab === "withdraw" && (
            <div className={styles.singlePanel}>
              <WithdrawForm onTxAppended={handleTxAppended} />
            </div>
          )}

          {activeTab === "history" && (
            <TransactionHistory refreshKey={historyRefreshKey} />
          )}
        </div>
      </main>

      <footer className={styles.footer}>
        Built for Sui Overflow 2026 — DeFi &amp; Payments Track
      </footer>
    </div>
  );
}
