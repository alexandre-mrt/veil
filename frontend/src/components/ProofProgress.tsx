"use client";

import type { TransferStep } from "@/hooks/useShieldedTransfer";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

interface StepDef {
  readonly key: TransferStep;
  readonly label: string;
  readonly number: number;
}

const STEPS: readonly StepDef[] = [
  { key: "loading-circuit", label: "Loading circuit", number: 1 },
  { key: "computing-witness", label: "Computing witness", number: 2 },
  { key: "generating-proof", label: "Generating ZK proof", number: 3 },
  { key: "converting-bytes", label: "Converting to Sui format", number: 4 },
  { key: "submitting-tx", label: "Submitting transaction", number: 5 },
] as const;

const TOTAL_STEPS = STEPS.length;
const BAR_WIDTH = 24;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStepIndex(current: TransferStep): number {
  const idx = STEPS.findIndex((s) => s.key === current);
  if (current === "done") return STEPS.length;
  return idx >= 0 ? idx : -1;
}

function buildBar(filled: number, total: number): string {
  const filledCount = Math.round((filled / total) * BAR_WIDTH);
  const emptyCount = BAR_WIDTH - filledCount;
  return "█".repeat(filledCount) + "░".repeat(emptyCount);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ProofProgressProps {
  readonly step: TransferStep;
  readonly progress: number;
  readonly isMock: boolean;
  readonly error: string | null;
}

export function ProofProgress({ step, progress, isMock, error }: ProofProgressProps) {
  if (step === "idle") return null;

  const currentIndex = getStepIndex(step);
  const isDone = step === "done";
  const isError = step === "error";

  return (
    <div className={styles.proofProgress}>
      {isMock && (
        <div className={styles.proofMockBanner}>
          [MOCK MODE - Circuit not compiled]
        </div>
      )}

      <div className={styles.proofSteps}>
        {STEPS.map((s, i) => {
          const isActive = i === currentIndex;
          const isComplete = i < currentIndex || isDone;
          const barFill = isComplete
            ? BAR_WIDTH
            : isActive
              ? Math.round((progress / 100) * BAR_WIDTH)
              : 0;

          let lineClass = styles.proofStepLine;
          if (isComplete) lineClass += ` ${styles.proofStepComplete}`;
          else if (isActive) lineClass += ` ${styles.proofStepActive}`;

          return (
            <div key={s.key} className={lineClass}>
              <span className={styles.proofStepLabel}>
                [{s.number}/{TOTAL_STEPS}] {s.label}...
              </span>
              <span className={styles.proofStepBar}>
                {buildBar(barFill, BAR_WIDTH)}
              </span>
            </div>
          );
        })}
      </div>

      {isDone && (
        <div className={styles.proofDone}>Proof verified. Transaction submitted.</div>
      )}

      {isError && error && (
        <div className={styles.proofError}>{error}</div>
      )}
    </div>
  );
}
