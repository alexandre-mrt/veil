"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import styles from "./components.module.css";

function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletButton() {
  const account = useCurrentAccount();

  return (
    <div className={styles.walletWrapper}>
      {account && (
        <span className={styles.walletAddress}>
          {truncateAddress(account.address)}
        </span>
      )}
      <ConnectButton />
    </div>
  );
}
