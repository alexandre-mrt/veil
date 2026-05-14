"use client";

import Link from "next/link";
import { THRESHOLD } from "@/lib/constants";
import { usePrivateState } from "@/hooks/usePrivateState";
import { WalletButton } from "./WalletButton";
import { PrivacyStatusBadge } from "./PrivacyStatus";
import styles from "./components.module.css";

export function Header() {
  const { state, isInitialized } = usePrivateState();

  const spending = state?.cumulativeSpending ?? 0n;

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <Link href="/" className={styles.headerLogo}>
          VEIL
        </Link>
        {isInitialized && (
          <PrivacyStatusBadge
            cumulativeSpending={spending}
            threshold={THRESHOLD}
          />
        )}
      </div>
      <div className={styles.headerRight}>
        <WalletButton />
      </div>
    </header>
  );
}
