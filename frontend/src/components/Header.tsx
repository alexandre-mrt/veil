"use client";

import Link from "next/link";
import { THRESHOLD } from "@/lib/constants";
import { WalletButton } from "./WalletButton";
import { PrivacyStatusBadge } from "./PrivacyStatus";
import styles from "./components.module.css";

interface HeaderProps {
  /** Current cumulative spending from private state. Omit if state not yet loaded. */
  readonly cumulativeSpending?: bigint;
  /** Whether the private state is initialized and ready to display. */
  readonly isPrivateStateReady?: boolean;
}

export function Header({
  cumulativeSpending,
  isPrivateStateReady = false,
}: HeaderProps) {
  const spending = cumulativeSpending ?? 0n;

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <Link href="/" className={styles.headerLogo}>
          VEIL
        </Link>
        {isPrivateStateReady && (
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
