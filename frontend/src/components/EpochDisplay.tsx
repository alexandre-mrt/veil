"use client";

import { useEpoch } from "@/hooks/useEpoch";
import styles from "./components.module.css";

export function EpochDisplay() {
  const { currentEpoch, daysRemaining, percentElapsed } = useEpoch();

  return (
    <div className={styles.epochPanel}>
      <div className={styles.epochPanelAccent} />
      <div className={styles.epochHeader}>
        <span className={styles.epochTitle}>Epoch</span>
        <span className={styles.epochNumber}>#{currentEpoch}</span>
      </div>
      <div className={styles.epochProgressTrack}>
        <div
          className={styles.epochProgressFill}
          style={{ width: `${percentElapsed}%` }}
        />
      </div>
      <span className={styles.epochResetMsg}>
        Spending resets in {daysRemaining} {daysRemaining === 1 ? "day" : "days"}
      </span>
    </div>
  );
}
