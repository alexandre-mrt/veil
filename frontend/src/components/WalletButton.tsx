"use client";

import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";
import "@mysten/dapp-kit/dist/index.css";
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
      <ConnectButton
        connectText="Connect Wallet"
        className={styles.walletConnectBtn}
      />
    </div>
  );
}
