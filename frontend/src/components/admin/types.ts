import type { Transaction } from "@mysten/sui/transactions";
import { VEIL_DECIMALS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Shared types for admin sub-components
// ---------------------------------------------------------------------------

export interface PoolAdminFields {
  readonly balance: bigint;
  readonly frozen: boolean;
  readonly complianceRequired: boolean;
  readonly pendingVk: number[];
  readonly vkUpdateEpoch: number;
  // Pending withdrawal fields
  readonly pendingWithdrawalAmount: bigint | null;
  readonly pendingWithdrawalRecipient: string | null;
  readonly pendingWithdrawalEpoch: number;
  // Pending compliance toggle fields
  readonly pendingComplianceRequired: boolean | null;
  readonly pendingComplianceEpoch: number;
}

export type ExecTxFn = (
  label: string,
  buildTx: (tx: Transaction) => void,
) => void;

export interface AdminSubComponentProps {
  readonly pool: PoolAdminFields | null;
  readonly isLoading: boolean;
  readonly txPending: boolean;
  readonly accountConnected: boolean;
  readonly execTx: ExecTxFn;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatBalance(value: bigint): string {
  const divisor = 10n ** BigInt(VEIL_DECIMALS);
  const whole = value / divisor;
  const frac = value % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac
    .toString()
    .padStart(VEIL_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${whole}.${fracStr.slice(0, 4)}`;
}

export function parsePoolAdminJson(
  json: Record<string, unknown> | null | undefined,
): PoolAdminFields | null {
  if (!json) return null;
  const pendingVkRaw = json.pending_vk;
  const pendingVk = Array.isArray(pendingVkRaw)
    ? (pendingVkRaw as number[])
    : [];

  const pendingWithdrawalRaw = json.pending_withdrawal;
  const pendingWithdrawalAmount =
    pendingWithdrawalRaw != null
      ? BigInt(pendingWithdrawalRaw as string | number)
      : null;
  const pendingWithdrawalRecipientRaw = json.pending_withdrawal_recipient;
  const pendingWithdrawalRecipient =
    pendingWithdrawalRecipientRaw != null
      ? String(pendingWithdrawalRecipientRaw)
      : null;

  const pendingComplianceRaw = json.pending_compliance_required;
  const pendingComplianceRequired =
    pendingComplianceRaw != null ? (pendingComplianceRaw as boolean) : null;

  return {
    balance: BigInt((json.balance as string | number) ?? 0),
    frozen: (json.frozen as boolean) ?? false,
    complianceRequired: (json.compliance_required as boolean) ?? false,
    pendingVk,
    vkUpdateEpoch: Number((json.vk_update_epoch as string | number) ?? 0),
    pendingWithdrawalAmount,
    pendingWithdrawalRecipient,
    pendingWithdrawalEpoch: Number(
      (json.pending_withdrawal_epoch as string | number) ?? 0,
    ),
    pendingComplianceRequired,
    pendingComplianceEpoch: Number(
      (json.pending_compliance_epoch as string | number) ?? 0,
    ),
  };
}
