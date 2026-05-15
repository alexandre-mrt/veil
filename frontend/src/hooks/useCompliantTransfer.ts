"use client";

import { useCallback, useState } from "react";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, POOL_ID, THRESHOLD, EPOCH_DURATION_MS } from "@/lib/constants";
import type { VeilPrivateState, ComplianceConfig, ComplianceStep } from "@/lib/types";
import { useProofGeneration } from "./useProofGeneration";
import { useComplianceProof } from "./useComplianceProof";
import type { ComplianceProofInput } from "./useComplianceProof";
import { useAuditorEncryption } from "./useAuditorEncryption";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompliantTransferResult {
  readonly success: boolean;
  readonly digest?: string;
  readonly error?: string;
}

interface UseCompliantTransferReturn {
  readonly executeCompliantTransfer: (
    privateState: VeilPrivateState,
    txAmount: bigint,
    salt: bigint,
    complianceConfig: ComplianceConfig,
    onStateUpdate: (cumulativeNew: bigint, newRandomness: bigint) => void,
  ) => Promise<CompliantTransferResult>;
  readonly step: ComplianceStep;
  readonly progress: number;
  readonly error: string | null;
  readonly isMock: boolean;
  readonly isPending: boolean;
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUI_CLOCK_OBJECT_ID = "0x6";

function getCurrentEpochId(): bigint {
  return BigInt(Math.floor(Date.now() / Number(EPOCH_DURATION_MS)));
}

/**
 * Extracts the transfer nullifier from transfer publicInputs bytes.
 * The nullifier occupies bytes 128..160 (the 5th 32-byte field).
 */
function extractTransferNullifier(publicInputs: Uint8Array): bigint {
  const nullifierBytes = publicInputs.slice(128, 160);
  let value = 0n;
  for (let i = 0; i < 32; i++) {
    value |= BigInt(nullifierBytes[i]) << BigInt(i * 8);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCompliantTransfer(): UseCompliantTransferReturn {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKitInstance = useDAppKit();
  const transferProofGen = useProofGeneration();
  const complianceProofGen = useComplianceProof();
  const auditorEncryption = useAuditorEncryption();

  const [step, setStep] = useState<ComplianceStep>("idle");
  const [progress, setProgress] = useState(0);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMock = transferProofGen.isMock || complianceProofGen.isMock;

  const reset = useCallback(() => {
    transferProofGen.reset();
    complianceProofGen.reset();
    auditorEncryption.reset();
    setStep("idle");
    setProgress(0);
    setIsPending(false);
    setError(null);
  }, [transferProofGen, complianceProofGen, auditorEncryption]);

  const executeCompliantTransfer = useCallback(
    async (
      privateState: VeilPrivateState,
      txAmount: bigint,
      salt: bigint,
      complianceConfig: ComplianceConfig,
      onStateUpdate: (cumulativeNew: bigint, newRandomness: bigint) => void,
    ): Promise<CompliantTransferResult> => {
      if (!account) {
        return { success: false, error: "Wallet not connected" };
      }

      setIsPending(true);
      setError(null);
      setStep("generating-transfer-proof");
      setProgress(10);

      try {
        // Step 1: Generate transfer proof (reuse existing hook)
        const transferResult = await transferProofGen.generateTransferProof(
          privateState,
          txAmount,
          getCurrentEpochId(),
          THRESHOLD,
        );

        if (!transferResult) {
          const msg = transferProofGen.error ?? "Transfer proof generation failed";
          setError(msg);
          setStep("error");
          setIsPending(false);
          return { success: false, error: msg };
        }

        setProgress(30);

        // Step 2: Extract transfer nullifier as contextId for compliance proof
        const transferNullifier = extractTransferNullifier(transferResult.publicInputs);

        // Step 3: Generate compliance proof
        setStep("generating-compliance-proof");
        setProgress(40);

        // Find first valid credential for the required KYC level
        const credential = privateState.credentials.find(
          (c) => c.kycLevel >= complianceConfig.requiredKycLevel,
        );

        if (!credential) {
          const msg = `No credential found for KYC level >= ${complianceConfig.requiredKycLevel}`;
          setError(msg);
          setStep("error");
          setIsPending(false);
          return { success: false, error: msg };
        }

        const complianceInput: ComplianceProofInput = {
          userSecret: privateState.userSecret,
          kycLevel: BigInt(credential.kycLevel),
          expiryEpoch: BigInt(credential.expiry),
          issuerId: credential.leaf, // issuer encoded in leaf
          merkleRoot: BigInt(complianceConfig.credentialRoot),
          pathElements: credential.merkleProof,
          pathIndices: Array.from(
            { length: credential.merkleProof.length },
            (_, i) => (credential.merkleIndex >> i) & 1,
          ),
          currentEpoch: getCurrentEpochId(),
          transferNullifier,
          requiredKycLevel: BigInt(complianceConfig.requiredKycLevel),
        };

        const complianceResult = await complianceProofGen.generateComplianceProof(
          complianceInput,
        );

        if (!complianceResult) {
          const msg = complianceProofGen.error ?? "Compliance proof generation failed";
          setError(msg);
          setStep("error");
          setIsPending(false);
          return { success: false, error: msg };
        }

        setProgress(60);

        // Step 4: Encrypt transaction details for auditor
        setStep("encrypting-for-auditor");
        setProgress(70);

        const auditorResult = await auditorEncryption.encryptForAuditor(
          complianceConfig.auditorPublicKey,
          { txAmount: txAmount.toString(), salt: salt.toString() },
        );

        if (!auditorResult) {
          const msg = auditorEncryption.error ?? "Auditor encryption failed";
          setError(msg);
          setStep("error");
          setIsPending(false);
          return { success: false, error: msg };
        }

        setProgress(80);

        // Step 5: Build PTB and submit
        setStep("submitting-tx");
        setProgress(85);

        const tx = new Transaction();
        tx.moveCall({
          target: `${PACKAGE_ID}::compliance::compliant_transfer`,
          arguments: [
            tx.object(POOL_ID),
            tx.object(complianceConfig.configId),
            tx.pure.vector("u8", Array.from(transferResult.proof)),
            tx.pure.vector("u8", Array.from(transferResult.publicInputs)),
            tx.pure.vector("u8", Array.from(complianceResult.proof)),
            tx.pure.vector("u8", Array.from(complianceResult.publicInputs)),
            tx.pure.vector("u8", Array.from(auditorResult.combined)),
            tx.object(SUI_CLOCK_OBJECT_ID),
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

        // Step 6: Update private state on success
        onStateUpdate(transferResult.cumulativeNew, transferResult.newRandomness);

        setStep("done");
        setProgress(100);
        setIsPending(false);

        return { success: true, digest };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Compliant transfer failed";
        setError(message);
        setStep("error");
        setIsPending(false);
        return { success: false, error: message };
      }
    },
    [account, client, dAppKitInstance, transferProofGen, complianceProofGen, auditorEncryption],
  );

  return {
    executeCompliantTransfer,
    step,
    progress,
    error,
    isMock,
    isPending,
    reset,
  };
}
