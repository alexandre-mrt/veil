/**
 * e2e-test.ts — End-to-end proof pipeline for Veil.
 *
 * Full flow: compile circuit -> generate witness -> produce Groth16 proof ->
 * convert to Sui format -> deploy contract -> shielded transfer -> verify -> replay rejection.
 *
 * Usage: bun run scripts/src/e2e-test.ts
 * Requires: sui CLI configured on testnet, circuit build artifacts (or circom to compile)
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
import type { PoseidonFunction } from "circomlibjs";

import { deployContract } from "./deploy.js";
import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "./proof-converter.js";
import type { SnarkjsProof, SnarkjsVK } from "./proof-converter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");
const WASM_PATH = join(BUILD_DIR, "transfer_js", "transfer.wasm");
const ZKEY_PATH = join(BUILD_DIR, "transfer_final.zkey");
const VK_PATH = join(BUILD_DIR, "transfer_vk.json");
const COMPILE_SCRIPT = join(CIRCUITS_DIR, "scripts", "compile.sh");

const NETWORK = "testnet" as const;
const SUI_CLOCK_OBJECT_ID = "0x6";
const MIN_SUI_BALANCE_MIST = 200_000_000; // 0.2 SUI minimum for operations
const GAS_BUDGET = 200_000_000;
const FAUCET_MINT_AMOUNT = 1_000_000; // Amount to deposit into pool
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const TRANSFER_THRESHOLD = 1_000_000_000n; // 1B threshold for KYC-free transfers

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a circomlibjs Poseidon output to a BigInt string.
 * circomlibjs returns an internal field element; we use F.toString to get the decimal string.
 */
function poseidonHash(poseidon: PoseidonFunction, inputs: bigint[]): string {
  const result = poseidon(inputs);
  return poseidon.F.toString(result);
}

function step(n: number, msg: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Step ${n}: ${msg}`);
  console.log("=".repeat(60));
}

function info(msg: string): void {
  console.log(`  [info] ${msg}`);
}

function success(msg: string): void {
  console.log(`  [ok]   ${msg}`);
}

// ---------------------------------------------------------------------------
// Step 1: Load keypair from Sui keystore
// ---------------------------------------------------------------------------

function loadKeypair(): Ed25519Keypair {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  info(`Active Sui address: ${activeAddress}`);

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
    } catch {}
  }

  throw new Error(`No Ed25519 key found matching active address ${activeAddress}`);
}

// ---------------------------------------------------------------------------
// Step 2: Ensure sufficient balance (request faucet if needed)
// ---------------------------------------------------------------------------

async function ensureBalance(
  client: SuiJsonRpcClient,
  address: string,
): Promise<void> {
  const balance = await client.getBalance({ owner: address });
  const totalMist = BigInt(balance.totalBalance);
  info(`Current balance: ${totalMist} MIST (${Number(totalMist) / 1e9} SUI)`);

  if (totalMist < BigInt(MIN_SUI_BALANCE_MIST)) {
    info("Balance too low, requesting testnet faucet...");
    await requestSuiFromFaucetV2({
      host: getFaucetHost(NETWORK),
      recipient: address,
    });
    // Wait for faucet to process
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const newBalance = await client.getBalance({ owner: address });
    success(`New balance: ${newBalance.totalBalance} MIST`);
  } else {
    success("Balance sufficient.");
  }
}

// ---------------------------------------------------------------------------
// Step 3: Compile circuit if needed
// ---------------------------------------------------------------------------

function ensureCircuitCompiled(): void {
  const hasArtifacts = existsSync(WASM_PATH) && existsSync(ZKEY_PATH) && existsSync(VK_PATH);

  if (hasArtifacts) {
    success("Circuit build artifacts found, skipping compilation.");
    return;
  }

  info("Circuit build artifacts missing, attempting compilation...");

  if (!existsSync(COMPILE_SCRIPT)) {
    throw new Error(`Compile script not found at ${COMPILE_SCRIPT}`);
  }

  // Check circom availability
  try {
    execSync("circom --version", { encoding: "utf-8", stdio: "pipe" });
  } catch {
    throw new Error(
      "circom is not installed. Install with: cargo install circom\n" +
      "Or pre-compile the circuit: cd circuits && bash scripts/compile.sh",
    );
  }

  info("Running circuit compilation (this may take a few minutes)...");
  execSync(`bash ${COMPILE_SCRIPT}`, {
    cwd: CIRCUITS_DIR,
    encoding: "utf-8",
    stdio: "inherit",
    timeout: 300_000, // 5 minutes
  });

  // Verify artifacts were created
  if (!existsSync(WASM_PATH) || !existsSync(ZKEY_PATH) || !existsSync(VK_PATH)) {
    throw new Error("Circuit compilation completed but artifacts are missing.");
  }
  success("Circuit compiled successfully.");
}

// ---------------------------------------------------------------------------
// Step 4: Generate witness + Groth16 proof
// ---------------------------------------------------------------------------

interface WitnessData {
  readonly proof: SnarkjsProof;
  readonly publicSignals: string[];
  readonly nullifierStr: string;
  readonly vk: SnarkjsVK;
}

async function generateProof(poseidon: PoseidonFunction): Promise<WitnessData> {
  // We import snarkjs dynamically since it has no types
  // @ts-expect-error snarkjs has no TypeScript declarations
  const snarkjs = await import("snarkjs");

  // Test transfer parameters
  const cumulativeOld = 0n; // Genesis (first transfer)
  const txAmount = 100n;
  const cumulativeNew = cumulativeOld + txAmount;
  const randomnessOld = 0n; // Genesis randomness
  const randomnessNew = 42424242n;
  const userSecret = 123456789n;
  const epochId = BigInt(Math.floor(Date.now() / 2_592_000_000));
  const salt = 777n;

  // Compute public inputs using Poseidon
  const oldCommitment = poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeOld, randomnessOld]);
  const newCommitment = poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeNew, randomnessNew]);
  const nullifier = poseidonHash(poseidon, [DOMAIN_NULLIFIER, userSecret, epochId]);
  const txAmountHash = poseidonHash(poseidon, [txAmount, salt]);

  info(`oldCommitment: ${oldCommitment}`);
  info(`newCommitment: ${newCommitment}`);
  info(`nullifier:     ${nullifier}`);
  info(`txAmountHash:  ${txAmountHash}`);

  // All circuit inputs (public + private)
  const circuitInput = {
    // Public inputs (6)
    oldCommitment,
    newCommitment,
    threshold: TRANSFER_THRESHOLD.toString(),
    epochId: epochId.toString(),
    nullifier,
    txAmountHash,
    // Private inputs (7)
    cumulativeOld: cumulativeOld.toString(),
    cumulativeNew: cumulativeNew.toString(),
    txAmount: txAmount.toString(),
    randomnessOld: randomnessOld.toString(),
    randomnessNew: randomnessNew.toString(),
    userSecret: userSecret.toString(),
    salt: salt.toString(),
  };

  info("Generating Groth16 proof with snarkjs...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  // Verify locally before sending on-chain
  const vk: SnarkjsVK = JSON.parse(readFileSync(VK_PATH, "utf-8"));
  const isValid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!isValid) {
    throw new Error("Local Groth16 verification failed! Proof is invalid.");
  }
  success("Proof generated and verified locally.");

  info(`Public signals (${publicSignals.length}): [${publicSignals.map((s: string) => s.slice(0, 20) + "...").join(", ")}]`);

  return {
    proof: proof as SnarkjsProof,
    publicSignals: publicSignals as string[],
    nullifierStr: nullifier,
    vk,
  };
}

// ---------------------------------------------------------------------------
// Step 5: Convert proof to Sui format
// ---------------------------------------------------------------------------

interface SuiProofData {
  readonly proofBytes: Uint8Array;
  readonly publicInputsBytes: Uint8Array;
  readonly vkBytes: Uint8Array;
}

function convertProofToSui(witnessData: WitnessData): SuiProofData {
  const proofBytes = proofToSuiBytes(witnessData.proof);
  const publicInputsBytes = publicInputsToSuiBytes(witnessData.publicSignals);
  const vkBytes = vkToSuiBytes(witnessData.vk);

  info(`Proof bytes:         ${proofBytes.length} bytes`);
  info(`Public inputs bytes: ${publicInputsBytes.length} bytes`);
  info(`VK bytes:            ${vkBytes.length} bytes`);

  return { proofBytes, publicInputsBytes, vkBytes };
}

// ---------------------------------------------------------------------------
// Step 6: Deploy contract
// ---------------------------------------------------------------------------

interface DeployedPackage {
  readonly packageId: string;
  readonly treasuryCapId: string;
}

function deployPackage(): DeployedPackage {
  const result = deployContract(PROJECT_ROOT, GAS_BUDGET);

  if (!result.treasuryCapId) {
    throw new Error("TreasuryCap not found after deployment. Token module init may have failed.");
  }

  // Pool is NOT created during publish (create_pool must be called separately)
  return {
    packageId: result.packageId,
    treasuryCapId: result.treasuryCapId,
  };
}

// ---------------------------------------------------------------------------
// Step 7: Create pool with VK
// ---------------------------------------------------------------------------

async function createPool(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  packageId: string,
  vkBytes: Uint8Array,
): Promise<string> {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);

  tx.moveCall({
    target: `${packageId}::pool::create_pool`,
    arguments: [
      tx.pure.vector("u8", Array.from(vkBytes)),
      tx.pure.u64(TRANSFER_THRESHOLD),
    ],
  });

  info("Sending create_pool transaction...");
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showObjectChanges: true, showEffects: true },
  });

  const txStatus = result.effects?.status?.status;
  if (txStatus !== "success") {
    throw new Error(`create_pool failed: ${JSON.stringify(result.effects?.status)}`);
  }

  // Find the Pool shared object in object changes
  const poolChange = result.objectChanges?.find(
    (c) => c.type === "created" && "objectType" in c && c.objectType.includes("::pool::Pool"),
  );
  if (!poolChange || !("objectId" in poolChange)) {
    throw new Error("Pool object not found in create_pool transaction changes");
  }

  const poolId = poolChange.objectId;
  success(`Pool created: ${poolId}`);
  info(`Gas used: ${result.effects?.gasUsed ? JSON.stringify(result.effects.gasUsed) : "unknown"}`);

  await client.waitForTransaction({ digest: result.digest });
  return poolId;
}

// ---------------------------------------------------------------------------
// Step 8: Mint tokens via faucet and deposit to pool
// ---------------------------------------------------------------------------

async function mintAndDeposit(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  packageId: string,
  treasuryCapId: string,
  poolId: string,
): Promise<void> {
  // First, mint tokens using token::faucet
  const mintTx = new Transaction();
  mintTx.setGasBudget(GAS_BUDGET);
  mintTx.moveCall({
    target: `${packageId}::token::faucet`,
    arguments: [mintTx.object(treasuryCapId)],
  });

  info("Minting VEIL tokens via faucet...");
  const mintResult = await client.signAndExecuteTransaction({
    transaction: mintTx,
    signer: keypair,
    options: { showObjectChanges: true, showEffects: true },
  });

  if (mintResult.effects?.status?.status !== "success") {
    throw new Error(`Token faucet failed: ${JSON.stringify(mintResult.effects?.status)}`);
  }
  success("Tokens minted successfully.");

  // Find the created Coin<TOKEN> object
  const coinChange = mintResult.objectChanges?.find(
    (c) => c.type === "created" && "objectType" in c && c.objectType.includes("::token::TOKEN"),
  );
  if (!coinChange || !("objectId" in coinChange)) {
    throw new Error("Minted coin not found in objectChanges");
  }
  const coinId = coinChange.objectId;
  info(`Minted coin: ${coinId}`);

  // Wait for the object to be available
  await client.waitForTransaction({ digest: mintResult.digest! });

  // Deposit into pool — need to split the exact amount first
  const depositTx = new Transaction();
  depositTx.setGasBudget(GAS_BUDGET);

  // Split a smaller coin from the minted coin for deposit
  const [depositCoin] = depositTx.splitCoins(depositTx.object(coinId), [
    depositTx.pure.u64(FAUCET_MINT_AMOUNT),
  ]);

  depositTx.moveCall({
    target: `${packageId}::pool::deposit`,
    arguments: [depositTx.object(poolId), depositCoin],
  });

  info(`Depositing ${FAUCET_MINT_AMOUNT} tokens to pool...`);
  const depositResult = await client.signAndExecuteTransaction({
    transaction: depositTx,
    signer: keypair,
    options: { showEffects: true },
  });

  if (depositResult.effects?.status?.status !== "success") {
    throw new Error(`Deposit failed: ${JSON.stringify(depositResult.effects?.status)}`);
  }
  success("Tokens deposited to pool.");
  info(`Gas used: ${depositResult.effects?.gasUsed ? JSON.stringify(depositResult.effects.gasUsed) : "unknown"}`);

  await client.waitForTransaction({ digest: depositResult.digest! });
}

// ---------------------------------------------------------------------------
// Step 9: Execute shielded transfer with proof
// ---------------------------------------------------------------------------

async function shieldedTransfer(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  packageId: string,
  poolId: string,
  proofBytes: Uint8Array,
  publicInputsBytes: Uint8Array,
): Promise<string> {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);

  tx.moveCall({
    target: `${packageId}::pool::shielded_transfer`,
    arguments: [
      tx.object(poolId),
      tx.pure.vector("u8", Array.from(proofBytes)),
      tx.pure.vector("u8", Array.from(publicInputsBytes)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  info("Executing shielded_transfer with ZK proof...");
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showEvents: true },
  });

  const status = result.effects?.status?.status;
  if (status !== "success") {
    const errorMsg = result.effects?.status
      ? JSON.stringify(result.effects.status)
      : "unknown error";
    throw new Error(`shielded_transfer failed: ${errorMsg}`);
  }

  success("Shielded transfer verified on-chain!");
  info(`Transaction digest: ${result.digest}`);
  info(`Gas used: ${result.effects?.gasUsed ? JSON.stringify(result.effects.gasUsed) : "unknown"}`);

  if (result.events && result.events.length > 0) {
    info(`Events emitted: ${result.events.length}`);
    for (const event of result.events) {
      info(`  - ${event.type}: ${JSON.stringify(event.parsedJson)}`);
    }
  }

  return result.digest!;
}

// ---------------------------------------------------------------------------
// Step 10: Test nullifier replay rejection
// ---------------------------------------------------------------------------

async function testNullifierReplay(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  packageId: string,
  poolId: string,
  proofBytes: Uint8Array,
  publicInputsBytes: Uint8Array,
): Promise<void> {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);

  tx.moveCall({
    target: `${packageId}::pool::shielded_transfer`,
    arguments: [
      tx.object(poolId),
      tx.pure.vector("u8", Array.from(proofBytes)),
      tx.pure.vector("u8", Array.from(publicInputsBytes)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  info("Attempting nullifier replay (should fail with E_NULLIFIER_SPENT)...");
  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    const status = result.effects?.status?.status;
    if (status === "success") {
      throw new Error("SECURITY ISSUE: Nullifier replay was accepted! Double-spend possible.");
    }
    // Transaction was submitted but failed on-chain (move abort)
    success(`Replay correctly rejected on-chain: ${JSON.stringify(result.effects?.status)}`);
  } catch (error: unknown) {
    // The transaction may fail during simulation/execution
    const errMsg = error instanceof Error ? error.message : String(error);
    if (
      errMsg.includes("MoveAbort") ||
      errMsg.includes("NULLIFIER") ||
      errMsg.includes("abort") ||
      errMsg.includes("E_NULLIFIER_SPENT") ||
      // Error code 2 = E_NULLIFIER_SPENT from pool.move
      errMsg.includes(", 2)") ||
      errMsg.includes("InsufficientGas") === false
    ) {
      success(`Replay correctly rejected: ${errMsg.slice(0, 200)}`);
    } else {
      throw new Error(`Unexpected error during replay test: ${errMsg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("  VEIL E2E PROOF PIPELINE");
  console.log("=".repeat(60));
  const startTime = Date.now();

  // ── Step 1: Load keypair ──────────────────────────────────────────────
  step(1, "Loading Sui keypair");
  const keypair = loadKeypair();
  const address = keypair.toSuiAddress();
  success(`Keypair loaded. Address: ${address}`);

  // ── Step 2: Connect to testnet + ensure balance ───────────────────────
  step(2, "Connecting to testnet and checking balance");
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(NETWORK),
    network: NETWORK,
  });
  await ensureBalance(client, address);

  // ── Step 3: Compile circuit if needed ─────────────────────────────────
  step(3, "Checking circuit compilation");
  ensureCircuitCompiled();

  // ── Step 4: Generate witness + Groth16 proof ──────────────────────────
  step(4, "Generating Poseidon hashes and Groth16 proof");
  const poseidon = await buildPoseidon();
  const witnessData = await generateProof(poseidon);

  // ── Step 5: Convert proof to Sui bytes ────────────────────────────────
  step(5, "Converting proof to Sui byte format");
  const { proofBytes, publicInputsBytes, vkBytes } = convertProofToSui(witnessData);

  // ── Step 6: Deploy contract ───────────────────────────────────────────
  step(6, "Deploying Move contract to testnet");
  const { packageId, treasuryCapId } = deployPackage();
  success(`Package deployed: ${packageId}`);

  // ── Step 7: Create pool with VK ───────────────────────────────────────
  step(7, "Creating pool with verification key");
  const poolId = await createPool(client, keypair, packageId, vkBytes);

  // ── Step 8: Mint and deposit tokens ───────────────────────────────────
  step(8, "Minting and depositing VEIL tokens");
  await mintAndDeposit(client, keypair, packageId, treasuryCapId, poolId);

  // ── Step 9: Execute shielded transfer ─────────────────────────────────
  step(9, "Executing shielded transfer with ZK proof");
  const digest = await shieldedTransfer(
    client,
    keypair,
    packageId,
    poolId,
    proofBytes,
    publicInputsBytes,
  );

  // Wait for the transaction to be finalized
  await client.waitForTransaction({ digest });

  // ── Step 10: Test nullifier replay rejection ──────────────────────────
  step(10, "Testing nullifier replay rejection");
  await testNullifierReplay(
    client,
    keypair,
    packageId,
    poolId,
    proofBytes,
    publicInputsBytes,
  );

  // ── Summary ───────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(60));
  console.log("  E2E PIPELINE COMPLETE");
  console.log("=".repeat(60));
  console.log(`  Package ID:     ${packageId}`);
  console.log(`  Pool ID:        ${poolId}`);
  console.log(`  Transfer digest: ${digest}`);
  console.log(`  Total time:     ${elapsed}s`);
  console.log(`  Network:        ${NETWORK}`);
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("\n[FATAL] E2E pipeline failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
