#!/usr/bin/env node
/**
 * gas-localnet.mjs — On-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Publishes a COPY of contracts/ (plus scripts/bench/move/gasbench.move, bench-only) to a local
 * network, then drives the real protocol flow with real Groth16 proofs:
 *   faucet -> create_pool -> deposit_and_register x4 -> update_commitment_root ->
 *   propose_withdraw_vk -> (wait one epoch) -> shielded_transfer x2 -> zk_withdraw ->
 *   create_compliance_config -> compliant_transfer, plus verify-only variants that isolate the
 *   Groth16 verifier and the cost of prepare_verifying_key.
 * Every number printed is `effects.gasUsed` of a transaction that was actually executed.
 *
 * Prerequisites:
 *   - `sui` CLI on PATH (or --sui <path>) with an active address on a local network that holds
 *     gas coins, and a local network running:
 *       sui start --force-regenesis --with-faucet   (gRPC :9000, faucet :9123)
 *       sui client new-address ed25519 && sui client faucet
 *   - circuits compiled: circuits/build{,-withdraw,-compliance}/ (see circuits/scripts/compile*.sh)
 *   - cd scripts/bench && npm install
 *
 * Usage:
 *   node scripts/bench/gas-localnet.mjs [--sui <path>] [--rpc http://127.0.0.1:9000] [--json out.json]
 */
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : dflt;
};
const SUI = arg("--sui", "sui");
const RPC = arg("--rpc", "http://127.0.0.1:9000"); // gRPC (JSON-RPC is gone in recent Sui)
const JSON_OUT = arg("--json", null);
const CALIBRATE = !process.argv.includes("--no-calibrate");

const CLOCK = "0x6";
const EPOCH_MS = 60_000; // create_pool minimum
const THRESHOLD = 1_000_000_000n;
const DEPTH = 20;
const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RHASH: 8n };

// ---------------------------------------------------------------------------------------------
let F;
let poseidon;
const H = (xs) => F.toObject(poseidon(xs));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sparse depth-20 Poseidon tree; empty subtree at level i is Z[i] (Z[0]=0, Z[i+1]=H(Z[i],Z[i])). */
function buildTree(leaves) {
  const Z = [0n];
  for (let i = 0; i < DEPTH; i++) Z.push(H([Z[i], Z[i]]));
  let level = new Map(leaves.map((l, i) => [i, l]));
  const paths = leaves.map(() => ({ el: [], idx: [] }));
  const pos = leaves.map((_, i) => i);
  for (let d = 0; d < DEPTH; d++) {
    pos.forEach((p, k) => {
      const sib = level.get(p ^ 1) ?? Z[d];
      paths[k].el.push(sib);
      paths[k].idx.push(BigInt(p & 1));
    });
    const next = new Map();
    for (const p of new Set([...level.keys()].map((k) => k >> 1))) {
      const l = level.get(2 * p) ?? Z[d];
      const r = level.get(2 * p + 1) ?? Z[d];
      next.set(p, H([l, r]));
    }
    level = next;
    pos.forEach((p, k) => (pos[k] = p >> 1));
  }
  return { root: level.get(0), paths };
}

const note = (cum, rnd, secret) => H([D.COMMIT, cum, rnd, secret]);

function transferInputs({ secret, cumOld, rndOld, rndNew, amt, epoch, root, path }) {
  const cumNew = cumOld + amt;
  const salt = 99n;
  return {
    oldCommitment: note(cumOld, rndOld, secret),
    newCommitment: note(cumNew, rndNew, secret),
    threshold: THRESHOLD,
    epochId: epoch,
    nullifier: H([D.NULL, secret, epoch, rndOld]),
    txAmountHash: H([D.TXAMT, amt, salt]),
    merkleRoot: root,
    cumulativeOld: cumOld, cumulativeNew: cumNew, txAmount: amt,
    randomnessOld: rndOld, randomnessNew: rndNew, userSecret: secret, salt,
    pathElements: path.el, pathIndices: path.idx,
  };
}
const str = (o) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

async function prove(name, dir, inputs) {
  const wasm = join(CIRCUITS, dir, `${name}_js`, `${name}.wasm`);
  const zkey = join(CIRCUITS, dir, `${name}_final.zkey`);
  const vk = JSON.parse(readFileSync(join(CIRCUITS, dir, `${name}_vk.json`), "utf-8"));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(str(inputs), wasm, zkey);
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${name}: local verify failed`);
  return {
    proof: proofToSuiBytes(proof),
    inputs: publicInputsToSuiBytes(publicSignals),
    vk: vkToSuiBytes(vk),
  };
}

// ---------------------------------------------------------------------------------------------
const rows = [];
let RGP = 1000n;

// --- raw-unit calibration ----------------------------------------------------------------------
// Sui charges computation = max(1000 units, raw units rounded up to a fine step) x gas price. A whole
// shielded_transfer sits BELOW the 1000-unit floor, so effects.gasUsed alone cannot tell a 10-unit
// entry point from a 900-unit one. We recover raw units with dry-runs (nothing is committed):
// append P copies of a cheap call (gasbench::prepare_only) so the total is far above the floor, and
// subtract the same P copies alone:
//     raw(entry) = units(entry + P*pad) - units(P*pad)
const PADS = 100;
let PAD = null; // { pkg, vk, c }

async function simUnits(client, addr, build, padN = 0) {
  const tx = new Transaction();
  tx.setSender(addr);
  tx.setGasBudget(5_000_000_000);
  build(tx);
  if (padN > 0) {
    const vk = tx.pure.vector("u8", Array.from(PAD.vk));
    for (let k = 0; k < padN; k++) tx.moveCall({ target: `${PAD.pkg}::gasbench::prepare_only`, arguments: [vk] });
  }
  const bytes = await tx.build({ client });
  const out = await client.core.simulateTransaction({ transaction: bytes, include: { effects: true } });
  const t = out.Transaction ?? out.FailedTransaction;
  if (!t.status.success) throw new Error(`sim failed: ${JSON.stringify(t.status)}`);
  return Number(BigInt(t.effects.gasUsed.computationCost) / RGP);
}

/** Per-call raw units of `fn`: slope between N=100 and N=300 copies (both far above the floor). */
async function slope(client, addr, fn) {
  const rep = (n) => (tx) => { for (let k = 0; k < n; k++) fn(tx); };
  const pts = {};
  for (const n of [100, 200, 300]) pts[n] = await simUnits(client, addr, rep(n), 0);
  const perCall = (pts[300] - pts[100]) / 200;
  const midResidual = pts[200] - (pts[100] + pts[300]) / 2; // linearity check (should be ~0)
  return { points: pts, perCall, midResidual };
}

let PAD_BASE = null;
async function rawUnits(client, addr, build) {
  PAD_BASE ??= await simUnits(client, addr, () => {}, PADS);
  const withEntry = await simUnits(client, addr, build, PADS);
  return { rawUnits: withEntry - PAD_BASE, withEntry, padOnly: PAD_BASE };
}

async function run(client, kp, label, build, { expectFail = false, calibrate = CALIBRATE } = {}) {
  let raw = null;
  if (calibrate && PAD && !expectFail) raw = await rawUnits(client, kp.toSuiAddress(), build);
  const tx = new Transaction();
  tx.setGasBudget(500_000_000);
  build(tx);
  let out;
  try {
    out = await client.core.signAndExecuteTransaction({
      transaction: tx, signer: kp, include: { effects: true, objectTypes: true },
    });
  } catch (e) {
    // The SDK dry-runs while building, so an aborting call never reaches execution.
    if (expectFail && /MoveAbort/.test(String(e.message))) {
      const code = /abort code: (\d+)/.exec(e.message)?.[1];
      console.log(`${label.padEnd(44)} abort(${code}) at dry-run — expected`);
      rows.push({ label, status: `abort(${code})` });
      return null;
    }
    throw e;
  }
  const res = out.Transaction ?? out.FailedTransaction;
  await client.core.waitForTransaction({ digest: res.digest });
  const ok = out.$kind === "Transaction" && res.status.success;
  if (ok === expectFail) throw new Error(`${label}: unexpected status ${JSON.stringify(res.status)}`);
  const g = res.effects.gasUsed;
  const comp = BigInt(g.computationCost), st = BigInt(g.storageCost), rb = BigInt(g.storageRebate);
  rows.push({
    label, digest: res.digest, status: ok ? "success" : "abort",
    computationCost: comp, storageCost: st, storageRebate: rb,
    computationUnits: comp / RGP, net: comp + st - rb, raw,
  });
  const rawStr = raw ? ` raw=${raw.rawUnits}u` : "";
  console.log(`${label.padEnd(44)} ok comp=${comp} (${comp / RGP}u${rawStr}) storage=${st} rebate=${rb} net=${comp + st - rb} MIST`);
  return res;
}

const created = (res, frag) =>
  res.effects.changedObjects.find(
    (c) => c.idOperation === "Created" && res.objectTypes[c.objectId]?.includes(frag),
  )?.objectId;
const bytes = (tx, u8) => tx.pure.vector("u8", Array.from(u8));
// same pure input reused across repeated calls inside one PTB (keeps the tx under the size limit)
const onceCache = new WeakMap();
const bytesOnce = (tx, key, u8) => {
  let m = onceCache.get(tx);
  if (!m) onceCache.set(tx, (m = new Map()));
  if (!m.has(key)) m.set(key, bytes(tx, u8));
  return m.get(key);
};

async function main() {
  poseidon = await buildPoseidon();
  F = poseidon.F;

  // --- identity (CLI keystore) ----------------------------------------------------------------
  const addr = execFileSync(SUI, ["client", "active-address"], { encoding: "utf-8" }).trim();
  const keystore = JSON.parse(readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf-8"));
  let kp;
  for (const k of keystore) {
    const raw = fromBase64(k);
    if (raw[0] !== 0) continue;
    const cand = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (cand.toSuiAddress() === addr) kp = cand;
  }
  if (!kp) throw new Error(`no ed25519 key for ${addr}`);
  const client = new SuiGrpcClient({ network: "localnet", baseUrl: RPC });
  RGP = BigInt((await client.core.getReferenceGasPrice()).referenceGasPrice);
  console.log(`address ${addr}  referenceGasPrice ${RGP} MIST/unit  rpc ${RPC}`);

  // --- publish a copy of contracts/ + bench module --------------------------------------------
  const work = mkdtempSync(join(tmpdir(), "veil-gas-"));
  cpSync(join(ROOT, "contracts"), work, { recursive: true });
  cpSync(join(__dirname, "move", "gasbench.move"), join(work, "sources", "gasbench.move"));
  const pub = JSON.parse(
    execFileSync(SUI, ["client", "test-publish", "--build-env", "testnet", "--gas-budget", "1000000000", "--json"], {
      cwd: work, encoding: "utf-8", maxBuffer: 64 << 20,
    }).replace(/^[^{]*/, ""),
  );
  const PKG = pub.objectChanges.find((c) => c.type === "published").packageId;
  const treasury = pub.objectChanges.find((c) => c.objectType?.includes("::coin::TreasuryCap"))?.objectId;
  const pubGas = pub.effects.gasUsed;
  console.log(`published ${PKG}  (publish gas: comp=${pubGas.computationCost} storage=${pubGas.storageCost})`);
  const pubRow = {
    label: "publish (contracts + gasbench)", digest: pub.effects.transactionDigest,
    computationCost: BigInt(pubGas.computationCost), storageCost: BigInt(pubGas.storageCost),
    storageRebate: BigInt(pubGas.storageRebate),
  };
  pubRow.computationUnits = pubRow.computationCost / RGP;
  pubRow.net = pubRow.computationCost + pubRow.storageCost - pubRow.storageRebate;
  rows.push(pubRow);

  // --- credentials: 4 notes, one tree -------------------------------------------------------
  const secrets = [111111n, 222222n, 333333n, 444444n];
  const leaves = secrets.map((s) => note(0n, 0n, s)); // genesis notes (cum=0, rnd=0)
  const tree = buildTree(leaves);
  const DENOM = 100_000_000n;

  // proofs that don't depend on epoch are built after the wait; build VK material now
  const vkT = vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, "build", "transfer_vk.json"), "utf-8")));
  const vkW = vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, "build-withdraw", "withdraw_vk.json"), "utf-8")));
  const vkC = vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, "build-compliance", "compliance_vk.json"), "utf-8")));

  // --- calibrate the padding call (prepare_only) once ----------------------------------------
  const slopes = {};
  PAD = { pkg: PKG, vk: vkT, c: 0 };
  if (CALIBRATE) {
    const padVk = (tx) => bytesOnce(tx, "vk", vkT);
    slopes.prepare_only = await slope(client, addr, (tx) =>
      tx.moveCall({ target: `${PKG}::gasbench::prepare_only`, arguments: [padVk(tx)] }));
    PAD.c = slopes.prepare_only.perCall;
    console.log(`pad call prepare_only: ${PAD.c.toFixed(2)} raw units/call, points ${JSON.stringify(slopes.prepare_only.points)}`);
  }

  // --- setup txs ----------------------------------------------------------------------------
  let r = await run(client, kp, "token_faucet::faucet (mint 1000 tokens)", (tx) =>
    tx.moveCall({ target: `${PKG}::token_faucet::faucet`, arguments: [tx.object(treasury)] }));
  const coin0 = created(r, "::token::TOKEN");
  r = await run(client, kp, "pool::create_pool", (tx) =>
    tx.moveCall({ target: `${PKG}::pool::create_pool`,
      arguments: [bytes(tx, vkT), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] }));
  const POOL = created(r, "::pool::Pool");
  const CAP = created(r, "::pool::AdminCap");

  for (let i = 0; i < 4; i++) {
    await run(client, kp, `pool::deposit_and_register #${i + 1}`, (tx) => {
      const [c] = tx.splitCoins(tx.object(coin0), [tx.pure.u64(DENOM)]);
      tx.moveCall({ target: `${PKG}::pool::deposit_and_register`,
        arguments: [tx.object(POOL), c, bytes(tx, bigintLE(leaves[i])), tx.object(CLOCK)] });
    });
  }
  await run(client, kp, "pool::update_commitment_root (propose)", (tx) =>
    tx.moveCall({ target: `${PKG}::pool::update_commitment_root`,
      arguments: [tx.object(POOL), tx.object(CAP), bytes(tx, bigintLE(tree.root)), tx.object(CLOCK)] }));
  await run(client, kp, "pool::propose_withdraw_vk", (tx) =>
    tx.moveCall({ target: `${PKG}::pool::propose_withdraw_vk`,
      arguments: [tx.object(POOL), tx.object(CAP), bytes(tx, vkW), tx.object(CLOCK)] }));
  r = await run(client, kp, "compliance::create_compliance_config", (tx) =>
    tx.moveCall({ target: `${PKG}::compliance::create_compliance_config`,
      arguments: [tx.object(CAP), tx.object(POOL), bytes(tx, vkC), bytes(tx, bigintLE(complianceRoot())),
        tx.pure.u64(1), bytes(tx, new Uint8Array(33).fill(7))] }));
  const CONFIG = created(r, "::compliance::ComplianceConfig");

  // gasbench holder (prepare once, store)
  r = await run(client, kp, "gasbench::make_holder (prepare VK once)", (tx) =>
    tx.moveCall({ target: `${PKG}::gasbench::make_holder`, arguments: [bytes(tx, vkT)] }));
  const HOLDER = created(r, "::gasbench::Holder");

  // --- wait for the timelocked root/VK to mature (next 60 s epoch boundary + margin) ---------
  const now = Date.now();
  const wait = EPOCH_MS - (now % EPOCH_MS) + 3000;
  console.log(`waiting ${(wait / 1000).toFixed(0)} s for the next epoch (timelocks + commitment maturity)...`);
  await sleep(wait);
  const epoch = BigInt(Math.floor(Date.now() / EPOCH_MS));

  // --- proofs ---------------------------------------------------------------------------------
  const T = (i, rndNew, amt) => prove("transfer", "build", transferInputs({
    secret: secrets[i], cumOld: 0n, rndOld: 0n, rndNew, amt, epoch, root: tree.root, path: tree.paths[i] }));
  const t1 = await T(0, 5001n, 100n);
  const t2 = await T(3, 5002n, 250n);
  const tc = await T(1, 5003n, 70n);

  const wRecipient = BigInt(addr);

  // --- the entry points under test -----------------------------------------------------------
  await run(client, kp, "pool::shielded_transfer #1", (tx) =>
    tx.moveCall({ target: `${PKG}::pool::shielded_transfer`,
      arguments: [tx.object(POOL), bytes(tx, t1.proof), bytes(tx, t1.inputs), tx.object(CLOCK)] }));
  await run(client, kp, "pool::shielded_transfer #2", (tx) =>
    tx.moveCall({ target: `${PKG}::pool::shielded_transfer`,
      arguments: [tx.object(POOL), bytes(tx, t2.proof), bytes(tx, t2.inputs), tx.object(CLOCK)] }));
  await run(client, kp, "pool::shielded_transfer (replay -> abort)", (tx) =>
    tx.moveCall({ target: `${PKG}::pool::shielded_transfer`,
      arguments: [tx.object(POOL), bytes(tx, t1.proof), bytes(tx, t1.inputs), tx.object(CLOCK)] }),
    { expectFail: true });

  // compliant transfer
  const cp = await prove("compliance", "build-compliance", complianceInputs({
    secret: secrets[1], transferNullifier: H([D.NULL, secrets[1], epoch, 0n]), epoch }));
  await run(client, kp, "compliance::compliant_transfer", (tx) =>
    tx.moveCall({ target: `${PKG}::compliance::compliant_transfer`,
      arguments: [tx.object(POOL), tx.object(CONFIG), bytes(tx, tc.proof), bytes(tx, tc.inputs),
        bytes(tx, cp.proof), bytes(tx, cp.inputs), bytes(tx, new Uint8Array(101).fill(9)), tx.object(CLOCK)] }));

  // zk_withdraw: needs a note with cumulative > 0 present in the pool. The new commitment created
  // by shielded_transfer #1 (cum=100, rnd=5001) is exactly that (registered as a CommitmentKey).
  // It must mature one epoch (pool_epoch > created_epoch) — wait for the next boundary.
  const wait2 = EPOCH_MS - (Date.now() % EPOCH_MS) + 3000;
  console.log(`waiting ${(wait2 / 1000).toFixed(0)} s for the transferred note to mature...`);
  await sleep(wait2);
  const wInputs = {
    commitment: note(100n, 5001n, secrets[0]),
    withdrawAmount: 40n,
    nullifier: H([D.WNULL, secrets[0], 5001n, 100n]),
    recipientHash: H([D.RHASH, wRecipient]),
    newCommitment: note(60n, 6001n, secrets[0]),
    cumulativeOld: 100n, randomnessOld: 5001n, userSecret: secrets[0],
    recipient: wRecipient, randomnessNew: 6001n,
  };
  const wp = await prove("withdraw", "build-withdraw", wInputs);
  await run(client, kp, "pool::zk_withdraw", (tx) =>
    tx.moveCall({ target: `${PKG}::pool::zk_withdraw`,
      arguments: [tx.object(POOL), bytes(tx, wp.proof), bytes(tx, wp.inputs), tx.pure.address(addr), tx.object(CLOCK)] }));

  // --- verifier isolation: per-call raw units from bucket crossings (dry-runs; nothing committed) ---
  if (CALIBRATE) {
    const A = (tx) => [bytesOnce(tx, "vk", vkT), bytesOnce(tx, "proof", t1.proof), bytesOnce(tx, "inputs", t1.inputs)];
    const variants = {
      noop: (tx) => tx.moveCall({ target: `${PKG}::gasbench::noop`, arguments: A(tx) }),
      verify_unprepared: (tx) => tx.moveCall({ target: `${PKG}::gasbench::verify_unprepared`, arguments: A(tx) }),
      verify_prepared: (tx) => tx.moveCall({ target: `${PKG}::gasbench::verify_prepared`,
        arguments: [tx.object(HOLDER), bytesOnce(tx, "proof", t1.proof), bytesOnce(tx, "inputs", t1.inputs)] }),
    };
    for (const [name, fn] of Object.entries(variants)) {
      slopes[name] = await slope(client, addr, fn);
      const x = slopes[name];
      console.log(`${("gasbench::" + name).padEnd(34)} ${x.perCall.toFixed(2)} raw units/call  points ${JSON.stringify(x.points)}`);
    }
  }

  // --- floor / batching curve: k verifications in ONE PTB (dry-run), charged computation units ---
  const curve = [];
  if (CALIBRATE) {
    const A = (tx) => [bytesOnce(tx, "vk", vkT), bytesOnce(tx, "proof", t1.proof), bytesOnce(tx, "inputs", t1.inputs)];
    for (const k of [1, 2, 3, 4, 5, 6, 8, 12]) {
      const u = await simUnits(client, addr, (tx) => {
        for (let i = 0; i < k; i++) tx.moveCall({ target: `${PKG}::gasbench::verify_unprepared`, arguments: A(tx) });
      });
      const up = await simUnits(client, addr, (tx) => {
        for (let i = 0; i < k; i++) tx.moveCall({ target: `${PKG}::gasbench::verify_prepared`,
          arguments: [tx.object(HOLDER), bytesOnce(tx, "proof", t1.proof), bytesOnce(tx, "inputs", t1.inputs)] });
      });
      curve.push({ k, unprepared: u, prepared: up });
      console.log(`${k} verifications in one PTB: unprepared charged=${u}u  prepared charged=${up}u`);
    }
  }

  console.log("\n=== SUMMARY (MIST; computation units = computationCost / referenceGasPrice) ===");
  for (const x of rows.filter((r) => r.computationCost !== undefined)) {
    const raw = x.raw ? String(x.raw.rawUnits) : "n/a";
    console.log(`${x.label.padEnd(44)} charged=${String(x.computationUnits).padStart(5)}u raw=${raw.padStart(6)}u  storage=${String(x.storageCost).padStart(9)} rebate=${String(x.storageRebate).padStart(9)} net=${String(x.net).padStart(9)} MIST`);
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ rgp: String(RGP), slopes, curve, rows }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log(`wrote ${JSON_OUT}`);
  }
}

function bigintLE(n) {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

// Compliance witness (credential tree of one leaf; zero siblings like circuits/test/compliance.test.mjs)
const CRED = { kyc: 2n, expiry: 10_000_000_000n, issuer: 42n, reqKyc: 1n };
function credLeaf(secret) { return H([D.CRED, secret, CRED.kyc, CRED.expiry, CRED.issuer]); }
function complianceRoot() {
  return credRootFor(222222n);
}
function credRootFor(secret) {
  let cur = credLeaf(secret);
  for (let i = 0; i < DEPTH; i++) cur = H([cur, 0n]);
  return cur;
}
function complianceInputs({ secret, transferNullifier, epoch }) {
  const root = credRootFor(secret);
  const contextId = H([D.CTX, transferNullifier, secret]);
  return {
    merkleRoot: root, currentEpoch: epoch, contextId, requiredKycLevel: CRED.reqKyc,
    nullifier: H([D.CNULL, secret, contextId]), validCredential: 1n,
    userSecret: secret, kycLevel: CRED.kyc, expiryEpoch: CRED.expiry, issuerId: CRED.issuer,
    pathElements: Array(DEPTH).fill(0n), pathIndices: Array(DEPTH).fill(0n), transferNullifier,
  };
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
