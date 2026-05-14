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
