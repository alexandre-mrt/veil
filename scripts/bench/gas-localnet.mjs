#!/usr/bin/env node
/**
 * gas-localnet.mjs — on-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Publishes contracts/ to a LOCAL network (`sui start --force-regenesis --with-faucet`), drives
 * every user-facing entry point with REAL Groth16 proofs, and reads `effects.gasUsed` from each
 * executed transaction. Nothing is estimated or simulated: each row is a transaction that was
 * executed by a validator and returned by the fullnode.
 *
 * Usage (from scripts/bench, with a local network already running):
 *   node gas-localnet.mjs [--out results.json]
 *
 * Env:
 *   SUI_BIN         path to the `sui` binary                      (default: `sui` on PATH)
 *   CONTRACTS_DIR   Move package to publish                       (default: ../../contracts)
 *   SUI_RPC         fullnode JSON-RPC URL                         (default: http://127.0.0.1:9000)
 *   SUI_FAUCET      faucet base URL                               (default: http://127.0.0.1:9123)
 *
 * Prerequisites: circuits compiled to circuits/build{,-withdraw,-compliance}/ exactly as for
 * prove-latency.mjs (r1cs + wasm + *_final.zkey + *_vk.json), `npm ci` in this directory.
 *
 * Epoch handling: the pool is created with the minimum epoch (60 s) so the 1-epoch timelocks
 * (commitment root, withdraw VK) and the commitment-maturity rule can be crossed in real time.
 * The script therefore takes ~2-3 minutes, almost all of it waiting for one epoch boundary.
 *
 * Reported per transaction (MIST): computationCost, storageCost, storageRebate, and
 * net = computation + storage - rebate. `computationUnits` = computationCost / referenceGasPrice
 * (price-independent; Sui buckets computation, minimum 1000 units).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import {
  WITNESS_BUILDERS, buildTransferWitness, buildWithdrawWitness, buildComplianceWitness,
  merkleRootFromPath, setPoseidonField, stringifyInputs,
} from "./witnesses.mjs";
import {
  proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes,
} from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = join(__dirname, "..", "..", "circuits");
const SUI_BIN = process.env.SUI_BIN ?? "sui";
const CONTRACTS_DIR = process.env.CONTRACTS_DIR ?? join(__dirname, "..", "..", "contracts");
const RPC = process.env.SUI_RPC ?? "http://127.0.0.1:9000";
const FAUCET = process.env.SUI_FAUCET ?? "http://127.0.0.1:9123";
const OUT = (() => { const i = process.argv.indexOf("--out"); return i !== -1 ? process.argv[i + 1] : null; })();

const CLOCK = "0x6";
const EPOCH_MS = 60_000;          // pool.move minimum epoch duration
const THRESHOLD = 1_000_000_000n; // transfer-circuit threshold == pool threshold
const GAS_BUDGET = 500_000_000;
const DEPTH = 20;

const rows = [];
let rgp = 0n;

function art(name, dir) {
  const base = join(CIRCUITS, dir);
  return {
    wasm: join(base, `${name}_js`, `${name}.wasm`),
    zkey: join(base, `${name}_final.zkey`),
    vk: JSON.parse(readFileSync(join(base, `${name}_vk.json`), "utf-8")),
  };
}
const ART = {
  transfer: art("transfer", "build"),
  withdraw: art("withdraw", "build-withdraw"),
  compliance: art("compliance", "build-compliance"),
};

async function prove(name, inputs) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    stringifyInputs(inputs), ART[name].wasm, ART[name].zkey);
  if (!(await snarkjs.groth16.verify(ART[name].vk, publicSignals, proof))) {
    throw new Error(`${name}: local verification failed`);
  }
  return { proofBytes: proofToSuiBytes(proof), inputBytes: publicInputsToSuiBytes(publicSignals) };
}

const be32 = (n) => { // 32-byte LE of a bigint, as Sui expects field elements
  const b = new Uint8Array(32); let v = n;
  for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const kp = new Ed25519Keypair();
const me = kp.toSuiAddress();

async function exec(label, build, { expectFail = false, group = "" } = {}) {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);
  const r = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  const status = r.effects.status;
  const ok = status.status === "success";
  if (ok === expectFail) {
    throw new Error(`${label}: expected ${expectFail ? "failure" : "success"}, got ${JSON.stringify(status)}`);
  }
  const g = r.effects.gasUsed;
  const comp = BigInt(g.computationCost), stor = BigInt(g.storageCost), reb = BigInt(g.storageRebate);
  const row = {
    label, group, status: ok ? "success" : `abort: ${status.error}`,
    computationUnits: Number(comp / rgp), computationCost: Number(comp),
    storageCost: Number(stor), storageRebate: Number(reb),
    nonRefundableStorageFee: Number(g.nonRefundableStorageFee),
    net: Number(comp + stor - reb), digest: r.digest,
  };
  rows.push(row);
  console.log(`${label.padEnd(46)} ${ok ? "ok   " : "ABORT"} comp=${String(row.computationCost).padStart(9)} stor=${String(row.storageCost).padStart(9)} rebate=${String(row.storageRebate).padStart(9)} net=${String(row.net).padStart(9)}`);
  return r;
}

function created(r, frag) {
  const c = r.objectChanges.find((x) => x.type === "created" && x.objectType?.includes(frag));
  if (!c) throw new Error(`no created object matching ${frag}`);
  return c.objectId;
}

async function waitForNextEpoch(extraMs = 4000) {
  const now = Date.now();
  const target = (Math.floor(now / EPOCH_MS) + 1) * EPOCH_MS + extraMs;
  console.log(`\n-- waiting ${((target - now) / 1000).toFixed(0)}s for the next pool epoch boundary --\n`);
  await new Promise((res) => setTimeout(res, target - now));
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const H = (a, b) => poseidon.F.toObject(poseidon([a, b]));

  rgp = BigInt(await client.getReferenceGasPrice());
  const pv = await client.getRpcApiVersion();
  console.log(`rpc api ${pv}, reference gas price ${rgp} MIST/unit, signer ${me}`);
  console.log(`sui binary: ${execFileSync(SUI_BIN, ["--version"], { encoding: "utf-8" }).trim()}\n`);

  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await new Promise((r) => setTimeout(r, 2500));

  // ── cost floor: a plain SUI transfer ───────────────────────────────────
  await exec("sui transfer (floor, 1 coin split+send)", (tx) => {
    const [c] = tx.splitCoins(tx.gas, [1000]);
    tx.transferObjects([c], "0x" + "11".repeat(32));
  }, { group: "floor" });

  // ── publish ───────────────────────────────────────────────────────────
  const built = JSON.parse(execFileSync(
    SUI_BIN, ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", CONTRACTS_DIR],
    { encoding: "utf-8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).replace(/^[^{]*/, ""));
  const pub = await exec("publish (all 6 modules)", (tx) => {
    const [cap] = tx.publish({ modules: built.modules, dependencies: built.dependencies });
    tx.transferObjects([cap], me);
  }, { group: "setup" });
  const pkg = pub.objectChanges.find((x) => x.type === "published").packageId;
  const treasury = created(pub, "::coin::TreasuryCap");

  // ── pool + withdraw VK + compliance config ────────────────────────────
  const vkT = vkToSuiBytes(ART.transfer.vk), vkW = vkToSuiBytes(ART.withdraw.vk), vkC = vkToSuiBytes(ART.compliance.vk);
  const cp = await exec("pool::create_pool", (tx) => {
    tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [
      tx.pure.vector("u8", [...vkT]), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
  }, { group: "admin" });
  const pool = created(cp, "::pool::Pool");
  const adminCap = created(cp, "::pool::AdminCap");

  await exec("pool::propose_withdraw_vk", (tx) => {
    tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [
      tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", [...vkW]), tx.object(CLOCK)] });
  }, { group: "admin" });

  // Credential tree for the compliance proof: the builder's own zero-sibling path.
  const cw0 = buildComplianceWitness(poseidon, { userSecret: 555n, currentEpoch: 0n, expiryEpoch: 1n << 40n });
  const credentialRoot = cw0.merkleRoot;
  const cc = await exec("compliance::create_compliance_config", (tx) => {
    tx.moveCall({ target: `${pkg}::compliance::create_compliance_config`, arguments: [
      tx.object(adminCap), tx.object(pool), tx.pure.vector("u8", [...vkC]),
      tx.pure.vector("u8", [...be32(credentialRoot)]), tx.pure.u64(1),
      tx.pure.vector("u8", Array.from({ length: 65 }, (_, i) => 2 + (i % 7)))] });
  }, { group: "compliance" });
  const config = created(cc, "::compliance::ComplianceConfig");

  // ── commitments: leaf 0 = transfer, leaf 1 = compliant transfer, leaves 2.. = PTB probe ──
  const T = { userSecret: 111n }, C = { userSecret: 222n };
  const t0 = buildTransferWitness(poseidon, T), c0 = buildTransferWitness(poseidon, C);
  const w0 = buildWithdrawWitness(poseidon, { userSecret: 333n });
  const PTB_SIZES = [2, 4, 6, 8];
  const extraSecrets = Array.from({ length: PTB_SIZES.reduce((a, b) => a + b, 0) }, (_, i) => BigInt(1000 + i));
  const extra = extraSecrets.map((userSecret) => ({ userSecret, w: buildTransferWitness(poseidon, { userSecret }) }));
  const leaves = [t0.oldCommitment, c0.oldCommitment, ...extra.map((e) => e.w.oldCommitment)];

  // Sparse depth-20 tree, empty node at level l = zeros[l] (zeros[0] = 0).
  const zeros = [0n]; for (let i = 0; i < DEPTH; i++) zeros.push(H(zeros[i], zeros[i]));
  const levels = [leaves];
  for (let l = 0; l < DEPTH; l++) {
    const lv = levels[l], next = [];
    for (let j = 0; j < Math.max(1, Math.ceil(lv.length / 2)); j++) next.push(H(lv[2 * j] ?? zeros[l], lv[2 * j + 1] ?? zeros[l]));
    levels.push(next);
  }
  const rootT = levels[DEPTH][0];
  const pathFor = (i) => ({
    pathElements: Array.from({ length: DEPTH }, (_, l) => levels[l][(i >> l) ^ 1] ?? zeros[l]),
    pathIndices: Array.from({ length: DEPTH }, (_, l) => BigInt((i >> l) & 1)),
  });
  const pathT = pathFor(0), pathC = pathFor(1);
  if (merkleRootFromPath(poseidon, leaves[1], pathC.pathElements, pathC.pathIndices) !== rootT) {
    throw new Error("merkle tree construction mismatch");
  }

  const deposit = async (label, commitment) => {
    const m = await exec("token_faucet::faucet (setup, not a Veil entry)", (tx) => {
      tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] });
    }, { group: "setup" });
    const coin = m.objectChanges.find((x) => x.type === "created" && x.objectType?.includes("::token::TOKEN"));
    await exec(label, (tx) => {
      tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [
        tx.object(pool), tx.object(coin.objectId), tx.pure.vector("u8", [...be32(commitment)]), tx.object(CLOCK)] });
    }, { group: "deposit" });
  };
  await deposit("pool::deposit_and_register (leaf 0)", t0.oldCommitment);
  await deposit("pool::deposit_and_register (leaf 1)", c0.oldCommitment);
  await deposit("pool::deposit_and_register (withdraw leaf)", w0.commitment);
  for (let i = 0; i < extra.length; i++) await deposit(`pool::deposit_and_register (probe leaf ${i})`, extra[i].w.oldCommitment);

  await exec("pool::update_commitment_root (propose)", (tx) => {
    tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [
      tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", [...be32(rootT)]), tx.object(CLOCK)] });
  }, { group: "admin" });

  await waitForNextEpoch();
  const epoch = BigInt(Math.floor(Date.now() / EPOCH_MS));

  // ── proofs, all bound to the live epoch ───────────────────────────────
  const tWit = buildTransferWitness(poseidon, { ...T, epochId: epoch, ...pathT });
  const cWit = buildTransferWitness(poseidon, { ...C, epochId: epoch, ...pathC });
  const kyc = buildComplianceWitness(poseidon, {
    userSecret: 555n, currentEpoch: epoch, expiryEpoch: 1n << 40n, transferNullifier: cWit.nullifier });
  if (kyc.merkleRoot !== credentialRoot) throw new Error("credential root drifted");
  const wWit = buildWithdrawWitness(poseidon, { userSecret: 333n });

  const pT = await prove("transfer", tWit), pC = await prove("transfer", cWit);
  const pK = await prove("compliance", kyc), pW = await prove("withdraw", wWit);
  console.log(`proof bytes ${pT.proofBytes.length}, transfer inputs ${pT.inputBytes.length}B, ` +
    `compliance inputs ${pK.inputBytes.length}B, withdraw inputs ${pW.inputBytes.length}B\n`);

  const call = (tx, p, extra = {}) => tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [
    tx.object(pool), tx.pure.vector("u8", [...(extra.proof ?? p.proofBytes)]),
    tx.pure.vector("u8", [...(extra.inputs ?? p.inputBytes)]), tx.object(CLOCK)] });

  // Rejected transfers first (aborted txs leave state untouched). `early` aborts on the
  // threshold check BEFORE the pairing; `late` runs the full Groth16 verify and then aborts.
  const early = new Uint8Array(pT.inputBytes); early[64] ^= 1; // threshold LSB
  await exec("shielded_transfer REJECTED early (threshold, pre-pairing)", (tx) =>
    call(tx, pT, { inputs: early }), { expectFail: true, group: "rejected" });
  const late = new Uint8Array(pT.inputBytes); late[160] ^= 1; // txAmountHash: only the pairing notices
  await exec("shielded_transfer REJECTED late (bad proof, post-pairing)", (tx) =>
    call(tx, pT, { inputs: late }), { expectFail: true, group: "rejected" });

  await exec("pool::shielded_transfer", (tx) => call(tx, pT), { group: "transfer" });
  await exec("pool::shielded_transfer REPLAY (nullifier/commitment spent)", (tx) => call(tx, pT),
    { expectFail: true, group: "rejected" });

  await exec("compliance::compliant_transfer (2 proofs)", (tx) => {
    tx.moveCall({ target: `${pkg}::compliance::compliant_transfer`, arguments: [
      tx.object(pool), tx.object(config),
      tx.pure.vector("u8", [...pC.proofBytes]), tx.pure.vector("u8", [...pC.inputBytes]),
      tx.pure.vector("u8", [...pK.proofBytes]), tx.pure.vector("u8", [...pK.inputBytes]),
      tx.pure.vector("u8", Array.from({ length: 93 }, (_, i) => i)), tx.object(CLOCK)] });
  }, { group: "transfer" });

  const recipient = "0x" + wWit.recipient.toString(16).padStart(64, "0");
  await exec("pool::zk_withdraw", (tx) => {
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [
      tx.object(pool), tx.pure.vector("u8", [...pW.proofBytes]), tx.pure.vector("u8", [...pW.inputBytes]),
      tx.pure.address(recipient), tx.object(CLOCK)] });
  }, { group: "withdraw" });

  // ── PTB probe: k shielded_transfers in ONE transaction (distinct users, distinct leaves) ──
  // Isolates what an extra Groth16 verification costs once the 1000-unit floor is crossed.
  let leaf = 2;
  for (const k of PTB_SIZES) {
    const ps = [];
    for (let j = 0; j < k; j++, leaf++) {
      ps.push(await prove("transfer", buildTransferWitness(poseidon, {
        userSecret: extraSecrets[leaf - 2], epochId: epoch, ...pathFor(leaf) })));
    }
    await exec(`PTB: ${k} x shielded_transfer in one tx`, (tx) => ps.forEach((p) => call(tx, p)), { group: `ptb${k}` });
  }

  // ── remaining admin entry points ─────────────────────────────────────
  await exec("pool::propose_vk_update", (tx) => {
    tx.moveCall({ target: `${pkg}::pool::propose_vk_update`, arguments: [
      tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", [...vkT]), tx.object(CLOCK)] });
  }, { group: "admin" });
  await exec("pool::cancel_vk_update", (tx) => {
    tx.moveCall({ target: `${pkg}::pool::cancel_vk_update`, arguments: [tx.object(pool), tx.object(adminCap)] });
  }, { group: "admin" });
  await exec("pool::freeze_pool", (tx) => {
    tx.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [tx.object(pool), tx.object(adminCap), tx.object(CLOCK)] });
  }, { group: "admin" });
  await exec("pool::unfreeze_pool", (tx) => {
    tx.moveCall({ target: `${pkg}::pool::unfreeze_pool`, arguments: [tx.object(pool), tx.object(adminCap)] });
  }, { group: "admin" });

  console.log("\n=== summary (MIST; computation units = computationCost / referenceGasPrice) ===");
  const result = { rgp: Number(rgp), rpcApi: pv, suiVersion: execFileSync(SUI_BIN, ["--version"], { encoding: "utf-8" }).trim(), rows };
  if (OUT) { writeFileSync(OUT, JSON.stringify(result, null, 2)); console.log(`wrote ${OUT}`); }
  console.table(rows.map((r) => ({ label: r.label, units: r.computationUnits, comp: r.computationCost, storage: r.storageCost, rebate: r.storageRebate, net: r.net, status: r.status === 'success' ? 'success' : 'abort ' + (r.status.match(/, (\d+)\)/)?.[1] ?? '?') })));
}

// snarkjs/ffjavascript leave worker threads alive after groth16 calls (see EXPERIMENTS.md item 12),
// so exit explicitly once the table is printed.
main().then(() => process.exit(0), (e) => { console.error("FATAL", e); process.exit(1); });
