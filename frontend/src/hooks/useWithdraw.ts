"use client";

import { useCallback, useState } from "react";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, POOL_ID } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WithdrawResult {
  readonly success: boolean;
  readonly digest?: string;
  readonly error?: string;
}

interface UseWithdrawReturn {
  readonly withdraw: (amount: bigint, recipient: string) => Promise<WithdrawResult>;
  readonly isPending: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWithdraw(): UseWithdrawReturn {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKitInstance = useDAppKit();
  const [isPending, setIsPending] = useState(false);

  const withdraw = useCallback(
    async (amount: bigint, recipient: string): Promise<WithdrawResult> => {
      if (!account) {
        return { success: false, error: "Wallet not connected" };
      }

      if (amount <= 0n) {
        return { success: false, error: "Invalid amount" };
      }

      if (!recipient || recipient.length === 0) {
        return { success: false, error: "Invalid recipient address" };
      }

      setIsPending(true);

      try {
        const tx = new Transaction();
        tx.moveCall({
          target: `${PACKAGE_ID}::pool::withdraw`,
          arguments: [
            tx.object(POOL_ID),
            tx.pure.u64(amount),
            tx.pure.address(recipient),
          ],
        });

        const txResult = await dAppKitInstance.signAndExecuteTransaction({ transaction: tx });

        if (txResult.FailedTransaction) {
          throw new Error(
            txResult.FailedTransaction.status.error?.message ?? "Transaction failed",
          );
        }

        const digest = txResult.Transaction.digest;

        // Wait for transaction finality before updating state
        await client.core.waitForTransaction({ digest });

        setIsPending(false);
        return { success: true, digest };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Withdraw failed";
        setIsPending(false);
        return { success: false, error: message };
      }
    },
    [account, client, dAppKitInstance],
  );

  return { withdraw, isPending };
}
