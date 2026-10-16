#!/usr/bin/env node
/**
 * gas-localnet.mjs — on-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Publishes the real contracts/ package to a localnet, drives every proof-bearing entry point
 * (shielded_transfer, zk_withdraw, compliant_transfer) with REAL Groth16 proofs generated from
 * circuits/build*, plus the setup/admin calls around them, and prints the `gasUsed` that the
 * validator reports in each transaction's effects (computationCost / storageCost /
 * storageRebate / nonRefundableStorageFee, in MIST).
 *
 * Prerequisites (see docs/research/2026-10-16-onchain-gas.md for the exact bring-up):
 *   - `sui` >= the version matching contracts/Move.toml's framework rev (1.72.x as of 2026-10)
 *   - localnet running:   sui start --force-regenesis --with-faucet
 *   - client env `local`:  sui client new-env --alias local --rpc http://127.0.0.1:9000
 *                          sui client switch --env local && sui client faucet
 *   - circuit artifacts:  cd circuits && bash scripts/compile.sh && bash scripts/compile-withdraw.sh \
 *                           && bash scripts/compile-compliance.sh
 *   - deps:               cd scripts/bench && npm ci
 *
 * Usage:  node scripts/bench/gas-localnet.mjs [--json out.json]   (node >= 22.18 for the .ts import; bun
 *         exits silently during the epoch wait — use node)
 *
 * Epoch handling: the pool is created with the 60 s minimum epoch, so the script waits for the
 * next epoch boundary once (~1 min) before the maturity-gated calls. Everything is deterministic
 * apart from storageRebate (depends on what a tx deletes) and the reference gas price.
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
import * as snarkjs from "snarkjs";
import { buildTransferWitness, buildWithdrawWitness, buildComplianceWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");
const RPC = process.env.SUI_LOCAL_RPC ?? "http://127.0.0.1:9000";
const CLOCK = "0x6";
const GAS_BUDGET = 500_000_000;
const EPOCH_MS = 60_000; // pool.move minimum epoch duration
const THRESHOLD = 1_000_000_000n;
const DENOM = 100_000_000; // pool.move DENOM_SMALL
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
// Any address whose 256-bit value is < the BN254 field order (the withdraw circuit takes it as a field element).
const RECIPIENT = "0x" + "0".repeat(52) + "abcdef123456";

const rows = [];
function record(name, effects, extra = {}) {
  const g = effects.gasUsed;
  const comp = BigInt(g.computationCost), stor = BigInt(g.storageCost), reb = BigInt(g.storageRebate);
  rows.push({ name, status: effects.status.status, computationCost: comp, storageCost: stor, storageRebate: reb,
    nonRefundableStorageFee: BigInt(g.nonRefundableStorageFee), net: comp + stor - reb, ...extra });
  console.log(`  ${name.padEnd(34)} ${effects.status.status}  comp=${comp} stor=${stor} rebate=${reb} net=${comp + stor - reb}`);
}

function loadKeypair() {
  const addr = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const keys = JSON.parse(readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf-8"));
  for (const k of keys) {
    const raw = fromBase64(k);
    if (raw[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (kp.toSuiAddress() === addr) return kp;
  }
  throw new Error(`no ed25519 key for active address ${addr}`);
}

async function main() {
  const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
  const kp = loadKeypair();
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const rgp = await client.getReferenceGasPrice();
  console.log(`=== Veil on-chain gas (localnet ${RPC}, reference gas price ${rgp} MIST/unit) ===`);

  const exec = async (name, tx, extra = {}) => {
    tx.setGasBudget(GAS_BUDGET);
    const r = await client.signAndExecuteTransaction({ transaction: tx, signer: kp,
      options: { showEffects: true, showObjectChanges: true } });
    await client.waitForTransaction({ digest: r.digest });
    if (r.effects.status.status !== "success") throw new Error(`${name} failed: ${JSON.stringify(r.effects.status)}`);
    record(name, r.effects, extra);
    return r;
  };

  // ── publish (CLI: handles dependency resolution / ephemeral publication) ──
  execSync("rm -f Pub.local.toml", { cwd: join(ROOT, "contracts") });
  const out = execSync(`sui client test-publish --build-env testnet --gas-budget ${GAS_BUDGET} --json`,
    { cwd: join(ROOT, "contracts"), encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const pub = JSON.parse(out.slice(out.indexOf("{")));
  if (pub.effects.status.status !== "success") throw new Error("publish failed");
  record("publish (whole package)", pub.effects);
  const pkg = pub.objectChanges.find((c) => c.type === "published").packageId;
  const treasury = pub.objectChanges.find((c) => c.objectType?.includes("::coin::TreasuryCap")).objectId;
  console.log(`  package ${pkg}`);

  const vkOf = (dir, name) => vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, dir, `${name}_vk.json`), "utf-8")));
  const transferVk = vkOf("build", "transfer"), withdrawVk = vkOf("build-withdraw", "withdraw"),
    complianceVk = vkOf("build-compliance", "compliance");
  const bytes = (u8) => Array.from(u8);
  const le32 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

  // ── pools: A (plain transfer + withdraw), B (compliant transfer) ──
  const mkPool = async (label) => {
    const r = await exec(`create_pool (${label})`, (() => {
      const tx = new Transaction();
      tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [tx.pure.vector("u8", bytes(transferVk)),
        tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
      return tx;
    })());
    return {
      pool: r.objectChanges.find((c) => c.objectType?.endsWith("::pool::Pool")).objectId,
      cap: r.objectChanges.find((c) => c.objectType?.endsWith("::pool::AdminCap")).objectId,
    };
  };
  const A = await mkPool("pool A"), B = await mkPool("pool B");

  // ── tokens: faucet mints 1000 TOKEN; split one DENOM coin per deposit ──
  let tx = new Transaction();
  tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] });
  const fr = await exec("token_faucet::faucet", tx);
  const coinId = fr.objectChanges.find((c) => c.type === "created" && c.objectType?.includes("::token::TOKEN")).objectId;

  // ── witnesses that don't depend on the epoch: commitments to deposit ──
  const epochNow = () => BigInt(Math.floor(Date.now() / EPOCH_MS));
  const SECRET_A = 111111111n, SECRET_B = 222222222n, SECRET_W = 333333333n;
  const wA0 = buildTransferWitness(poseidon, { userSecret: SECRET_A, epochId: epochNow(), threshold: THRESHOLD });
  const wB0 = buildTransferWitness(poseidon, { userSecret: SECRET_B, epochId: epochNow(), threshold: THRESHOLD });
  const wW0 = buildWithdrawWitness(poseidon, { userSecret: SECRET_W, recipient: BigInt(RECIPIENT) });

  const deposit = async (label, poolId, commitment) => {
    const t = new Transaction();
    const [c] = t.splitCoins(t.object(coinId), [t.pure.u64(DENOM)]);
    t.moveCall({ target: `${pkg}::pool::deposit_and_register`,
      arguments: [t.object(poolId), c, t.pure.vector("u8", bytes(le32(commitment))), t.object(CLOCK)] });
    return exec(`deposit_and_register (${label})`, t);
  };
  await deposit("pool A / transfer commitment", A.pool, wA0.oldCommitment);
  await deposit("pool A / withdraw commitment", A.pool, wW0.commitment);
  await deposit("pool B / transfer commitment", B.pool, wB0.oldCommitment);

  // ── admin setup (1-epoch timelocks) ──
  const adminCall = (label, fn, args) => {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::${fn}`, arguments: args(t) });
    return exec(`${fn} (${label})`, t);
  };
  await adminCall("pool A", "update_commitment_root", (t) => [t.object(A.pool), t.object(A.cap),
    t.pure.vector("u8", bytes(le32(wA0.merkleRoot))), t.object(CLOCK)]);
  await adminCall("pool B", "update_commitment_root", (t) => [t.object(B.pool), t.object(B.cap),
    t.pure.vector("u8", bytes(le32(wB0.merkleRoot))), t.object(CLOCK)]);
  await adminCall("pool A", "propose_withdraw_vk", (t) => [t.object(A.pool), t.object(A.cap),
    t.pure.vector("u8", bytes(withdrawVk)), t.object(CLOCK)]);

  // compliance config on pool B (credential root from a throwaway compliance witness; epoch-independent)
  const EXPIRY = 1_000_000_000n; // epochs; credential leaf (hence root) must be identical in cw0 and cw
  const cw0 = buildComplianceWitness(poseidon, { userSecret: SECRET_B, expiryEpoch: EXPIRY });
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::compliance::create_compliance_config`, arguments: [
    tx.object(B.cap), tx.object(B.pool), tx.pure.vector("u8", bytes(complianceVk)),
    tx.pure.vector("u8", bytes(le32(cw0.merkleRoot))), tx.pure.u64(1),
    tx.pure.vector("u8", bytes(new Uint8Array(65).fill(4)))] });
  const cr = await exec("create_compliance_config", tx);
  const configId = cr.objectChanges.find((c) => c.objectType?.endsWith("::compliance::ComplianceConfig")).objectId;

  // ── wait for the next epoch boundary (timelocks + commitment maturity) ──
  const target = (epochNow() + 1n) * BigInt(EPOCH_MS);
  const waitMs = Number(target - BigInt(Date.now())) + 2000;
  console.log(`\n  waiting ${(waitMs / 1000).toFixed(1)}s for epoch boundary...\n`);
  await new Promise((r) => setTimeout(r, waitMs));

  // ── real proofs bound to the live epoch ──
  const prove = async (circuit, dir, inputs) => {
    const t0 = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInputs(inputs),
      join(CIRCUITS, dir, `${circuit}_js`, `${circuit}.wasm`), join(CIRCUITS, dir, `${circuit}_final.zkey`));
    const vk = JSON.parse(readFileSync(join(CIRCUITS, dir, `${circuit}_vk.json`), "utf-8"));
    if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${circuit}: local verify failed`);
    console.log(`  proved ${circuit} in ${Date.now() - t0} ms`);
    return { proof: bytes(proofToSuiBytes(proof)), inputs: bytes(publicInputsToSuiBytes(publicSignals)) };
  };
  const E = epochNow();
  const wA = buildTransferWitness(poseidon, { userSecret: SECRET_A, epochId: E, threshold: THRESHOLD });
  const wB = buildTransferWitness(poseidon, { userSecret: SECRET_B, epochId: E, threshold: THRESHOLD });
  const cw = buildComplianceWitness(poseidon, { userSecret: SECRET_B, currentEpoch: E, expiryEpoch: EXPIRY,
    transferNullifier: wB.nullifier });
  const pA = await prove("transfer", "build", wA);
  const pB = await prove("transfer", "build", wB);
  const pC = await prove("compliance", "build-compliance", cw);
  const pW = await prove("withdraw", "build-withdraw", wW0);

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(A.pool),
    tx.pure.vector("u8", pA.proof), tx.pure.vector("u8", pA.inputs), tx.object(CLOCK)] });
  await exec("shielded_transfer", tx, { proofSystem: "groth16/bn254", publicInputs: 7 });

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(A.pool),
    tx.pure.vector("u8", pW.proof), tx.pure.vector("u8", pW.inputs), tx.pure.address(RECIPIENT), tx.object(CLOCK)] });
  await exec("zk_withdraw", tx, { publicInputs: 5 });

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::compliance::compliant_transfer`, arguments: [tx.object(B.pool), tx.object(configId),
    tx.pure.vector("u8", pB.proof), tx.pure.vector("u8", pB.inputs),
    tx.pure.vector("u8", pC.proof), tx.pure.vector("u8", pC.inputs),
    tx.pure.vector("u8", bytes(new Uint8Array(93).fill(7))), tx.object(CLOCK)] });
  await exec("compliant_transfer (2 proofs)", tx, { publicInputs: 7 + 6 });

  // ── cheap admin ops, for scale ──
  await adminCall("pool A", "freeze_pool", (t) => [t.object(A.pool), t.object(A.cap), t.object(CLOCK)]);
  await adminCall("pool A", "unfreeze_pool", (t) => [t.object(A.pool), t.object(A.cap)]);

  console.log("\n=== Summary (MIST; 1 SUI = 1e9 MIST) ===");
  console.log("| Entry point | computationCost | storageCost | storageRebate | net |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.name} | ${r.computationCost} | ${r.storageCost} | ${r.storageRebate} | ${r.net} |`);
  console.log(`\nreference gas price: ${rgp} MIST/unit; computation units = computationCost / ${rgp}`);
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ rgp: String(rgp), rows }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log(`wrote ${jsonOut}`);
  }
}

main().catch((e) => { console.error("gas-localnet failed:", e); process.exit(1); });
