export interface VeilPrivateState {
  userSecret: bigint;
  currentEpoch: number;
  cumulativeSpending: bigint;
  randomness: bigint;
  credentials: Credential[];
}

export interface Credential {
  leaf: bigint;
  kycLevel: number;
  expiry: number;
  merkleProof: bigint[];
  merkleIndex: number;
}

export interface TransferParams {
  amount: bigint;
  recipient: string;
}

export interface ProofResult {
  proof: Uint8Array;
  publicInputs: Uint8Array;
}

export type PrivacyTier = "anonymous" | "kyc-required" | "frozen";

// ---------------------------------------------------------------------------
// Compliance (Tier 3)
// ---------------------------------------------------------------------------

export interface ComplianceConfig {
  configId: string;
  poolId: string;
  credentialRoot: string;
  requiredKycLevel: number;
  auditorPublicKey: Uint8Array;
}

export interface AuditorCiphertext {
  ephemeralPublicKey: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  combined: Uint8Array;
}

export type ComplianceStep =
  | "idle"
  | "generating-transfer-proof"
  | "generating-compliance-proof"
  | "encrypting-for-auditor"
  | "submitting-tx"
  | "done"
  | "error";
