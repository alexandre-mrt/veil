"use client";

import { THRESHOLD } from "@/lib/constants";
import { usePrivateState } from "@/hooks/usePrivateState";
import { Header } from "@/components/Header";
import { BalanceDisplay } from "@/components/BalanceDisplay";
import { DepositForm } from "@/components/DepositForm";
import { PrivacyStatusPanel } from "@/components/PrivacyStatus";
import styles from "./page.module.css";
import compStyles from "@/components/components.module.css";

export default function DashboardPage() {
  const { state, isInitialized } = usePrivateState();

  const spending = state?.cumulativeSpending ?? 0n;

  return (
    <div className={styles.dashboard}>
      <Header />

      <main className={styles.content}>
        <BalanceDisplay />

        <div className={styles.actionGrid}>
          <DepositForm />

          <div className={compStyles.placeholderPanel}>
            <span className={compStyles.placeholderTitle}>Transfer</span>
            <span className={compStyles.placeholderText}>Coming Soon</span>
          </div>
        </div>

        {isInitialized && (
          <PrivacyStatusPanel
            cumulativeSpending={spending}
            threshold={THRESHOLD}
          />
        )}
      </main>

      <footer className={styles.footer}>
        Built for Sui Overflow 2026 — DeFi &amp; Payments Track
      </footer>
    </div>
  );
}
