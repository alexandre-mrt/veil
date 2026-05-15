"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { PACKAGE_ID, NETWORK, EXPLORER_TX_URL } from "@/lib/constants";
import styles from "./components.module.css";

// ---------------------------------------------------------------------------
// Constants (must match useAuditorEncryption.ts)
// ---------------------------------------------------------------------------

const EVENT_TYPE = `${PACKAGE_ID}::compliance::ComplianceVerifiedEvent`;
const TRUNCATE_HEAD = 8;
const TRUNCATE_TAIL = 6;
const PAGE_SIZE = 25;
const EPHEMERAL_PUB_LEN = 65;
const AES_GCM_IV_LEN = 12;
const HKDF_INFO = "veil-auditor-v1";
const FIXED_PLAINTEXT_LEN = 128;

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
// Decryption helpers (mirrors useAuditorEncryption.ts encryption)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function decryptAuditorAmount(
  encryptedHex: string,
  auditorPrivateKeyHex: string,
): Promise<string> {
  const combined = hexToBytes(encryptedHex);
  if (combined.length < EPHEMERAL_PUB_LEN + AES_GCM_IV_LEN + 1) {
    throw new Error("Encrypted data too short");
  }

  const ephemeralPubBytes = combined.slice(0, EPHEMERAL_PUB_LEN);
  const iv = combined.slice(EPHEMERAL_PUB_LEN, EPHEMERAL_PUB_LEN + AES_GCM_IV_LEN);
  const ciphertext = combined.slice(EPHEMERAL_PUB_LEN + AES_GCM_IV_LEN);

  // Import ephemeral public key
  const ephPubBuffer = new ArrayBuffer(ephemeralPubBytes.length);
  new Uint8Array(ephPubBuffer).set(ephemeralPubBytes);
  const ephemeralPubKey = await crypto.subtle.importKey(
    "raw",
    ephPubBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // Import auditor private key (raw 32-byte scalar -> PKCS8 or JWK)
  const privBytes = hexToBytes(auditorPrivateKeyHex);
  if (privBytes.length !== 32) {
    throw new Error(`Invalid private key length: expected 32, got ${privBytes.length}`);
  }

  // Build JWK for P-256 private key import
  const privKeyJwk = await buildP256PrivateJwk(privBytes);
  const auditorPrivKey = await crypto.subtle.importKey(
    "jwk",
    privKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );

  // ECDH -> shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: ephemeralPubKey },
    auditorPrivKey,
    256,
  );

  // HKDF with ephemeral pub as salt (same as encryption)
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  const encoder = new TextEncoder();
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephPubBuffer,
      info: encoder.encode(HKDF_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // Decrypt
  const ivBuffer = new ArrayBuffer(iv.length);
  new Uint8Array(ivBuffer).set(iv);
  const ctBuffer = new ArrayBuffer(ciphertext.length);
  new Uint8Array(ctBuffer).set(ciphertext);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuffer },
    aesKey,
    ctBuffer,
  );

  // Remove zero-padding (fixed FIXED_PLAINTEXT_LEN)
  const plainBytes = new Uint8Array(plainBuffer);
  const trimmed = plainBytes.slice(0, FIXED_PLAINTEXT_LEN);
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === 0) end--;
  const jsonStr = new TextDecoder().decode(trimmed.slice(0, end));

  const payload = JSON.parse(jsonStr) as { txAmount?: string; salt?: string };
  return payload.txAmount ?? "unknown";
}

/**
 * Builds a JWK for a P-256 private key from raw 32-byte scalar.
 * We derive the public key by doing a sign+verify round-trip with a temp key,
 * but the simpler approach is to generate a keypair and replace `d`.
 * Instead, we use the SubtleCrypto exportKey approach:
 * 1. Generate a temp P-256 keypair
 * 2. Export to JWK
 * 3. Replace the `d` parameter with our private key bytes
 * 4. Derive the public point by importing with deriveBits
 *
 * Actually the cleanest way: import as PKCS8. But building PKCS8 from raw
 * is complex. So we'll use the JWK approach with a trick:
 * We need x, y coordinates for the public key. We can compute them by
 * importing the key and exporting the public part.
 *
 * Simplest correct approach: build the PKCS8 DER envelope around the raw key.
 */
async function buildP256PrivateJwk(
  rawPriv: Uint8Array,
): Promise<JsonWebKey> {
  // PKCS8 envelope for P-256 (RFC 5958 + RFC 5480)
  // SEQUENCE { version, AlgorithmIdentifier { OID ecPublicKey, OID prime256v1 }, OCTET STRING { ECPrivateKey } }
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x81, 0x87, // SEQUENCE, length 135
    0x02, 0x01, 0x00, // INTEGER version = 0
    0x30, 0x13,       // SEQUENCE AlgorithmIdentifier
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID 1.2.840.10045.2.1 (ecPublicKey)
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID 1.2.840.10045.3.1.7 (prime256v1)
    0x04, 0x6d,       // OCTET STRING, length 109
    0x30, 0x6b,       // SEQUENCE ECPrivateKey, length 107
    0x02, 0x01, 0x01, // INTEGER version = 1
    0x04, 0x20,       // OCTET STRING, length 32 (private key)
  ]);

  // After the private key bytes, we need the publicKey bit string
  // but we can omit it (optional in ECPrivateKey) and let the import derive it.
  // Minimal ECPrivateKey without public key:
  const minPkcs8Prefix = new Uint8Array([
    0x30, 0x41,       // SEQUENCE, length 65
    0x02, 0x01, 0x00, // INTEGER version = 0
    0x30, 0x13,       // SEQUENCE AlgorithmIdentifier
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
    0x04, 0x27,       // OCTET STRING, length 39
    0x30, 0x25,       // SEQUENCE ECPrivateKey, length 37
    0x02, 0x01, 0x01, // INTEGER version = 1
    0x04, 0x20,       // OCTET STRING, length 32
  ]);

  const pkcs8 = new Uint8Array(minPkcs8Prefix.length + rawPriv.length);
  pkcs8.set(minPkcs8Prefix);
  pkcs8.set(rawPriv, minPkcs8Prefix.length);

  const pkcs8Buffer = new ArrayBuffer(pkcs8.length);
  new Uint8Array(pkcs8Buffer).set(pkcs8);

  // Import as ECDH key, then export as JWK to get x, y, d
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Buffer,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );

  return crypto.subtle.exportKey("jwk", key);
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

  // Decryption state
  const [auditorKeyHex, setAuditorKeyHex] = useState("");
  const [decryptedAmounts, setDecryptedAmounts] = useState<Record<string, string>>({});
  const [decrypting, setDecrypting] = useState<string | null>(null);

  const handleDecrypt = useCallback(
    async (digest: string, encryptedHex: string) => {
      const key = auditorKeyHex.trim();
      if (key.length === 0) return;
      setDecrypting(digest);
      try {
        const amount = await decryptAuditorAmount(encryptedHex, key);
        setDecryptedAmounts((prev) => ({ ...prev, [digest]: amount }));
      } catch {
        setDecryptedAmounts((prev) => ({ ...prev, [digest]: "Decryption failed" }));
      } finally {
        setDecrypting(null);
      }
    },
    [auditorKeyHex],
  );

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

      {/* Decrypt section */}
      <div className={styles.auditorDecryptSection}>
        <label htmlFor="auditor-privkey" className={styles.auditorDecryptLabel}>
          Auditor Private Key (hex)
        </label>
        <input
          id="auditor-privkey"
          type="password"
          placeholder="32-byte hex (without 0x prefix)"
          value={auditorKeyHex}
          onChange={(e) => setAuditorKeyHex(e.target.value)}
          className={styles.adminInput}
        />
        <span className={styles.auditorDecryptNote}>
          For authorized auditors only. Private key never leaves your browser.
        </span>
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
                <th className={styles.historyTh}>Decrypted</th>
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
                  <td className={styles.historyTd}>
                    {decryptedAmounts[evt.digest] ? (
                      <span
                        className={
                          decryptedAmounts[evt.digest] === "Decryption failed"
                            ? styles.auditorDecryptFailed
                            : styles.auditorDecryptedValue
                        }
                      >
                        {decryptedAmounts[evt.digest]}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.auditorDecryptBtn}
                        disabled={
                          !auditorKeyHex.trim() ||
                          decrypting === evt.digest
                        }
                        onClick={() =>
                          handleDecrypt(evt.digest, evt.encryptedAmount)
                        }
                      >
                        {decrypting === evt.digest ? "..." : "Decrypt"}
                      </button>
                    )}
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
