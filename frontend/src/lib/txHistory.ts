// ---------------------------------------------------------------------------
// Transaction History — local storage utility
// ---------------------------------------------------------------------------

export type TxType = "deposit" | "transfer" | "withdraw";

export interface TxRecord {
  readonly id: string;
  readonly type: TxType;
  readonly amount: bigint;
  readonly digest: string;
  readonly timestamp: number;
}

// Serialized form (bigint → string)
interface TxRecordSerialized {
  readonly id: string;
  readonly type: TxType;
  readonly amount: string;
  readonly digest: string;
  readonly timestamp: number;
}

const STORAGE_KEY = "veil-tx-history";
const MAX_ENTRIES = 20;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadTxHistory(): TxRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: TxRecordSerialized[] = JSON.parse(raw);
    return parsed.map((r) => ({ ...r, amount: BigInt(r.amount) }));
  } catch {
    return [];
  }
}

export function appendTx(record: Omit<TxRecord, "id" | "timestamp">): TxRecord {
  const full: TxRecord = {
    ...record,
    id: generateId(),
    timestamp: Date.now(),
  };

  const existing = loadTxHistory();
  // Newest first, cap at MAX_ENTRIES
  const updated = [full, ...existing].slice(0, MAX_ENTRIES);

  const serialized: TxRecordSerialized[] = updated.map((r) => ({
    ...r,
    amount: r.amount.toString(),
  }));

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Storage quota exceeded — silently drop oldest entries
  }

  return full;
}
