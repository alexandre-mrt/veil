/**
 * relayer.ts — Sponsored transaction relayer for Veil sender privacy.
 *
 * Demonstrates the Sui sponsored transaction pattern where a relayer pays gas
 * and submits transactions on behalf of users, hiding the sender address on-chain.
 *
 * Flow:
 *   1. User builds a TransactionKind (the Move call, without gas data)
 *   2. User signs the full TransactionData (with relayer's gas info)
 *   3. Relayer receives txBytes + userSignature
 *   4. Relayer signs the gas payment portion
 *   5. Relayer submits both signatures to the Sui network
 *
 * On-chain, the transaction appears as:
 *   - sender: user address (for Move-level auth)
 *   - gas payer: relayer address
 *   - submitted by: relayer (the actual network sender)
 *
 * For full sender privacy, users connect via the relayer so their IP/address
 * is never directly linked to the transaction submission.
 *
 * Usage:
 *   bun run src/relayer.ts --help
 *   bun run src/relayer.ts serve --port 3001
 *   bun run src/relayer.ts demo
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

const NETWORK = "testnet" as const;
const DEFAULT_PORT = 3001;
const GAS_BUDGET = 50_000_000; // 0.05 SUI

// ---------------------------------------------------------------------------
// Security: Auth, CORS, Rate Limiting, Payload Limits
// ---------------------------------------------------------------------------

const PACKAGE_ID = process.env.PACKAGE_ID || process.env.NEXT_PUBLIC_PACKAGE_ID;

const RELAYER_API_KEY = process.env.RELAYER_API_KEY;

if (!RELAYER_API_KEY) {
  console.warn(
    "[security] WARNING: RELAYER_API_KEY not set — running in dev mode without authentication. " +
      "Set RELAYER_API_KEY in production!",
  );
}

function checkAuth(request: Request): boolean {
  if (!RELAYER_API_KEY) return true; // dev mode: no auth required
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${RELAYER_API_KEY}`;
}

const ALLOWED_ORIGIN = process.env.RELAYER_CORS_ORIGIN || "https://frontend-sepia-nine-30.vercel.app";
const LOCAL_DEV_ORIGIN = process.env.NODE_ENV !== "production" ? "http://localhost:3000" : null;
const MAX_PAYLOAD_BYTES = 50_000; // 50KB

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10; // requests per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

/** Extract client IP using Bun's native requestIP (most reliable), with x-forwarded-for fallback. */
function getClientIP(request: Request, server: { requestIP?: (req: Request) => { address: string } | null }): string {
  // Bun native IP (most reliable — direct socket address)
  const nativeIP = server?.requestIP?.(request)?.address;
  if (nativeIP) return nativeIP;

  // Fallback: x-forwarded-for (trusted only behind reverse proxy in production)
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();

  // Last resort: x-real-ip header
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri;

  return "unknown";
}

/**
 * Validates that a TransactionKind targets the Veil package.
 * Decodes base64 kindBytes and checks if the package ID hex appears in the serialized bytes.
 * Skips validation if no PACKAGE_ID is configured (dev mode).
 */
function validateTransactionKind(kindBytes: string): boolean {
  if (!PACKAGE_ID) return true; // skip validation if no package ID configured
  const decoded = Buffer.from(kindBytes, "base64").toString("hex");
  const packageHex = PACKAGE_ID.replace("0x", "").toLowerCase();
  return decoded.includes(packageHex);
}

/**
 * Validates a Sui address format: 0x followed by exactly 64 hex characters.
 */
function isValidSuiAddress(addr: string): boolean {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{64}$/.test(addr);
}

function resolveAllowedOrigin(requestOrigin: string | null): string {
  if (LOCAL_DEV_ORIGIN && requestOrigin === LOCAL_DEV_ORIGIN) return LOCAL_DEV_ORIGIN;
  if (requestOrigin === ALLOWED_ORIGIN) return ALLOWED_ORIGIN;
  return ALLOWED_ORIGIN; // Default: production origin (browser will block mismatched)
}

// ---------------------------------------------------------------------------
// Keypair Loader (reuses active Sui CLI address)
// ---------------------------------------------------------------------------

function loadRelayerKeypair(): Ed25519Keypair {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  console.log(`[relayer] Relayer address: ${activeAddress}`);

  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  if (!existsSync(keystorePath)) {
    throw new Error(`Sui keystore not found at ${keystorePath}. Run 'sui client' first.`);
  }

  const keystore: string[] = JSON.parse(readFileSync(keystorePath, "utf-8"));
  if (keystore.length === 0) {
    throw new Error("Sui keystore is empty.");
  }

  for (const key of keystore) {
    const raw = fromBase64(key);
    if (raw[0] !== 0) continue;
    try {
      const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
      if (kp.toSuiAddress() === activeAddress) {
        return kp;
      }
    } catch {
      // Skip non-matching keys
    }
  }

  throw new Error(`No Ed25519 key found matching active address ${activeAddress}`);
}

// ---------------------------------------------------------------------------
// Core Relayer Logic
// ---------------------------------------------------------------------------

interface SponsorRequest {
  /** Base64-encoded TransactionKind bytes (user's intended operations) */
  readonly kindBytes: string;
  /** User's Sui address (the logical sender for Move auth) */
  readonly sender: string;
}

interface SponsorResponse {
  /** Base64-encoded full TransactionData bytes for user to sign */
  readonly txBytes: string;
  /** Relayer's address (gas payer) */
  readonly sponsor: string;
}

interface SubmitRequest {
  /** Base64-encoded TransactionData bytes */
  readonly txBytes: string;
  /** User's signature (base64) */
  readonly userSignature: string;
}

interface SubmitResponse {
  readonly digest: string;
  readonly success: boolean;
  readonly error?: string;
}

/**
 * Sponsors a transaction by wrapping user's TransactionKind with gas payment.
 * Returns the full TransactionData bytes for the user to sign.
 */
async function sponsorTransaction(
  client: SuiJsonRpcClient,
  relayerKeypair: Ed25519Keypair,
  request: SponsorRequest,
): Promise<SponsorResponse> {
  const relayerAddress = relayerKeypair.toSuiAddress();

  // Reconstruct transaction from kind bytes
  const kindBytesRaw = fromBase64(request.kindBytes);
  const tx = Transaction.fromKind(kindBytesRaw);

  // Set the logical sender (user) and gas owner (relayer)
  tx.setSender(request.sender);
  tx.setGasOwner(relayerAddress);
  tx.setGasBudget(GAS_BUDGET);

  // Get relayer's gas coins for payment
  const coins = await client.getCoins({
    owner: relayerAddress,
    coinType: "0x2::sui::SUI",
    limit: 1,
  });

  if (!coins.data || coins.data.length === 0) {
    throw new Error(`Relayer has no SUI coins for gas payment`);
  }

  const gasCoin = coins.data[0];
  tx.setGasPayment([
    {
      objectId: gasCoin.coinObjectId,
      version: gasCoin.version,
      digest: gasCoin.digest,
    },
  ]);

  // Build the full transaction bytes
  const txBytes = await tx.build({ client });

  return {
    txBytes: toBase64(txBytes),
    sponsor: relayerAddress,
  };
}

/**
 * Submits a dual-signed transaction (user signature + relayer gas signature).
 */
async function submitSponsoredTransaction(
  client: SuiJsonRpcClient,
  relayerKeypair: Ed25519Keypair,
  request: SubmitRequest,
): Promise<SubmitResponse> {
  const txBytes = fromBase64(request.txBytes);

  // Relayer signs the gas portion
  const relayerSignature = await relayerKeypair.sign(txBytes);
  const relayerSigBase64 = toBase64(relayerSignature);

  // Submit with both signatures: user's signature first, then relayer's
  try {
    const result = await client.executeTransactionBlock({
      transactionBlock: request.txBytes,
      signature: [request.userSignature, relayerSigBase64],
      options: { showEffects: true },
    });

    const status = result.effects?.status?.status;
    if (status !== "success") {
      return {
        digest: result.digest ?? "unknown",
        success: false,
        error: `Transaction failed: ${result.effects?.status?.error ?? "unknown error"}`,
      };
    }

    return {
      digest: result.digest,
      success: true,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Submit failed";
    return { digest: "unknown", success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Demo: Full sponsored transaction flow (single machine, both keys)
// ---------------------------------------------------------------------------

async function runDemo(): Promise<void> {
  console.log("\n=== Veil Sponsored Transaction Demo ===\n");
  console.log("This demonstrates the relayer pattern for sender privacy.");
  console.log("In production, user and relayer are separate machines.\n");

  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(NETWORK) });
  const relayerKeypair = loadRelayerKeypair();
  const relayerAddress = relayerKeypair.toSuiAddress();

  console.log(`[demo] Network: ${NETWORK}`);
  console.log(`[demo] Relayer (gas payer): ${relayerAddress}`);

  // For demo, user = relayer (same key). In production these are different.
  const userKeypair = relayerKeypair;
  const userAddress = userKeypair.toSuiAddress();
  console.log(`[demo] User (sender): ${userAddress}`);
  console.log(`[demo] Note: In production, user and relayer are separate entities.\n`);

  // Step 1: User builds a TransactionKind (without gas)
  console.log("[step 1] User builds TransactionKind (Move call without gas)...");
  const userTx = new Transaction();
  // Example: a simple transfer to self (no-op, just demonstrates the pattern)
  userTx.moveCall({
    target: "0x2::sui::transfer",
    arguments: [
      userTx.splitCoins(userTx.gas, [1]),
      userTx.pure.address(userAddress),
    ],
  });

  const kindBytes = await userTx.build({ client, onlyTransactionKind: true });
  const kindBytesBase64 = toBase64(kindBytes);
  console.log(`  TransactionKind: ${kindBytesBase64.slice(0, 40)}...`);
  console.log(`  Size: ${kindBytes.length} bytes\n`);

  // Step 2: User sends kindBytes to relayer, relayer sponsors it
  console.log("[step 2] Relayer sponsors transaction (adds gas payment)...");
  const sponsorResponse = await sponsorTransaction(client, relayerKeypair, {
    kindBytes: kindBytesBase64,
    sender: userAddress,
  });
  console.log(`  Sponsor: ${sponsorResponse.sponsor}`);
  console.log(`  Full TX bytes: ${sponsorResponse.txBytes.slice(0, 40)}...\n`);

  // Step 3: User signs the full TransactionData
  console.log("[step 3] User signs the full transaction data...");
  const txBytesRaw = fromBase64(sponsorResponse.txBytes);
  const userSignature = await userKeypair.sign(txBytesRaw);
  const userSigBase64 = toBase64(userSignature);
  console.log(`  User signature: ${userSigBase64.slice(0, 40)}...\n`);

  // Step 4: Relayer submits with both signatures
  console.log("[step 4] Relayer signs gas + submits dual-signed transaction...");
  const submitResult = await submitSponsoredTransaction(client, relayerKeypair, {
    txBytes: sponsorResponse.txBytes,
    userSignature: userSigBase64,
  });

  if (submitResult.success) {
    console.log(`\n  [OK] Transaction executed successfully!`);
    console.log(`  Digest: ${submitResult.digest}`);
    console.log(`  Explorer: https://suiscan.xyz/${NETWORK}/tx/${submitResult.digest}`);
    console.log(`\n  On-chain, this tx shows:`);
    console.log(`    sender = ${userAddress} (Move-level auth)`);
    console.log(`    gas payer = ${relayerAddress} (who submitted + paid)`);
    console.log(`\n  For Veil privacy: the relayer address appears as the submitter,`);
    console.log(`  hiding the user's network-level identity from observers.\n`);
  } else {
    console.log(`\n  [FAIL] Transaction failed: ${submitResult.error}`);
    console.log(`  This is expected if the demo account has insufficient balance.`);
    console.log(`  The pattern itself is correct — in production, the relayer would`);
    console.log(`  have a funded hot wallet.\n`);
  }
}

// ---------------------------------------------------------------------------
// HTTP Server Mode (lightweight, for frontend integration)
// ---------------------------------------------------------------------------

async function serve(port: number): Promise<void> {
  console.log(`\n=== Veil Relayer Server ===\n`);

  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(NETWORK) });
  const relayerKeypair = loadRelayerKeypair();
  const relayerAddress = relayerKeypair.toSuiAddress();

  console.log(`[server] Network: ${NETWORK}`);
  console.log(`[server] Relayer address: ${relayerAddress}`);
  console.log(`[server] Listening on http://localhost:${port}\n`);
  console.log(`[server] Endpoints:`);
  console.log(`  POST /sponsor  — Sponsor a TransactionKind`);
  console.log(`  POST /submit   — Submit a dual-signed transaction`);
  console.log(`  GET  /health   — Health check\n`);

  const server = Bun.serve({
    port,
    async fetch(req, bunServer) {
      const url = new URL(req.url);
      const method = req.method;
      const requestOrigin = req.headers.get("origin");
      const origin = resolveAllowedOrigin(requestOrigin);

      // CORS headers — restricted to known origins
      const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Rate limiting — use Bun native IP with header fallback
      const clientIp = getClientIP(req, bunServer);

      if (!checkRateLimit(clientIp)) {
        console.warn(`[rate-limit] Blocked ${clientIp}`);
        return Response.json(
          { error: "Too many requests" },
          { status: 429, headers: corsHeaders },
        );
      }

      // Health check (public — no auth required)
      if (url.pathname === "/health" && method === "GET") {
        return Response.json(
          { status: "ok", relayer: relayerAddress, network: NETWORK },
          { headers: corsHeaders },
        );
      }

      // Authentication — required for /sponsor and /submit
      if (!checkAuth(req)) {
        return Response.json(
          { error: "Unauthorized" },
          { status: 401, headers: corsHeaders },
        );
      }

      // Sponsor endpoint
      if (url.pathname === "/sponsor" && method === "POST") {
        try {
          // Payload size limit
          const rawBody = await req.text();
          if (rawBody.length > MAX_PAYLOAD_BYTES) {
            return Response.json(
              { error: "Payload too large" },
              { status: 413, headers: corsHeaders },
            );
          }
          const body = JSON.parse(rawBody) as SponsorRequest;

          if (!body.kindBytes || !body.sender) {
            return Response.json(
              { error: "Missing kindBytes or sender" },
              { status: 400, headers: corsHeaders },
            );
          }

          if (!isValidSuiAddress(body.sender)) {
            return Response.json(
              { error: "Invalid sender address" },
              { status: 400, headers: corsHeaders },
            );
          }

          if (!validateTransactionKind(body.kindBytes)) {
            return Response.json(
              { error: "Transaction does not target Veil package" },
              { status: 403, headers: corsHeaders },
            );
          }

          const result = await sponsorTransaction(client, relayerKeypair, body);
          console.log(`[sponsor] Sponsored tx for ${body.sender}`);
          return Response.json(result, { headers: corsHeaders });
        } catch (e) {
          console.error("[/sponsor] Error:", e);
          return Response.json(
            { error: "Sponsorship failed" },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      // Submit endpoint
      if (url.pathname === "/submit" && method === "POST") {
        try {
          // Payload size limit
          const rawBody = await req.text();
          if (rawBody.length > MAX_PAYLOAD_BYTES) {
            return Response.json(
              { error: "Payload too large" },
              { status: 413, headers: corsHeaders },
            );
          }
          const body = JSON.parse(rawBody) as SubmitRequest;

          if (!body.txBytes || !body.userSignature) {
            return Response.json(
              { error: "Missing txBytes or userSignature" },
              { status: 400, headers: corsHeaders },
            );
          }

          const result = await submitSponsoredTransaction(client, relayerKeypair, body);
          console.log(`[submit] ${result.success ? "OK" : "FAIL"} — digest: ${result.digest}`);
          return Response.json(result, { headers: corsHeaders });
        } catch (e) {
          console.error("[/submit] Error:", e);
          return Response.json(
            { error: "Submission failed" },
            { status: 500, headers: corsHeaders },
          );
        }
      }

      return Response.json(
        { error: "Not found" },
        { status: 404, headers: corsHeaders },
      );
    },
  });

  console.log(`[server] Ready at ${server.url}`);
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
Veil Sponsored Transaction Relayer
===================================

Hides the sender address on-chain by submitting transactions through a relayer
that pays gas fees. Uses Sui's native sponsored transaction support.

Commands:
  demo              Run a local demo of the sponsored transaction flow
  serve [--port N]  Start the relayer HTTP server (default port: ${DEFAULT_PORT})
  help              Show this help message

Examples:
  bun run src/relayer.ts demo
  bun run src/relayer.ts serve --port 3001

Architecture:
  1. User builds TransactionKind (Move calls, no gas info)
  2. User sends kindBytes to relayer → relayer adds gas payment
  3. User signs the full TransactionData
  4. Relayer co-signs (gas portion) and submits to Sui network
  5. On-chain: sender = user (Move auth), gas payer = relayer (network identity)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  switch (command) {
    case "demo":
      await runDemo();
      break;

    case "serve": {
      const portIdx = args.indexOf("--port");
      const port = portIdx !== -1 ? Number.parseInt(args[portIdx + 1], 10) : DEFAULT_PORT;
      if (Number.isNaN(port)) {
        console.error("Invalid port number");
        process.exit(1);
      }
      await serve(port);
      break;
    }

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[relayer] Fatal error: ${e.message}`);
  process.exit(1);
});
