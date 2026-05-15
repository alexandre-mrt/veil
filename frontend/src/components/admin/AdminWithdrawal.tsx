"use client";

import { useCallback, useState } from "react";
import { parseAmountToBigInt } from "@/lib/utils";
import {
  PACKAGE_ID,
  POOL_ID,
  ADMIN_CAP_ID,
  VEIL_DECIMALS,
} from "@/lib/constants";
import type { AdminSubComponentProps } from "./types";
import { formatBalance } from "./types";
import styles from "../components.module.css";

// ---------------------------------------------------------------------------
// Propose withdrawal, execute, cancel, emergency withdraw
// ---------------------------------------------------------------------------

interface AdminWithdrawalProps extends Omit<AdminSubComponentProps, "isLoading"> {
  readonly accountAddress: string | undefined;
}

export function AdminWithdrawal({
  pool,
  txPending,
  accountConnected,
  accountAddress,
  execTx,
}: AdminWithdrawalProps) {
  // Normal withdrawal form (timelocked)
  const [proposeWithdrawAmount, setProposeWithdrawAmount] = useState("");
  const [proposeWithdrawRecipient, setProposeWithdrawRecipient] = useState("");

  // Emergency withdraw form
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawRecipient, setWithdrawRecipient] = useState("");

  const hasPendingWithdrawal = pool?.pendingWithdrawalAmount != null;

  // -- Normal Withdrawal (timelocked) ---------------------------------------

  const handleProposeWithdrawal = useCallback(() => {
    const parsed = Number.parseFloat(proposeWithdrawAmount);
    if (Number.isNaN(parsed) || parsed <= 0) return;

    const rawAmount = parseAmountToBigInt(proposeWithdrawAmount, VEIL_DECIMALS);
    const recipient = proposeWithdrawRecipient.trim() || accountAddress;
    if (!recipient) return;

    execTx("Withdrawal proposed", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::propose_withdrawal`,
        arguments: [
          tx.object(POOL_ID),
          tx.object(ADMIN_CAP_ID),
          tx.pure.u64(rawAmount),
          tx.pure.address(recipient),
          tx.object("0x6"),
        ],
      });
    });
  }, [proposeWithdrawAmount, proposeWithdrawRecipient, accountAddress, execTx]);

  const handleExecuteWithdrawal = useCallback(() => {
    execTx("Withdrawal executed", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::execute_pending_withdrawal`,
        arguments: [
          tx.object(POOL_ID),
          tx.object(ADMIN_CAP_ID),
          tx.object("0x6"),
        ],
      });
    });
  }, [execTx]);

  const handleCancelWithdrawal = useCallback(() => {
    execTx("Withdrawal cancelled", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::cancel_withdrawal`,
        arguments: [tx.object(POOL_ID), tx.object(ADMIN_CAP_ID)],
      });
    });
  }, [execTx]);

  // -- Emergency Withdraw ---------------------------------------------------

  const handleEmergencyWithdraw = useCallback(() => {
    const parsed = Number.parseFloat(withdrawAmount);
    if (Number.isNaN(parsed) || parsed <= 0) return;

    const rawAmount = parseAmountToBigInt(withdrawAmount, VEIL_DECIMALS);
    const recipient = withdrawRecipient.trim() || accountAddress;
    if (!recipient) return;

    execTx("Emergency withdraw", (tx) => {
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::emergency_withdraw`,
        arguments: [
          tx.object(POOL_ID),
          tx.object(ADMIN_CAP_ID),
          tx.pure.u64(rawAmount),
          tx.pure.address(recipient),
        ],
      });
    });
  }, [withdrawAmount, withdrawRecipient, accountAddress, execTx]);

  return (
    <>
      {/* Normal Withdrawal (Timelocked) */}
      <div className={styles.adminSection}>
        <span className={styles.adminSectionTitle}>Propose Withdrawal</span>

        {hasPendingWithdrawal && (
          <div className={styles.adminPendingVk}>
            Pending withdrawal:{" "}
            {formatBalance(pool.pendingWithdrawalAmount!)} VEIL &rarr;{" "}
            {pool.pendingWithdrawalRecipient?.slice(0, 10)}... — effective epoch{" "}
            {pool.pendingWithdrawalEpoch}
          </div>
        )}

        {!hasPendingWithdrawal && (
          <div className={styles.adminVkForm}>
            <input
              type="number"
              min="0"
              step="0.000001"
              placeholder="Amount (VEIL)"
              value={proposeWithdrawAmount}
              onChange={(e) => setProposeWithdrawAmount(e.target.value)}
              className={styles.adminInput}
              disabled={txPending}
            />
            <input
              type="text"
              placeholder={accountAddress ?? "Recipient address (0x...)"}
              value={proposeWithdrawRecipient}
              onChange={(e) => setProposeWithdrawRecipient(e.target.value)}
              className={styles.adminInput}
              disabled={txPending}
            />
            <button
              type="button"
              className={styles.adminBtnAccent}
              disabled={
                txPending ||
                !accountConnected ||
                !proposeWithdrawAmount ||
                Number.parseFloat(proposeWithdrawAmount) <= 0
              }
              onClick={handleProposeWithdrawal}
            >
              {txPending ? "Signing..." : "Propose Withdrawal"}
            </button>
          </div>
        )}

        {hasPendingWithdrawal && (
          <div className={styles.adminVkButtons}>
            <button
              type="button"
              className={styles.adminBtnAccent}
              disabled={txPending || !accountConnected}
              onClick={handleExecuteWithdrawal}
            >
              {txPending ? "Signing..." : "Execute Withdrawal"}
            </button>
            <button
              type="button"
              className={styles.adminBtnDanger}
              disabled={txPending || !accountConnected}
              onClick={handleCancelWithdrawal}
            >
              Cancel Withdrawal
            </button>
          </div>
        )}
      </div>

      {/* Emergency Withdraw (Frozen Only) */}
      <div className={styles.adminSection}>
        <span className={styles.adminSectionTitle}>
          Emergency Withdraw (Frozen Only)
        </span>
        <div className={styles.adminVkForm}>
          <input
            type="number"
            min="0"
            step="0.000001"
            placeholder="Amount (VEIL)"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            className={styles.adminInput}
            disabled={txPending}
          />
          <input
            type="text"
            placeholder={accountAddress ?? "Recipient address (0x...)"}
            value={withdrawRecipient}
            onChange={(e) => setWithdrawRecipient(e.target.value)}
            className={styles.adminInput}
            disabled={txPending}
          />
          <button
            type="button"
            className={styles.adminBtnDanger}
            disabled={
              txPending ||
              !accountConnected ||
              !withdrawAmount ||
              Number.parseFloat(withdrawAmount) <= 0
            }
            onClick={handleEmergencyWithdraw}
          >
            {txPending ? "Signing..." : "Emergency Withdraw"}
          </button>
        </div>
      </div>
    </>
  );
}
