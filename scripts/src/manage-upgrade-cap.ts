/**
 * manage-upgrade-cap.ts — UpgradeCap management for Veil package.
 *
 * Offers two operations:
 *   1. burn    — Permanently make the contract immutable (calls sui::package::make_immutable)
 *   2. transfer — Transfer the UpgradeCap to a new owner (e.g., multisig address)
 *
 * Usage:
 *   bun run src/manage-upgrade-cap.ts burn
 *   bun run src/manage-upgrade-cap.ts transfer <recipient-address>
 *
 * Environment:
 *   UPGRADE_CAP_ID  — The object ID of the UpgradeCap (or pass via --cap <id>)
 *   SUI_NETWORK     — Network to use: "mainnet" | "testnet" | "devnet" (default: "testnet")
 */

import { execSync } from "child_process";
import { createInterface } from "readline";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type SuiNetwork = "mainnet" | "testnet" | "devnet";
const VALID_NETWORKS: readonly SuiNetwork[] = ["mainnet", "testnet", "devnet"] as const;
const DEFAULT_NETWORK: SuiNetwork = "testnet";
const UPGRADE_CAP_TYPE = "0x2::package::UpgradeCap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNetwork(): SuiNetwork {
  const env = process.env.SUI_NETWORK;
  if (!env) return DEFAULT_NETWORK;
  if (VALID_NETWORKS.includes(env as SuiNetwork)) return env as SuiNetwork;
  throw new Error(
    `Invalid SUI_NETWORK="${env}". Must be one of: ${VALID_NETWORKS.join(", ")}`,
  );
}

function getUpgradeCapId(args: readonly string[]): string {
  // Check --cap flag first
  const capIdx = args.indexOf("--cap");
  if (capIdx !== -1 && args[capIdx + 1]) {
    return args[capIdx + 1];
  }
  // Then check env
  const envId = process.env.UPGRADE_CAP_ID;
  if (envId) return envId;

  throw new Error(
    "UpgradeCap ID not provided. Use --cap <id> or set UPGRADE_CAP_ID env var.",
  );
}

/**
 * Loads the active Sui CLI keypair from the local keystore.
 * Same pattern as relayer.ts — reads sui.keystore and matches the active address.
 */
function loadKeypair(): Ed25519Keypair {
  const activeAddress = execSync("sui client active-address", {
    encoding: "utf-8",
  }).trim();
  console.log(`[upgrade-cap] Active address: ${activeAddress}`);

  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  if (!existsSync(keystorePath)) {
    throw new Error(
      `Sui keystore not found at ${keystorePath}. Run 'sui client' first.`,
    );
  }

  const keystore: string[] = JSON.parse(readFileSync(keystorePath, "utf-8"));
  if (keystore.length === 0) {
    throw new Error("Sui keystore is empty.");
  }

  for (const key of keystore) {
    const raw = fromBase64(key);
    // Ed25519 keys are prefixed with 0x00
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

  throw new Error(
    `No Ed25519 key found matching active address ${activeAddress}`,
  );
}

/**
 * Prompts the user for a confirmation string via stdin.
 * Returns the trimmed input.
 */
function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Fetches the UpgradeCap object and validates ownership.
 * Returns the owner address string.
 */
async function validateUpgradeCap(
  client: SuiJsonRpcClient,
  upgradeCapId: string,
  expectedOwner: string,
): Promise<string> {
  const response = await client.getObject({
    id: upgradeCapId,
    options: { showOwner: true, showType: true },
  });

  if (response.error) {
    throw new Error(
      `Failed to fetch UpgradeCap ${upgradeCapId}: ${response.error.code ?? "unknown error"}`,
    );
  }

  const data = response.data;
  if (!data) {
    throw new Error(`UpgradeCap ${upgradeCapId} not found on-chain.`);
  }

  // Verify it's actually an UpgradeCap
  if (data.type && !data.type.includes(UPGRADE_CAP_TYPE)) {
    throw new Error(
      `Object ${upgradeCapId} is not an UpgradeCap. Type: ${data.type}`,
    );
  }

  // Verify ownership
  const owner = data.owner;
  if (!owner || typeof owner === "string") {
    // owner === "Immutable" means already burned
    throw new Error(
      `UpgradeCap ${upgradeCapId} is not owned by an address (status: ${String(owner ?? "unknown")}). It may already be immutable.`,
    );
  }

  if ("AddressOwner" in owner) {
    const currentOwner = owner.AddressOwner;
    if (currentOwner !== expectedOwner) {
      throw new Error(
        `UpgradeCap is owned by ${currentOwner}, but your active address is ${expectedOwner}. You cannot manage this UpgradeCap.`,
      );
    }
    return currentOwner;
  }

  if ("ObjectOwner" in owner) {
    throw new Error(
      `UpgradeCap is owned by object ${owner.ObjectOwner}, not an address. Cannot manage it from a keypair.`,
    );
  }

  if ("Shared" in owner) {
    throw new Error(
      "UpgradeCap is a shared object. This should not happen for a standard UpgradeCap.",
    );
  }

  throw new Error(
    `Unexpected owner format for UpgradeCap: ${JSON.stringify(owner)}`,
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function burnUpgradeCap(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  upgradeCapId: string,
): Promise<void> {
  const address = keypair.toSuiAddress();
  const currentOwner = await validateUpgradeCap(client, upgradeCapId, address);

  console.log("\n========================================");
  console.log("  WARNING: IRREVERSIBLE OPERATION");
  console.log("========================================");
  console.log(`  UpgradeCap ID:    ${upgradeCapId}`);
  console.log(`  Current owner:    ${currentOwner}`);
  console.log(`  Action:           BURN (make_immutable)`);
  console.log("");
  console.log("  This will permanently make the Veil contract immutable.");
  console.log("  No future upgrades will be possible. This CANNOT be undone.");
  console.log("========================================\n");

  const answer = await prompt("Type 'BURN' to confirm: ");
  if (answer !== "BURN") {
    console.log("[upgrade-cap] Aborted. No changes made.");
    return;
  }

  console.log("[upgrade-cap] Building transaction...");
  const tx = new Transaction();
  tx.moveCall({
    target: "0x2::package::make_immutable",
    arguments: [tx.object(upgradeCapId)],
  });

  console.log("[upgrade-cap] Signing and executing...");
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });

  const status = result.effects?.status?.status;
  if (status !== "success") {
    throw new Error(
      `Transaction failed: ${result.effects?.status?.error ?? "unknown error"}`,
    );
  }

  console.log(`\n[upgrade-cap] UpgradeCap burned successfully.`);
  console.log(`  Digest:   ${result.digest}`);
  console.log(`  Explorer: https://suiscan.xyz/${getNetwork()}/tx/${result.digest}`);
  console.log(`  The Veil contract is now permanently immutable.\n`);
}

async function transferUpgradeCap(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  upgradeCapId: string,
  recipient: string,
): Promise<void> {
  const address = keypair.toSuiAddress();
  const currentOwner = await validateUpgradeCap(client, upgradeCapId, address);

  console.log("\n========================================");
  console.log("  UpgradeCap Transfer");
  console.log("========================================");
  console.log(`  UpgradeCap ID:    ${upgradeCapId}`);
  console.log(`  Current owner:    ${currentOwner}`);
  console.log(`  Recipient:        ${recipient}`);
  console.log(`  Action:           Transfer ownership`);
  console.log("========================================\n");

  const answer = await prompt("Type 'TRANSFER' to confirm: ");
  if (answer !== "TRANSFER") {
    console.log("[upgrade-cap] Aborted. No changes made.");
    return;
  }

  console.log("[upgrade-cap] Building transaction...");
  const tx = new Transaction();
  tx.transferObjects([tx.object(upgradeCapId)], recipient);

  console.log("[upgrade-cap] Signing and executing...");
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });

  const status = result.effects?.status?.status;
  if (status !== "success") {
    throw new Error(
      `Transaction failed: ${result.effects?.status?.error ?? "unknown error"}`,
    );
  }

  console.log(`\n[upgrade-cap] UpgradeCap transferred successfully.`);
  console.log(`  Digest:   ${result.digest}`);
  console.log(`  Explorer: https://suiscan.xyz/${getNetwork()}/tx/${result.digest}`);
  console.log(`  New owner: ${recipient}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
Veil UpgradeCap Management
===========================

Manage the Veil package UpgradeCap — burn it (immutable forever) or transfer it.

Commands:
  burn                          Permanently make the contract immutable
  transfer <recipient-address>  Transfer the UpgradeCap to a new owner

Options:
  --cap <id>    UpgradeCap object ID (or set UPGRADE_CAP_ID env var)
  --help, -h    Show this help message

Environment:
  UPGRADE_CAP_ID    The object ID of the UpgradeCap
  SUI_NETWORK       Network: mainnet | testnet | devnet (default: testnet)

Examples:
  bun run src/manage-upgrade-cap.ts burn --cap 0xabc123...
  UPGRADE_CAP_ID=0xabc123 bun run src/manage-upgrade-cap.ts transfer 0xdef456...
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const network = getNetwork();
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(network),
    network,
  });
  const keypair = loadKeypair();

  console.log(`[upgrade-cap] Network: ${network}`);

  switch (command) {
    case "burn": {
      const upgradeCapId = getUpgradeCapId(args);
      await burnUpgradeCap(client, keypair, upgradeCapId);
      break;
    }

    case "transfer": {
      const upgradeCapId = getUpgradeCapId(args);
      // Recipient is the first positional arg after "transfer" that doesn't start with --
      const recipient = args.find(
        (arg, idx) => idx > 0 && !arg.startsWith("--") && args[idx - 1] !== "--cap",
      );
      if (!recipient) {
        console.error(
          "Error: recipient address required. Usage: transfer <recipient-address>",
        );
        process.exit(1);
      }
      await transferUpgradeCap(client, keypair, upgradeCapId, recipient);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[upgrade-cap] Fatal error: ${message}`);
  process.exit(1);
});
