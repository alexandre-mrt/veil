/**
 * onchain-gas.ts — Real on-chain gas measurement for Veil's Move entry points.
 *
 * Runs against a LOCAL Sui network (`sui start`), not testnet: this sandbox's egress
 * policy blocks arbitrary hosts (fullnode.testnet.sui.io, storage.googleapis.com, ...),
 * so a local validator on 127.0.0.1 is the only way to get real `effects.gasUsed`
 * numbers without a network exception. Gas costs are a protocol constant (computation
 * budget + storage schedule), not a function of which network executes them, so a
 * local measurement is exactly as real as a testnet one for this purpose.
 *
 * Builds one self-consistent UTXO chain (deposit -> shielded_transfer -> zk_withdraw)
 * with real Groth16 proofs, so every entry point sees the same commitment/nullifier
 * state a real user's would.
 *
 * Usage (see README at bottom of this file for full local-network setup):
 *   bun run scripts/bench/onchain-gas.ts
 *
 * Requires: `sui` CLI in PATH, `sui client` configured against a running local network
 * with a funded active address, circuits compiled at circuits/build{,-withdraw}/.
 */

import { execSync } from "child_process";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";
import type { PoseidonFunction } from "circomlibjs";

import { deployContract } from "../src/deploy.js";
import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "../src/proof-converter.js";
import type { SnarkjsProof, SnarkjsVK } from "../src/proof-converter.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");

const TRANSFER_WASM = join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm");
const TRANSFER_ZKEY = join(CIRCUITS_DIR, "build", "transfer_final.zkey");
const TRANSFER_VK = join(CIRCUITS_DIR, "build", "transfer_vk.json");
const WITHDRAW_WASM = join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm");
const WITHDRAW_ZKEY = join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey");
const WITHDRAW_VK = join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json");

const RPC_URL = process.env.VEIL_LOCALNET_RPC ?? "http://127.0.0.1:9000";
const SUI_CLOCK_OBJECT_ID = "0x6";
const GAS_BUDGET = 200_000_000;
const EPOCH_DURATION_MS = 60_000; // minimum allowed by pool.move; keeps the 1-epoch timelocks short
const THRESHOLD = 1_000_000_000n;
const DEPOSIT_AMOUNT = 1_000_000_000n; // DENOM_LARGE — matches token_faucet's FAUCET_AMOUNT exactly

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;
const MERKLE_DEPTH = 20;

const USER_SECRET = 987654321n;
const RECIPIENT_FIELD = 0xabcdef123456n; // same convention as circuits/test/withdraw.test.mjs

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(msg);
}

function poseidonHash(poseidon: PoseidonFunction, inputs: bigint[]): bigint {
  return poseidon.F.toObject(poseidon(inputs));
}

function toHex32(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

// Little-endian, matching proof-converter.ts's bigintToLE32 — Move compares commitment/root
// bytes directly against this same encoding of the circuit's public signals.
function bigintToLE32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

interface GasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
  nonRefundableStorageFee: string;
}

interface GasRow {
  entryPoint: string;
  digest: string;
  gas: GasUsed;
  netMist: bigint;
}

const results: GasRow[] = [];

function recordGas(entryPoint: string, digest: string, gas: GasUsed | undefined): void {
  if (!gas) throw new Error(`${entryPoint}: no gasUsed in effects`);
  const net =
    BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
  results.push({ entryPoint, digest, gas, netMist: net });
  log(
    `  [gas] ${entryPoint}: computation=${gas.computationCost} storage=${gas.storageCost} ` +
      `rebate=${gas.storageRebate} net=${net} MIST`,
  );
}

// ---------------------------------------------------------------------------
// Keypair / client
// ---------------------------------------------------------------------------

function loadKeypair(): Ed25519Keypair {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const keystore: string[] = JSON.parse(readFileSync(keystorePath, "utf-8"));
  for (const key of keystore) {
    const raw = fromBase64(key);
    if (raw[0] !== 0) continue;
    try {
      const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
      if (kp.toSuiAddress() === activeAddress) return kp;
    } catch {
      /* not an ed25519 key */
    }
  }
  throw new Error(`No Ed25519 key found matching active address ${activeAddress}`);
}

async function currentEpoch(client: SuiJsonRpcClient): Promise<bigint> {
  const clockObj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
  const content = clockObj.data?.content as { fields?: { timestamp_ms?: string } } | undefined;
  const ts = BigInt(content?.fields?.timestamp_ms ?? "0");
  return ts / BigInt(EPOCH_DURATION_MS);
}

async function waitForEpochRollover(client: SuiJsonRpcClient, fromEpoch: bigint): Promise<bigint> {
  log(`  waiting for on-chain epoch to advance past ${fromEpoch} (epoch_duration_ms=${EPOCH_DURATION_MS})...`);
  for (;;) {
    const e = await currentEpoch(client);
    if (e > fromEpoch) return e;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  for (const p of [TRANSFER_WASM, TRANSFER_ZKEY, TRANSFER_VK, WITHDRAW_WASM, WITHDRAW_ZKEY, WITHDRAW_VK]) {
    if (!existsSync(p)) throw new Error(`Missing circuit artifact: ${p} (compile circuits first)`);
  }

  const snarkjs = await import("snarkjs");
  const poseidon = await buildPoseidon();

  const keypair = loadKeypair();
  const address = keypair.toSuiAddress();
  log(`Active address: ${address}`);

  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
  const balance = await client.getBalance({ owner: address });
  log(`Balance: ${balance.totalBalance} MIST`);

  const transferVk: SnarkjsVK = JSON.parse(readFileSync(TRANSFER_VK, "utf-8"));
  const withdrawVk: SnarkjsVK = JSON.parse(readFileSync(WITHDRAW_VK, "utf-8"));
  const transferVkBytes = vkToSuiBytes(transferVk);
  const withdrawVkBytes = vkToSuiBytes(withdrawVk);

  // ── 1. Publish package + create_pool ────────────────────────────────────
  log("\n=== deploy: sui client publish ===");
  const { packageId, treasuryCapId } = deployContract(PROJECT_ROOT, GAS_BUDGET);
  log(`packageId=${packageId} treasuryCapId=${treasuryCapId}`);

  log("\n=== create_pool ===");
  let poolId: string;
  let adminCapId: string;
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [
        tx.pure.vector("u8", Array.from(transferVkBytes)),
        tx.pure.u64(THRESHOLD),
        tx.pure.u64(BigInt(EPOCH_DURATION_MS)),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`create_pool failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("create_pool", result.digest, result.effects?.gasUsed as GasUsed);

    const poolChange = result.objectChanges?.find(
      (c) => c.type === "created" && "objectType" in c && c.objectType.includes("::pool::Pool"),
    );
    const adminCapChange = result.objectChanges?.find(
      (c) => c.type === "created" && "objectType" in c && c.objectType.includes("::pool::AdminCap"),
    );
    if (!poolChange || !("objectId" in poolChange)) throw new Error("Pool object not found in create_pool changes");
    if (!adminCapChange || !("objectId" in adminCapChange)) throw new Error("AdminCap not found in create_pool changes");
    poolId = poolChange.objectId as string;
    adminCapId = adminCapChange.objectId as string;

    await client.waitForTransaction({ digest: result.digest });
  }
  log(`poolId=${poolId} adminCapId=${adminCapId}`);

  // ── 2. Genesis commitment + deposit_and_register ────────────────────────
  const cumulativeOld0 = 0n;
  const randomnessOld0 = 0n;
  const commitment0 = poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeOld0, randomnessOld0, USER_SECRET]);
  const commitment0BytesLE = bigintToLE32(commitment0);

  log("\n=== token_faucet::faucet (mint, not a Veil entry point — logged for completeness) ===");
  let coinId: string;
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [tx.object(treasuryCapId)] });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`faucet failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("token_faucet::faucet (utility, not counted in headline table)", result.digest, result.effects?.gasUsed as GasUsed);
    const coinChange = result.objectChanges?.find(
      (c) => c.type === "created" && "objectType" in c && c.objectType.includes("::token::TOKEN"),
    );
    if (!coinChange || !("objectId" in coinChange)) throw new Error("Minted coin not found");
    coinId = coinChange.objectId as string;
    await client.waitForTransaction({ digest: result.digest });
  }

  log("\n=== deposit_and_register ===");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [
        tx.object(poolId),
        tx.object(coinId),
        tx.pure.vector("u8", Array.from(commitment0BytesLE)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`deposit_and_register failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("deposit_and_register", result.digest, result.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: result.digest });
  }

  // ── 3. Propose commitment root + withdraw VK (both 1-epoch timelocked) ──
  function merkleRootFromZeroPath(leaf: bigint): bigint {
    let node = leaf;
    for (let i = 0; i < MERKLE_DEPTH; i++) node = poseidonHash(poseidon, [node, 0n]);
    return node;
  }
  const merkleRoot = merkleRootFromZeroPath(commitment0);
  const merkleRootBytesLE = bigintToLE32(merkleRoot);

  const proposalEpoch = await currentEpoch(client);

  log("\n=== update_commitment_root ===");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [
        tx.object(poolId),
        tx.object(adminCapId),
        tx.pure.vector("u8", Array.from(merkleRootBytesLE)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`update_commitment_root failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("update_commitment_root (admin, proposal)", result.digest, result.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: result.digest });
  }

  log("\n=== propose_withdraw_vk ===");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::propose_withdraw_vk`,
      arguments: [
        tx.object(poolId),
        tx.object(adminCapId),
        tx.pure.vector("u8", Array.from(withdrawVkBytes)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`propose_withdraw_vk failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("propose_withdraw_vk (admin, proposal)", result.digest, result.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: result.digest });
  }

  log("\n=== propose_vk_update (admin op, measured for gas only — reproposes the same transfer VK) ===");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::propose_vk_update`,
      arguments: [
        tx.object(poolId),
        tx.object(adminCapId),
        tx.pure.vector("u8", Array.from(transferVkBytes)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`propose_vk_update failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("propose_vk_update (admin, proposal)", result.digest, result.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: result.digest });

    // Cancel it immediately so it doesn't clobber transfer_vk mid-experiment — cancel is
    // itself a cheap admin op worth a gas row.
    const cancelTx = new Transaction();
    cancelTx.setGasBudget(GAS_BUDGET);
    cancelTx.moveCall({
      target: `${packageId}::pool::cancel_vk_update`,
      arguments: [tx.object(poolId), tx.object(adminCapId)],
    });
    const cancelResult = await client.signAndExecuteTransaction({
      transaction: cancelTx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (cancelResult.effects?.status?.status !== "success") {
      throw new Error(`cancel_vk_update failed: ${JSON.stringify(cancelResult.effects?.status)}`);
    }
    recordGas("cancel_vk_update (admin)", cancelResult.digest, cancelResult.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: cancelResult.digest });
  }

  // ── 4. Wait for the 1-epoch timelock, then shielded_transfer ────────────
  const postRolloverEpoch = await waitForEpochRollover(client, proposalEpoch);
  log(`  epoch rolled over: ${proposalEpoch} -> ${postRolloverEpoch}`);

  const txAmount = 100n;
  const cumulativeNew1 = cumulativeOld0 + txAmount;
  const randomnessNew1 = 12345n;
  const salt = 99n;
  const epochIdForProof = await currentEpoch(client);

  const newCommitment1 = poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeNew1, randomnessNew1, USER_SECRET]);
  const nullifier1 = poseidonHash(poseidon, [DOMAIN_NULLIFIER, USER_SECRET, epochIdForProof, randomnessOld0]);
  const txAmountHash = poseidonHash(poseidon, [DOMAIN_TX_AMOUNT, txAmount, salt]);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);

  const transferInput = {
    oldCommitment: commitment0.toString(),
    newCommitment: newCommitment1.toString(),
    threshold: THRESHOLD.toString(),
    epochId: epochIdForProof.toString(),
    nullifier: nullifier1.toString(),
    txAmountHash: txAmountHash.toString(),
    merkleRoot: merkleRoot.toString(),
    cumulativeOld: cumulativeOld0.toString(),
    cumulativeNew: cumulativeNew1.toString(),
    txAmount: txAmount.toString(),
    randomnessOld: randomnessOld0.toString(),
    randomnessNew: randomnessNew1.toString(),
    userSecret: USER_SECRET.toString(),
    salt: salt.toString(),
    pathElements: pathElements.map(String),
    pathIndices: pathIndices.map(String),
  };

  log("\n=== generating real transfer Groth16 proof ===");
  const { proof: transferProof, publicSignals: transferSignals } = await snarkjs.groth16.fullProve(
    transferInput,
    TRANSFER_WASM,
    TRANSFER_ZKEY,
  );
  const transferOk = await snarkjs.groth16.verify(transferVk, transferSignals, transferProof);
  if (!transferOk) throw new Error("Local transfer proof verification failed");

  const transferProofBytes = proofToSuiBytes(transferProof as SnarkjsProof);
  const transferPublicBytes = publicInputsToSuiBytes(transferSignals as string[]);

  log("\n=== shielded_transfer ===");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::shielded_transfer`,
      arguments: [
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(transferProofBytes)),
        tx.pure.vector("u8", Array.from(transferPublicBytes)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`shielded_transfer failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("shielded_transfer", result.digest, result.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: result.digest });
  }

  // ── 5. zk_withdraw, chained from the transfer's new commitment ──────────
  const withdrawAmount = 40n;
  const remainingBalance = cumulativeNew1 - withdrawAmount;
  const randomnessNew2 = 5555n;
  const newCommitment2 = poseidonHash(poseidon, [DOMAIN_COMMITMENT, remainingBalance, randomnessNew2, USER_SECRET]);
  const nullifierW = poseidonHash(poseidon, [DOMAIN_WITHDRAW_NULLIFIER, USER_SECRET, randomnessNew1, cumulativeNew1]);
  const recipientHash = poseidonHash(poseidon, [DOMAIN_RECIPIENT_HASH, RECIPIENT_FIELD]);

  const withdrawInput = {
    commitment: newCommitment1.toString(),
    withdrawAmount: withdrawAmount.toString(),
    nullifier: nullifierW.toString(),
    recipientHash: recipientHash.toString(),
    newCommitment: newCommitment2.toString(),
    cumulativeOld: cumulativeNew1.toString(),
    randomnessOld: randomnessNew1.toString(),
    userSecret: USER_SECRET.toString(),
    recipient: RECIPIENT_FIELD.toString(),
    randomnessNew: randomnessNew2.toString(),
  };

  log("\n=== generating real withdraw Groth16 proof ===");
  const { proof: withdrawProof, publicSignals: withdrawSignals } = await snarkjs.groth16.fullProve(
    withdrawInput,
    WITHDRAW_WASM,
    WITHDRAW_ZKEY,
  );
  const withdrawOk = await snarkjs.groth16.verify(withdrawVk, withdrawSignals, withdrawProof);
  if (!withdrawOk) throw new Error("Local withdraw proof verification failed");

  const withdrawProofBytes = proofToSuiBytes(withdrawProof as SnarkjsProof);
  const withdrawPublicBytes = publicInputsToSuiBytes(withdrawSignals as string[]);
  const recipientAddress = toHex32(RECIPIENT_FIELD);

  log("\n=== zk_withdraw ===");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::zk_withdraw`,
      arguments: [
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(withdrawProofBytes)),
        tx.pure.vector("u8", Array.from(withdrawPublicBytes)),
        tx.pure.address(recipientAddress),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`zk_withdraw failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("zk_withdraw", result.digest, result.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: result.digest });
  }

  // ── 6. Cheap admin ops: freeze / unfreeze ────────────────────────────────
  log("\n=== freeze_pool ===");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::freeze_pool`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`freeze_pool failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("freeze_pool (admin)", result.digest, result.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: result.digest });
  }

  log("\n=== unfreeze_pool ===");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::unfreeze_pool`,
      arguments: [tx.object(poolId), tx.object(adminCapId)],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`unfreeze_pool failed: ${JSON.stringify(result.effects?.status)}`);
    }
    recordGas("unfreeze_pool (admin)", result.digest, result.effects?.gasUsed as GasUsed);
    await client.waitForTransaction({ digest: result.digest });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("  ON-CHAIN GAS SUMMARY (real local-network execution)");
  console.log("=".repeat(70));
  for (const r of results) {
    console.log(
      `${r.entryPoint.padEnd(55)} net=${r.netMist.toString().padStart(10)} MIST  (${r.digest})`,
    );
  }

  const outPath = join(__dirname, "onchain-gas-results.json");
  writeFileSync(outPath, JSON.stringify(results.map((r) => ({ ...r, netMist: r.netMist.toString() })), null, 2));
  console.log(`\nRaw results written to ${outPath}`);
}

main().catch((err) => {
  console.error("\n[FATAL] onchain-gas benchmark failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});

/*
 * Local network setup (one-time, per session):
 *
 *   sui start --force-regenesis --with-faucet &
 *   sui client switch --env localnet   # or: sui client new-env --alias localnet --rpc http://127.0.0.1:9000
 *   curl -X POST http://127.0.0.1:9123/gas -d '{"FixedAmountRequest":{"recipient":"<active-address>"}}' \
 *     -H 'Content-Type: application/json'
 *
 * Then, from the repo root:
 *   cd circuits && bash scripts/compile.sh   # or the manual circom + snarkjs steps if the
 *                                             # ptau CDN is unreachable (see this repo's
 *                                             # docs/research/ for the offline ceremony steps)
 *   bun run scripts/bench/onchain-gas.ts
 */
