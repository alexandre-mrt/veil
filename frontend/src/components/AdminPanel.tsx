"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import {
  POOL_ID,
  EXPLORER_TX_URL,
  REFETCH_INTERVAL_MS,
} from "@/lib/constants";
import type { PoolAdminFields } from "./admin/types";
import { parsePoolAdminJson } from "./admin/types";
import { AdminPoolStatus } from "./admin/AdminPoolStatus";
import { AdminPoolActions } from "./admin/AdminPoolActions";
import { AdminWithdrawal } from "./admin/AdminWithdrawal";
import { AdminComplianceConfig } from "./admin/AdminComplianceConfig";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Thin wrapper: owns pool fetch + execTx, delegates UI to sub-components
// ---------------------------------------------------------------------------

export function AdminPanel() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();

  const [pool, setPool] = useState<PoolAdminFields | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [txPending, setTxPending] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    digest?: string;
  } | null>(null);

  // -----------------------------------------------------------------------
  // Fetch pool data
  // -----------------------------------------------------------------------

  const fetchPool = useCallback(async () => {
    if (!client) return;
    setIsLoading(true);
    try {
      const res = await client.core.getObject({
        objectId: POOL_ID,
        include: { json: true },
      });
      const parsed = parsePoolAdminJson(
        res.object.json as Record<string, unknown> | null,
      );
      setPool(parsed);
    } catch {
      // Pool fetch failure is non-fatal
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    fetchPool();
    const interval = setInterval(fetchPool, REFETCH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchPool]);

  // -----------------------------------------------------------------------
  // Transaction helper (shared across sub-components)
  // -----------------------------------------------------------------------

  const execTx = useCallback(
    async (label: string, buildTx: (tx: Transaction) => void) => {
      if (!account) {
        setResult({ success: false, message: "Wallet not connected" });
        return;
      }
      setTxPending(true);
      setResult(null);

      try {
        const tx = new Transaction();
        buildTx(tx);
        const txResult = await dAppKit.signAndExecuteTransaction({
          transaction: tx,
        });

        if (txResult.FailedTransaction) {
          throw new Error(
            txResult.FailedTransaction.status.error?.message ??
              "Transaction failed",
          );
        }

        const digest = txResult.Transaction.digest;
        await client.core.waitForTransaction({ digest });
        setResult({ success: true, message: `${label} confirmed`, digest });
        fetchPool();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : `${label} failed`;
        setResult({ success: false, message });
      } finally {
        setTxPending(false);
      }
    },
    [account, client, dAppKit, fetchPool],
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const accountConnected = !!account;

  return (
    <div className={styles.adminPanel}>
      <div className={styles.adminPanelAccent} />
      <span className={styles.adminTitle}>Admin Controls</span>

      <div className={styles.adminWarning}>
        Admin actions require the AdminCap. Only the pool deployer can execute
        these operations.
      </div>

      <AdminPoolStatus pool={pool} isLoading={isLoading} />

      <AdminPoolActions
        pool={pool}
        txPending={txPending}
        accountConnected={accountConnected}
        execTx={execTx}
      />

      <AdminWithdrawal
        pool={pool}
        txPending={txPending}
        accountConnected={accountConnected}
        accountAddress={account?.address}
        execTx={execTx}
      />

      <AdminComplianceConfig
        txPending={txPending}
        accountConnected={accountConnected}
        execTx={execTx}
      />

      {result && (
        <div
          className={`${styles.adminResult} ${
            result.success
              ? styles.adminResultSuccess
              : styles.adminResultError
          }`}
        >
          {result.message}
          {result.digest && (
            <>
              {" "}
              <a
                href={`${EXPLORER_TX_URL}/${result.digest}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.adminResultLink}
              >
                View on Suiscan
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
