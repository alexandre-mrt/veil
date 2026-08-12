/**
 * gas-bench.ts — Real on-chain gas cost per Veil entry point, measured on a local Sui network.
 *
 * WHY LOCAL, NOT TESTNET: this research loop's sandbox blocks all outbound traffic to
 * fullnode.{testnet,mainnet}.sui.io at the network-policy layer (CONNECT -> 403, confirmed via
 * the proxy's own status endpoint, not an application-level failure). That's the same blocker
 * hit on 2026-07-22. `sui start` runs a real single-validator Sui network entirely on localhost:
 * real Move VM, real gas metering, zero outbound calls. The numbers below are genuine — the same
 * bytecode, the same verifier, the same gas schedule a testnet validator runs — they are just not
 * from the specific already-deployed testnet package. See
 * docs/research/2026-08-12-onchain-gas-baseline.md for the full writeup.
 *
 * Usage:
 *   sui start --force-regenesis &            # local validator + faucet, no network access needed
 *   bun run scripts/bench/gas-bench.ts
 *
 * Requires: `sui` CLI on PATH with an active env pointed at the running localnet
 *   (`sui client new-env --alias local --rpc http://127.0.0.1:9000` then
 *    `sui client switch --env local`), circuits compiled
 *   (circuits/build{,-withdraw,-compliance}/ — see circuits/scripts/compile*.sh).
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";

import { deployContract } from "../src/deploy.js";
import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
  bigintToLE32,
} from "../src/proof-converter.js";
import type { SnarkjsProof, SnarkjsVK } from "../src/proof-converter.js";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");

const LOCAL_RPC_URL = process.env.VEIL_LOCAL_RPC ?? "http://127.0.0.1:9000";
const LOCAL_FAUCET_URL = process.env.VEIL_LOCAL_FAUCET ?? "http://127.0.0.1:9123/gas";
const SUI_CLOCK_OBJECT_ID = "0x6";
const GAS_BUDGET = 500_000_000;
const EPOCH_DURATION_MS = 60_000; // minimum allowed by pool.move (assert!(epoch_duration_ms >= 60_000))
const TRANSFER_THRESHOLD = 1_000_000_000_000n; // large enough that our tiny test amounts never trip it
const DENOM_SMALL = 100_000_000; // must match pool.move's DENOM_SMALL exactly (deposit_and_register requires standard amounts)

const CIRCUITS = {
  transfer: { dir: "build", name: "transfer" },
  withdraw: { dir: "build-withdraw", name: "withdraw" },
  compliance: { dir: "build-compliance", name: "compliance" },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function step(msg: string): void {
  console.log(`\n=== ${msg} ===`);
}

function info(msg: string): void {
  console.log(`  [info] ${msg}`);
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
  gasUsed: GasUsed;
  netMist: bigint;
}

const rows: GasRow[] = [];

function netMist(g: GasUsed): bigint {
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
}

async function execAndRecord(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  entryPoint: string,
  build: (tx: Transaction) => void,
): Promise<{ digest: string; objectChanges: any[]; events: any[] }> {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showObjectChanges: true, showEffects: true, showEvents: true },
  });

  const status = result.effects?.status?.status;
  if (status !== "success") {
    throw new Error(`${entryPoint} failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await client.waitForTransaction({ digest: result.digest! });

  const gasUsed = result.effects!.gasUsed as unknown as GasUsed;
  rows.push({ entryPoint, digest: result.digest!, gasUsed, netMist: netMist(gasUsed) });
  info(`${entryPoint}: net ${netMist(gasUsed)} MIST (computation ${gasUsed.computationCost}, storage ${gasUsed.storageCost}, rebate ${gasUsed.storageRebate})`);

  return {
    digest: result.digest!,
    objectChanges: result.objectChanges ?? [],
    events: result.events ?? [],
  };
}

// ---------------------------------------------------------------------------
// Keypair + balance (local faucet, no outbound network)
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
    } catch {}
  }
  throw new Error(`No Ed25519 key found matching active address ${activeAddress}`);
}

async function ensureBalance(client: SuiJsonRpcClient, address: string): Promise<void> {
  const balance = await client.getBalance({ owner: address });
  if (BigInt(balance.totalBalance) > 5_000_000_000n) return;
  info("Requesting SUI from local faucet...");
  const res = await fetch(LOCAL_FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
  });
  if (!res.ok) throw new Error(`Local faucet request failed: ${res.status} ${await res.text()}`);
  await new Promise((r) => setTimeout(r, 2000));
}

// ---------------------------------------------------------------------------
// Proof generation
// ---------------------------------------------------------------------------

function poseidonHash(poseidon: any, inputs: bigint[]): bigint {
  return poseidon.F.toObject(poseidon(inputs));
}

async function proveCircuit(circuit: keyof typeof CIRCUITS, inputs: Record<string, unknown>) {
  // @ts-expect-error snarkjs has no TypeScript declarations
  const snarkjs = await import("snarkjs");
  const { dir, name } = CIRCUITS[circuit];
  const wasmPath = join(CIRCUITS_DIR, dir, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(CIRCUITS_DIR, dir, `${name}_final.zkey`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
  return { proof: proof as SnarkjsProof, publicSignals: publicSignals as string[] };
}

function loadVk(circuit: keyof typeof CIRCUITS): SnarkjsVK {
  const { dir, name } = CIRCUITS[circuit];
  return JSON.parse(readFileSync(join(CIRCUITS_DIR, dir, `${name}_vk.json`), "utf-8"));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until the wall-clock epoch (timestamp_ms / EPOCH_DURATION_MS) advances past `fromEpoch`. */
async function waitForEpoch(client: SuiJsonRpcClient, fromEpoch: bigint): Promise<void> {
  for (;;) {
    const clockObj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
    const content = clockObj.data?.content as any;
    const timestampMs = BigInt(content.fields.timestamp_ms);
    const currentEpoch = timestampMs / BigInt(EPOCH_DURATION_MS);
    if (currentEpoch > fromEpoch) {
      info(`epoch advanced ${fromEpoch} -> ${currentEpoch} (clock ${timestampMs}ms)`);
      return;
    }
    await sleepMs(3000);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Veil on-chain gas benchmark (local Sui network) ===");

  const keypair = loadKeypair();
  const address = keypair.toSuiAddress();
  info(`Address: ${address}`);

  const client = new SuiJsonRpcClient({ url: LOCAL_RPC_URL, network: "localnet" as any });
  await ensureBalance(client, address);

  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  // ---- Build all three witnesses up front ----
  const transferWitness = WITNESS_BUILDERS.transfer(poseidon);
  const withdrawWitness = WITNESS_BUILDERS.withdraw(poseidon);
  const complianceWitness = WITNESS_BUILDERS.compliance(poseidon);

  // A second, distinct transfer witness (different userSecret) so compliant_transfer consumes
  // its own genesis commitment rather than replaying the one shielded_transfer already spent.
  const transferWitness2 = (() => {
    const w = WITNESS_BUILDERS.transfer(poseidon);
    // Rebuild with a different userSecret so oldCommitment/nullifier differ from transferWitness.
    const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n;
    const userSecret = 555444333n, cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 67890n, epochId = 1n, salt = 42n;
    const cumulativeNew = cumulativeOld + txAmount;
    const oldCommitment = poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]);
    const newCommitment = poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]);
    const nullifier = poseidonHash(poseidon, [DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]);
    const txAmountHash = poseidonHash(poseidon, [DOMAIN_TX_AMOUNT, txAmount, salt]);
    return {
      ...w,
      oldCommitment, newCommitment, nullifier, txAmountHash,
      cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
      merkleRoot: oldCommitment, // depth-20 all-zero path from a leaf equal to itself only holds when pathElements are 0 and node starts at leaf; recomputed below
    };
  })();
  // recompute merkleRoot for transferWitness2 properly (all-zero Merkle path, depth 20)
  {
    let node = transferWitness2.oldCommitment;
    for (let i = 0; i < 20; i++) node = poseidonHash(poseidon, [node, 0n]);
    (transferWitness2 as any).merkleRoot = node;
    (transferWitness2 as any).pathElements = Array.from({ length: 20 }, () => 0n);
    (transferWitness2 as any).pathIndices = Array.from({ length: 20 }, () => 0n);
  }

  const vkBytes = {
    transfer: vkToSuiBytes(loadVk("transfer")),
    withdraw: vkToSuiBytes(loadVk("withdraw")),
    compliance: vkToSuiBytes(loadVk("compliance")),
  };

  // ---- Deploy ----
  step("Deploy package");
  const deployResult = deployContract(PROJECT_ROOT, GAS_BUDGET);
  const packageId = deployResult.packageId;
  const treasuryCapId = deployResult.treasuryCapId!;
  info(`package: ${packageId}, treasuryCap: ${treasuryCapId}`);
  // deploy.ts doesn't capture publish gas today (JSON output from `sui client publish` lacks a
  // clean single digest to re-query without another RPC round-trip) -- explicitly out of scope
  // for this run, package publish is a one-time cost, not a per-transfer one.

  // ---- create_pool ----
  step("create_pool (admin op)");
  const createPoolRes = await execAndRecord(client, keypair, "pool::create_pool", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [
        tx.pure.vector("u8", Array.from(vkBytes.transfer)),
        tx.pure.u64(TRANSFER_THRESHOLD),
        tx.pure.u64(EPOCH_DURATION_MS),
      ],
    });
  });
  const poolChange = createPoolRes.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::pool::Pool"),
  );
  const adminCapChange = createPoolRes.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::pool::AdminCap"),
  );
  const poolId: string = poolChange.objectId;
  const adminCapId: string = adminCapChange.objectId;
  info(`pool: ${poolId}, adminCap: ${adminCapId}`);

  // ---- propose_withdraw_vk (admin op, timelocked) ----
  step("propose_withdraw_vk (admin op)");
  await execAndRecord(client, keypair, "pool::propose_withdraw_vk", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdraw_vk`,
      arguments: [
        tx.object(poolId),
        tx.object(adminCapId),
        tx.pure.vector("u8", Array.from(vkBytes.withdraw)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  });

  // ---- create_compliance_config (admin op) ----
  step("create_compliance_config (admin op)");
  const credentialRoot = bigintToLE32(complianceWitness.merkleRoot as bigint);
  const auditorKey = new Uint8Array(33); // dummy, only length matters for MIN_AUDITOR_KEY_LENGTH
  auditorKey.fill(7);
  const createConfigRes = await execAndRecord(client, keypair, "compliance::create_compliance_config", (tx) => {
    tx.moveCall({
      target: `${packageId}::compliance::create_compliance_config`,
      arguments: [
        tx.object(adminCapId),
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(vkBytes.compliance)),
        tx.pure.vector("u8", Array.from(credentialRoot)),
        tx.pure.u64(1n),
        tx.pure.vector("u8", Array.from(auditorKey)),
      ],
    });
  });
  const configChange = createConfigRes.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::compliance::ComplianceConfig"),
  );
  const configId: string = configChange.objectId;
  info(`complianceConfig: ${configId}`);

  // ---- mint TOKEN ----
  step("token_faucet::faucet (mint)");
  const mintRes = await execAndRecord(client, keypair, "token_faucet::faucet", (tx) => {
    tx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [tx.object(treasuryCapId)] });
  });
  const coinChange = mintRes.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::token::TOKEN"),
  );
  const coinId: string = coinChange.objectId;

  // ---- three deposits (one per genesis commitment we'll spend later) ----
  const genesisCommitments: [string, Uint8Array][] = [
    ["transfer", bigintToLE32(transferWitness.oldCommitment as bigint)],
    ["withdraw", bigintToLE32(withdrawWitness.commitment as bigint)],
    ["compliant_transfer", bigintToLE32((transferWitness2 as any).oldCommitment as bigint)],
  ];

  let currentCoinId = coinId;
  const depositEpochs: bigint[] = [];
  for (const [label, commitment] of genesisCommitments) {
    step(`deposit_and_register (${label} genesis commitment)`);
    const clockObj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
    const timestampMs = BigInt((clockObj.data?.content as any).fields.timestamp_ms);
    depositEpochs.push(timestampMs / BigInt(EPOCH_DURATION_MS));

    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    const [depositCoin] = tx.splitCoins(tx.object(currentCoinId), [tx.pure.u64(DENOM_SMALL)]);
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [
        tx.object(poolId),
        depositCoin,
        tx.pure.vector("u8", Array.from(commitment)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      throw new Error(`deposit_and_register (${label}) failed: ${JSON.stringify(result.effects?.status)}`);
    }
    await client.waitForTransaction({ digest: result.digest! });
    const gasUsed = result.effects!.gasUsed as unknown as GasUsed;
    rows.push({ entryPoint: `pool::deposit_and_register (${label})`, digest: result.digest!, gasUsed, netMist: netMist(gasUsed) });
    info(`deposit (${label}): net ${netMist(gasUsed)} MIST`);
  }

  // ---- freeze / unfreeze (cheap admin ops, no timelock, no wait needed) ----
  step("freeze_pool / unfreeze_pool (admin ops)");
  await execAndRecord(client, keypair, "pool::freeze_pool", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::freeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId), tx.object(SUI_CLOCK_OBJECT_ID)] });
  });
  await execAndRecord(client, keypair, "pool::unfreeze_pool", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::unfreeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  });

  // ---- wait for epoch to advance so deposits mature + withdraw VK timelock applies ----
  const maxDepositEpoch = depositEpochs.reduce((a, b) => (b > a ? b : a));
  step(`Waiting for epoch > ${maxDepositEpoch} (commitment maturity + VK timelock)`);
  await waitForEpoch(client, maxDepositEpoch);

  // ---- generate real proofs ----
  step("Generating real Groth16 proofs (transfer, withdraw, compliance x2)");
  const transferProof = await proveCircuit("transfer", stringifyInputs(transferWitness));
  const withdrawProof = await proveCircuit("withdraw", stringifyInputs(withdrawWitness));
  const complianceProof = await proveCircuit("compliance", stringifyInputs(complianceWitness));
  const transferProof2 = await proveCircuit("transfer", stringifyInputs(transferWitness2));

  // ---- shielded_transfer ----
  step("shielded_transfer");
  await execAndRecord(client, keypair, "pool::shielded_transfer", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::shielded_transfer`,
      arguments: [
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(proofToSuiBytes(transferProof.proof))),
        tx.pure.vector("u8", Array.from(publicInputsToSuiBytes(transferProof.publicSignals))),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  });

  // ---- zk_withdraw ----
  step("zk_withdraw");
  await execAndRecord(client, keypair, "pool::zk_withdraw", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::zk_withdraw`,
      arguments: [
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(proofToSuiBytes(withdrawProof.proof))),
        tx.pure.vector("u8", Array.from(publicInputsToSuiBytes(withdrawProof.publicSignals))),
        tx.pure.address(address),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  });

  // ---- compliant_transfer (dual-proof) ----
  step("compliance::compliant_transfer (dual Groth16 verify)");
  const encryptedAmount = new Uint8Array(93);
  encryptedAmount.fill(9);
  await execAndRecord(client, keypair, "compliance::compliant_transfer", (tx) => {
    tx.moveCall({
      target: `${packageId}::compliance::compliant_transfer`,
      arguments: [
        tx.object(poolId),
        tx.object(configId),
        tx.pure.vector("u8", Array.from(proofToSuiBytes(transferProof2.proof))),
        tx.pure.vector("u8", Array.from(publicInputsToSuiBytes(transferProof2.publicSignals))),
        tx.pure.vector("u8", Array.from(proofToSuiBytes(complianceProof.proof))),
        tx.pure.vector("u8", Array.from(publicInputsToSuiBytes(complianceProof.publicSignals))),
        tx.pure.vector("u8", Array.from(encryptedAmount)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  });

  // ---- summary ----
  step("Summary");
  console.log("\nEntry point | net MIST | computation | storage | rebate");
  console.log("---|---|---|---|---");
  for (const r of rows) {
    console.log(
      `${r.entryPoint} | ${r.netMist} | ${r.gasUsed.computationCost} | ${r.gasUsed.storageCost} | ${r.gasUsed.storageRebate}`,
    );
  }

  const outPath = join(__dirname, "gas-bench-results.json");
  writeFileSync(outPath, JSON.stringify({ packageId, poolId, configId, rows: rows.map((r) => ({ ...r, netMist: r.netMist.toString() })) }, null, 2));
  console.log(`\nRaw results written to ${outPath}`);
}

main().catch((err) => {
  console.error("\n[FATAL] gas-bench failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
