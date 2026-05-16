"use client";

import { useCallback, useState } from "react";
import type { VeilPrivateState } from "@/lib/types";
import type { SnarkjsProof } from "@/lib/proof-converter";
import { dynamicRequire } from "@/lib/dynamicRequire";
import { generateRandomBigInt } from "@/lib/random";
import { MerkleTree } from "@/lib/merkle-tree";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProofStep =
  | "idle"
  | "loading-circuit"
  | "computing-witness"
  | "generating-proof"
  | "converting-bytes"
  | "done"
  | "error";

export interface ProofGenerationResult {
  readonly proof: Uint8Array;
  readonly publicInputs: Uint8Array;
  readonly newRandomness: bigint;
  readonly cumulativeNew: bigint;
}

interface UseProofGenerationReturn {
  readonly generateTransferProof: (
    privateState: VeilPrivateState,
    txAmount: bigint,
    epochId: bigint,
    threshold: bigint,
  ) => Promise<ProofGenerationResult | null>;
  readonly step: ProofStep;
  readonly progress: number;
  readonly error: string | null;
  readonly isMock: boolean;
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const CIRCUIT_WASM_PATH = "/circuits/transfer.wasm";
const CIRCUIT_ZKEY_PATH = "/circuits/transfer_final.zkey";
const MOCK_PROOF_BYTES = 128;
const MOCK_PUBLIC_INPUTS_COUNT = 6;
const MOCK_DELAY_MS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function circuitArtifactsExist(): Promise<boolean> {
  try {
    const [wasmRes, zkeyRes] = await Promise.all([
      fetch(CIRCUIT_WASM_PATH, { method: "HEAD" }),
      fetch(CIRCUIT_ZKEY_PATH, { method: "HEAD" }),
    ]);
    return wasmRes.ok && zkeyRes.ok;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Mock proof generation (used when circuit artifacts are not available)
// ---------------------------------------------------------------------------

async function generateMockProof(
  privateState: VeilPrivateState,
  txAmount: bigint,
): Promise<ProofGenerationResult> {
  await delay(MOCK_DELAY_MS);

  const newRandomness = generateRandomBigInt();
  const cumulativeNew = privateState.cumulativeSpending + txAmount;

  // Generate deterministic-looking but fake proof bytes
  const proof = new Uint8Array(MOCK_PROOF_BYTES);
  crypto.getRandomValues(proof);

  const publicInputs = new Uint8Array(MOCK_PUBLIC_INPUTS_COUNT * 32);
  crypto.getRandomValues(publicInputs);

  return { proof, publicInputs, newRandomness, cumulativeNew };
}

// ---------------------------------------------------------------------------
// Real proof generation (snarkjs + circomlibjs)
// ---------------------------------------------------------------------------

async function generateRealProof(
  privateState: VeilPrivateState,
  txAmount: bigint,
  epochId: bigint,
  threshold: bigint,
): Promise<ProofGenerationResult> {
  // Dynamic imports: snarkjs and circomlibjs are heavy, load on demand.
  // Uses dynamicRequire to avoid webpack bundling these optional deps.
  const snarkjs = (await dynamicRequire("snarkjs")) as {
    groth16: {
      fullProve: (
        input: Record<string, string | string[] | number[]>,
        wasmPath: string,
        zkeyPath: string,
      ) => Promise<{ proof: SnarkjsProof; publicSignals: string[] }>;
    };
  };
  const circomlibjs = (await dynamicRequire("circomlibjs")) as {
    buildPoseidon: () => Promise<PoseidonInstance>;
  };

  interface PoseidonInstance {
    (inputs: bigint[]): unknown;
    F: { toString: (v: unknown) => string };
  }

  const poseidon: PoseidonInstance = await circomlibjs.buildPoseidon();
  const F = poseidon.F;

  const newRandomness = generateRandomBigInt();
  const salt = generateRandomBigInt();
  const cumulativeNew = privateState.cumulativeSpending + txAmount;

  // Compute Poseidon hashes with domain separation (v2: Poseidon(4) for commitments/nullifiers)
  const oldCommitment = F.toString(
    poseidon([DOMAIN_COMMITMENT, privateState.cumulativeSpending, privateState.randomness, privateState.userSecret]),
  );
  const newCommitment = F.toString(
    poseidon([DOMAIN_COMMITMENT, cumulativeNew, newRandomness, privateState.userSecret]),
  );
  const nullifier = F.toString(
    poseidon([DOMAIN_NULLIFIER, privateState.userSecret, epochId, privateState.randomness]),
  );
  const txAmountHash = F.toString(poseidon([3n, txAmount, salt]));

  // Build Merkle proof for old commitment inclusion
  // REVIEW: Merkle tree is built with mock data — requires on-chain indexer to fetch real commitment leaves
  const merkleTree = new MerkleTree();
  await merkleTree.init();
  // Insert old commitment as the only leaf (demo mode)
  // In production, fetch all commitment events from the pool and insert them in order
  merkleTree.insert(BigInt(oldCommitment));
  const merkleProof = merkleTree.getProof(0);
  const merkleRoot = merkleProof.root.toString();
  const pathElements = merkleProof.pathElements.map((e) => e.toString());
  const pathIndices = [...merkleProof.pathIndices];

  // Circuit input must match transfer.circom signal order
  const circuitInput = {
    oldCommitment,
    newCommitment,
    threshold: threshold.toString(),
    epochId: epochId.toString(),
    nullifier,
    txAmountHash,
    merkleRoot,
    pathElements,
    pathIndices,
    cumulativeOld: privateState.cumulativeSpending.toString(),
    cumulativeNew: cumulativeNew.toString(),
    txAmount: txAmount.toString(),
    randomnessOld: privateState.randomness.toString(),
    randomnessNew: newRandomness.toString(),
    userSecret: privateState.userSecret.toString(),
    salt: salt.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    CIRCUIT_WASM_PATH,
    CIRCUIT_ZKEY_PATH,
  );

  // Convert to Sui format
  const { proofToSuiBytes, publicInputsToSuiBytes } = await import("@/lib/proof-converter");
  const suiProof = proofToSuiBytes(proof);
  const suiInputs = publicInputsToSuiBytes(publicSignals);

  return {
    proof: suiProof,
    publicInputs: suiInputs,
    newRandomness,
    cumulativeNew,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useProofGeneration(): UseProofGenerationReturn {
  const [step, setStep] = useState<ProofStep>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);

  const reset = useCallback(() => {
    setStep("idle");
    setProgress(0);
    setError(null);
  }, []);

  const generateTransferProof = useCallback(
    async (
      privateState: VeilPrivateState,
      txAmount: bigint,
      epochId: bigint,
      threshold: bigint,
    ): Promise<ProofGenerationResult | null> => {
      try {
        setError(null);
        setStep("loading-circuit");
        setProgress(10);

        const hasArtifacts = await circuitArtifactsExist();
        setIsMock(!hasArtifacts);

        if (!hasArtifacts) {
          if (process.env.NODE_ENV === "production") {
            throw new Error("Circuit artifacts unavailable — cannot generate proof");
          }

          // Mock mode (dev only): simulate proof generation with staged progress
          setStep("computing-witness");
          setProgress(30);
          await delay(800);

          setStep("generating-proof");
          setProgress(50);

          const result = await generateMockProof(privateState, txAmount);

          setStep("converting-bytes");
          setProgress(80);
          await delay(400);

          setStep("done");
          setProgress(100);
          return result;
        }

        // Real proof generation
        setStep("computing-witness");
        setProgress(30);

        setStep("generating-proof");
        setProgress(50);

        const result = await generateRealProof(
          privateState,
          txAmount,
          epochId,
          threshold,
        );

        setStep("converting-bytes");
        setProgress(80);

        setStep("done");
        setProgress(100);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Proof generation failed";
        setError(message);
        setStep("error");
        return null;
      }
    },
    [],
  );

  return { generateTransferProof, step, progress, error, isMock, reset };
}
