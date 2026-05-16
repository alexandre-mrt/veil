"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { POOL_ID, THRESHOLD } from "@/lib/constants";
import type { Credential } from "@/lib/types";
import { usePrivateState } from "@/hooks/usePrivateState";
import { useWalletKey } from "@/hooks/useWalletKey";
import { useVeilPool } from "@/hooks/useVeilPool";
import { encryptData, decryptData } from "@/lib/crypto";
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
import { ErrorBoundary } from "@/components/ErrorBoundary";
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
// Credential serialization
// ---------------------------------------------------------------------------

const CREDENTIAL_STORAGE_KEY = "veil_credentials";

interface SerializedCredential {
  readonly leaf: string;
  readonly kycLevel: number;
  readonly expiry: number;
  readonly merkleProof: readonly string[];
  readonly merkleIndex: number;
}

function serializeCredentials(creds: readonly Credential[]): string {
  const serialized: SerializedCredential[] = creds.map((c) => ({
    leaf: c.leaf.toString(),
    kycLevel: c.kycLevel,
    expiry: c.expiry,
    merkleProof: c.merkleProof.map((p) => p.toString()),
    merkleIndex: c.merkleIndex,
  }));
  return JSON.stringify(serialized);
}

function deserializeCredentials(json: string): Credential[] {
  const parsed = JSON.parse(json) as SerializedCredential[];
  return parsed.map((c) => ({
    leaf: BigInt(c.leaf),
    kycLevel: c.kycLevel,
    expiry: c.expiry,
    merkleProof: c.merkleProof.map((p) => BigInt(p)),
    merkleIndex: c.merkleIndex,
  }));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const account = useCurrentAccount();
  const walletAddress = account?.address;

  // Wallet-signature-derived encryption key
  const { unlock, key: walletKey, isUnlocked } = useWalletKey();
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  // Private state uses the wallet-derived key
  const { state, isInitialized, updateAfterTransfer } = usePrivateState(walletKey);
  const { frozen } = useVeilPool(POOL_ID);

  const [activeTab, setActiveTab] = useState<Tab>("deposit");
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const credKeyRef = useRef<CryptoKey | null>(null);

  const spending = state?.cumulativeSpending ?? 0n;

  // Auto-unlock: attempt to load cached key when wallet connects
  useEffect(() => {
    if (!walletAddress || isUnlocked) return;

    let cancelled = false;

    async function tryAutoUnlock(address: string) {
      try {
        // unlock() checks IndexedDB first -- if a cached key exists,
        // no wallet prompt appears. Only prompts on first-ever unlock.
        await unlock(address);
      } catch {
        // Cache miss or IndexedDB unavailable -- user will need to click "Unlock Vault"
        // This is expected on first visit; don't set an error
      }
      if (cancelled) return;
    }

    tryAutoUnlock(walletAddress);
    return () => {
      cancelled = true;
    };
  }, [walletAddress, isUnlocked, unlock]);

  // Manual unlock handler for the button
  const handleUnlock = useCallback(async () => {
    if (!walletAddress) return;
    setIsUnlocking(true);
    setUnlockError(null);
    try {
      await unlock(walletAddress);
    } catch (e) {
      setUnlockError(
        e instanceof Error ? e.message : "Failed to unlock vault",
      );
    } finally {
      setIsUnlocking(false);
    }
  }, [walletAddress, unlock]);

  // Load encrypted credentials from localStorage when key is available
  useEffect(() => {
    if (!walletKey) {
      setCredentials([]);
      setCredentialsLoaded(false);
      credKeyRef.current = null;
      return;
    }

    let cancelled = false;
    credKeyRef.current = walletKey;

    async function loadCredentials(key: CryptoKey) {
      try {
        const stored = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
        if (!stored) {
          if (!cancelled) setCredentialsLoaded(true);
          return;
        }

        try {
          // Try encrypted decryption first
          const json = await decryptData(stored, key);
          if (!cancelled) setCredentials(deserializeCredentials(json));
        } catch {
          // Fallback: legacy plaintext JSON -- migrate by re-encrypting
          try {
            const legacy = deserializeCredentials(stored);
            const encrypted = await encryptData(serializeCredentials(legacy), key);
            localStorage.setItem(CREDENTIAL_STORAGE_KEY, encrypted);
            if (!cancelled) setCredentials(legacy);
          } catch {
            // Corrupted or encrypted with old address-derived key -- start fresh
            localStorage.removeItem(CREDENTIAL_STORAGE_KEY);
          }
        }
      } catch {
        // Crypto unavailable -- credentials will remain empty
      }
      if (!cancelled) setCredentialsLoaded(true);
    }

    loadCredentials(walletKey);
    return () => { cancelled = true; };
  }, [walletKey]);

  // Persist credentials to localStorage (encrypted)
  useEffect(() => {
    if (!credentialsLoaded) return;

    const key = credKeyRef.current;
    if (!key) return;

    async function persistCredentials() {
      try {
        const json = serializeCredentials(credentials);
        const encrypted = await encryptData(json, key as CryptoKey);
        localStorage.setItem(CREDENTIAL_STORAGE_KEY, encrypted);
      } catch {
        // Encryption or storage quota failed -- ignore
      }
    }

    persistCredentials();
  }, [credentials, credentialsLoaded]);

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

  // --- Unlock gate: show unlock prompt if wallet connected but vault locked ---
  if (walletAddress && !isUnlocked) {
    return (
      <div className={styles.dashboard}>
        <Header />
        <main className={styles.content}>
          <div className={styles.unlockPanel}>

            <div className={styles.unlockPanelAccent} />
            <p className={styles.unlockTitle}>Unlock Vault</p>
            <p className={styles.unlockDescription}>
              Sign a message with your wallet to derive your encryption key.
              This never leaves your browser and is required once per session.
            </p>
            <button
              type="button"
              className={componentStyles.depositSubmitBtn}
              onClick={handleUnlock}
              disabled={isUnlocking}
            >
              {isUnlocking ? "Signing..." : "Unlock Vault"}
            </button>
            {unlockError && (
              <p className={componentStyles.depositResultError}>
                {unlockError}
              </p>
            )}
          </div>
        </main>
        <footer className={styles.footer}>
          Built for Sui Overflow 2026 — DeFi &amp; Payments Track
        </footer>
      </div>
    );
  }

  return (
    <div className={styles.dashboard}>
      <Header
        cumulativeSpending={state?.cumulativeSpending}
        isPrivateStateReady={isInitialized}
      />

      <main className={styles.content}>
        <ErrorBoundary>
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
                    onSwitchTab={setActiveTab}
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
        </ErrorBoundary>
      </main>

      <footer className={styles.footer}>
        Built for Sui Overflow 2026 — DeFi &amp; Payments Track
      </footer>
    </div>
  );
}
