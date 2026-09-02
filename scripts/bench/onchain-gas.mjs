#!/usr/bin/env node
/**
 * onchain-gas.mjs — Real on-chain gas cost per Veil entry point.
 *
 * Measured against a LOCAL Sui network, not the live testnet deployment. Two prior nights
 * (see docs/research/LEDGER.md, 2026-07-22) tried to reach `fullnode.testnet.sui.io` for this
 * number and were blocked by the sandbox's network policy both times. This run confirmed the
 * same host is still policy-denied (403 at the CONNECT layer — see the report), so instead of a
 * third attempt at the same blocked path, this script deploys the real, unmodified `contracts/`
 * package to a real local Sui validator (`sui start`) and calls each entry point with a real
 * Groth16 proof. Gas pricing (reference gas price, storage price, rebate rate) is protocol
 * config, identical between localnet and testnet in this Sui version — the numbers below are not
 * synthetic estimates, they are `effects.gasUsed` from real transaction execution.
 *
 * Plain node ESM, not TypeScript/bun like scripts/src/*.ts: circomlibjs's buildPoseidon() pulls
 * in ffjavascript's threaded curve builder, which spawns a real worker_thread even when called
 * with singleThread=true. Under bun 1.3.11 that worker crashes the process (bun's `web-worker`
 * polyfill throws `TypeError: Argument 1 ('event') ... must be an instance of Event` inside
 * worker_threads' parentPort 'message' handler) — a bun/circomlibjs compatibility bug, not
 * anything in this codebase. Plain node has no such issue (same as prove-latency.mjs / the
 * circuits/test/*.test.mjs suite), so this script runs under `node`, duplicating the handful of
 * proof-converter.ts / compliance-utils.ts helpers it needs rather than importing TS across the
 * node/bun boundary.
 *
 * Usage:
 *   sui start --with-faucet --force-regenesis &          # background local validator
 *   sleep 5 && sui client switch --env local
 *   node scripts/bench/onchain-gas.mjs
 *
 * Requires:
 *   - `sui` CLI on PATH (this project: built from source, see the report for the exact command)
 *   - circuits/build{,-withdraw,-compliance}/ compiled (bash circuits/scripts/compile*.sh)
 *   - an active `sui client` env pointed at the local network, with a keystore address
 *
 * Prints one JSON line per entry point call: { entryPoint, digest, status, gasUsed }.
 * `gasUsed` is Sui's four-field breakdown: computationCost, storageCost, storageRebate,
 * nonRefundableStorageFee (all in MIST, 1 SUI = 1e9 MIST).
 */
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");

const RPC_URL = process.env.SUI_RPC_URL ?? "http://127.0.0.1:9000";
const FAUCET_URL = process.env.SUI_FAUCET_URL ?? "http://127.0.0.1:9123/gas";
const SUI_CLOCK_OBJECT_ID = "0x6";
const GAS_BUDGET = 200_000_000;
const EPOCH_DURATION_MS = 60_000; // minimum allowed by pool::create_pool
const MIN_SUI_BALANCE_MIST = 5_000_000_000; // 5 SUI
const TRANSFER_THRESHOLD = 1_000_000_000n;
const MERKLE_DEPTH = 20;

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;
const ZERO_LEAF = 0n;

const results = [];

// ---------------------------------------------------------------------------
// Proof/VK byte conversion (ported from scripts/src/proof-converter.ts —
// arkworks compressed serialization for BN254; see that file for the format
// docs and the 109-case test suite that verifies it against real proofs).
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
  const setSign = y1 > Q_HALF || (y1 === Q_HALF && y0 > Q_HALF);
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
  for (let i = 0; i < signals.length; i++) result.set(bigintToLE32(BigInt(signals[i])), i * 32);
  return result;
}

function vkToSuiBytes(vk) {
  const parts = [
    compressG1(BigInt(vk.vk_alpha_1[0]), BigInt(vk.vk_alpha_1[1])),
    compressG2(BigInt(vk.vk_beta_2[0][0]), BigInt(vk.vk_beta_2[0][1]), BigInt(vk.vk_beta_2[1][0]), BigInt(vk.vk_beta_2[1][1])),
    compressG2(BigInt(vk.vk_gamma_2[0][0]), BigInt(vk.vk_gamma_2[0][1]), BigInt(vk.vk_gamma_2[1][0]), BigInt(vk.vk_gamma_2[1][1])),
    compressG2(BigInt(vk.vk_delta_2[0][0]), BigInt(vk.vk_delta_2[0][1]), BigInt(vk.vk_delta_2[1][0]), BigInt(vk.vk_delta_2[1][1])),
  ];
  const lenBytes = new Uint8Array(8);
  let v = BigInt(vk.IC.length);
  for (let i = 0; i < 8; i++) {
    lenBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  parts.push(lenBytes);
  for (const ic of vk.IC) parts.push(compressG1(BigInt(ic[0]), BigInt(ic[1])));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Credential Merkle tree (ported from scripts/src/compliance-utils.ts)
// ---------------------------------------------------------------------------

function computeCredentialLeaf(poseidon, F, userSecret, kycLevel, expiryEpoch, issuerId) {
  return F.toObject(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
}

function buildMerkleTree(poseidon, F, leaves, depth) {
  const capacity = 1 << depth;
  if (leaves.length > capacity) throw new Error(`Too many leaves: ${leaves.length} > 2^${depth}`);
  const leafLayer = Array.from({ length: capacity }, (_, i) => (i < leaves.length ? leaves[i] : ZERO_LEAF));
  const layers = [leafLayer];
  let current = leafLayer;
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(F.toObject(poseidon([current[i], current[i + 1]])));
    }
    layers.push(next);
    current = next;
  }
  return { root: layers[depth][0], layers };
}

function getMerkleProof(layers, index, depth) {
  const pathElements = [];
  const pathIndices = [];
  let currentIndex = index;
  for (let d = 0; d < depth; d++) {
    const isRightChild = currentIndex % 2 === 1;
    const siblingIndex = isRightChild ? currentIndex - 1 : currentIndex + 1;
    pathElements.push(layers[d][siblingIndex]);
    pathIndices.push(isRightChild ? 1 : 0);
    currentIndex = Math.floor(currentIndex / 2);
  }
  return { pathElements, pathIndices };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[bench] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadKeypair() {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  if (!existsSync(keystorePath)) {
    throw new Error(`Sui keystore not found at ${keystorePath}. Run 'sui client' first.`);
  }
  const keystore = JSON.parse(readFileSync(keystorePath, "utf-8"));
  for (const key of keystore) {
    const raw = fromBase64(key);
    if (raw[0] !== 0) continue;
    try {
      const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
      if (kp.toSuiAddress() === activeAddress) return kp;
    } catch {
      // not an ed25519 key, skip
    }
  }
  throw new Error(`No Ed25519 key found matching active address ${activeAddress}`);
}

async function ensureBalance(client, address) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const balance = await client.getBalance({ owner: address });
    const totalMist = BigInt(balance.totalBalance);
    log(`balance: ${totalMist} MIST`);
    if (totalMist >= BigInt(MIN_SUI_BALANCE_MIST)) return;
    log("requesting local faucet...");
    const resp = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
    });
    if (!resp.ok) throw new Error(`local faucet request failed: ${resp.status} ${await resp.text()}`);
    await sleep(2000);
  }
  throw new Error("Could not fund address from local faucet after 5 attempts");
}

async function currentEpoch(client) {
  const clockObj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
  const timestampMs = BigInt(clockObj.data?.content?.fields?.timestamp_ms ?? Date.now());
  return timestampMs / BigInt(EPOCH_DURATION_MS);
}

async function waitForNextEpoch(client, fromEpoch) {
  log(`waiting for on-chain epoch to advance past ${fromEpoch} (epoch_duration_ms=${EPOCH_DURATION_MS})...`);
  while (true) {
    const epoch = await currentEpoch(client);
    if (epoch > fromEpoch) {
      log(`epoch advanced to ${epoch}`);
      return;
    }
    await sleep(5000);
  }
}

async function call(client, keypair, entryPoint, build, opts = {}) {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  const status = result.effects?.status?.status ?? "unknown";
  const digest = result.digest ?? "unknown";
  const gasUsed = result.effects?.gasUsed;
  console.log(JSON.stringify({ entryPoint, digest, status, gasUsed }));
  results.push({ entryPoint, digest, gasUsed, status });
  if (status !== "success" && !opts.allowFailure) {
    throw new Error(`${entryPoint} failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await client.waitForTransaction({ digest });
  return { status, digest, result };
}

// ---------------------------------------------------------------------------
// Witness / proof builders (epochId bound at call time — scripts/bench/
// witnesses.mjs's fixed epochId=1n can't be reused here: the real on-chain
// epoch is floor(unix_ms / epoch_duration_ms), so it must be read live)
// ---------------------------------------------------------------------------

async function buildTransferProof(poseidon, F, epochId, userSecret = 987654321n) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const hash = (...xs) => F.toObject(poseidon(xs));
  const oldCommitment = hash(DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret);
  const newCommitment = hash(DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret);
  const nullifier = hash(DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld);
  const txAmountHash = hash(DOMAIN_TX_AMOUNT, txAmount, salt);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  let node = oldCommitment;
  for (let i = 0; i < MERKLE_DEPTH; i++) node = hash(node, 0n);
  const merkleRoot = node;

  const input = {
    oldCommitment: oldCommitment.toString(), newCommitment: newCommitment.toString(),
    threshold: TRANSFER_THRESHOLD.toString(), epochId: epochId.toString(),
    nullifier: nullifier.toString(), txAmountHash: txAmountHash.toString(),
    merkleRoot: merkleRoot.toString(),
    cumulativeOld: cumulativeOld.toString(), cumulativeNew: cumulativeNew.toString(),
    txAmount: txAmount.toString(), randomnessOld: randomnessOld.toString(),
    randomnessNew: randomnessNew.toString(), userSecret: userSecret.toString(),
    salt: salt.toString(),
    pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm"),
    join(CIRCUITS_DIR, "build", "transfer_final.zkey"),
  );
  return {
    proofBytes: proofToSuiBytes(proof),
    publicInputsBytes: publicInputsToSuiBytes(publicSignals),
    oldCommitmentBytes: bigintToLE32(oldCommitment),
    merkleRootBytes: bigintToLE32(merkleRoot),
    nullifierField: nullifier,
  };
}

async function buildWithdrawProof(poseidon, F) {
  const cumulativeOld = 500_000_000n, randomnessOld = 12345n, userSecret = 555555555n;
  const withdrawAmount = 100_000_000n, recipientField = 0xABCDEF123456n, randomnessNew = 77777n;
  const hash = (...xs) => F.toObject(poseidon(xs));
  const commitment = hash(DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret);
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = hash(DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret);
  const nullifier = hash(DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld);
  const recipientHash = hash(DOMAIN_RECIPIENT_HASH, recipientField);

  const input = {
    commitment: commitment.toString(), withdrawAmount: withdrawAmount.toString(),
    nullifier: nullifier.toString(), recipientHash: recipientHash.toString(),
    newCommitment: newCommitment.toString(),
    cumulativeOld: cumulativeOld.toString(), randomnessOld: randomnessOld.toString(),
    userSecret: userSecret.toString(), recipient: recipientField.toString(),
    randomnessNew: randomnessNew.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm"),
    join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey"),
  );
  return {
    proofBytes: proofToSuiBytes(proof),
    publicInputsBytes: publicInputsToSuiBytes(publicSignals),
    commitmentBytes: bigintToLE32(commitment),
  };
}

// ---------------------------------------------------------------------------
// Local publish
// ---------------------------------------------------------------------------
//
// `sui client publish` refuses to build when the active client environment
// (here: `local`, http://127.0.0.1:9000) has no matching `[environments]`
// entry in contracts/Move.toml — this repo only pins deps for `testnet`
// (see contracts/Move.lock). `test-publish --build-env testnet` builds
// against the testnet-pinned framework revision (compatible with this local
// node — same `sui` binary, same protocol version) but *executes* the
// publish against whichever network the active client env points to, which
// is exactly what a local-network gas benchmark needs. It records an
// ephemeral publish entry in a pubfile so re-running the script doesn't
// collide with the previous run's publish.
function publishLocal(gasBudget) {
  const contractsDir = join(PROJECT_ROOT, "contracts");
  const pubfilePath = join(PROJECT_ROOT, "scripts", "bench", ".local-pubfile.toml");
  try {
    execSync(`rm -f ${pubfilePath}`, { encoding: "utf-8" });
  } catch {
    // ignore
  }
  const output = execSync(
    `sui client test-publish --build-env testnet --pubfile-path ${pubfilePath} --gas-budget ${gasBudget} --json`,
    { cwd: contractsDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
  );
  const result = JSON.parse(output);
  const status = result.effects?.status?.status;
  if (status !== "success") {
    throw new Error(`[publishLocal] publish failed: ${JSON.stringify(result.effects?.status)}`);
  }
  const changes = result.objectChanges ?? [];
  const published = changes.find((c) => c.type === "published");
  const treasuryCapChange = changes.find(
    (c) => c.type === "created" && c.objectType?.includes("::coin::TreasuryCap"),
  );
  if (!published?.packageId || !treasuryCapChange?.objectId) {
    throw new Error(`[publishLocal] missing packageId or TreasuryCap in objectChanges: ${output.slice(0, 500)}`);
  }
  return { packageId: published.packageId, treasuryCapId: treasuryCapChange.objectId };
}

async function main() {
  log(`RPC: ${RPC_URL}`);
  const keypair = loadKeypair();
  const address = keypair.toSuiAddress();
  log(`address: ${address}`);
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
  await ensureBalance(client, address);

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash = (...xs) => F.toObject(poseidon(xs));

  // ---- Deploy package ----------------------------------------------------
  log("publishing package...");
  const { packageId, treasuryCapId } = publishLocal(GAS_BUDGET);
  log(`package: ${packageId}`);

  const transferVkBytes = vkToSuiBytes(
    JSON.parse(readFileSync(join(CIRCUITS_DIR, "build", "transfer_vk.json"), "utf-8")),
  );
  const withdrawVkBytes = vkToSuiBytes(
    JSON.parse(readFileSync(join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json"), "utf-8")),
  );
  const complianceVkBytes = vkToSuiBytes(
    JSON.parse(readFileSync(join(CIRCUITS_DIR, "build-compliance", "compliance_vk.json"), "utf-8")),
  );

  // ---- create_pool ---------------------------------------------------------
  let poolId = "";
  {
    const { result } = await call(client, keypair, "pool::create_pool", (tx) => {
      tx.moveCall({
        target: `${packageId}::pool::create_pool`,
        arguments: [
          tx.pure.vector("u8", Array.from(transferVkBytes)),
          tx.pure.u64(TRANSFER_THRESHOLD),
          tx.pure.u64(BigInt(EPOCH_DURATION_MS)),
        ],
      });
    });
    const poolChange = result.objectChanges?.find(
      (c) => c.type === "created" && c.objectType?.includes("::pool::Pool"),
    );
    poolId = poolChange.objectId;
    log(`pool: ${poolId}`);
  }

  // Find AdminCap from the create_pool tx (owned object, not in publish's objectChanges)
  const ownedObjects = await client.getOwnedObjects({
    owner: address,
    filter: { StructType: `${packageId}::pool::AdminCap` },
    options: { showContent: true },
  });
  const adminCapId = ownedObjects.data[0]?.data?.objectId;
  if (!adminCapId) throw new Error("AdminCap not found");
  log(`AdminCap: ${adminCapId}`);

  // ---- create_compliance_config -------------------------------------------
  const credentialUserSecret = 424242n;
  const credentialLeaf = computeCredentialLeaf(poseidon, F, credentialUserSecret, 2n, 999_999_999n, 42n);
  const credTree = buildMerkleTree(poseidon, F, [credentialLeaf], MERKLE_DEPTH);
  const credProof = getMerkleProof(credTree.layers, 0, MERKLE_DEPTH);
  const credentialRootBytes = bigintToLE32(credTree.root);

  const auditorKeyPair = await crypto.webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const auditorPubRaw = new Uint8Array(
    await crypto.webcrypto.subtle.exportKey("raw", auditorKeyPair.publicKey),
  );

  let complianceConfigId = "";
  {
    const { result } = await call(client, keypair, "compliance::create_compliance_config", (tx) => {
      tx.moveCall({
        target: `${packageId}::compliance::create_compliance_config`,
        arguments: [
          tx.object(adminCapId),
          tx.object(poolId),
          tx.pure.vector("u8", Array.from(complianceVkBytes)),
          tx.pure.vector("u8", Array.from(credentialRootBytes)),
          tx.pure.u64(1n),
          tx.pure.vector("u8", Array.from(auditorPubRaw)),
        ],
      });
    });
    const configChange = result.objectChanges?.find(
      (c) => c.type === "created" && c.objectType?.includes("::compliance::ComplianceConfig"),
    );
    complianceConfigId = configChange.objectId;
    log(`ComplianceConfig: ${complianceConfigId}`);
  }

  // ---- propose_withdraw_vk (timelocked admin op) --------------------------
  await call(client, keypair, "pool::propose_withdraw_vk", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdraw_vk`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(withdrawVkBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  // ---- cheap admin ops that need no timelock wait -------------------------
  await call(client, keypair, "pool::freeze_pool", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::freeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId), tx.object(SUI_CLOCK_OBJECT_ID)] });
  });
  await call(client, keypair, "pool::unfreeze_pool", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::unfreeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  });
  await call(client, keypair, "pool::propose_vk_update", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_vk_update`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(transferVkBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  await call(client, keypair, "pool::cancel_vk_update", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::cancel_vk_update`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  });
  // amount=0: pool balance is still 0 at this point (deposits happen later) — E_INSUFFICIENT_BALANCE
  // (assert!(pool.balance.value() >= amount)) would abort for any amount > 0 here.
  await call(client, keypair, "pool::propose_withdrawal", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdrawal`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.u64(0n), tx.pure.address(address), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  await call(client, keypair, "pool::cancel_withdrawal", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::cancel_withdrawal`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  });

  // ---- mint tokens (need 3: transfer leg, withdraw leg, compliance leg) --
  async function mintCoin() {
    const { result } = await call(client, keypair, "token_faucet::faucet", (tx) => {
      tx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [tx.object(treasuryCapId)] });
    });
    const coinChange = result.objectChanges?.find(
      (c) => c.type === "created" && c.objectType?.includes("::token::TOKEN"),
    );
    return coinChange.objectId;
  }
  const coinForTransfer = await mintCoin();
  const coinForWithdraw = await mintCoin();
  const coinForCompliance = await mintCoin();

  // ---- build transfer + withdraw proofs against the epoch we'll deposit in
  const depositEpoch = await currentEpoch(client);
  const transferProof = await buildTransferProof(poseidon, F, depositEpoch);
  const withdrawProof = await buildWithdrawProof(poseidon, F);

  // ---- deposit_and_register x2 (transfer leg + withdraw leg) -------------
  await call(client, keypair, "pool::deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(poolId), tx.object(coinForTransfer), tx.pure.vector("u8", Array.from(transferProof.oldCommitmentBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  await call(client, keypair, "pool::deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(poolId), tx.object(coinForWithdraw), tx.pure.vector("u8", Array.from(withdrawProof.commitmentBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  // ---- update_commitment_root to match the transfer leg's Merkle root ----
  await call(client, keypair, "pool::update_commitment_root", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(transferProof.merkleRootBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  // Wait relative to the epoch observed *after* the setup calls above, not `depositEpoch`
  // captured before them: each call is a real local-network transaction (consensus + execution
  // latency), so by the time update_commitment_root actually executes, pool_epoch(pool, clock)
  // may already have ticked past depositEpoch — its effective_epoch is pool_epoch-at-call-time+1,
  // which can be depositEpoch+2 or later. Waiting on the stale depositEpoch undershoots that.
  const setupEpoch = await currentEpoch(client);
  await waitForNextEpoch(client, setupEpoch);

  // ---- shielded_transfer (applies pending root + matures commitment) -----
  {
    const nowEpoch = await currentEpoch(client);
    // Rebuild with the (possibly ticked) current epoch to stay inside the ±1 grace window.
    const freshTransferProof = await buildTransferProof(poseidon, F, nowEpoch);
    await call(client, keypair, "pool::shielded_transfer", (tx) => {
      tx.moveCall({
        target: `${packageId}::pool::shielded_transfer`,
        arguments: [
          tx.object(poolId),
          tx.pure.vector("u8", Array.from(freshTransferProof.proofBytes)),
          tx.pure.vector("u8", Array.from(freshTransferProof.publicInputsBytes)),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
    });
  }

  // ---- zk_withdraw (applies pending withdraw_vk + matures commitment) ----
  await call(client, keypair, "pool::zk_withdraw", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::zk_withdraw`,
      arguments: [
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(withdrawProof.proofBytes)),
        tx.pure.vector("u8", Array.from(withdrawProof.publicInputsBytes)),
        tx.pure.address(address),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  }, { allowFailure: true }); // recorded either way — see report if this failed

  // ---- compliant_transfer: needs its own commitment + Merkle root cycle --
  // Distinct userSecret from the main transfer leg: buildTransferProof's other parameters
  // (amount, randomness) are fixed constants, so reusing 987654321n here would produce the
  // exact same oldCommitment/newCommitment already consumed/created by shielded_transfer above
  // and abort with E_COMMITMENT_EXISTS the moment execute_transfer tries to add the duplicate.
  const COMPLIANCE_LEG_USER_SECRET = 135792468n;
  const complianceDepositEpoch = await currentEpoch(client);
  const complianceLegProof = await buildTransferProof(poseidon, F, complianceDepositEpoch, COMPLIANCE_LEG_USER_SECRET);

  await call(client, keypair, "pool::deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(poolId), tx.object(coinForCompliance), tx.pure.vector("u8", Array.from(complianceLegProof.oldCommitmentBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  await call(client, keypair, "pool::update_commitment_root", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(complianceLegProof.merkleRootBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  const complianceSetupEpoch = await currentEpoch(client);
  await waitForNextEpoch(client, complianceSetupEpoch);

  {
    const nowEpoch = await currentEpoch(client);
    const freshLegProof = await buildTransferProof(poseidon, F, nowEpoch, COMPLIANCE_LEG_USER_SECRET);

    // Compliance proof, bound to the transfer leg's actual nullifier via contextId.
    const contextId = hash(DOMAIN_CONTEXT_BINDING, freshLegProof.nullifierField, credentialUserSecret);
    const credNullifier = hash(DOMAIN_COMPLIANCE_NULLIFIER, credentialUserSecret, contextId);

    const complianceInput = {
      merkleRoot: credTree.root.toString(), currentEpoch: nowEpoch.toString(),
      contextId: contextId.toString(), requiredKycLevel: "1",
      nullifier: credNullifier.toString(), validCredential: "1",
      userSecret: credentialUserSecret.toString(), kycLevel: "2",
      expiryEpoch: "999999999", issuerId: "42",
      pathElements: credProof.pathElements.map(String), pathIndices: credProof.pathIndices.map(String),
      transferNullifier: freshLegProof.nullifierField.toString(),
    };
    const { proof: cProof, publicSignals: cSignals } = await snarkjs.groth16.fullProve(
      complianceInput,
      join(CIRCUITS_DIR, "build-compliance", "compliance_js", "compliance.wasm"),
      join(CIRCUITS_DIR, "build-compliance", "compliance_final.zkey"),
    );
    const complianceProofBytes = proofToSuiBytes(cProof);
    const complianceInputsBytes = publicInputsToSuiBytes(cSignals);

    // Auditor-encrypted amount (ECDH P-256 + AES-256-GCM, HKDF-derived key — same construction
    // as auditor-tool.ts / e2e-compliance-test.ts).
    const ephemeral = await crypto.webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const ephemeralPubRaw = new Uint8Array(await crypto.webcrypto.subtle.exportKey("raw", ephemeral.publicKey));
    const sharedBits = await crypto.webcrypto.subtle.deriveBits(
      { name: "ECDH", public: auditorKeyPair.publicKey }, ephemeral.privateKey, 256,
    );
    const sharedKeyMaterial = await crypto.webcrypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
    const aesKey = await crypto.webcrypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: ephemeralPubRaw, info: new TextEncoder().encode("veil-auditor-v1") },
      sharedKeyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new Uint8Array(128);
    plaintext.set(new TextEncoder().encode(JSON.stringify({ txAmount: "100", salt: "99" })));
    const ciphertext = new Uint8Array(await crypto.webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));
    const encryptedAmount = new Uint8Array(ephemeralPubRaw.length + iv.length + ciphertext.length);
    encryptedAmount.set(ephemeralPubRaw, 0);
    encryptedAmount.set(iv, ephemeralPubRaw.length);
    encryptedAmount.set(ciphertext, ephemeralPubRaw.length + iv.length);

    await call(client, keypair, "compliance::compliant_transfer", (tx) => {
      tx.moveCall({
        target: `${packageId}::compliance::compliant_transfer`,
        arguments: [
          tx.object(poolId), tx.object(complianceConfigId),
          tx.pure.vector("u8", Array.from(freshLegProof.proofBytes)),
          tx.pure.vector("u8", Array.from(freshLegProof.publicInputsBytes)),
          tx.pure.vector("u8", Array.from(complianceProofBytes)),
          tx.pure.vector("u8", Array.from(complianceInputsBytes)),
          tx.pure.vector("u8", Array.from(encryptedAmount)),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
    }, { allowFailure: true }); // recorded either way — see report if this failed
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  console.log("\n=== PARTIAL RESULTS BEFORE FAILURE ===");
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
});
