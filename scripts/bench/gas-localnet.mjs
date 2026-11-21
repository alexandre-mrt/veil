#!/usr/bin/env node
/**
 * gas-localnet.mjs — Real on-chain gas per Veil entry point, measured on a local Sui network,
 * using real Groth16 proofs from the compiled circuits.
 *
 * It also runs two exploit probes (labelled FINDING) that came up while building this harness:
 *   F1  deposit-commitment inflation: deposit 100 TOKEN with a commitment that claims a 1000 TOKEN
 *       balance, then zk_withdraw 1000 TOKEN.
 *   F2  withdrawal front-running: a valid withdraw proof made for recipient A, submitted with
 *       recipient B.
 * Each probe reports SUCCEEDED (the exploit works) or REJECTED. Nothing in the result is asserted
 * in advance: the run reports what the chain did.
 *
 * Prerequisites:
 *   1. sui CLI on PATH (measured with sui 1.84.1, prebuilt release binary)
 *   2. Circuit artifacts in circuits/build{,-withdraw,-compliance}/ (circuits/scripts/compile*.sh)
 *   3. A local network:  sui start --with-faucet --force-regenesis
 *      (JSON-RPC is gone in sui 1.84's node; this script talks gRPC on :9000, faucet on :9123)
 *
 * Usage:
 *   NO_PROXY=127.0.0.1,localhost node scripts/bench/gas-localnet.mjs [--json out.json]
 *
 * Runtime: ~2–3 min. Epochs in Veil are pool-local (Clock / epoch_duration_ms); the pool is created
 * with the minimum 60 s epoch, and the script waits one epoch boundary so the timelocked
 * commitment root / withdraw VK apply and the deposits mature.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes, bigintToLE32, R } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const C = join(ROOT, "circuits");
const RPC = process.env.SUI_RPC ?? "http://127.0.0.1:9000";
const FAUCET = process.env.SUI_FAUCET ?? "http://127.0.0.1:9123";
const JSON_OUT = (() => { const i = process.argv.indexOf("--json"); return i > 0 ? process.argv[i + 1] : null; })();

const EPOCH_MS = 60_000;
const THRESHOLD = 1_000_000_000n;
const DENOM_SMALL = 100_000_000n;  // 100 TOKEN
const DENOM_LARGE = 1_000_000_000n; // 1000 TOKEN
const MERKLE_DEPTH = 20;
const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RECIP: 8n };

const client = new SuiGrpcClient({ network: "localnet", baseUrl: RPC });
const admin = new Ed25519Keypair();
const results = [];
let poseidon, F;
const H = (xs) => F.toObject(poseidon(xs));
const le = (x) => Array.from(bigintToLE32(x));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const epochNow = () => BigInt(Math.floor(Date.now() / EPOCH_MS));
async function waitNextEpoch() {
  const target = (Math.floor(Date.now() / EPOCH_MS) + 1) * EPOCH_MS + 4_000; // +4s for checkpoint clock lag
  console.log(`  [wait] ${(target - Date.now()) / 1000}s to the next pool epoch boundary…`);
  await sleep(target - Date.now());
}

async function exec(label, build, { expectFailure = false, signer = admin, record = true } = {}) {
  const tx = new Transaction();
  build(tx);
  // An explicit budget skips the SDK's pre-execution dry run, so an expected abort reaches the
  // chain and its real (charged) gas is measured instead of being refused client-side.
  if (expectFailure) tx.setGasBudget(100_000_000);
  let res;
  try {
    res = await client.signAndExecuteTransaction({
      transaction: tx, signer, include: { effects: true, objectTypes: true, events: true },
    });
  } catch (e) {
    if (!expectFailure) throw e;
    console.log(`  [rej]  ${label.padEnd(42)} refused before execution: ${String(e.message).slice(0, 200)}`);
    return { ok: false, rejectedClientSide: true, row: null };
  }
  const t = res.Transaction ?? res.FailedTransaction;
  await client.waitForTransaction({ digest: t.digest });
  const ok = t.effects.status.success;
  const g = t.effects.gasUsed;
  const row = {
    label, ok,
    computation: BigInt(g.computationCost), storage: BigInt(g.storageCost),
    rebate: BigInt(g.storageRebate), nonRefundable: BigInt(g.nonRefundableStorageFee),
    error: ok ? null : JSON.stringify(t.effects.status.error).slice(0, 220),
  };
  row.net = row.computation + row.storage - row.rebate;
  console.log(`  ${ok ? "[ok]  " : "[FAIL]"} ${label.padEnd(42)} comp=${row.computation} storage=${row.storage} rebate=${row.rebate} net=${row.net}${row.error ? "  err=" + row.error : ""}`);
  if (record) results.push(row);
  if (!ok && !expectFailure) throw new Error(`${label} failed: ${row.error}`);
  return { ...t, ok, row };
}
const created = (t, typeSubstr) =>
  Object.entries(t.objectTypes ?? {}).find(([id, ty]) => ty.includes(typeSubstr) &&
    t.effects.changedObjects.some((o) => o.objectId === id && o.idOperation === "Created"))?.[0];

async function prove(name, dir, input) {
  const wasm = join(C, dir, `${name}_js`, `${name}.wasm`);
  const zkey = join(C, dir, `${name}_final.zkey`);
  const str = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(str, wasm, zkey);
  const vk = JSON.parse(readFileSync(join(C, dir, `${name}_vk.json`), "utf8"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${name}: local verify failed`);
  return { proof: Array.from(proofToSuiBytes(proof)), inputs: Array.from(publicInputsToSuiBytes(publicSignals)) };
}
const vkBytes = (dir, name) => Array.from(vkToSuiBytes(JSON.parse(readFileSync(join(C, dir, `${name}_vk.json`), "utf8"))));

function transferWitness({ secret, rNew, path, idx, epochId, txAmount = 100n, salt = 99n }) {
  const oldCommitment = H([D.COMMIT, 0n, 0n, secret]);
  const newCommitment = H([D.COMMIT, txAmount, rNew, secret]);
  let node = oldCommitment;
  for (let i = 0; i < MERKLE_DEPTH; i++) node = idx[i] === 0n ? H([node, path[i]]) : H([path[i], node]);
  return {
    oldCommitment, newCommitment, threshold: THRESHOLD, epochId,
    nullifier: H([D.NULL, secret, epochId, 0n]), txAmountHash: H([D.TXAMT, txAmount, salt]), merkleRoot: node,
    cumulativeOld: 0n, cumulativeNew: txAmount, txAmount, randomnessOld: 0n, randomnessNew: rNew,
    userSecret: secret, salt, pathElements: path, pathIndices: idx,
  };
}
function withdrawWitness({ secret, rOld, claimed, amount, recipientField, rNew }) {
  return {
    commitment: H([D.COMMIT, claimed, rOld, secret]), withdrawAmount: amount,
    nullifier: H([D.WNULL, secret, rOld, claimed]), recipientHash: H([D.RECIP, recipientField]),
    newCommitment: H([D.COMMIT, claimed - amount, rNew, secret]),
    cumulativeOld: claimed, randomnessOld: rOld, userSecret: secret, recipient: recipientField, randomnessNew: rNew,
  };
}

async function main() {
  poseidon = await buildPoseidon(); F = poseidon.F;
  const sui = execFileSync("sui", ["--version"], { encoding: "utf8" }).trim();
  const { referenceGasPrice } = await client.getReferenceGasPrice();
  console.log(`=== Veil on-chain gas (localnet) — ${sui}, RGP ${referenceGasPrice} MIST, node ${process.version} ===`);
  const addr = admin.toSuiAddress();
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: addr });
  await sleep(2000);

  // ---- publish --------------------------------------------------------------------------
  const built = JSON.parse(execFileSync("sui", ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking",
    "--path", join(ROOT, "contracts")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const pub = await exec("publish (6 modules)", (tx) => {
    tx.setGasBudget(2_000_000_000);
    const cap = tx.publish({ modules: built.modules, dependencies: built.dependencies });
    tx.transferObjects([cap], addr);
  });
  const pkg = pub.effects.changedObjects.find((o) => o.outputState === "PackageWrite").objectId;
  const treasury = created(pub, "TreasuryCap");
  const T = (m, f) => `${pkg}::${m}::${f}`;

  // ---- pool + admin setup ---------------------------------------------------------------
  const cp = await exec("pool::create_pool", (tx) => tx.moveCall({ target: T("pool", "create_pool"),
    arguments: [tx.pure.vector("u8", vkBytes("build", "transfer")), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] }));
  const pool = created(cp, "::pool::Pool");
  const cap = created(cp, "::pool::AdminCap");
  await exec("pool::propose_withdraw_vk", (tx) => tx.moveCall({ target: T("pool", "propose_withdraw_vk"),
    arguments: [tx.object(pool), tx.object(cap), tx.pure.vector("u8", vkBytes("build-withdraw", "withdraw")), tx.object.clock()] }));

  // ---- mint + deposits -------------------------------------------------------------------
  const coins = [];
  for (let i = 0; i < 2; i++) {
    const m = await exec("token_faucet::faucet (1000 TOKEN)", (tx) => tx.moveCall({ target: T("token_faucet", "faucet"), arguments: [tx.object(treasury)] }), { record: i === 0 });
    coins.push(created(m, "::token::TOKEN"));
  }
  const s = { t1: 1111n, t2: 2222n, w1: 3333n, w2: 4444n, victim: 5555n };
  const genesis = (secret) => H([D.COMMIT, 0n, 0n, secret]);
  const c1 = genesis(s.t1), c2 = genesis(s.t2);
  // F1: claims 1000 TOKEN in the commitment's "cumulative" slot, deposits 100.
  const wF1 = { secret: s.w1, rOld: 31n, claimed: DENOM_LARGE, rNew: 32n };
  // F2: claims exactly what it deposits (100 TOKEN) — the "honest if it were bound" case.
  const wF2 = { secret: s.w2, rOld: 41n, claimed: DENOM_SMALL, rNew: 42n };
  const cF1 = H([D.COMMIT, wF1.claimed, wF1.rOld, wF1.secret]);
  const cF2 = H([D.COMMIT, wF2.claimed, wF2.rOld, wF2.secret]);
  const deposit = (label, coin, amount, commitment, record = true) => exec(label, (tx) => {
    const [c] = tx.splitCoins(tx.object(coin), [tx.pure.u64(amount)]);
    tx.moveCall({ target: T("pool", "deposit_and_register"),
      arguments: [tx.object(pool), c, tx.pure.vector("u8", le(commitment)), tx.object.clock()] });
  }, { record });
  await deposit("pool::deposit_and_register (100 TOKEN)", coins[0], DENOM_SMALL, c1);
  await deposit("pool::deposit_and_register (100 TOKEN) #2", coins[0], DENOM_SMALL, c2, false);
  await deposit("deposit 100 TOKEN, commitment claims 1000 [F1]", coins[0], DENOM_SMALL, cF1, false);
  await deposit("deposit 100 TOKEN, commitment claims 100 [F2]", coins[0], DENOM_SMALL, cF2, false);
  await deposit("victim deposit 1000 TOKEN", coins[1], DENOM_LARGE, genesis(s.victim), false);

  // Commitment tree: c1, c2 as leaves 0 and 1 of a depth-20 tree (zero siblings above).
  const z = Array(MERKLE_DEPTH).fill(0n);
  const p1 = [c2, ...z.slice(1)], i1 = [0n, ...z.slice(1)];
  const p2 = [c1, ...z.slice(1)], i2 = [1n, ...z.slice(1)];
  const root = transferWitness({ secret: s.t1, rNew: 1n, path: p1, idx: i1, epochId: 0n }).merkleRoot;
  await exec("pool::update_commitment_root", (tx) => tx.moveCall({ target: T("pool", "update_commitment_root"),
    arguments: [tx.object(pool), tx.object(cap), tx.pure.vector("u8", le(root)), tx.object.clock()] }));

  // Compliance config: a single-credential tree for t2's user.
  const cred = { userSecret: s.t2, kycLevel: 2n, expiryEpoch: 1n << 40n, issuerId: 42n };
  let croot = H([D.CRED, cred.userSecret, cred.kycLevel, cred.expiryEpoch, cred.issuerId]);
  for (let i = 0; i < MERKLE_DEPTH; i++) croot = H([croot, 0n]);
  const cc = await exec("compliance::create_compliance_config", (tx) => tx.moveCall({ target: T("compliance", "create_compliance_config"),
    arguments: [tx.object(cap), tx.object(pool), tx.pure.vector("u8", vkBytes("build-compliance", "compliance")),
      tx.pure.vector("u8", le(croot)), tx.pure.u64(1), tx.pure.vector("u8", Array(33).fill(2))] }));
  const config = created(cc, "::compliance::ComplianceConfig");

  // Admin ops that are cheap to measure here.
  const adm = (label, fn, args) => exec(label, (tx) => tx.moveCall({ target: T("pool", fn), arguments: args(tx) }));
  await adm("pool::propose_compliance_toggle", "propose_compliance_toggle", (tx) => [tx.object(pool), tx.object(cap), tx.pure.bool(true), tx.object.clock()]);
  await adm("pool::cancel_compliance_toggle", "cancel_compliance_toggle", (tx) => [tx.object(pool), tx.object(cap)]);
  await adm("pool::propose_vk_update", "propose_vk_update", (tx) => [tx.object(pool), tx.object(cap), tx.pure.vector("u8", vkBytes("build", "transfer")), tx.object.clock()]);
  await adm("pool::cancel_vk_update", "cancel_vk_update", (tx) => [tx.object(pool), tx.object(cap)]);
  await adm("pool::freeze_pool", "freeze_pool", (tx) => [tx.object(pool), tx.object(cap), tx.object.clock()]);
  await adm("pool::unfreeze_pool", "unfreeze_pool", (tx) => [tx.object(pool), tx.object(cap)]);

  await waitNextEpoch();
  const E = epochNow();
  console.log(`  [info] pool epoch now ${E}`);

  // ---- shielded_transfer -----------------------------------------------------------------
  const w1 = transferWitness({ secret: s.t1, rNew: 777n, path: p1, idx: i1, epochId: E });
  const P1 = await prove("transfer", "build", w1);
  const stx = (tx, P) => tx.moveCall({ target: T("pool", "shielded_transfer"),
    arguments: [tx.object(pool), tx.pure.vector("u8", P.proof), tx.pure.vector("u8", P.inputs), tx.object.clock()] });
  await exec("pool::shielded_transfer", (tx) => stx(tx, P1));
  await exec("pool::shielded_transfer (replay — must abort)", (tx) => stx(tx, P1), { expectFailure: true });

  // ---- compliant_transfer ----------------------------------------------------------------
  const w2 = transferWitness({ secret: s.t2, rNew: 888n, path: p2, idx: i2, epochId: E });
  const P2 = await prove("transfer", "build", w2);
  const contextId = H([D.CTX, w2.nullifier, s.t2]);
  const PC = await prove("compliance", "build-compliance", {
    merkleRoot: croot, currentEpoch: E, contextId, requiredKycLevel: 1n,
    nullifier: H([D.CNULL, s.t2, contextId]), validCredential: 1n, ...cred,
    pathElements: z, pathIndices: z, transferNullifier: w2.nullifier,
  });
  await exec("compliance::compliant_transfer", (tx) => tx.moveCall({ target: T("compliance", "compliant_transfer"),
    arguments: [tx.object(pool), tx.object(config), tx.pure.vector("u8", P2.proof), tx.pure.vector("u8", P2.inputs),
      tx.pure.vector("u8", PC.proof), tx.pure.vector("u8", PC.inputs), tx.pure.vector("u8", Array(93).fill(7)), tx.object.clock()] }));

  // ---- zk_withdraw: F1 (inflation) -------------------------------------------------------
  const attacker = new Ed25519Keypair();
  const fld = (a) => BigInt(a) % R;
  const balBefore = async (a) => BigInt((await client.getBalance({ owner: a, coinType: `${pkg}::token::TOKEN` })).balance.balance);
  const wd = (tx, P, recipient) => tx.moveCall({ target: T("pool", "zk_withdraw"),
    arguments: [tx.object(pool), tx.pure.vector("u8", P.proof), tx.pure.vector("u8", P.inputs), tx.pure.address(recipient), tx.object.clock()] });

  const PF1 = await prove("withdraw", "build-withdraw", withdrawWitness({ ...wF1, amount: DENOM_LARGE, recipientField: fld(addr) }));
  const b0 = await balBefore(addr);
  const r1 = await exec("pool::zk_withdraw [F1: withdraw 1000 after depositing 100]", (tx) => wd(tx, PF1, addr), { expectFailure: true });
  const b1 = await balBefore(addr);
  console.log(`  [F1] ${r1.ok ? "SUCCEEDED" : "REJECTED"} — admin TOKEN balance ${b0} -> ${b1} (Δ ${b1 - b0}); deposited 100_000_000 under this commitment`);

  // ---- zk_withdraw: F2 (front-running) ---------------------------------------------------
  const PF2 = await prove("withdraw", "build-withdraw", withdrawWitness({ ...wF2, amount: DENOM_SMALL, recipientField: fld(addr) }));
  const a0 = await balBefore(attacker.toSuiAddress());
  const r2 = await exec("pool::zk_withdraw [F2: proof for A, recipient=B]", (tx) => wd(tx, PF2, attacker.toSuiAddress()), { expectFailure: true });
  const a1 = await balBefore(attacker.toSuiAddress());
  console.log(`  [F2] ${r2.ok ? "SUCCEEDED" : "REJECTED"} — non-prover recipient B balance ${a0} -> ${a1} (Δ ${a1 - a0}); proof's recipientHash = Poseidon(8, A)`);

  // ---- summary ---------------------------------------------------------------------------
  console.log(`\n| Entry point | status | computation | storage | rebate | net (MIST) | computation units (÷RGP) |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const r of results) {
    console.log(`| ${r.label} | ${r.ok ? "ok" : "abort"} | ${r.computation} | ${r.storage} | ${r.rebate} | ${r.net} | ${r.computation / BigInt(referenceGasPrice)} |`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ sui, referenceGasPrice, results, F1: { exploited: r1.ok, delta: String(b1 - b0) }, F2: { exploited: r2.ok, delta: String(a1 - a0) } },
    (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
