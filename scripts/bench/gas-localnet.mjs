#!/usr/bin/env node
/**
 * gas-localnet.mjs — On-chain gas per Veil entry point, measured on a local Sui network with
 * real Groth16 proofs (no mocks, no `sui move test` stubs).
 *
 * Usage (from repo root):
 *   sui start --force-regenesis --with-faucet &          # local network, JSON-RPC on :9000
 *   sui client switch --env local && sui client faucet   # fund the active address
 *   node scripts/bench/gas-localnet.mjs [--out docs/research/gas-localnet.json]
 *
 * Prerequisites:
 *   - circuits compiled: circuits/build{,-withdraw,-compliance}/ (see circuits/scripts/compile*.sh)
 *   - `bun install` in scripts/ (for @mysten/sui) and `npm install` in scripts/bench/
 *
 * What it does: publishes the package, creates a plain pool and a compliance pool, deposits,
 * waits one epoch (60 s, the contract minimum — commitments must mature and timelocked
 * updates must take effect), then runs shielded_transfer / zk_withdraw / compliant_transfer
 * with proofs generated at the current on-chain epoch. Every gasUsed figure comes from the
 * transaction effects returned by the node.
 *
 * Gas fields (MIST): computationCost (what verification + execution cost), storageCost (new
 * bytes written), storageRebate (refund for deleted bytes), net = computation + storage - rebate.
 * Computation is deterministic for a given protocol version and reference gas price; storage
 * depends on the protocol's storage price per byte.
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
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { buildTransferWitness, buildWithdrawWitness, buildComplianceWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes, bigintToLE32 } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");
const RPC_URL = process.env.SUI_RPC_URL ?? "http://127.0.0.1:9000";
const CLOCK = "0x6";
const EPOCH_MS = 60_000; // contract minimum (E_INVALID_EPOCH_DURATION)
const THRESHOLD = 1_000_000_000n; // matches buildTransferWitness
const BUDGET = 500_000_000;
const PUBFILE = join(process.env.TMPDIR ?? "/tmp", `veil-gas-pub-${Date.now()}.toml`);
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx !== -1 ? process.argv[outIdx + 1] : null;

const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
const rows = [];

function loadKeypair() {
  const addr = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const ks = JSON.parse(readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf-8"));
  for (const k of ks) {
    const raw = fromBase64(k);
    if (raw[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (kp.toSuiAddress() === addr) return kp;
  }
  throw new Error(`no ed25519 key for ${addr}`);
}
const kp = loadKeypair();
const sender = kp.toSuiAddress();

function record(label, effects, extra = {}) {
  const g = effects.gasUsed;
  const comp = BigInt(g.computationCost), sto = BigInt(g.storageCost), reb = BigInt(g.storageRebate);
  const row = {
    label, status: effects.status.status,
    computationCost: comp.toString(), storageCost: sto.toString(), storageRebate: reb.toString(),
    net: (comp + sto - reb).toString(), ...extra,
  };
  rows.push(row);
  console.log(`[gas] ${label.padEnd(38)} ${row.status.padEnd(8)} comp=${comp} storage=${sto} rebate=${reb} net=${row.net}`);
  return row;
}

/** Execute a transaction; record gas whether it succeeds or aborts (aborted txs still pay). */
async function run(label, build, { expectFail = false, extra = {} } = {}) {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(BUDGET);
  build(tx);
  const res = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const ok = res.effects.status.status === "success";
  if (ok === expectFail) {
    throw new Error(`${label}: expected ${expectFail ? "failure" : "success"}, got ${JSON.stringify(res.effects.status)}`);
  }
  record(label, res.effects, { digest: res.digest, ...extra });
  return res;
}

const bytes = (u8) => Array.from(u8);
const created = (res, needle) =>
  res.objectChanges.find((c) => c.type === "created" && c.objectType?.includes(needle))?.objectId;

function publish() {
  const out = execSync(`sui client test-publish --build-env local --pubfile-path ${PUBFILE} --gas-budget ${BUDGET} --json`, {
    cwd: join(ROOT, "contracts"), encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
  });
  const r = JSON.parse(out.slice(out.indexOf("{")));
  if (r.effects.status.status !== "success") throw new Error("publish failed");
  record("publish (whole package)", r.effects, { digest: r.digest });
  return {
    pkg: r.objectChanges.find((c) => c.type === "published").packageId,
    treasury: r.objectChanges.find((c) => c.type === "created" && c.objectType.includes("::coin::TreasuryCap")).objectId,
  };
}

const epochNow = () => BigInt(Math.floor(Date.now() / EPOCH_MS));

async function sleepUntilEpoch(target) {
  while (epochNow() < target) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 1500)); // clock-object lag margin
}

async function groth16(circuit, dir, input) {
  const t = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    stringifyInputs(input),
    join(CIRCUITS, dir, `${circuit}_js`, `${circuit}.wasm`),
    join(CIRCUITS, dir, `${circuit}_final.zkey`),
  );
  const vk = JSON.parse(readFileSync(join(CIRCUITS, dir, `${circuit}_vk.json`), "utf-8"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${circuit}: local verify failed`);
  console.log(`[prove] ${circuit} ${(performance.now() - t).toFixed(0)} ms, ${publicSignals.length} public signals`);
  return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals), publicSignals };
}

function vkFile(circuit, dir) {
  return vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, dir, `${circuit}_vk.json`), "utf-8")));
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const meta = {
    rpc: RPC_URL, chain: await client.getChainIdentifier(), epochMs: EPOCH_MS,
    referenceGasPrice: String(await client.getReferenceGasPrice()),
    sui: execSync("sui --version", { encoding: "utf-8" }).trim(),
  };
  console.log(`[env] ${JSON.stringify(meta)}`);

  // ---------------- setup (epoch E) ----------------
  const { pkg, treasury } = publish();
  const transferVk = vkFile("transfer", "build");
  const withdrawVk = vkFile("withdraw", "build-withdraw");
  const complianceVk = vkFile("compliance", "build-compliance");
  meta.vkBytes = { transfer: transferVk.length, withdraw: withdrawVk.length, compliance: complianceVk.length };

  // Pool A: shielded_transfer + zk_withdraw + admin ops. Pool B: compliant_transfer.
  const mkPool = async (label) => {
    const r = await run(label, (tx) =>
      tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [
        tx.pure.vector("u8", bytes(transferVk)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS) ] }));
    return { pool: created(r, "::pool::Pool"), cap: created(r, "::pool::AdminCap") };
  };
  const A = await mkPool("create_pool (transfer VK 488 B)");
  const B = await mkPool("create_pool (second pool)");

  // Note: the Merkle root and the old commitment do not depend on epoch, so the setup witness
  // fixes the commitments/root; the proving witness is rebuilt below at the live epoch.
  const setupT = buildTransferWitness(poseidon, { epochId: 0n });
  const setupW = buildWithdrawWitness(poseidon);
  const le = (n) => bytes(bigintToLE32(n));

  const faucet = async (n) => {
    const coins = [];
    for (let i = 0; i < n; i++) {
      const r = await run(`faucet (test helper) #${i + 1}`, (tx) =>
        tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] }));
      coins.push(created(r, "::token::TOKEN"));
    }
    return coins;
  };
  const coins = await faucet(4);
  const deposit = (label, pool, coin, commitment) =>
    run(label, (tx) => tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [
      tx.object(pool), tx.object(coin), tx.pure.vector("u8", commitment), tx.object(CLOCK) ] }));
  await deposit("deposit_and_register (1st leaf in pool)", A.pool, coins[0], le(setupT.oldCommitment));
  await deposit("deposit_and_register (2nd leaf in pool)", A.pool, coins[1], le(setupW.commitment));
  await deposit("deposit_and_register (compliance pool)", B.pool, coins[2], le(setupT.oldCommitment));

  const adminCall = (label, fn, args, o) =>
    run(label, (tx) => tx.moveCall({ target: `${pkg}::${fn}`, arguments: args(tx) }), o);

  await adminCall("update_commitment_root (pool A)", "pool::update_commitment_root", (tx) =>
    [tx.object(A.pool), tx.object(A.cap), tx.pure.vector("u8", le(setupT.merkleRoot)), tx.object(CLOCK)]);
  await adminCall("update_commitment_root (pool B)", "pool::update_commitment_root", (tx) =>
    [tx.object(B.pool), tx.object(B.cap), tx.pure.vector("u8", le(setupT.merkleRoot)), tx.object(CLOCK)]);
  await adminCall("propose_withdraw_vk (withdraw VK 424 B)", "pool::propose_withdraw_vk", (tx) =>
    [tx.object(A.pool), tx.object(A.cap), tx.pure.vector("u8", bytes(withdrawVk)), tx.object(CLOCK)]);

  const setupCW = buildComplianceWitness(poseidon, { currentEpoch: 0n, expiryEpoch: 10n ** 12n });
  const auditorKey = new Uint8Array(33).fill(2);
  const cfgRes = await run("create_compliance_config", (tx) =>
    tx.moveCall({ target: `${pkg}::compliance::create_compliance_config`, arguments: [
      tx.object(B.cap), tx.object(B.pool), tx.pure.vector("u8", bytes(complianceVk)),
      tx.pure.vector("u8", le(setupCW.merkleRoot)), tx.pure.u64(1), tx.pure.vector("u8", bytes(auditorKey)) ] }));
  const cfg = created(cfgRes, "::compliance::ComplianceConfig");

  // timelocked admin ops proposed now, executed/cancelled later
  await adminCall("propose_withdrawal", "pool::propose_withdrawal", (tx) =>
    [tx.object(A.pool), tx.object(A.cap), tx.pure.u64(1000), tx.pure.address(sender), tx.object(CLOCK)]);
  await adminCall("propose_vk_update", "pool::propose_vk_update", (tx) =>
    [tx.object(A.pool), tx.object(A.cap), tx.pure.vector("u8", bytes(transferVk)), tx.object(CLOCK)]);
  await adminCall("cancel_vk_update", "pool::cancel_vk_update", (tx) => [tx.object(A.pool), tx.object(A.cap)]);
  await adminCall("freeze_pool", "pool::freeze_pool", (tx) => [tx.object(A.pool), tx.object(A.cap), tx.object(CLOCK)]);
  await adminCall("unfreeze_pool", "pool::unfreeze_pool", (tx) => [tx.object(A.pool), tx.object(A.cap)]);

  // ---------------- wait for the next epoch ----------------
  const setupEpoch = epochNow();
  console.log(`[wait] setup finished in epoch ${setupEpoch}; sleeping to ${setupEpoch + 1n}`);
  await sleepUntilEpoch(setupEpoch + 1n);
  const E = epochNow();
  console.log(`[epoch] proving at epoch ${E}`);

  // ---------------- proofs at the live epoch ----------------
  const t = await groth16("transfer", "build", buildTransferWitness(poseidon, { epochId: E }));
  const w = await groth16("withdraw", "build-withdraw", buildWithdrawWitness(poseidon));
  const tNullifier = BigInt(t.publicSignals[4]);
  const c = await groth16("compliance", "build-compliance",
    buildComplianceWitness(poseidon, { currentEpoch: E, transferNullifier: tNullifier, expiryEpoch: 10n ** 12n }));

  const callTransfer = (pool, inputs) => (tx) => tx.moveCall({
    target: `${pkg}::pool::shielded_transfer`,
    arguments: [tx.object(pool), tx.pure.vector("u8", bytes(t.proof)), tx.pure.vector("u8", bytes(inputs)), tx.object(CLOCK)] });

  // negative control: valid proof, one public input tampered -> Groth16 verify returns false.
  // The tx aborts with E_INVALID_PROOF (3) *after* prepare_verifying_key + verify, so its
  // computation cost approximates the verification-dominated share of a transfer.
  const tampered = t.inputs.slice();
  tampered[5 * 32] ^= 1; // txAmountHash
  const bad = await run("shielded_transfer, TAMPERED input (abort)", callTransfer(A.pool, tampered), { expectFail: true });
  console.log(`[neg] ${JSON.stringify(bad.effects.status)}`);

  await run("shielded_transfer (valid proof)", callTransfer(A.pool, t.inputs));
  const replay = await run("shielded_transfer REPLAY (abort)", callTransfer(A.pool, t.inputs), { expectFail: true });
  console.log(`[neg] ${JSON.stringify(replay.effects.status)}`);

  await run("zk_withdraw (valid proof)", (tx) => tx.moveCall({
    target: `${pkg}::pool::zk_withdraw`,
    arguments: [tx.object(A.pool), tx.pure.vector("u8", bytes(w.proof)), tx.pure.vector("u8", bytes(w.inputs)),
      tx.pure.address(`0x${(0xABCDEF123456n).toString(16).padStart(64, "0")}`), tx.object(CLOCK)] }));

  const encAmount = new Uint8Array(93).fill(7); // contract minimum: 65 ephemeral key + 12 IV + 16 tag
  await run("compliant_transfer (dual proof)", (tx) => tx.moveCall({
    target: `${pkg}::compliance::compliant_transfer`,
    arguments: [tx.object(B.pool), tx.object(cfg), tx.pure.vector("u8", bytes(t.proof)),
      tx.pure.vector("u8", bytes(t.inputs)), tx.pure.vector("u8", bytes(c.proof)),
      tx.pure.vector("u8", bytes(c.inputs)), tx.pure.vector("u8", bytes(encAmount)), tx.object(CLOCK)] }));

  await adminCall("execute_pending_withdrawal", "pool::execute_pending_withdrawal", (tx) =>
    [tx.object(A.pool), tx.object(A.cap), tx.object(CLOCK)]);

  const result = { meta, rows };
  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  console.log("\n=== SUMMARY (MIST) ===");
  console.table(rows.map((r) => ({ label: r.label, status: r.status, computation: r.computationCost, storage: r.storageCost, rebate: r.storageRebate, net: r.net })));
}

main().then(() => process.exit(0)).catch((e) => { console.error("[FATAL]", e); process.exit(1); });
