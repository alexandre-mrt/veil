"use client";

import { useCallback, useState } from "react";
import type { SnarkjsProof } from "@/lib/proof-converter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplianceProofStep =
  | "idle"
  | "loading-circuit"
  | "computing-witness"
  | "generating-proof"
  | "converting-bytes"
  | "done"
  | "error";

export interface ComplianceProofInput {
  readonly userSecret: bigint;
  readonly kycLevel: bigint;
  readonly expiryEpoch: bigint;
  readonly issuerId: bigint;
  readonly merkleRoot: bigint;
  readonly pathElements: readonly bigint[];
  readonly pathIndices: readonly number[];
  readonly currentEpoch: bigint;
  readonly transferNullifier: bigint;
  readonly requiredKycLevel: bigint;
}

export interface ComplianceProofResult {
  readonly proof: Uint8Array;
  readonly publicInputs: Uint8Array;
}

interface UseComplianceProofReturn {
  readonly generateComplianceProof: (
    input: ComplianceProofInput,
  ) => Promise<ComplianceProofResult | null>;
  readonly step: ComplianceProofStep;
  readonly progress: number;
  readonly error: string | null;
  readonly isMock: boolean;
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const CIRCUIT_WASM_PATH = "/circuits/compliance.wasm";
const CIRCUIT_ZKEY_PATH = "/circuits/compliance_final.zkey";
const MOCK_PROOF_BYTES = 128;
const MOCK_PUBLIC_INPUTS_COUNT = 6;
const MOCK_DELAY_MS = 2500;

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

async function generateMockProof(): Promise<ComplianceProofResult> {
  await delay(MOCK_DELAY_MS);

  const proof = new Uint8Array(MOCK_PROOF_BYTES);
  crypto.getRandomValues(proof);

  const publicInputs = new Uint8Array(MOCK_PUBLIC_INPUTS_COUNT * 32);
  crypto.getRandomValues(publicInputs);

  return { proof, publicInputs };
}

// ---------------------------------------------------------------------------
// Real proof generation (snarkjs + circomlibjs)
// ---------------------------------------------------------------------------

/**
 * Dynamically imports a module by name, bypassing webpack static analysis.
 * This prevents build failures when optional dependencies are not installed.
 */
async function dynamicRequire(moduleName: string): Promise<unknown> {
  // Using Function constructor to create a dynamic import that webpack cannot
  // statically analyze, allowing optional dependencies to be missing at build time.
  // eslint-disable-next-line no-new-func
  const importFn = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
  return importFn(moduleName);
}

async function generateRealProof(
  input: ComplianceProofInput,
): Promise<ComplianceProofResult> {
  const snarkjs = (await dynamicRequire("snarkjs")) as {
    groth16: {
      fullProve: (
        input: Record<string, string>,
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
    F: { toObject: (v: unknown) => bigint; toString: (v: unknown) => string };
  }

  const poseidon: PoseidonInstance = await circomlibjs.buildPoseidon();
  const F = poseidon.F;

  // Compute contextId: Poseidon(6, transferNullifier, userSecret)
  const contextId = F.toObject(
    poseidon([DOMAIN_CONTEXT_BINDING, input.transferNullifier, input.userSecret]),
  );

  // Domain tag 5: nullifier = Poseidon(5, userSecret, contextId)
  const nullifier = F.toObject(
    poseidon([DOMAIN_NULLIFIER, input.userSecret, contextId]),
  );

  const circuitInput: Record<string, string> = {
    // Public
    merkleRoot: input.merkleRoot.toString(),
    currentEpoch: input.currentEpoch.toString(),
    contextId: contextId.toString(),
    requiredKycLevel: input.requiredKycLevel.toString(),
    nullifier: nullifier.toString(),
    validCredential: "1",
    // Private
    userSecret: input.userSecret.toString(),
    kycLevel: input.kycLevel.toString(),
    expiryEpoch: input.expiryEpoch.toString(),
    issuerId: input.issuerId.toString(),
    pathElements: input.pathElements.map((e) => e.toString()).join(","),
    pathIndices: input.pathIndices.map((i) => i.toString()).join(","),
    transferNullifier: input.transferNullifier.toString(),
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

  return { proof: suiProof, publicInputs: suiInputs };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useComplianceProof(): UseComplianceProofReturn {
  const [step, setStep] = useState<ComplianceProofStep>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);

  const reset = useCallback(() => {
    setStep("idle");
    setProgress(0);
    setError(null);
  }, []);

  const generateComplianceProof = useCallback(
    async (
      input: ComplianceProofInput,
    ): Promise<ComplianceProofResult | null> => {
      try {
        setError(null);
        setStep("loading-circuit");
        setProgress(10);

        const hasArtifacts = await circuitArtifactsExist();
        setIsMock(!hasArtifacts);

        if (!hasArtifacts) {
          // Mock mode: simulate proof generation with staged progress
          setStep("computing-witness");
          setProgress(30);
          await delay(800);

          setStep("generating-proof");
          setProgress(50);

          const result = await generateMockProof();

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

        const result = await generateRealProof(input);

        setStep("converting-bytes");
        setProgress(80);

        setStep("done");
        setProgress(100);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Compliance proof generation failed";
        setError(message);
        setStep("error");
        return null;
      }
    },
    [],
  );

  return { generateComplianceProof, step, progress, error, isMock, reset };
}
