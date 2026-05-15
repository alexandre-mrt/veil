"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { PACKAGE_ID, NETWORK, EXPLORER_TX_URL } from "@/lib/constants";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_TYPE = `${PACKAGE_ID}::compliance::ComplianceVerifiedEvent`;
const TRUNCATE_HEAD = 8;
const TRUNCATE_TAIL = 6;
const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComplianceEvent {
  readonly digest: string;
  readonly credentialNullifier: string;
  readonly encryptedAmount: string;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateHex(hex: string): string {
  if (hex.length <= TRUNCATE_HEAD + TRUNCATE_TAIL + 3) return hex;
  return `${hex.slice(0, TRUNCATE_HEAD)}...${hex.slice(-TRUNCATE_TAIL)}`;
}

function bytesToHex(bytes: unknown): string {
  if (Array.isArray(bytes)) {
    return (
      "0x" +
      (bytes as number[]).map((b) => b.toString(16).padStart(2, "0")).join("")
    );
  }
  if (typeof bytes === "string") return bytes;
  return "---";
}

function formatTimestamp(ms: string | number | null | undefined): string {
  if (!ms) return "---";
  const date = new Date(Number(ms));
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditorEventBrowser() {
  const rpcClient = useMemo(
    () =>
      new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl(NETWORK),
        network: NETWORK,
      }),
    [],
  );

  const [events, setEvents] = useState<ComplianceEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await rpcClient.queryEvents({
        query: { MoveEventType: EVENT_TYPE },
        limit: PAGE_SIZE,
        order: "descending",
      });

      const parsed: ComplianceEvent[] = result.data.map((evt) => {
        const json = evt.parsedJson as Record<string, unknown> | undefined;
        return {
          digest: evt.id?.txDigest ?? "unknown",
          credentialNullifier: bytesToHex(json?.credential_nullifier),
          encryptedAmount: bytesToHex(json?.encrypted_amount),
          timestamp: formatTimestamp(evt.timestampMs),
        };
      });

      setEvents(parsed);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch events";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [rpcClient]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  return (
    <div className={styles.eventBrowserPanel}>
      <div className={styles.eventBrowserAccent} />

      <div className={styles.eventBrowserHeader}>
        <span className={styles.eventBrowserTitle}>Compliance Events</span>
        <button
          type="button"
          className={styles.eventBrowserRefreshBtn}
          disabled={isLoading}
          onClick={fetchEvents}
        >
          {isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className={styles.eventBrowserError}>{error}</div>
      )}

      {!isLoading && !error && events.length === 0 && (
        <div className={styles.eventBrowserEmpty}>
          No compliant transfers recorded yet
        </div>
      )}

      {events.length > 0 && (
        <div className={styles.historyTableWrapper}>
          <table className={styles.historyTable}>
            <thead>
              <tr>
                <th className={styles.historyTh}>Tx Digest</th>
                <th className={styles.historyTh}>Nullifier</th>
                <th className={styles.historyTh}>Encrypted Amt</th>
                <th className={styles.historyTh}>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((evt) => (
                <tr key={evt.digest} className={styles.historyRow}>
                  <td className={styles.historyTd}>
                    <a
                      href={`${EXPLORER_TX_URL}/${evt.digest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.historyDigestLink}
                    >
                      {truncateHex(evt.digest)}
                    </a>
                  </td>
                  <td className={styles.historyTd}>
                    <span title={evt.credentialNullifier}>
                      {truncateHex(evt.credentialNullifier)}
                    </span>
                  </td>
                  <td className={styles.historyTd}>
                    <span title={evt.encryptedAmount}>
                      {truncateHex(evt.encryptedAmount)}
                    </span>
                  </td>
                  <td className={`${styles.historyTd} ${styles.historyTimestamp}`}>
                    {evt.timestamp}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
