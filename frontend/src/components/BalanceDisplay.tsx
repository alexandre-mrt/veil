"use client";

import { useEffect, useState } from "react";
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { POOL_ID, TOKEN_TYPE, VEIL_DECIMALS, THRESHOLD, REFETCH_INTERVAL_MS } from "@/lib/constants";
import type { VeilPrivateState } from "@/lib/types";
import { useVeilPool } from "@/hooks/useVeilPool";
import styles from "./components.module.css";

const SUI_DECIMALS = 9;

function formatBalance(raw: string | bigint, decimals: number): string {
  const value = typeof raw === "string" ? BigInt(raw) : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = value % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr.slice(0, 4)}`;
}

interface BalanceCardProps {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly isLoading?: boolean;
}

function BalanceCard({ label, value, unit, isLoading }: BalanceCardProps) {
  return (
    <div className={styles.balanceCard}>
      <div className={styles.balanceCardAccent} />
      <div className={styles.balanceLabel}>{label}</div>
      <div>
        <span className={styles.balanceValue}>
          {isLoading ? "..." : value}
        </span>
        <span className={styles.balanceUnit}>{unit}</span>
      </div>
    </div>
  );
}

function EpochSpendingCard({
  privateState,
  hasWallet,
}: {
  readonly privateState?: VeilPrivateState | null;
  readonly hasWallet: boolean;
}) {
  if (!hasWallet) {
    return (
      <div className={styles.balanceCard}>
        <div className={styles.balanceCardAccent} />
        <div className={styles.balanceLabel}>Epoch Spending</div>
        <div>
          <span className={styles.balanceValue}>Connect wallet</span>
        </div>
      </div>
    );
  }

  if (!privateState) {
    return (
      <div className={styles.balanceCard}>
        <div className={styles.balanceCardAccent} />
        <div className={styles.balanceLabel}>Epoch Spending</div>
        <div>
          <span className={styles.balanceValue}>---</span>
        </div>
      </div>
    );
  }

  const spent = privateState.cumulativeSpending;
  const thresholdDisplay = THRESHOLD;
  const pct =
    thresholdDisplay === 0n
      ? 100
      : Math.min(Number((spent * 10000n) / thresholdDisplay) / 100, 100);
  const barClass =
    pct >= 100
      ? styles.epochBarDanger
      : pct >= 70
        ? styles.epochBarWarning
        : styles.epochBarNormal;

  return (
    <div className={styles.balanceCard}>
      <div className={styles.balanceCardAccent} />
      <div className={styles.balanceLabel}>Epoch Spending</div>
      <div className={styles.epochSpendingBar}>
        <div className={styles.epochBarTrack}>
          <div
            className={`${styles.epochBarFill} ${barClass}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={styles.epochSpendingText}>
          {formatBalance(spent, VEIL_DECIMALS)} / {formatBalance(thresholdDisplay, VEIL_DECIMALS)} VEIL
        </span>
      </div>
    </div>
  );
}

interface BalanceDisplayProps {
  readonly privateState?: VeilPrivateState | null;
}

export function BalanceDisplay({ privateState }: BalanceDisplayProps = {}) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const address = account?.address ?? "";

  const [suiBalance, setSuiBalance] = useState<string | null>(null);
  const [suiLoading, setSuiLoading] = useState(false);
  const [veilRaw, setVeilRaw] = useState(0n);
  const [veilLoading, setVeilLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const { balance: poolBalance, nextLeafIndex: anonymitySet, isLoading: poolLoading } =
    useVeilPool(POOL_ID);

  // Fetch SUI and VEIL balances
  useEffect(() => {
    if (!address || !client) return;

    let cancelled = false;

    async function fetchBalances() {
      setSuiLoading(true);
      setVeilLoading(true);
      setFetchError(false);

      try {
        const [suiResult, coinsResult] = await Promise.all([
          client.core.getBalance({ owner: address }),
          client.core.listCoins({ owner: address, coinType: TOKEN_TYPE }),
        ]);

        if (cancelled) return;

        setSuiBalance(suiResult.balance.balance);
        const total = coinsResult.objects?.reduce(
          (sum: bigint, c: { balance: string }) => sum + BigInt(c.balance),
          0n,
        ) ?? 0n;
        setVeilRaw(total);
      } catch {
        if (!cancelled) {
          setFetchError(true);
        }
      } finally {
        if (!cancelled) {
          setSuiLoading(false);
          setVeilLoading(false);
        }
      }
    }

    fetchBalances();
    const interval = setInterval(fetchBalances, REFETCH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address, client]);

  const suiFormatted = fetchError
    ? "Error loading"
    : suiBalance
      ? formatBalance(suiBalance, SUI_DECIMALS)
      : "0";

  const veilFormatted = fetchError
    ? "Error loading"
    : address
      ? formatBalance(veilRaw, VEIL_DECIMALS)
      : "--";

  const poolFormatted = formatBalance(poolBalance, VEIL_DECIMALS);

  return (
    <div className={styles.balanceGrid}>
      <BalanceCard
        label="SUI Balance"
        value={suiFormatted}
        unit="SUI"
        isLoading={suiLoading && !!address}
      />
      <BalanceCard
        label="VEIL Tokens"
        value={veilFormatted}
        unit="VEIL"
        isLoading={veilLoading && !!address}
      />
      <BalanceCard
        label="Pool Total"
        value={poolFormatted}
        unit="VEIL"
        isLoading={poolLoading}
      />
      <BalanceCard
        label="Anonymity Set"
        value={anonymitySet.toString()}
        unit={anonymitySet === 1 ? "commitment" : "commitments"}
        isLoading={poolLoading}
      />
      <EpochSpendingCard privateState={privateState} hasWallet={!!address} />
    </div>
  );
}
