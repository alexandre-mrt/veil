#!/usr/bin/env bun

/**
 * auditor-tool.ts -- Auditor Decryption CLI for Veil compliance events.
 *
 * Allows a compliance auditor to:
 *   1. Fetch all ComplianceVerifiedEvent events from the Sui network
 *   2. Decrypt encrypted amounts using the auditor's P-256 private key
 *   3. Verify individual event ciphertexts
 *   4. Generate JSON compliance reports
 *
 * Encryption format (matches useAuditorEncryption.ts):
 *   ECDH P-256 + HKDF-SHA256 (salt=ephemeralPubKey, info="veil-auditor-v1") + AES-GCM-256
 *   Combined: [ephemeralPubKey(65) | iv(12) | ciphertext(128 padded + 16 GCM tag)]
 *   Plaintext JSON: { txAmount, salt }
 *
 * Usage:
 *   bun run src/auditor-tool.ts decrypt --pool <pool-id> --key <hex> [--network testnet|mainnet]
 *   bun run src/auditor-tool.ts report --pool <pool-id> --key <hex> [--output report.json]
 *   bun run src/auditor-tool.ts verify --pool <pool-id> --key <hex> --event-id <tx-digest>
 */

import { writeFileSync } from "fs";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

// ---------------------------------------------------------------------------
// Constants (must match useAuditorEncryption.ts / AuditorEventBrowser.tsx)
// ---------------------------------------------------------------------------

const EPHEMERAL_PUB_LEN = 65; // uncompressed P-256 public key
const AES_GCM_IV_LEN = 12;
const HKDF_INFO = "veil-auditor-v1";
const FIXED_PLAINTEXT_LEN = 128;
const PRIVATE_KEY_LEN = 32;
const EVENTS_PAGE_SIZE = 50;
const TOKEN_DECIMALS = 6;
const DEFAULT_NETWORK = "testnet" as const;

const USAGE = `
Veil Auditor Decryption Tool
=============================

Decrypts ComplianceVerifiedEvent encrypted amounts using the auditor's P-256 private key.

Usage:
  bun run src/auditor-tool.ts decrypt  --pool <pool-id> --key <hex> [--network testnet|mainnet]
  bun run src/auditor-tool.ts report   --pool <pool-id> --key <hex> [--output report.json] [--network testnet|mainnet]
  bun run src/auditor-tool.ts verify   --pool <pool-id> --key <hex> --event-id <tx-digest> [--network testnet|mainnet]
  bun run src/auditor-tool.ts help

Commands:
  decrypt   Fetch and decrypt all compliance events for a pool
  report    Generate a JSON compliance report with totals and date range
  verify    Decrypt and verify a single event by its transaction digest
  help      Show this help message

Options:
  --pool <id>        Pool object ID (used to resolve the package ID)
  --key <hex>        Auditor's P-256 private key (32-byte hex, no 0x prefix)
  --network <net>    Network: testnet (default) or mainnet
  --output <path>    Output file path for report command (default: report.json)
  --event-id <id>    Transaction digest for verify command
  --package <id>     Package ID (optional, skips pool lookup if provided)

Security:
  The private key is used in-memory only and never logged or written to disk.
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SuiNetwork = "testnet" | "mainnet";

interface DecryptedEvent {
  readonly digest: string;
  readonly credentialNullifier: string;
  readonly encryptedAmountHex: string;
  readonly decryptedAmount: number | null;
  readonly decryptedAmountRaw: string | null;
  readonly decryptedSalt: string | null;
  readonly error: string | null;
  readonly timestampMs: number | null;
}

interface ComplianceReport {
  readonly generatedAt: string;
  readonly network: SuiNetwork;
  readonly packageId: string;
  readonly poolId: string;
  readonly totalEvents: number;
  readonly successfulDecryptions: number;
  readonly failedDecryptions: number;
  readonly totalAmountRaw: string;
  readonly totalAmountFormatted: string;
  readonly dateRange: { earliest: string | null; latest: string | null };
  readonly events: readonly DecryptedEvent[];
}

interface ParsedArgs {
  readonly command: string;
  readonly pool: string;
  readonly key: string;
  readonly network: SuiNetwork;
  readonly output: string;
  readonly eventId: string;
  readonly packageId: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";

  let pool = "";
  let key = "";
  let network: SuiNetwork = DEFAULT_NETWORK;
  let output = "report.json";
  let eventId = "";
  let packageId = "";

  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1] ?? "";

    switch (flag) {
      case "--pool":
        pool = value;
        i++;
        break;
      case "--key":
        key = value.startsWith("0x") ? value.slice(2) : value;
        i++;
        break;
      case "--network":
        if (value !== "testnet" && value !== "mainnet") {
          throw new Error(`Invalid network: ${value}. Must be testnet or mainnet.`);
        }
        network = value;
        i++;
        break;
      case "--output":
        output = value;
        i++;
        break;
      case "--event-id":
        eventId = value;
        i++;
        break;
      case "--package":
        packageId = value;
        i++;
        break;
      default:
        if (flag.startsWith("--")) {
          throw new Error(`Unknown flag: ${flag}`);
        }
    }
  }

  return { command, pool, key, network, output, eventId, packageId };
}

function validateRequiredArgs(args: ParsedArgs, requiredFields: readonly string[]): void {
  for (const field of requiredFields) {
    const value = args[field as keyof ParsedArgs];
    if (!value || value === "") {
      throw new Error(`Missing required argument: --${field}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Hex / byte utilities
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: unknown): string {
  if (Array.isArray(bytes)) {
    return "0x" + (bytes as number[]).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (typeof bytes === "string") return bytes;
  return "";
}

// ---------------------------------------------------------------------------
// P-256 private key import (PKCS8 DER envelope)
// Mirrors AuditorEventBrowser.tsx buildP256PrivateJwk approach
// ---------------------------------------------------------------------------

async function importP256PrivateKey(rawPrivHex: string): Promise<CryptoKey> {
  const rawPriv = hexToBytes(rawPrivHex);
  if (rawPriv.length !== PRIVATE_KEY_LEN) {
    throw new Error(
      `Invalid private key length: expected ${PRIVATE_KEY_LEN}, got ${rawPriv.length}`,
    );
  }

  // Minimal PKCS8 DER envelope for P-256 (without optional public key)
  // Matches the exact format from AuditorEventBrowser.tsx
  const pkcs8Prefix = new Uint8Array([
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

  const pkcs8 = new Uint8Array(pkcs8Prefix.length + rawPriv.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(rawPriv, pkcs8Prefix.length);

  const pkcs8Buffer = new ArrayBuffer(pkcs8.length);
  new Uint8Array(pkcs8Buffer).set(pkcs8);

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8Buffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

// ---------------------------------------------------------------------------
// Decryption (mirrors useAuditorEncryption.ts encrypt path)
// ---------------------------------------------------------------------------

async function decryptAmount(
  encryptedHex: string,
  auditorPrivateKey: CryptoKey,
): Promise<{ txAmount: string; salt: string }> {
  const combined = hexToBytes(encryptedHex);
  const minLength = EPHEMERAL_PUB_LEN + AES_GCM_IV_LEN + 1;
  if (combined.length < minLength) {
    throw new Error(
      `Encrypted data too short: ${combined.length} bytes (minimum ${minLength})`,
    );
  }

  // Parse: [ephemeralPubKey(65) | iv(12) | ciphertext]
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

  // ECDH: derive 256-bit shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: ephemeralPubKey },
    auditorPrivateKey,
    256,
  );

  // HKDF-SHA256: salt = ephemeral public key, info = "veil-auditor-v1"
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

  // AES-GCM decrypt
  const ivBuffer = new ArrayBuffer(iv.length);
  new Uint8Array(ivBuffer).set(iv);
  const ctBuffer = new ArrayBuffer(ciphertext.length);
  new Uint8Array(ctBuffer).set(ciphertext);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuffer },
    aesKey,
    ctBuffer,
  );

  // Remove zero-padding (fixed FIXED_PLAINTEXT_LEN padded plaintext)
  const plainBytes = new Uint8Array(plainBuffer);
  const trimmed = plainBytes.slice(0, FIXED_PLAINTEXT_LEN);
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === 0) end--;
  const jsonStr = new TextDecoder().decode(trimmed.slice(0, end));

  const payload = JSON.parse(jsonStr) as { txAmount?: string; salt?: string };
  if (!payload.txAmount) {
    throw new Error("Decrypted payload missing txAmount field");
  }

  return {
    txAmount: payload.txAmount,
    salt: payload.salt ?? "",
  };
}

// ---------------------------------------------------------------------------
// Event fetching (paginated)
// ---------------------------------------------------------------------------

interface RawComplianceEvent {
  readonly digest: string;
  readonly credentialNullifier: string;
  readonly encryptedAmountHex: string;
  readonly timestampMs: number | null;
}

async function fetchAllComplianceEvents(
  client: SuiJsonRpcClient,
  packageId: string,
): Promise<readonly RawComplianceEvent[]> {
  const eventType = `${packageId}::compliance::ComplianceVerifiedEvent`;
  const allEvents: RawComplianceEvent[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null = null;
  let hasMore = true;

  while (hasMore) {
    const result = await client.queryEvents({
      query: { MoveEventType: eventType },
      limit: EVENTS_PAGE_SIZE,
      order: "descending",
      ...(cursor ? { cursor } : {}),
    });

    for (const evt of result.data) {
      const json = evt.parsedJson as Record<string, unknown> | undefined;
      allEvents.push({
        digest: evt.id?.txDigest ?? "unknown",
        credentialNullifier: bytesToHex(json?.credential_nullifier),
        encryptedAmountHex: bytesToHex(json?.encrypted_amount),
        timestampMs: evt.timestampMs ? Number(evt.timestampMs) : null,
      });
    }

    if (result.nextCursor && result.hasNextPage) {
      cursor = result.nextCursor;
    } else {
      hasMore = false;
    }
  }

  return allEvents;
}

// ---------------------------------------------------------------------------
// Package ID resolution from pool object
// ---------------------------------------------------------------------------

async function resolvePackageId(
  client: SuiJsonRpcClient,
  poolId: string,
): Promise<string> {
  const obj = await client.getObject({
    id: poolId,
    options: { showType: true },
  });

  const objType = obj.data?.type;
  if (!objType) {
    throw new Error(`Could not resolve type for pool object: ${poolId}`);
  }

  // Type format: "<packageId>::pool::Pool"
  const match = objType.match(/^(0x[0-9a-f]+)::pool::Pool$/);
  if (!match) {
    throw new Error(`Unexpected pool type format: ${objType}`);
  }

  return match[1];
}

// ---------------------------------------------------------------------------
// Decrypt all events
// ---------------------------------------------------------------------------

async function decryptAllEvents(
  rawEvents: readonly RawComplianceEvent[],
  auditorPrivateKey: CryptoKey,
): Promise<readonly DecryptedEvent[]> {
  const results: DecryptedEvent[] = [];

  for (const evt of rawEvents) {
    try {
      const { txAmount, salt } = await decryptAmount(evt.encryptedAmountHex, auditorPrivateKey);
      results.push({
        digest: evt.digest,
        credentialNullifier: evt.credentialNullifier,
        encryptedAmountHex: evt.encryptedAmountHex,
        decryptedAmount: Number(txAmount) / 10 ** TOKEN_DECIMALS,
        decryptedAmountRaw: txAmount,
        decryptedSalt: salt,
        error: null,
        timestampMs: evt.timestampMs,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Decryption failed";
      results.push({
        digest: evt.digest,
        credentialNullifier: evt.credentialNullifier,
        encryptedAmountHex: evt.encryptedAmountHex,
        decryptedAmount: null,
        decryptedAmountRaw: null,
        decryptedSalt: null,
        error: message,
        timestampMs: evt.timestampMs,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatAmount(raw: string): string {
  const val = Number(raw) / 10 ** TOKEN_DECIMALS;
  return `${val.toLocaleString()} TOKEN`;
}

function formatDate(ms: number | null): string {
  if (!ms) return "---";
  return new Date(ms).toISOString();
}

function truncateHex(hex: string, head = 10, tail = 6): string {
  if (hex.length <= head + tail + 3) return hex;
  return `${hex.slice(0, head)}...${hex.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Command: decrypt
// ---------------------------------------------------------------------------

async function commandDecrypt(args: ParsedArgs): Promise<void> {
  validateRequiredArgs(args, ["key"]);
  if (!args.pool && !args.packageId) {
    throw new Error("Either --pool or --package is required");
  }

  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(args.network), network: args.network });
  const auditorPrivateKey = await importP256PrivateKey(args.key);

  const packageId = args.packageId || await resolvePackageId(client, args.pool);
  console.log(`[auditor] Network: ${args.network}`);
  console.log(`[auditor] Package: ${packageId}`);
  if (args.pool) console.log(`[auditor] Pool: ${args.pool}`);

  console.log("[auditor] Fetching compliance events...");
  const rawEvents = await fetchAllComplianceEvents(client, packageId);
  console.log(`[auditor] Found ${rawEvents.length} compliance events\n`);

  if (rawEvents.length === 0) {
    console.log("No compliance events found.");
    return;
  }

  console.log("[auditor] Decrypting...\n");
  const decrypted = await decryptAllEvents(rawEvents, auditorPrivateKey);

  // Print table
  const successCount = decrypted.filter((e) => e.error === null).length;
  const failCount = decrypted.length - successCount;

  console.log("  Digest              | Amount           | Salt                     | Time");
  console.log("  " + "-".repeat(90));

  for (const evt of decrypted) {
    const digest = truncateHex(evt.digest, 8, 6);
    if (evt.error) {
      console.log(`  ${digest}  | ERROR: ${evt.error}`);
    } else {
      const amount = formatAmount(evt.decryptedAmountRaw ?? "0");
      const salt = evt.decryptedSalt ? truncateHex(evt.decryptedSalt, 8, 6) : "---";
      const time = formatDate(evt.timestampMs);
      console.log(`  ${digest.padEnd(20)} | ${amount.padEnd(16)} | ${salt.padEnd(24)} | ${time}`);
    }
  }

  console.log(`\n[auditor] Summary: ${successCount} decrypted, ${failCount} failed, ${decrypted.length} total`);
}

// ---------------------------------------------------------------------------
// Command: report
// ---------------------------------------------------------------------------

async function commandReport(args: ParsedArgs): Promise<void> {
  validateRequiredArgs(args, ["key"]);
  if (!args.pool && !args.packageId) {
    throw new Error("Either --pool or --package is required");
  }

  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(args.network), network: args.network });
  const auditorPrivateKey = await importP256PrivateKey(args.key);

  const packageId = args.packageId || await resolvePackageId(client, args.pool);
  console.log(`[auditor] Network: ${args.network}`);
  console.log(`[auditor] Package: ${packageId}`);

  console.log("[auditor] Fetching compliance events...");
  const rawEvents = await fetchAllComplianceEvents(client, packageId);
  console.log(`[auditor] Found ${rawEvents.length} events`);

  console.log("[auditor] Decrypting...");
  const decrypted = await decryptAllEvents(rawEvents, auditorPrivateKey);

  const successfulEvents = decrypted.filter((e) => e.error === null);
  const failedEvents = decrypted.filter((e) => e.error !== null);

  // Compute totals
  let totalRaw = 0n;
  for (const evt of successfulEvents) {
    if (evt.decryptedAmountRaw) {
      totalRaw += BigInt(evt.decryptedAmountRaw);
    }
  }

  // Date range
  const timestamps = decrypted
    .map((e) => e.timestampMs)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);

  const earliest = timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null;
  const latest = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null;

  const report: ComplianceReport = {
    generatedAt: new Date().toISOString(),
    network: args.network,
    packageId,
    poolId: args.pool || "N/A (resolved via --package)",
    totalEvents: decrypted.length,
    successfulDecryptions: successfulEvents.length,
    failedDecryptions: failedEvents.length,
    totalAmountRaw: totalRaw.toString(),
    totalAmountFormatted: `${Number(totalRaw) / 10 ** TOKEN_DECIMALS} TOKEN`,
    dateRange: { earliest, latest },
    events: decrypted,
  };

  const outputPath = args.output;
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n[auditor] Report written to: ${outputPath}`);
  console.log(`[auditor] Total decrypted amount: ${report.totalAmountFormatted}`);
  console.log(`[auditor] Date range: ${earliest ?? "N/A"} to ${latest ?? "N/A"}`);
  console.log(`[auditor] Events: ${report.successfulDecryptions} OK, ${report.failedDecryptions} failed`);
}

// ---------------------------------------------------------------------------
// Command: verify
// ---------------------------------------------------------------------------

async function commandVerify(args: ParsedArgs): Promise<void> {
  validateRequiredArgs(args, ["key", "eventId"]);
  if (!args.pool && !args.packageId) {
    throw new Error("Either --pool or --package is required");
  }

  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(args.network), network: args.network });
  const auditorPrivateKey = await importP256PrivateKey(args.key);

  const packageId = args.packageId || await resolvePackageId(client, args.pool);
  const eventType = `${packageId}::compliance::ComplianceVerifiedEvent`;

  console.log(`[auditor] Network: ${args.network}`);
  console.log(`[auditor] Looking up event in tx: ${args.eventId}`);

  // Fetch events for this specific transaction
  const txEvents = await client.queryEvents({
    query: { Transaction: args.eventId },
    limit: 10,
  });

  const complianceEvents = txEvents.data.filter(
    (evt) => evt.type === eventType,
  );

  if (complianceEvents.length === 0) {
    console.error(`[auditor] No ComplianceVerifiedEvent found in tx ${args.eventId}`);
    process.exit(1);
  }

  for (const evt of complianceEvents) {
    const json = evt.parsedJson as Record<string, unknown> | undefined;
    const encryptedHex = bytesToHex(json?.encrypted_amount);
    const nullifier = bytesToHex(json?.credential_nullifier);

    console.log(`\n  Credential Nullifier: ${nullifier}`);
    console.log(`  Encrypted Amount: ${truncateHex(encryptedHex)}`);

    try {
      const { txAmount, salt } = await decryptAmount(encryptedHex, auditorPrivateKey);
      console.log(`  Decrypted Amount: ${formatAmount(txAmount)} (raw: ${txAmount})`);
      console.log(`  Salt: ${salt}`);
      console.log(`  Status: VERIFIED`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Decryption failed";
      console.error(`  Decryption Error: ${message}`);
      console.log(`  Status: FAILED`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "decrypt":
      await commandDecrypt(args);
      break;
    case "report":
      await commandReport(args);
      break;
    case "verify":
      await commandVerify(args);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[auditor] Fatal error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
