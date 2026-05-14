"use client";

import { useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import { POOL_ID } from "@/lib/constants";
import { useVeilPool } from "@/hooks/useVeilPool";
import styles from "./components.module.css";

const SUI_DECIMALS = 9;
const VEIL_DECIMALS = 6;

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

export function BalanceDisplay() {
  const account = useCurrentAccount();
  const address = account?.address ?? "";

  const { data: suiBalance, isLoading: suiLoading } = useSuiClientQuery(
    "getBalance",
    { owner: address },
    { enabled: !!address },
  );

  const { balance: poolBalance, isLoading: poolLoading } =
    useVeilPool(POOL_ID);

  const suiFormatted = suiBalance
    ? formatBalance(suiBalance.totalBalance, SUI_DECIMALS)
    : "0";

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
        value={address ? "0" : "--"}
        unit="VEIL"
      />
      <BalanceCard
        label="Pool Total"
        value={poolFormatted}
        unit="VEIL"
        isLoading={poolLoading}
      />
    </div>
  );
}
