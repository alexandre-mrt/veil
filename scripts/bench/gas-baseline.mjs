#!/usr/bin/env node
/**
 * gas-baseline.mjs — On-chain gas benchmark for Veil's Move entry points.
 *
 * Runs against a local `sui start` network (no external fullnode/faucet dependency —
 * public Sui RPC endpoints are blocked by this environment's egress policy). Deploys the
 * real package, drives every gas-relevant entry point with REAL Groth16 proofs generated
 * from the compiled circuits, and reports the exact gasUsed breakdown from each
 * transaction's effects.
 *
 * Self-contained (duplicates the small amount of proof-conversion logic from
 * scripts/src/proof-converter.ts) so it runs under plain `node`, matching the other
 * scripts in this directory — snarkjs's wasm witness calculator crashes Bun 1.3.11 here
 * (a bug in the `web-worker` package's node:worker_threads shim, not in Veil's code).
 *
 * Usage:
 *   sui genesis -f --with-faucet --working-dir <config-dir>
 *   sui start --network.config <config-dir> --with-faucet=0.0.0.0:9123 &
 *   # point the default sui CLI config (~/.sui/sui_config/client.yaml) at that network,
 *   # then, from scripts/:
 *   node bench/gas-baseline.mjs
 *
 * Requires: sui CLI on PATH, circuit build artifacts (circuits/build{,-withdraw,-compliance}/,
 * including *_final.zkey and *_vk.json — see circuits/scripts/compile*.sh).
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

// ---------------------------------------------------------------------------
// Proof conversion (mirrors scripts/src/proof-converter.ts exactly — see that
// file for the arkworks-compressed-serialization rationale and test coverage;
// duplicated here so this script has no cross-runtime (bun-only) dependency).
// ---------------------------------------------------------------------------

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
    compressG2(
      BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1]),
      BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1]),
    ),
    32,
  );
  result.set(compressG1(BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])), 96);
  return result;
}

function publicInputsToSuiBytes(signals) {
  const result = new Uint8Array(signals.length * 32);
  for (let i = 0; i < signals.length; i++) result.set(bigintToLE32(BigInt(signals[i])), i * 32);
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
  for (let i = 0; i < 8; i++) { lenBytes[i] = Number(v & 0xffn); v >>= 8n; }
  parts.push(lenBytes);
  for (const ic of vk.IC) parts.push(compressG1(BigInt(ic[0]), BigInt(ic[1])));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { result.set(p, off); off += p.length; }
  return result;
}

// ---------------------------------------------------------------------------
// Deploy (mirrors scripts/src/deploy.ts's `sui client publish` / test-publish
// fallback — duplicated for the same cross-runtime reason as above)
// ---------------------------------------------------------------------------

function deployContract(contractsDir, gasBudget) {
  console.log(`[deploy] Publishing from ${contractsDir} with gas budget ${gasBudget}...`);
  let output;
  try {
    output = execSync(`sui client publish --gas-budget ${gasBudget} --json`, {
      cwd: contractsDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const combined = (err.stdout ?? "") + (err.stderr ?? "");
    if (combined.includes('"objectChanges"') || combined.includes('"effects"')) {
      output = combined;
    } else if (combined.includes("does not define an") && combined.includes("environment")) {
      // Sui CLI's package-management feature requires Move.toml to declare a named
      // [environments] entry matching the active env before a persistent `publish` is
      // allowed; veil's Move.toml predates that feature. Fall back to an ephemeral
      // test-publish against whatever env is currently active.
      const activeEnv = execSync("sui client active-env", { encoding: "utf-8" }).trim();
      console.log(`[deploy] publish requires a declared environment; falling back to test-publish --build-env ${activeEnv}`);
      const pubfilePath = join(contractsDir, `Pub.${activeEnv}.toml`);
      if (existsSync(pubfilePath)) unlinkSync(pubfilePath);
      output = execSync(`sui client test-publish --build-env ${activeEnv} --gas-budget ${gasBudget} --json`, {
        cwd: contractsDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
      });
    } else {
      throw new Error(`[deploy] Publish failed (exit ${err.status}): ${combined.slice(0, 500)}`);
    }
  }
  const jsonStart = output.indexOf("{");
  const result = JSON.parse(output.slice(jsonStart));
  if (result.effects?.status?.status !== "success") {
    throw new Error(`[deploy] Transaction failed: ${JSON.stringify(result.effects?.status)}`);
  }
  const changes = result.objectChanges ?? [];
  const published = changes.find((c) => c.type === "published");
  if (!published?.packageId) throw new Error("[deploy] No published package found");
  const treasuryCapId = changes.find((c) => c.type === "created" && c.objectType?.includes("::coin::TreasuryCap"))?.objectId ?? null;
  return { packageId: published.packageId, treasuryCapId, digest: result.digest, publishEffects: result.effects };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");
const CONTRACTS_DIR = join(PROJECT_ROOT, "contracts");

const TRANSFER_WASM = join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm");
const TRANSFER_ZKEY = join(CIRCUITS_DIR, "build", "transfer_final.zkey");
const TRANSFER_VK = join(CIRCUITS_DIR, "build", "transfer_vk.json");

const WITHDRAW_WASM = join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm");
const WITHDRAW_ZKEY = join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey");
const WITHDRAW_VK = join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json");

const COMPLIANCE_WASM = join(CIRCUITS_DIR, "build-compliance", "compliance_js", "compliance.wasm");
const COMPLIANCE_ZKEY = join(CIRCUITS_DIR, "build-compliance", "compliance_final.zkey");
const COMPLIANCE_VK = join(CIRCUITS_DIR, "build-compliance", "compliance_vk.json");

const RPC_URL = process.env.VEIL_LOCAL_RPC ?? "http://127.0.0.1:9000";
const SUI_CLOCK_OBJECT_ID = "0x6";
const GAS_BUDGET = 300_000_000;
const EPOCH_DURATION_MS = 60_000; // pool.move's MIN_EPOCH_DURATION — smallest legal value
const DENOM_SMALL = 100_000_000n;
const TRANSFER_THRESHOLD = 1_000_000_000n;
const REQUIRED_KYC_LEVEL = 1n;
const MIN_VK_LENGTH = 232;

const OUT_PATH = join(__dirname, "gas-baseline-results.json");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[gas-baseline] ${msg}`);
}

function bigintToAddressHex(n) {
  return "0x" + n.toString(16).padStart(64, "0");
}

function loadKeypair() {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  if (!existsSync(keystorePath)) throw new Error(`Sui keystore not found at ${keystorePath}.`);
  const keystore = JSON.parse(readFileSync(keystorePath, "utf-8"));
  for (const key of keystore) {
    const raw = fromBase64(key);
    if (raw[0] !== 0) continue;
    try {
      const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
      if (kp.toSuiAddress() === activeAddress) return kp;
    } catch {
      /* not an ed25519 entry */
    }
  }
  throw new Error(`No Ed25519 key found matching active address ${activeAddress}`);
}

async function getPoolEpoch(client, epochDurationMs) {
  const obj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
  const timestampMs = BigInt(obj.data?.content?.fields?.timestamp_ms ?? "0");
  return timestampMs / BigInt(epochDurationMs);
}

async function waitForPoolEpoch(client, epochDurationMs, targetEpoch, label) {
  const deadline = Date.now() + 120_000;
  let epoch = await getPoolEpoch(client, epochDurationMs);
  log(`waiting for pool epoch >= ${targetEpoch} (currently ${epoch}) [${label}]...`);
  while (epoch < targetEpoch) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for epoch ${targetEpoch} (${label}); stuck at ${epoch}`);
    await new Promise((r) => setTimeout(r, 3000));
    epoch = await getPoolEpoch(client, epochDurationMs);
  }
  log(`epoch ${epoch} reached [${label}]`);
}

const gasLog = [];

function recordGas(op, effects, digest) {
  const g = effects.gasUsed;
  const net = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
  gasLog.push({
    op, computationCost: g.computationCost, storageCost: g.storageCost,
    storageRebate: g.storageRebate, nonRefundableStorageFee: g.nonRefundableStorageFee,
    netGas: net.toString(), digest,
  });
  log(`gas[${op}] computation=${g.computationCost} storage=${g.storageCost} rebate=${g.storageRebate} net=${net}`);
}

function effectiveEpochFromEvents(result) {
  for (const ev of result.events ?? []) {
    const eff = ev.parsedJson?.effective_epoch;
    if (eff !== undefined) return BigInt(eff);
  }
  return null;
}

async function run(client, keypair, tx, label) {
  tx.setGasBudget(GAS_BUDGET);
  const result = await client.signAndExecuteTransaction({
    transaction: tx, signer: keypair,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (result.effects?.status?.status !== "success") {
    throw new Error(`${label} failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await client.waitForTransaction({ digest: result.digest });
  recordGas(label, result.effects, result.digest);
  return result;
}

async function proveAndVerify(input, wasmPath, zkeyPath, vkPath, label) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const vk = JSON.parse(readFileSync(vkPath, "utf-8"));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error(`${label} proof failed local verification`);
  return { proof, publicSignals };
}

// ---------------------------------------------------------------------------
// Epoch-parameterized witness builders (mirror witnesses.mjs but bind
// on-chain-checked epoch fields to the LIVE pool epoch instead of a fixed
// constant — public RPCs are unreachable here, but a fixed epoch would just
// fail E_EPOCH_MISMATCH against a real, wall-clock-driven local validator).
// ---------------------------------------------------------------------------

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const MERKLE_DEPTH = 20;

function toBI(F, val) {
  if (typeof val === "bigint") return val;
  if (val instanceof Uint8Array) return F.toObject(val);
  return BigInt(val);
}

function merkleRootFromZeroPath(poseidon, F, leaf) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) node = toBI(F, poseidon([node, 0n]));
  return node;
}

function buildTransferWitnessForEpoch(poseidon, F, epochId, userSecret) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n,
    randomnessNew = 424242n + userSecret, threshold = TRANSFER_THRESHOLD, salt = 99n + userSecret;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(F, poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromZeroPath(poseidon, F, oldCommitment);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

function buildComplianceWitnessForEpoch(poseidon, F, currentEpoch, transferNullifier, userSecret) {
  const kycLevel = 2n, expiryEpoch = currentEpoch + 500n, issuerId = 42n, requiredKycLevel = REQUIRED_KYC_LEVEL;
  const credentialLeaf = toBI(F, poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const pathElements = [], pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n); pathIndices.push(0n);
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

async function buildAuditorPayload() {
  const subtle = globalThis.crypto.subtle;
  const auditorKeyPair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auditorPubRaw = new Uint8Array(await subtle.exportKey("raw", auditorKeyPair.publicKey));
  const ephemeralKeyPair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephemeralPubRaw = new Uint8Array(await subtle.exportKey("raw", ephemeralKeyPair.publicKey));
  const sharedBits = await subtle.deriveBits({ name: "ECDH", public: auditorKeyPair.publicKey }, ephemeralKeyPair.privateKey, 256);
  const sharedKeyMaterial = await subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const aesKey = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ephemeralPubRaw, info: new TextEncoder().encode("veil-auditor-v1") },
    sharedKeyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const plaintext = new TextEncoder().encode(JSON.stringify({ txAmount: "100", salt: "1" }));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));
  const encryptedAmount = new Uint8Array(ephemeralPubRaw.length + iv.length + ciphertext.length);
  encryptedAmount.set(ephemeralPubRaw, 0);
  encryptedAmount.set(iv, ephemeralPubRaw.length);
  encryptedAmount.set(ciphertext, ephemeralPubRaw.length + iv.length);
  return { auditorPubRaw, encryptedAmount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  for (const [label, p] of [
    ["transfer wasm", TRANSFER_WASM], ["transfer zkey", TRANSFER_ZKEY], ["transfer vk", TRANSFER_VK],
    ["withdraw wasm", WITHDRAW_WASM], ["withdraw zkey", WITHDRAW_ZKEY], ["withdraw vk", WITHDRAW_VK],
    ["compliance wasm", COMPLIANCE_WASM], ["compliance zkey", COMPLIANCE_ZKEY], ["compliance vk", COMPLIANCE_VK],
  ]) {
    if (!existsSync(p)) throw new Error(`Missing ${label} at ${p} — run circuits/scripts/compile*.sh first`);
  }

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  setPoseidonField(F);

  const keypair = loadKeypair();
  const address = keypair.toSuiAddress();
  log(`address: ${address}`);

  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
  const balance = await client.getBalance({ owner: address });
  log(`balance: ${balance.totalBalance} MIST`);

  // ── Deploy ────────────────────────────────────────────────────────────
  log("publishing package...");
  const deployed = deployContract(CONTRACTS_DIR, GAS_BUDGET);
  if (!deployed.treasuryCapId) throw new Error("TreasuryCap not found after publish");
  const packageId = deployed.packageId;
  log(`package: ${packageId}`);
  recordGas("publish", deployed.publishEffects, deployed.digest);

  // ── VKs ──────────────────────────────────────────────────────────────
  const transferVk = JSON.parse(readFileSync(TRANSFER_VK, "utf-8"));
  const withdrawVk = JSON.parse(readFileSync(WITHDRAW_VK, "utf-8"));
  const complianceVk = JSON.parse(readFileSync(COMPLIANCE_VK, "utf-8"));
  const transferVkBytes = vkToSuiBytes(transferVk);
  const withdrawVkBytes = vkToSuiBytes(withdrawVk);
  const complianceVkBytes = vkToSuiBytes(complianceVk);
  if (transferVkBytes.length < MIN_VK_LENGTH) throw new Error("transfer VK too short");

  // ── create_pool ──────────────────────────────────────────────────────
  log("create_pool...");
  let tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pool::create_pool`,
    arguments: [
      tx.pure.vector("u8", Array.from(transferVkBytes)),
      tx.pure.u64(TRANSFER_THRESHOLD),
      tx.pure.u64(BigInt(EPOCH_DURATION_MS)),
    ],
  });
  let result = await run(client, keypair, tx, "create_pool");
  const poolId = result.objectChanges.find((c) => c.type === "created" && c.objectType?.includes("::pool::Pool"))?.objectId;
  const adminCapId = result.objectChanges.find((c) => c.type === "created" && c.objectType?.includes("::pool::AdminCap"))?.objectId;
  if (!poolId || !adminCapId) throw new Error("Pool/AdminCap not found after create_pool");
  log(`pool: ${poolId} adminCap: ${adminCapId}`);

  async function mintCoin() {
    const mintTx = new Transaction();
    mintTx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [mintTx.object(deployed.treasuryCapId)] });
    const mintResult = await run(client, keypair, mintTx, "token_faucet::faucet");
    const coinId = mintResult.objectChanges.find((c) => c.type === "created" && c.objectType?.includes("::token::TOKEN"))?.objectId;
    if (!coinId) throw new Error("Minted coin not found");
    return coinId;
  }

  // ── deposit #1 (genesis commitment for shielded_transfer) ──────────────
  const userSecretA = 987654321111n;
  const epochAtProposeA = await getPoolEpoch(client, EPOCH_DURATION_MS);
  const transferWitnessA = buildTransferWitnessForEpoch(poseidon, F, epochAtProposeA, userSecretA);
  const genesisCommitmentA = bigintToLE32(transferWitnessA.oldCommitment);

  const coinIdA = await mintCoin();
  tx = new Transaction();
  const [depositCoinA] = tx.splitCoins(tx.object(coinIdA), [tx.pure.u64(DENOM_SMALL)]);
  tx.moveCall({
    target: `${packageId}::pool::deposit_and_register`,
    arguments: [tx.object(poolId), depositCoinA, tx.pure.vector("u8", Array.from(genesisCommitmentA)), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  await run(client, keypair, tx, "deposit_and_register");

  // ── deposit #2 (commitment for zk_withdraw) ─────────────────────────────
  const withdrawWitness = WITNESS_BUILDERS.withdraw(poseidon);
  const withdrawCommitmentBytes = bigintToLE32(withdrawWitness.commitment);
  const coinIdB = await mintCoin();
  tx = new Transaction();
  const [depositCoinB] = tx.splitCoins(tx.object(coinIdB), [tx.pure.u64(DENOM_SMALL)]);
  tx.moveCall({
    target: `${packageId}::pool::deposit_and_register`,
    arguments: [tx.object(poolId), depositCoinB, tx.pure.vector("u8", Array.from(withdrawCommitmentBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  await run(client, keypair, tx, "deposit_and_register (withdraw commitment)");

  // ── propose commitment root (for transfer A) + withdraw VK, same epoch window ──
  const rootABytes = bigintToLE32(transferWitnessA.merkleRoot);
  tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pool::update_commitment_root`,
    arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(rootABytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  const rootResult = await run(client, keypair, tx, "update_commitment_root");

  tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pool::propose_withdraw_vk`,
    arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(withdrawVkBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  const withdrawVkResult = await run(client, keypair, tx, "propose_withdraw_vk");

  const targetEpoch1 = [
    effectiveEpochFromEvents(rootResult) ?? epochAtProposeA + 1n,
    effectiveEpochFromEvents(withdrawVkResult) ?? epochAtProposeA + 1n,
    epochAtProposeA + 1n,
  ].reduce((a, b) => (a > b ? a : b));
  await waitForPoolEpoch(client, EPOCH_DURATION_MS, targetEpoch1, "commitment root + withdraw VK + deposit maturity");

  // ── shielded_transfer ────────────────────────────────────────────────
  const epochAtTransferA = await getPoolEpoch(client, EPOCH_DURATION_MS);
  const inputA = stringifyInputs(transferWitnessA);
  inputA.epochId = epochAtTransferA.toString();
  inputA.nullifier = toBI(F, poseidon([DOMAIN_NULLIFIER, userSecretA, epochAtTransferA, transferWitnessA.randomnessOld])).toString();
  const { proof: transferProofA, publicSignals: transferSignalsA } = await proveAndVerify(inputA, TRANSFER_WASM, TRANSFER_ZKEY, TRANSFER_VK, "transfer(A)");
  const transferProofABytes = proofToSuiBytes(transferProofA);
  const transferInputsABytes = publicInputsToSuiBytes(transferSignalsA);

  tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pool::shielded_transfer`,
    arguments: [tx.object(poolId), tx.pure.vector("u8", Array.from(transferProofABytes)), tx.pure.vector("u8", Array.from(transferInputsABytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  await run(client, keypair, tx, "shielded_transfer");

  // ── zk_withdraw ──────────────────────────────────────────────────────
  const { proof: withdrawProof, publicSignals: withdrawSignals } = await proveAndVerify(stringifyInputs(withdrawWitness), WITHDRAW_WASM, WITHDRAW_ZKEY, WITHDRAW_VK, "withdraw");
  const withdrawProofBytes = proofToSuiBytes(withdrawProof);
  const withdrawInputsBytes = publicInputsToSuiBytes(withdrawSignals);
  const recipientAddr = bigintToAddressHex(withdrawWitness.recipient);

  tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pool::zk_withdraw`,
    arguments: [
      tx.object(poolId), tx.pure.vector("u8", Array.from(withdrawProofBytes)),
      tx.pure.vector("u8", Array.from(withdrawInputsBytes)), tx.pure.address(recipientAddr),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  await run(client, keypair, tx, "zk_withdraw");

  // ── compliance config + compliant_transfer ──────────────────────────────
  const userSecretC = 555111222333n;
  const epochAtProposeC = await getPoolEpoch(client, EPOCH_DURATION_MS);
  const transferWitnessC = buildTransferWitnessForEpoch(poseidon, F, epochAtProposeC, userSecretC);
  const genesisCommitmentC = bigintToLE32(transferWitnessC.oldCommitment);

  const coinIdC = await mintCoin();
  tx = new Transaction();
  const [depositCoinC] = tx.splitCoins(tx.object(coinIdC), [tx.pure.u64(DENOM_SMALL)]);
  tx.moveCall({
    target: `${packageId}::pool::deposit_and_register`,
    arguments: [tx.object(poolId), depositCoinC, tx.pure.vector("u8", Array.from(genesisCommitmentC)), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  await run(client, keypair, tx, "deposit_and_register (compliant-transfer commitment)");

  const complianceWitnessC = buildComplianceWitnessForEpoch(poseidon, F, epochAtProposeC, transferWitnessC.nullifier, userSecretC);
  const credentialRootBytes = bigintToLE32(complianceWitnessC.merkleRoot);
  const { auditorPubRaw, encryptedAmount } = await buildAuditorPayload();

  tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::compliance::create_compliance_config`,
    arguments: [
      tx.object(adminCapId), tx.object(poolId),
      tx.pure.vector("u8", Array.from(complianceVkBytes)),
      tx.pure.vector("u8", Array.from(credentialRootBytes)),
      tx.pure.u64(REQUIRED_KYC_LEVEL),
      tx.pure.vector("u8", Array.from(auditorPubRaw)),
    ],
  });
  result = await run(client, keypair, tx, "create_compliance_config");
  const configId = result.objectChanges.find((c) => c.type === "created" && c.objectType?.includes("::compliance::ComplianceConfig"))?.objectId;
  if (!configId) throw new Error("ComplianceConfig not found after create_compliance_config");

  const rootCBytes = bigintToLE32(transferWitnessC.merkleRoot);
  tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::pool::update_commitment_root`,
    arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(rootCBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  const rootCResult = await run(client, keypair, tx, "update_commitment_root (compliant-transfer root)");

  const targetEpoch2 = effectiveEpochFromEvents(rootCResult) ?? epochAtProposeC + 1n;
  await waitForPoolEpoch(client, EPOCH_DURATION_MS, targetEpoch2, "compliant-transfer commitment root");

  const epochAtTransferC = await getPoolEpoch(client, EPOCH_DURATION_MS);
  const inputC = stringifyInputs(transferWitnessC);
  inputC.epochId = epochAtTransferC.toString();
  inputC.nullifier = toBI(F, poseidon([DOMAIN_NULLIFIER, userSecretC, epochAtTransferC, transferWitnessC.randomnessOld])).toString();
  const { proof: transferProofC, publicSignals: transferSignalsC } = await proveAndVerify(inputC, TRANSFER_WASM, TRANSFER_ZKEY, TRANSFER_VK, "transfer(C)");
  const complianceInputC = stringifyInputs(complianceWitnessC);
  complianceInputC.currentEpoch = epochAtTransferC.toString();
  const { proof: complianceProof, publicSignals: complianceSignals } = await proveAndVerify(complianceInputC, COMPLIANCE_WASM, COMPLIANCE_ZKEY, COMPLIANCE_VK, "compliance");

  tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::compliance::compliant_transfer`,
    arguments: [
      tx.object(poolId), tx.object(configId),
      tx.pure.vector("u8", Array.from(proofToSuiBytes(transferProofC))),
      tx.pure.vector("u8", Array.from(publicInputsToSuiBytes(transferSignalsC))),
      tx.pure.vector("u8", Array.from(proofToSuiBytes(complianceProof))),
      tx.pure.vector("u8", Array.from(publicInputsToSuiBytes(complianceSignals))),
      tx.pure.vector("u8", Array.from(encryptedAmount)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  await run(client, keypair, tx, "compliant_transfer");

  // ── admin ops (freeze / unfreeze — immediate, no timelock) ──────────────
  tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::freeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId), tx.object(SUI_CLOCK_OBJECT_ID)] });
  await run(client, keypair, tx, "freeze_pool");

  tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::unfreeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  await run(client, keypair, tx, "unfreeze_pool");

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  console.log("  GAS BASELINE RESULTS (local sui network, real proofs)");
  console.log("=".repeat(72));
  console.table(gasLog.map((r) => ({ op: r.op, computation: r.computationCost, storage: r.storageCost, rebate: r.storageRebate, net: r.netGas })));
  writeFileSync(OUT_PATH, JSON.stringify({ packageId, poolId, adminCapId, gasLog }, null, 2));
  log(`wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err?.stack ?? err);
  process.exit(1);
});
