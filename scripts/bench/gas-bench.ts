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
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
  bigintToLE32,
} from "../src/proof-converter.js";
import type { SnarkjsProof, SnarkjsVK } from "../src/proof-converter.js";

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
const TRANSFER_THRESHOLD = 1_000_000_000n; // must match witnesses.mjs buildTransferWitness's hardcoded `threshold` exactly
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
// Proof generation — shelled out to plain Node (see generate-proofs.mjs header for why: Bun's
// spec-strict EventTarget crashes on snarkjs's Node worker-thread path).
// ---------------------------------------------------------------------------

interface GeneratedProofs {
  genesisCommitments: { transfer: string; withdraw: string; compliant_transfer: string };
  transferMerkleRoot: string;
  transfer2MerkleRoot: string;
  complianceCredentialRoot: string;
  proofs: {
    transfer: { proof: SnarkjsProof; publicSignals: string[] };
    withdraw: { proof: SnarkjsProof; publicSignals: string[] };
    compliance: { proof: SnarkjsProof; publicSignals: string[] };
    transfer2: { proof: SnarkjsProof; publicSignals: string[] };
  };
}

function generateProofsViaNode(epoch: bigint): GeneratedProofs {
  const scriptPath = join(__dirname, "generate-proofs.mjs");
  const output = execSync(`node ${scriptPath} ${epoch}`, { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(output.trim().split("\n").pop()!);
}

function loadVk(circuit: keyof typeof CIRCUITS): SnarkjsVK {
  const { dir, name } = CIRCUITS[circuit];
  return JSON.parse(readFileSync(join(CIRCUITS_DIR, dir, `${name}_vk.json`), "utf-8"));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Deploy (localnet-specific: `sui client publish` requires Move.toml to declare a matching
// [environments] entry, which contracts/Move.toml doesn't for an ad-hoc localnet. `test-publish`
// is the CLI's documented ephemeral-address path for exactly this case.)
// ---------------------------------------------------------------------------

function deployContractLocal(projectRoot: string, gasBudget: number): { packageId: string; treasuryCapId: string } {
  const contractsDir = join(projectRoot, "contracts");
  const pubfile = join(projectRoot, "scripts", "bench", ".local-pubfile.toml");
  console.log(`[deploy] test-publish from ${contractsDir} (ephemeral local addresses, gas budget ${gasBudget})...`);

  let output: string;
  try {
    output = execSync(
      `sui client test-publish --build-env local --gas-budget ${gasBudget} --pubfile-path ${pubfile} --json`,
      { cwd: contractsDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    const combined = (execErr.stdout ?? "") + (execErr.stderr ?? "");
    if (combined.includes('"objectChanges"') || combined.includes('"effects"')) {
      output = combined;
    } else {
      throw new Error(`[deploy] test-publish failed (exit ${execErr.status}): ${combined.slice(0, 1000)}`);
    }
  }

  const jsonStart = output.indexOf("{");
  const result = JSON.parse(output.slice(jsonStart));
  const status = result.effects?.status?.status;
  if (status !== "success") {
    throw new Error(`[deploy] Transaction failed: ${JSON.stringify(result.effects?.status)}`);
  }

  const changes = result.objectChanges ?? [];
  const published = changes.find((c: any) => c.type === "published");
  const treasuryCapChange = changes.find(
    (c: any) => c.type === "created" && c.objectType?.includes("::coin::TreasuryCap"),
  );
  if (!published?.packageId) throw new Error("[deploy] No published package found in objectChanges");
  if (!treasuryCapChange?.objectId) throw new Error("[deploy] No TreasuryCap found in objectChanges");

  console.log(`[deploy] Package published: ${published.packageId}`);
  return { packageId: published.packageId, treasuryCapId: treasuryCapChange.objectId };
}

async function currentEpoch(client: SuiJsonRpcClient): Promise<bigint> {
  const clockObj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
  const timestampMs = BigInt((clockObj.data?.content as any).fields.timestamp_ms);
  return timestampMs / BigInt(EPOCH_DURATION_MS);
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

  // ---- Genesis commitments + compliance credential root (epoch-independent, see
  // generate-proofs.mjs) computed now so deposits/config creation can happen before we know the
  // exact on-chain epoch the submitted proofs will need to target. ----
  step("Computing genesis commitments + credential root via Node subprocess");
  const early = generateProofsViaNode(0n);
  info(`genesis commitments: transfer=${early.genesisCommitments.transfer.slice(0, 12)}... withdraw=${early.genesisCommitments.withdraw.slice(0, 12)}... compliant_transfer=${early.genesisCommitments.compliant_transfer.slice(0, 12)}...`);

  const vkBytes = {
    transfer: vkToSuiBytes(loadVk("transfer")),
    withdraw: vkToSuiBytes(loadVk("withdraw")),
    compliance: vkToSuiBytes(loadVk("compliance")),
  };

  // ---- Deploy ----
  step("Deploy package");
  const deployResult = deployContractLocal(PROJECT_ROOT, GAS_BUDGET);
  const packageId = deployResult.packageId;
  const treasuryCapId = deployResult.treasuryCapId;
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

  // ---- update_commitment_root (admin op, timelocked): pool.commitment_root starts all-zero;
  // shielded_transfer checks the transfer proof's Merkle root against it, so it must be switched
  // to match transferWitness's single-leaf root before shielded_transfer can succeed. ----
  step("update_commitment_root -> transfer witness root (admin op)");
  await execAndRecord(client, keypair, "pool::update_commitment_root", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [
        tx.object(poolId),
        tx.object(adminCapId),
        tx.pure.vector("u8", Array.from(bigintToLE32(BigInt(early.transferMerkleRoot)))),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  });

  // ---- create_compliance_config (admin op) ----
  step("create_compliance_config (admin op)");
  const credentialRoot = bigintToLE32(BigInt(early.complianceCredentialRoot));
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
    ["transfer", bigintToLE32(BigInt(early.genesisCommitments.transfer))],
    ["withdraw", bigintToLE32(BigInt(early.genesisCommitments.withdraw))],
    ["compliant_transfer", bigintToLE32(BigInt(early.genesisCommitments.compliant_transfer))],
  ];

  let currentCoinId = coinId;
  const depositEpochs: bigint[] = [];
  for (const [label, commitment] of genesisCommitments) {
    step(`deposit_and_register (${label} genesis commitment)`);
    depositEpochs.push(await currentEpoch(client));

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

  // ---- ROUND 1: shielded_transfer + zk_withdraw. Generate proofs pinned to the actual deposit
  // epoch (pool.move's epoch check needs proof_epoch == on_chain_epoch OR on_chain_epoch - 1;
  // pinning to the deposit epoch and then waiting for on-chain epoch to advance past it satisfies
  // that check, commitment maturity, the withdraw-VK timelock, and the commitment-root timelock
  // all in the same wait, since all four were proposed/deposited in this same epoch window) ----
  const maxDepositEpoch = depositEpochs.reduce((a, b) => (b > a ? b : a));
  step(`Generating round-1 Groth16 proofs pinned to epoch ${maxDepositEpoch} via Node subprocess`);
  const round1 = generateProofsViaNode(maxDepositEpoch);
  const transferProof = round1.proofs.transfer;
  const withdrawProof = round1.proofs.withdraw;

  step(`Waiting for epoch > ${maxDepositEpoch} (commitment maturity + VK timelock + commitment-root timelock + proof epoch grace window)`);
  await waitForEpoch(client, maxDepositEpoch);

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

  // ---- ROUND 2: compliant_transfer. Needs pool.commitment_root switched to transferWitness2's
  // root (a different genesis commitment than round 1's), which is itself timelocked -- so this
  // is its own propose -> wait -> submit cycle, with fresh proofs pinned to the new epoch. ----
  step("update_commitment_root -> compliant_transfer witness root (admin op)");
  const round2StartEpoch = await currentEpoch(client);
  await execAndRecord(client, keypair, "pool::update_commitment_root (round 2)", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [
        tx.object(poolId),
        tx.object(adminCapId),
        tx.pure.vector("u8", Array.from(bigintToLE32(BigInt(early.transfer2MerkleRoot)))),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  });

  step(`Generating round-2 Groth16 proofs pinned to epoch ${round2StartEpoch} via Node subprocess`);
  const round2 = generateProofsViaNode(round2StartEpoch);
  const complianceProof = round2.proofs.compliance;
  const transferProof2 = round2.proofs.transfer2;

  step(`Waiting for epoch > ${round2StartEpoch} (round-2 commitment-root timelock + proof epoch grace window)`);
  await waitForEpoch(client, round2StartEpoch);

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
