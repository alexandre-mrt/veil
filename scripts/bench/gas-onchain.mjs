#!/usr/bin/env node
/**
 * gas-onchain.mjs — Real on-chain gas benchmark for every Veil Move entry point.
 *
 * Publishes the actual `contracts/` package (real compiled transfer/withdraw/compliance
 * verifying keys, not dummy VKs) to a local Sui network, drives real Groth16 proofs through
 * shielded_transfer / zk_withdraw / compliant_transfer, and reads the real gas summary
 * (computationCost, storageCost, storageRebate, nonRefundableStorageFee) off each
 * transaction's effects. No number here is estimated — every row is the JSON gasUsed
 * object from an actually-executed transaction, printed verbatim.
 *
 * Prerequisites:
 *   - A `sui` CLI on PATH whose bundled Move compiler matches contracts/Move.toml's pinned
 *     framework revision (see docs/research/2026-08-02-onchain-gas-baseline.md — as of that
 *     report, mainnet-v1.76.1 was the working release; testnet-v1.40.1 and testnet-v1.59.1
 *     both failed to compile the pinned framework rev).
 *   - A local Sui network + faucet running and the active `sui client` env funded:
 *       sui start --force-regenesis --with-faucet &
 *       sui client envs   # confirms an env pointing at http://127.0.0.1:9000
 *       curl -X POST -d '{"FixedAmountRequest":{"recipient":"<active-address>"}}' \
 *            http://127.0.0.1:9123/gas
 *   - Compiled circuits with a real trusted setup in circuits/build{,-withdraw,-compliance}/:
 *       cd circuits && bash scripts/compile.sh && bash scripts/compile-withdraw.sh \
 *         && bash scripts/compile-compliance.sh
 *   - `bun install` run once in scripts/ (for @mysten/sui, snarkjs, circomlibjs) — this script
 *     resolves them via scripts/node_modules, but MUST be run with plain `node`, not `bun`:
 *     snarkjs's worker-thread proving crashes Bun's web-worker shim in this environment.
 *
 * Usage:
 *   node --experimental-vm-modules scripts/bench/gas-onchain.mjs
 *
 * Output: prints a gas table to stdout and writes JSON results to
 *   scripts/bench/gas-onchain-results.json
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

import { setPoseidonField, buildWithdrawWitness } from "./witnesses.mjs";

const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;

/**
 * Compliance witness with a live currentEpoch. Mirrors buildComplianceWitness() in
 * witnesses.mjs exactly, but takes currentEpoch as a real on-chain value (huge, real-time
 * derived) instead of the offline placeholder (500n) and re-derives every value that chains
 * off it (expiryEpoch, credentialLeaf, merkleRoot) — a shallow override of just `currentEpoch`
 * desyncs the Merkle leaf from the root and trips C1/C2 in compliance.circom.
 */
function buildLiveComplianceWitness(poseidon, currentEpoch) {
  const userSecret = 987654321n,
    kycLevel = 2n,
    issuerId = 42n,
    requiredKycLevel = 1n,
    transferNullifier = 111222333n;
  const expiryEpoch = currentEpoch + 1000n; // not-yet-expired relative to the live epoch
  const credentialLeaf = BigInt(
    poseidon.F.toString(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId])),
  );
  const MERKLE_DEPTH = 20;
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = BigInt(poseidon.F.toString(poseidon([current, 0n])));
  }
  const merkleRoot = current;
  const contextId = BigInt(poseidon.F.toString(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret])));
  const nullifier = BigInt(poseidon.F.toString(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId])));
  const validCredential = expiryEpoch >= currentEpoch && kycLevel >= requiredKycLevel ? 1n : 0n;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

// Inlined from scripts/src/proof-converter.ts (plain-JS copy so this script runs under
// plain `node`, not just `bun`/`ts-node` — snarkjs's worker-thread proving crashes under
// Bun in this environment; see the toolchain note in the report this script accompanies).
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const Q_HALF = (Q - 1n) / 2n;

function bigintToLE32(n) {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

function compressG1(x, y) {
  const bytes = bigintToLE32(x);
  if (y > Q_HALF) bytes[31] |= 0x80;
  return bytes;
}

function compressG2(x0, x1, y0, y1) {
  const result = new Uint8Array(64);
  result.set(bigintToLE32(x0), 0);
  result.set(bigintToLE32(x1), 32);
  let setSign = false;
  if (y1 > Q_HALF) setSign = true;
  else if (y1 === Q_HALF && y0 > Q_HALF) setSign = true;
  if (setSign) result[63] |= 0x80;
  return result;
}

function proofToSuiBytes(proof) {
  const result = new Uint8Array(128);
  result.set(compressG1(BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])), 0);
  result.set(
    compressG2(BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])),
    32,
  );
  result.set(compressG1(BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])), 96);
  return result;
}

function publicInputsToSuiBytes(signals) {
  const result = new Uint8Array(signals.length * 32);
  for (let i = 0; i < signals.length; i++) {
    result.set(bigintToLE32(BigInt(signals[i])), i * 32);
  }
  return result;
}

function vkToSuiBytes(vk) {
  const parts = [];
  parts.push(compressG1(BigInt(vk.vk_alpha_1[0]), BigInt(vk.vk_alpha_1[1])));
  parts.push(compressG2(BigInt(vk.vk_beta_2[0][0]), BigInt(vk.vk_beta_2[0][1]), BigInt(vk.vk_beta_2[1][0]), BigInt(vk.vk_beta_2[1][1])));
  parts.push(compressG2(BigInt(vk.vk_gamma_2[0][0]), BigInt(vk.vk_gamma_2[0][1]), BigInt(vk.vk_gamma_2[1][0]), BigInt(vk.vk_gamma_2[1][1])));
  parts.push(compressG2(BigInt(vk.vk_delta_2[0][0]), BigInt(vk.vk_delta_2[0][1]), BigInt(vk.vk_delta_2[1][0]), BigInt(vk.vk_delta_2[1][1])));
  const icLen = BigInt(vk.IC.length);
  const lenBytes = new Uint8Array(8);
  let v = icLen;
  for (let i = 0; i < 8; i++) {
    lenBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  parts.push(lenBytes);
  for (const ic of vk.IC) parts.push(compressG1(BigInt(ic[0]), BigInt(ic[1])));
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");
const CONTRACTS_DIR = join(PROJECT_ROOT, "contracts");

const RPC_URL = process.env.VEIL_LOCALNET_RPC || "http://127.0.0.1:9000";
const GAS_BUDGET = 500_000_000;
const SUI_CLOCK_OBJECT_ID = "0x6";
// 5 minutes, not pool::create_pool's 60s minimum: setup here is ~20 sequential transactions
// (each a real network round-trip); at 60s a slow run can spill past an epoch boundary mid-setup
// and desync which epoch a given proposal's 1-epoch timelock resolves against (observed directly:
// execute_pending_withdrawal intermittently aborted with E_WITHDRAWAL_NOT_READY at 60s). 300s
// gives setup a wide margin to stay within one epoch.
const EPOCH_DURATION_MS = 300_000;
const THRESHOLD = 1_000_000_000n;
const DENOM_SMALL = 100_000_000n; // matches pool.move DENOM_SMALL (100 TOKEN, 6 decimals)

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;

function log(msg) {
  console.log(`[gas-onchain] ${msg}`);
}

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// Keypair (reused from scripts/src/e2e-test.ts's loadKeypair pattern)
// ---------------------------------------------------------------------------
function loadKeypair() {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const keystore = JSON.parse(readFileSync(keystorePath, "utf-8"));
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

// ---------------------------------------------------------------------------
// Gas capture
// ---------------------------------------------------------------------------
const results = [];

function recordGas(label, effects) {
  const status = effects?.status?.status;
  const gasUsed = effects?.gasUsed;
  const net =
    gasUsed &&
    BigInt(gasUsed.computationCost) +
      BigInt(gasUsed.storageCost) -
      BigInt(gasUsed.storageRebate);
  const row = { label, status, gasUsed, netMist: net?.toString() };
  results.push(row);
  log(`${label}: status=${status} gasUsed=${JSON.stringify(gasUsed)} net=${net} MIST`);
  if (status !== "success") {
    throw new Error(`${label} failed: ${JSON.stringify(effects?.status)}`);
  }
  return row;
}

async function call(client, keypair, label, build) {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  });
  recordGas(label, result.effects);
  await client.waitForTransaction({ digest: result.digest });
  return result;
}

function findCreated(result, typeSubstr) {
  const c = result.objectChanges?.find(
    (c) => c.type === "created" && "objectType" in c && c.objectType.includes(typeSubstr),
  );
  if (!c) throw new Error(`No created object matching '${typeSubstr}' in objectChanges`);
  return c.objectId;
}

// ---------------------------------------------------------------------------
// Proof generation
// ---------------------------------------------------------------------------
function poseidonHash(poseidon, inputs) {
  return poseidon.F.toString(poseidon(inputs));
}

function toLE32Bytes(bi) {
  const bytes = new Uint8Array(32);
  let v = BigInt(bi);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

/** Transfer witness with a live epochId, all-zero Merkle siblings at index 0 (single-leaf tree). */
function buildLiveTransferWitness(poseidon, epochId, seed) {
  const cumulativeOld = 0n,
    txAmount = 100n,
    randomnessOld = 0n,
    randomnessNew = 12345n + seed,
    userSecret = 987654321n + seed,
    threshold = THRESHOLD,
    salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = BigInt(
    poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]),
  );
  const newCommitment = BigInt(
    poseidonHash(poseidon, [DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]),
  );
  const nullifier = BigInt(
    poseidonHash(poseidon, [DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]),
  );
  const txAmountHash = BigInt(poseidonHash(poseidon, [DOMAIN_TX_AMOUNT, txAmount, salt]));
  const MERKLE_DEPTH = 20;
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  let node = oldCommitment;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    node = BigInt(poseidonHash(poseidon, [node, 0n]));
  }
  const merkleRoot = node;
  return {
    oldCommitment,
    newCommitment,
    threshold,
    epochId,
    nullifier,
    txAmountHash,
    merkleRoot,
    cumulativeOld,
    cumulativeNew,
    txAmount,
    randomnessOld,
    randomnessNew,
    userSecret,
    salt,
    pathElements,
    pathIndices,
  };
}

async function proveTransfer(witness) {
  const input = {
    oldCommitment: witness.oldCommitment.toString(),
    newCommitment: witness.newCommitment.toString(),
    threshold: witness.threshold.toString(),
    epochId: witness.epochId.toString(),
    nullifier: witness.nullifier.toString(),
    txAmountHash: witness.txAmountHash.toString(),
    merkleRoot: witness.merkleRoot.toString(),
    cumulativeOld: witness.cumulativeOld.toString(),
    cumulativeNew: witness.cumulativeNew.toString(),
    txAmount: witness.txAmount.toString(),
    randomnessOld: witness.randomnessOld.toString(),
    randomnessNew: witness.randomnessNew.toString(),
    userSecret: witness.userSecret.toString(),
    salt: witness.salt.toString(),
    pathElements: witness.pathElements.map((x) => x.toString()),
    pathIndices: witness.pathIndices.map((x) => x.toString()),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm"),
    join(CIRCUITS_DIR, "build", "transfer_final.zkey"),
  );
  return { proof, publicSignals };
}

async function proveWithdraw(witness) {
  const input = {
    commitment: witness.commitment.toString(),
    withdrawAmount: witness.withdrawAmount.toString(),
    nullifier: witness.nullifier.toString(),
    recipientHash: witness.recipientHash.toString(),
    newCommitment: witness.newCommitment.toString(),
    cumulativeOld: witness.cumulativeOld.toString(),
    randomnessOld: witness.randomnessOld.toString(),
    userSecret: witness.userSecret.toString(),
    recipient: witness.recipient.toString(),
    randomnessNew: witness.randomnessNew.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm"),
    join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey"),
  );
  return { proof, publicSignals };
}

async function proveCompliance(witness) {
  const input = {
    merkleRoot: witness.merkleRoot.toString(),
    currentEpoch: witness.currentEpoch.toString(),
    contextId: witness.contextId.toString(),
    requiredKycLevel: witness.requiredKycLevel.toString(),
    nullifier: witness.nullifier.toString(),
    validCredential: witness.validCredential.toString(),
    userSecret: witness.userSecret.toString(),
    kycLevel: witness.kycLevel.toString(),
    expiryEpoch: witness.expiryEpoch.toString(),
    issuerId: witness.issuerId.toString(),
    pathElements: witness.pathElements.map((x) => x.toString()),
    pathIndices: witness.pathIndices.map((x) => x.toString()),
    transferNullifier: witness.transferNullifier.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(CIRCUITS_DIR, "build-compliance", "compliance_js", "compliance.wasm"),
    join(CIRCUITS_DIR, "build-compliance", "compliance_final.zkey"),
  );
  return { proof, publicSignals };
}

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------
async function currentEpoch(client) {
  const obj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
  const ms = BigInt(obj.data.content.fields.timestamp_ms);
  return { epoch: ms / BigInt(EPOCH_DURATION_MS), ms };
}

async function sleepUntilNextEpoch(client, fromEpoch) {
  const targetMs = (fromEpoch + 1n) * BigInt(EPOCH_DURATION_MS);
  while (true) {
    const { epoch, ms } = await currentEpoch(client);
    if (epoch > fromEpoch) {
      log(`epoch advanced ${fromEpoch} -> ${epoch} (clock ${ms}ms)`);
      return epoch;
    }
    const remainMs = Number(targetMs - ms) + 3000;
    log(`waiting for epoch ${fromEpoch + 1n} (currently ${epoch}, clock ${ms}ms) — sleeping ${remainMs}ms`);
    await new Promise((r) => setTimeout(r, Math.max(2000, remainMs)));
  }
}

async function mintCoin(client, keypair, packageId, treasuryCapId) {
  const result = await call(client, keypair, "token_faucet::faucet (setup, not counted)", (tx) => {
    tx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [tx.object(treasuryCapId)] });
  });
  results.pop(); // setup call — do not include in the reported gas table
  return findCreated(result, "::token::TOKEN");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  for (const [name, p] of [
    ["transfer wasm", join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm")],
    ["withdraw wasm", join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm")],
    ["compliance wasm", join(CIRCUITS_DIR, "build-compliance", "compliance_js", "compliance.wasm")],
  ]) {
    if (!existsSync(p)) throw new Error(`Missing ${name} at ${p} — run circuits/scripts/compile*.sh first`);
  }

  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  log("Publishing contracts/ package (sui client test-publish)...");
  const pubfilePath = join(__dirname, `.ephemeral-pubfile-${Date.now()}.json`);
  const publishOut = sh(
    `sui client test-publish --build-env testnet --pubfile-path ${pubfilePath} --gas-budget ${GAS_BUDGET} --json`,
    CONTRACTS_DIR,
  );
  const jsonStart = publishOut.indexOf("\n{");
  const publish = JSON.parse(jsonStart >= 0 ? publishOut.slice(jsonStart + 1) : publishOut);
  recordGas("publish (contracts/ package)", publish.effects);
  const packageId = publish.objectChanges.find((c) => c.type === "published").packageId;
  const treasuryCapId = findCreated(publish, "::coin::TreasuryCap");
  log(`packageId=${packageId} treasuryCapId=${treasuryCapId}`);

  const keypair = loadKeypair();
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });

  const transferVkBytes = vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS_DIR, "build", "transfer_vk.json"), "utf-8")));
  const withdrawVkBytes = vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json"), "utf-8")));
  const complianceVkBytes = vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS_DIR, "build-compliance", "compliance_vk.json"), "utf-8")));

  // ---- Pool 1: shielded_transfer + zk_withdraw -----------------------------
  const pool1Publish = await call(client, keypair, "create_pool (pool1: transfer+withdraw)", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [tx.pure.vector("u8", Array.from(transferVkBytes)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_DURATION_MS)],
    });
  });
  const pool1Id = findCreated(pool1Publish, "::pool::Pool");
  const adminCap1Id = findCreated(pool1Publish, "::pool::AdminCap");
  log(`pool1=${pool1Id} adminCap1=${adminCap1Id}`);

  await call(client, keypair, "propose_withdraw_vk", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdraw_vk`,
      arguments: [tx.object(pool1Id), tx.object(adminCap1Id), tx.pure.vector("u8", Array.from(withdrawVkBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  const { epoch: baseEpoch } = await currentEpoch(client);
  const transferWitness = buildLiveTransferWitness(poseidon, baseEpoch, 0n);
  const withdrawWitness = buildWithdrawWitness(poseidon);

  const coinForTransfer = await mintCoin(client, keypair, packageId, treasuryCapId);
  await call(client, keypair, "deposit_and_register (transfer genesis UTXO)", (tx) => {
    const [depositCoin] = tx.splitCoins(tx.object(coinForTransfer), [tx.pure.u64(DENOM_SMALL)]);
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(pool1Id), depositCoin, tx.pure.vector("u8", Array.from(toLE32Bytes(transferWitness.oldCommitment))), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  const coinForWithdraw = await mintCoin(client, keypair, packageId, treasuryCapId);
  await call(client, keypair, "deposit_and_register (withdraw genesis UTXO)", (tx) => {
    const [depositCoin] = tx.splitCoins(tx.object(coinForWithdraw), [tx.pure.u64(DENOM_SMALL)]);
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(pool1Id), depositCoin, tx.pure.vector("u8", Array.from(toLE32Bytes(withdrawWitness.commitment))), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  await call(client, keypair, "update_commitment_root", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(pool1Id), tx.object(adminCap1Id), tx.pure.vector("u8", Array.from(toLE32Bytes(transferWitness.merkleRoot))), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  await call(client, keypair, "propose_vk_update (admin op)", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_vk_update`,
      arguments: [tx.object(pool1Id), tx.object(adminCap1Id), tx.pure.vector("u8", Array.from(transferVkBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  // ---- Pool 2: compliant_transfer ------------------------------------------
  const pool2Publish = await call(client, keypair, "create_pool (pool2: compliance) [reuses same gas as pool1]", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [tx.pure.vector("u8", Array.from(transferVkBytes)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_DURATION_MS)],
    });
  });
  results.pop(); // duplicate of pool1's create_pool — don't double count in the table
  const pool2Id = findCreated(pool2Publish, "::pool::Pool");
  const adminCap2Id = findCreated(pool2Publish, "::pool::AdminCap");

  // currentEpoch is pinned to baseEpoch (known now) rather than fetched after the wait: the
  // compliance proof's expiryEpoch/credentialLeaf/merkleRoot all chain off currentEpoch, and
  // create_compliance_config below needs the resulting merkleRoot *before* the wait. pool.move's
  // grace period (proof_epoch == on_chain_epoch - 1 accepted) covers baseEpoch vs. baseEpoch+1
  // at execution time, the same way it does for transferWitness/transferWitness2 above.
  const complianceWitness = buildLiveComplianceWitness(poseidon, baseEpoch);
  const transferWitness2 = buildLiveTransferWitness(poseidon, baseEpoch, 1n);

  const auditorKey = new Uint8Array(33).fill(0xab);

  const complianceConfigResult = await call(client, keypair, "create_compliance_config", (tx) => {
    tx.moveCall({
      target: `${packageId}::compliance::create_compliance_config`,
      arguments: [
        tx.object(adminCap2Id),
        tx.object(pool2Id),
        tx.pure.vector("u8", Array.from(complianceVkBytes)),
        tx.pure.vector("u8", Array.from(toLE32Bytes(complianceWitness.merkleRoot))),
        tx.pure.u64(1n),
        tx.pure.vector("u8", Array.from(auditorKey)),
      ],
    });
  });
  const configId = findCreated(complianceConfigResult, "::compliance::ComplianceConfig");

  const coinForCompliance = await mintCoin(client, keypair, packageId, treasuryCapId);
  await call(client, keypair, "deposit_and_register (pool2 genesis UTXO) [same cost as pool1's]", (tx) => {
    const [depositCoin] = tx.splitCoins(tx.object(coinForCompliance), [tx.pure.u64(DENOM_SMALL)]);
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(pool2Id), depositCoin, tx.pure.vector("u8", Array.from(toLE32Bytes(transferWitness2.oldCommitment))), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  results.pop();

  await call(client, keypair, "update_commitment_root (pool2) [same cost as pool1's]", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(pool2Id), tx.object(adminCap2Id), tx.pure.vector("u8", Array.from(toLE32Bytes(transferWitness2.merkleRoot))), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  results.pop();

  // ---- Pool 3: freeze/unfreeze/withdrawal-timelock admin ops --------------
  const pool3Publish = await call(client, keypair, "create_pool (pool3: admin ops) [same cost as pool1's]", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [tx.pure.vector("u8", Array.from(transferVkBytes)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_DURATION_MS)],
    });
  });
  results.pop();
  const pool3Id = findCreated(pool3Publish, "::pool::Pool");
  const adminCap3Id = findCreated(pool3Publish, "::pool::AdminCap");

  const coinForPool3 = await mintCoin(client, keypair, packageId, treasuryCapId);
  await call(client, keypair, "deposit_and_register (pool3, funds withdrawal test) [same cost as pool1's]", (tx) => {
    const [depositCoin] = tx.splitCoins(tx.object(coinForPool3), [tx.pure.u64(DENOM_SMALL)]);
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(pool3Id), depositCoin, tx.pure.vector("u8", Array.from(toLE32Bytes(99999n))), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  results.pop();

  const addr = keypair.toSuiAddress();
  await call(client, keypair, "propose_withdrawal (admin op)", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdrawal`,
      arguments: [tx.object(pool3Id), tx.object(adminCap3Id), tx.pure.u64(1_000_000n), tx.pure.address(addr), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  await call(client, keypair, "freeze_pool (admin op)", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::freeze_pool`, arguments: [tx.object(pool3Id), tx.object(adminCap3Id), tx.object(SUI_CLOCK_OBJECT_ID)] });
  });
  await call(client, keypair, "unfreeze_pool (admin op)", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::unfreeze_pool`, arguments: [tx.object(pool3Id), tx.object(adminCap3Id)] });
  });

  // ---- Pool 4: emergency_withdraw (needs to stay frozen through the wait) --
  const pool4Publish = await call(client, keypair, "create_pool (pool4: emergency_withdraw) [same cost as pool1's]", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [tx.pure.vector("u8", Array.from(transferVkBytes)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_DURATION_MS)],
    });
  });
  results.pop();
  const pool4Id = findCreated(pool4Publish, "::pool::Pool");
  const adminCap4Id = findCreated(pool4Publish, "::pool::AdminCap");
  const coinForPool4 = await mintCoin(client, keypair, packageId, treasuryCapId);
  await call(client, keypair, "deposit_and_register (pool4) [same cost as pool1's]", (tx) => {
    const [depositCoin] = tx.splitCoins(tx.object(coinForPool4), [tx.pure.u64(DENOM_SMALL)]);
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(pool4Id), depositCoin, tx.pure.vector("u8", Array.from(toLE32Bytes(88888n))), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  results.pop();
  await call(client, keypair, "freeze_pool (pool4, for emergency_withdraw) [same cost as pool3's]", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::freeze_pool`, arguments: [tx.object(pool4Id), tx.object(adminCap4Id), tx.object(SUI_CLOCK_OBJECT_ID)] });
  });
  results.pop();

  // ---- Wait for the epoch boundary so every 1-epoch timelock above applies -
  log(`All epoch-E setup done. Waiting for epoch > ${baseEpoch}...`);
  await sleepUntilNextEpoch(client, baseEpoch);

  // ---- shielded_transfer -----------------------------------------------
  const { proof: tProof, publicSignals: tSignals } = await proveTransfer(transferWitness);
  const tProofBytes = proofToSuiBytes(tProof);
  const tInputsBytes = publicInputsToSuiBytes(tSignals);
  await call(client, keypair, "shielded_transfer", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::shielded_transfer`,
      arguments: [tx.object(pool1Id), tx.pure.vector("u8", Array.from(tProofBytes)), tx.pure.vector("u8", Array.from(tInputsBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  // ---- zk_withdraw -------------------------------------------------------
  const { proof: wProof, publicSignals: wSignals } = await proveWithdraw(withdrawWitness);
  const wProofBytes = proofToSuiBytes(wProof);
  const wInputsBytes = publicInputsToSuiBytes(wSignals);
  await call(client, keypair, "zk_withdraw", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::zk_withdraw`,
      arguments: [
        tx.object(pool1Id),
        tx.pure.vector("u8", Array.from(wProofBytes)),
        tx.pure.vector("u8", Array.from(wInputsBytes)),
        tx.pure.address(`0x${(0xabcdef123456n).toString(16).padStart(64, "0")}`),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  });

  // ---- compliant_transfer (dual proof) -----------------------------------
  // complianceWitness was already built (pinned to baseEpoch) before the wait, matching the
  // credential_root set in create_compliance_config above — reused as-is here.
  const { proof: cProof, publicSignals: cSignals } = await proveCompliance(complianceWitness);
  const cProofBytes = proofToSuiBytes(cProof);
  const cInputsBytes = publicInputsToSuiBytes(cSignals);

  // epochId is left as baseEpoch (not overridden to epochNow) — overriding it here without
  // recomputing the nullifier hash would desync nullifier from epochId, the same C10 bug fixed
  // above for the compliance witness. pool.move's epoch check has a 1-epoch grace period
  // (proof_epoch == on_chain_epoch - 1 is accepted), which covers baseEpoch vs baseEpoch+1.
  const { proof: t2Proof, publicSignals: t2Signals } = await proveTransfer(transferWitness2);
  const t2ProofBytes = proofToSuiBytes(t2Proof);
  const t2InputsBytes = publicInputsToSuiBytes(t2Signals);

  const encryptedAmount = new Uint8Array(93).fill(0x01);
  await call(client, keypair, "compliant_transfer (dual proof: transfer + compliance)", (tx) => {
    tx.moveCall({
      target: `${packageId}::compliance::compliant_transfer`,
      arguments: [
        tx.object(pool2Id),
        tx.object(configId),
        tx.pure.vector("u8", Array.from(t2ProofBytes)),
        tx.pure.vector("u8", Array.from(t2InputsBytes)),
        tx.pure.vector("u8", Array.from(cProofBytes)),
        tx.pure.vector("u8", Array.from(cInputsBytes)),
        tx.pure.vector("u8", Array.from(encryptedAmount)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  });

  // ---- execute_pending_withdrawal (pool3) --------------------------------
  await call(client, keypair, "execute_pending_withdrawal (admin op)", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::execute_pending_withdrawal`,
      arguments: [tx.object(pool3Id), tx.object(adminCap3Id), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  // ---- emergency_withdraw (pool4, still frozen) --------------------------
  // Needs pool_epoch(pool4) > frozen_at_epoch. frozen_at_epoch was set during epoch-E setup,
  // but a fast local devnet can land setup transactions right at a checkpoint boundary, so
  // frozen_at_epoch is not reliably < the epoch reached by the single sleepUntilNextEpoch above
  // (confirmed empirically: it can equal it). Force one more full epoch to elapse first.
  const { epoch: preEmergencyEpoch } = await currentEpoch(client);
  await sleepUntilNextEpoch(client, preEmergencyEpoch);
  await call(client, keypair, "emergency_withdraw (admin op)", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::emergency_withdraw`,
      arguments: [tx.object(pool4Id), tx.object(adminCap4Id), tx.pure.u64(1_000_000n), tx.pure.address(addr), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  writeFileSync(join(__dirname, "gas-onchain-results.json"), JSON.stringify(results, null, 2));
  log("\n=== Gas summary (net = computation + storage - rebate, MIST) ===");
  for (const r of results) {
    log(`${r.label.padEnd(55)} ${r.netMist?.padStart(12)} MIST  (${JSON.stringify(r.gasUsed)})`);
  }
}

main().catch((err) => {
  console.error("[gas-onchain] FATAL:", err instanceof Error ? err.stack : err);
  writeFileSync(join(__dirname, "gas-onchain-results.json"), JSON.stringify(results, null, 2));
  process.exit(1);
});
