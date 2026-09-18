#!/usr/bin/env node
/**
 * onchain-gas.mjs — Real on-chain gas measurement for every Veil Move entry point.
 *
 * Deploys the Move package to a *local* Sui network (sui start --force-regenesis
 * --with-faucet) and drives every entry point with real Groth16 proofs (built from
 * circuits/build{,-withdraw,-compliance}/), capturing Sui's own transaction-effects
 * gasUsed for each call. No estimates: every row in the output table comes from a
 * transaction that actually executed on a real (local) Sui network.
 *
 * A LOCAL network is used (not testnet) because outbound access to
 * fullnode.testnet.sui.io is blocked by this environment's egress policy. The gas
 * schedule (computation/storage cost tables) is protocol-defined, not network-specific,
 * so a local network started from the matching `sui` binary produces the same numbers
 * testnet would — see the paired research report for the full story, including why a
 * GitHub *release* download worked when the raw JSON-RPC/API hosts didn't.
 *
 * Epoch handling: pool.move's `pool_epoch` is `clock.timestamp_ms() / epoch_duration_ms`
 * — an absolute value, not "epochs since pool creation". witnesses.mjs's fixed
 * epochId/currentEpoch placeholders (1n / 500n) are fine for isolated circuit-proving
 * benchmarks but would never match a real on-chain epoch, so this script queries the
 * live clock and rebuilds the transfer/compliance witnesses' epoch-dependent fields
 * (nullifier, compliance contextId + nullifier) right before submitting — see
 * `buildTransferWitnessAtEpoch` / `buildComplianceWitnessAtEpoch` below.
 *
 * Prerequisites:
 *   1. `sui` CLI on PATH, matching the protocol version pinned by contracts/Move.toml's
 *      `rev` (if `sui move build` reports a parser error in the framework source,
 *      that's a version mismatch — download the matching
 *      sui-testnet-vX.Y.Z-ubuntu-x86_64.tgz release asset from
 *      https://github.com/MystenLabs/sui/releases).
 *   2. A local network running and funded:
 *        sui start --force-regenesis --with-faucet &
 *        sui client new-env --alias local --rpc http://127.0.0.1:9000   # first time only
 *        sui client switch --env local
 *        sui client faucet
 *   3. Circuits compiled (circom + snarkjs) — see circuits/scripts/compile*.sh. If
 *      storage.googleapis.com (the pot15 host) is also blocked, generate Powers of Tau
 *      locally instead (fully offline, dev-only — same trust model as the single-
 *      contributor `compile.sh` path, just no download):
 *        cd circuits && npx snarkjs powersoftau new bn128 15 build/pot15_0000.ptau -v
 *        npx snarkjs powersoftau contribute build/pot15_0000.ptau build/pot15_0001.ptau -v
 *        npx snarkjs powersoftau prepare phase2 build/pot15_0001.ptau build/pot15_final.ptau -v
 *        (then groth16 setup / zkey contribute / export verificationkey per circuit —
 *         same commands compile.sh runs once the ptau file exists)
 *
 * Usage: node scripts/bench/onchain-gas.mjs
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes, bigintToLE32 } from "./proof-format.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CONTRACTS_DIR = join(ROOT, "contracts");
const CIRCUITS_DIR = join(ROOT, "circuits");
const RPC_URL = process.env.VEIL_LOCAL_RPC ?? "http://127.0.0.1:9000";
const CLOCK_ID = "0x6";
const GAS_BUDGET = 500_000_000;
const EPOCH_DURATION_MS = 60_000; // minimum allowed by pool::create_pool (E_INVALID_EPOCH_DURATION)
const MERKLE_DEPTH = 20;

// Domain tags — must match circuits/*.circom and scripts/bench/witnesses.mjs exactly.
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;

const results = [];

function log(msg) {
  console.log(msg);
}

function record(entryPoint, label, effects, extra = {}) {
  const g = effects.gasUsed;
  const net = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
  const row = {
    entryPoint,
    label,
    computationCost: g.computationCost,
    storageCost: g.storageCost,
    storageRebate: g.storageRebate,
    nonRefundableStorageFee: g.nonRefundableStorageFee,
    netCostMist: net.toString(),
    status: effects.status?.status,
    ...extra,
  };
  results.push(row);
  log(
    `  [gas] ${entryPoint} (${label}): net ${net} MIST ` +
      `(computation ${g.computationCost}, storage ${g.storageCost}, rebate ${g.storageRebate})`,
  );
  return row;
}

// ---------------------------------------------------------------------------
// Witness construction — mirrors scripts/bench/witnesses.mjs formulas, but with
// epochId / currentEpoch as real parameters instead of fixed placeholders (see
// module docstring for why that matters for an actual on-chain submission).
// ---------------------------------------------------------------------------

function toBI(F, val) {
  return val instanceof Uint8Array ? F.toObject(val) : BigInt(val);
}

function merkleRootFromZeroPath(poseidon, F, leaf, depth) {
  let node = leaf;
  for (let i = 0; i < depth; i++) node = toBI(F, poseidon([node, 0n]));
  return node;
}

function buildTransferWitnessAtEpoch(poseidon, F, epochId) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(F, poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromZeroPath(poseidon, F, oldCommitment, MERKLE_DEPTH);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

function buildWithdrawWitness(poseidon, F) {
  // No epoch dependency: zk_withdraw only checks UTXO existence + nullifier-spent, not epoch.
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(F, poseidon([DOMAIN_RECIPIENT_HASH, recipient]));
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

function buildComplianceWitnessAtEpoch(poseidon, F, currentEpoch, transferNullifier) {
  const userSecret = 555444333n, kycLevel = 2n, expiryEpoch = 10_000_000_000n, issuerId = 42n;
  const requiredKycLevel = 1n;
  const credentialLeaf = toBI(F, poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = toBI(F, poseidon([current, 0n]));
  }
  const merkleRoot = current;
  const contextId = toBI(F, poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}

async function proveAndConvert(circuitName, dir, raw) {
  const inputs = stringifyInputs(raw);
  const wasmPath = join(CIRCUITS_DIR, dir, `${circuitName}_js`, `${circuitName}.wasm`);
  const zkeyPath = join(CIRCUITS_DIR, dir, `${circuitName}_final.zkey`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
  const vk = JSON.parse(readFileSync(join(CIRCUITS_DIR, dir, `${circuitName}_vk.json`), "utf-8"));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error(`${circuitName}: locally-generated proof failed local verification`);
  return {
    raw,
    proofBytes: proofToSuiBytes(proof),
    publicInputsBytes: publicInputsToSuiBytes(publicSignals),
    vkBytes: vkToSuiBytes(vk),
  };
}

// ---------------------------------------------------------------------------
// CLI / SDK plumbing
// ---------------------------------------------------------------------------

function suiJson(cmd) {
  const out = execSync(cmd, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, cwd: CONTRACTS_DIR });
  const start = out.indexOf("{");
  if (start === -1) throw new Error(`No JSON in output of: ${cmd}\n${out.slice(0, 2000)}`);
  return JSON.parse(out.slice(start));
}

function publishPackage() {
  log("\n=== Publishing veil package to local network (sui client test-publish) ===");
  // A plain `sui client publish` refuses to run against an env alias the package's
  // Move.lock doesn't pin (Move.toml only pins `testnet`) — see the paired report.
  // `test-publish --build-env testnet` builds against testnet's pinned dependency
  // addresses but executes for real on whatever network the CLI is currently pointed
  // at (our local one), which is exactly what we want. Each run gets its own
  // ephemeral pubfile (--pubfile-path) so re-running this script never collides with
  // a previous run's "already published for this chain-id" record — test-publish's
  // default pubfile (contracts/Pub.local.toml) is per-package, not per-run.
  const pubfile = join(CONTRACTS_DIR, `.onchain-gas-pub-${Date.now()}.toml`);
  const result = suiJson(
    `sui client test-publish --build-env testnet --pubfile-path ${pubfile} --gas-budget ${GAS_BUDGET} --json`,
  );
  if (result.effects?.status?.status !== "success") {
    throw new Error(`Publish failed: ${JSON.stringify(result.effects?.status)}`);
  }
  const changes = result.objectChanges ?? [];
  const published = changes.find((c) => c.type === "published");
  const treasuryCap = changes.find(
    (c) => c.type === "created" && c.objectType?.includes("::coin::TreasuryCap"),
  );
  record("publish", "package publish", result.effects);
  try {
    rmSync(pubfile);
  } catch {}
  return { packageId: published.packageId, treasuryCapId: treasuryCap.objectId };
}

function loadKeypair() {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const keystore = JSON.parse(readFileSync(keystorePath, "utf-8"));
  for (const key of keystore) {
    const raw = fromBase64(key);
    if (raw[0] !== 0) continue;
    try {
      const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
      if (kp.toSuiAddress() === activeAddress) return { kp, address: activeAddress };
    } catch {}
  }
  throw new Error(`No Ed25519 key found matching active address ${activeAddress}`);
}

async function call(client, keypair, label, entryPoint, build, extra = {}) {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (result.effects?.status?.status !== "success") {
    throw new Error(`${entryPoint} (${label}) failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await client.waitForTransaction({ digest: result.digest });
  record(entryPoint, label, result.effects, extra);
  return result;
}

async function getCurrentEpoch(client) {
  const obj = await client.getObject({ id: CLOCK_ID, options: { showContent: true } });
  const timestampMs = BigInt(obj.data.content.fields.timestamp_ms);
  return timestampMs / BigInt(EPOCH_DURATION_MS);
}

async function sleepPastEpochBoundary() {
  const s = EPOCH_DURATION_MS / 1000 + 5;
  log(`  [wait] sleeping ${s}s for pool epoch to roll over (timelocked updates apply lazily)...`);
  await new Promise((r) => setTimeout(r, s * 1000));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const { kp: keypair, address } = loadKeypair();
  log(`Active address: ${address}`);
  log(`RPC: ${RPC_URL}`);

  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
  const chainId = await client.getChainIdentifier();
  log(`Chain identifier: ${chainId}`);

  // Epoch-independent witness material, needed up front for deposits / VK setup.
  // (epochId/currentEpoch/nullifier/contextId are placeholders here — resolved for
  // real in Phase C, right before the proof-gated calls.)
  const transferBase = buildTransferWitnessAtEpoch(poseidon, F, 0n);
  const withdrawFull = buildWithdrawWitness(poseidon, F); // fully epoch-independent
  const complianceBase = buildComplianceWitnessAtEpoch(poseidon, F, 0n, 0n);

  log("\n=== Generating withdraw proof (epoch-independent, safe to build now) ===");
  const withdrawProof = await proveAndConvert("withdraw", "build-withdraw", withdrawFull);

  // ── Publish ────────────────────────────────────────────────────────────
  const { packageId, treasuryCapId } = publishPackage();
  log(`Package: ${packageId}`);

  // ── We need transfer_vk / compliance_vk bytes before any proof exists — export
  //    them straight from the zkey-derived vk.json (vk bytes don't depend on epoch
  //    or on any specific proof). ─────────────────────────────────────────
  const transferVk = JSON.parse(readFileSync(join(CIRCUITS_DIR, "build", "transfer_vk.json"), "utf-8"));
  const transferVkBytes = vkToSuiBytes(transferVk);
  const complianceVk = JSON.parse(readFileSync(join(CIRCUITS_DIR, "build-compliance", "compliance_vk.json"), "utf-8"));
  const complianceVkBytes = vkToSuiBytes(complianceVk);

  // ── Pool #1: transfer + withdraw ──────────────────────────────────────
  log("\n=== create_pool (transfer_vk) ===");
  const poolResult = await call(client, keypair, "create_pool", "create_pool", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [
        tx.pure.vector("u8", Array.from(transferVkBytes)),
        tx.pure.u64(transferBase.threshold),
        tx.pure.u64(EPOCH_DURATION_MS),
      ],
    });
  });
  const poolId = poolResult.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::pool::Pool"),
  ).objectId;
  const adminCapId = poolResult.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::pool::AdminCap"),
  ).objectId;
  log(`Pool: ${poolId}  AdminCap: ${adminCapId}`);

  async function mintCoin(label) {
    const result = await call(client, keypair, label, "token_faucet::faucet", (tx) => {
      tx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [tx.object(treasuryCapId)] });
    });
    return result.objectChanges.find(
      (c) => c.type === "created" && c.objectType?.includes("::token::TOKEN"),
    ).objectId;
  }

  log("\n=== token_faucet::faucet (mint x3: transfer genesis, withdraw UTXO, pool #2 genesis) ===");
  const coinForTransfer = await mintCoin("faucet mint (transfer genesis)");
  const coinForWithdraw = await mintCoin("faucet mint (withdraw UTXO)");
  const coinForPool2 = await mintCoin("faucet mint (pool #2 genesis)");

  log("\n=== deposit_and_register (transfer genesis commitment) ===");
  const transferGenesisBytes = bigintToLE32(transferBase.oldCommitment);
  await call(client, keypair, "deposit (transfer genesis)", "deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [
        tx.object(poolId),
        tx.object(coinForTransfer),
        tx.pure.vector("u8", Array.from(transferGenesisBytes)),
        tx.object(CLOCK_ID),
      ],
    });
  });

  log("\n=== deposit_and_register (withdraw UTXO commitment) ===");
  const withdrawCommitmentBytes = bigintToLE32(withdrawProof.raw.commitment);
  await call(client, keypair, "deposit (withdraw UTXO)", "deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [
        tx.object(poolId),
        tx.object(coinForWithdraw),
        tx.pure.vector("u8", Array.from(withdrawCommitmentBytes)),
        tx.object(CLOCK_ID),
      ],
    });
  });

  // Real Merkle root over the transfer genesis leaf (zk_withdraw doesn't check
  // commitment_root — only shielded_transfer / compliant_transfer do).
  const rootBytes = bigintToLE32(transferBase.merkleRoot);
  log("\n=== update_commitment_root + propose_withdraw_vk (both timelocked 1 epoch) ===");
  await call(client, keypair, "update_commitment_root", "update_commitment_root", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(rootBytes)), tx.object(CLOCK_ID)],
    });
  });
  await call(client, keypair, "propose_withdraw_vk", "propose_withdraw_vk", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdraw_vk`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(withdrawProof.vkBytes)), tx.object(CLOCK_ID)],
    });
  });

  // ── Pool #2 setup (compliant_transfer), proposed in the same epoch window ────
  log("\n=== Pool #2: create_pool + create_compliance_config + genesis deposit ===");
  const pool2Result = await call(client, keypair, "create_pool #2", "create_pool", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [
        tx.pure.vector("u8", Array.from(transferVkBytes)),
        tx.pure.u64(transferBase.threshold),
        tx.pure.u64(EPOCH_DURATION_MS),
      ],
    });
  });
  const pool2Id = pool2Result.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::pool::Pool"),
  ).objectId;
  const adminCap2Id = pool2Result.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::pool::AdminCap"),
  ).objectId;

  const credentialRootBytes = bigintToLE32(complianceBase.merkleRoot);
  const auditorKey = new Uint8Array(33).fill(7); // dummy 33-byte compressed-pubkey-shaped placeholder
  const configResult = await call(client, keypair, "create_compliance_config", "create_compliance_config", (tx) => {
    tx.moveCall({
      target: `${packageId}::compliance::create_compliance_config`,
      arguments: [
        tx.object(adminCap2Id),
        tx.object(pool2Id),
        tx.pure.vector("u8", Array.from(complianceVkBytes)),
        tx.pure.vector("u8", Array.from(credentialRootBytes)),
        tx.pure.u64(complianceBase.requiredKycLevel),
        tx.pure.vector("u8", Array.from(auditorKey)),
      ],
    });
  });
  const configId = configResult.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.includes("::compliance::ComplianceConfig"),
  ).objectId;

  const pool2GenesisBytes = bigintToLE32(transferBase.oldCommitment);
  await call(client, keypair, "deposit (pool #2 genesis)", "deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(pool2Id), tx.object(coinForPool2), tx.pure.vector("u8", Array.from(pool2GenesisBytes)), tx.object(CLOCK_ID)],
    });
  });
  await call(client, keypair, "update_commitment_root #2", "update_commitment_root", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(pool2Id), tx.object(adminCap2Id), tx.pure.vector("u8", Array.from(rootBytes)), tx.object(CLOCK_ID)],
    });
  });
  await call(client, keypair, "propose_compliance_toggle", "propose_compliance_toggle", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_compliance_toggle`,
      arguments: [tx.object(pool2Id), tx.object(adminCap2Id), tx.pure.bool(true), tx.object(CLOCK_ID)],
    });
  });

  // ── Wait for both pools' 1-epoch timelocks to roll over ──────────────────
  await sleepPastEpochBoundary();

  // ── Phase C: resolve the REAL on-chain epoch, rebuild the epoch-dependent
  //    witness fields, generate the transfer + compliance proofs now ───────
  const liveEpoch = await getCurrentEpoch(client);
  log(`\n=== Live on-chain epoch: ${liveEpoch} — generating epoch-correct proofs ===`);
  const transferFinal = buildTransferWitnessAtEpoch(poseidon, F, liveEpoch);
  const transferProof = await proveAndConvert("transfer", "build", transferFinal);
  const complianceFinal = buildComplianceWitnessAtEpoch(poseidon, F, liveEpoch, transferFinal.nullifier);
  const complianceProof = await proveAndConvert("compliance", "build-compliance", complianceFinal);

  // ── shielded_transfer (pool #1) — real Groth16 verification on-chain ─────
  log("\n=== shielded_transfer (real Groth16 verification on-chain) ===");
  await call(
    client, keypair, "shielded_transfer", "shielded_transfer",
    (tx) => {
      tx.moveCall({
        target: `${packageId}::pool::shielded_transfer`,
        arguments: [
          tx.object(poolId),
          tx.pure.vector("u8", Array.from(transferProof.proofBytes)),
          tx.pure.vector("u8", Array.from(transferProof.publicInputsBytes)),
          tx.object(CLOCK_ID),
        ],
      });
    },
    { proofBytes: transferProof.proofBytes.length, publicInputsBytes: transferProof.publicInputsBytes.length },
  );

  // ── zk_withdraw (pool #1) — real Groth16 verification on-chain ───────────
  log("\n=== zk_withdraw (real Groth16 verification on-chain) ===");
  const recipient = "0x" + (0xABCDEF123456n).toString(16).padStart(64, "0");
  await call(
    client, keypair, "zk_withdraw", "zk_withdraw",
    (tx) => {
      tx.moveCall({
        target: `${packageId}::pool::zk_withdraw`,
        arguments: [
          tx.object(poolId),
          tx.pure.vector("u8", Array.from(withdrawProof.proofBytes)),
          tx.pure.vector("u8", Array.from(withdrawProof.publicInputsBytes)),
          tx.pure.address(recipient),
          tx.object(CLOCK_ID),
        ],
      });
    },
    { proofBytes: withdrawProof.proofBytes.length, publicInputsBytes: withdrawProof.publicInputsBytes.length },
  );

  // ── Admin ops (cheap, no proof) ───────────────────────────────────────────
  log("\n=== Admin ops (freeze / unfreeze / propose_withdrawal) ===");
  await call(client, keypair, "freeze_pool", "freeze_pool", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::freeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId), tx.object(CLOCK_ID)] });
  });
  await call(client, keypair, "unfreeze_pool", "unfreeze_pool", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::unfreeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  });
  await call(client, keypair, "propose_withdrawal", "propose_withdrawal", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdrawal`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.u64(1000), tx.pure.address(address), tx.object(CLOCK_ID)],
    });
  });

  // ── compliant_transfer (pool #2) — two real Groth16 verifications, one call ──
  log("\n=== compliant_transfer (transfer proof + compliance proof, both verified on-chain) ===");
  const encryptedAmount = new Uint8Array(93).fill(9); // dummy ciphertext; only length is enforced on-chain
  await call(
    client, keypair, "compliant_transfer", "compliant_transfer",
    (tx) => {
      tx.moveCall({
        target: `${packageId}::compliance::compliant_transfer`,
        arguments: [
          tx.object(pool2Id),
          tx.object(configId),
          tx.pure.vector("u8", Array.from(transferProof.proofBytes)),
          tx.pure.vector("u8", Array.from(transferProof.publicInputsBytes)),
          tx.pure.vector("u8", Array.from(complianceProof.proofBytes)),
          tx.pure.vector("u8", Array.from(complianceProof.publicInputsBytes)),
          tx.pure.vector("u8", Array.from(encryptedAmount)),
          tx.object(CLOCK_ID),
        ],
      });
    },
    {
      transferProofBytes: transferProof.proofBytes.length,
      complianceProofBytes: complianceProof.proofBytes.length,
    },
  );

  // ── Summary ────────────────────────────────────────────────────────────
  log("\n=== Summary (JSON) ===");
  const out = JSON.stringify(results, null, 2);
  console.log(out);
  writeFileSync(join(__dirname, "onchain-gas-results.json"), out);
  log(`\nWrote ${join(__dirname, "onchain-gas-results.json")}`);
}

main().catch((err) => {
  console.error("\n[FATAL] onchain-gas benchmark failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
