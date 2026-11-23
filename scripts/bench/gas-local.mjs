#!/usr/bin/env node
/**
 * gas-local.mjs — Measure real on-chain gas for every Veil entry point on a local Sui network.
 *
 * Every number this script prints comes from the `effects.gasUsed` of a transaction that was
 * actually executed by a local validator (`sui start`), with real Groth16 proofs generated from
 * the real circuits. Nothing is estimated.
 *
 * Prerequisites (see scripts/bench/run-gas-local.sh, which does all of this):
 *   - `sui` CLI on PATH, a local network running (`sui start --with-faucet --force-regenesis`),
 *     and the active `sui client` env pointing at it (http://127.0.0.1:9000).
 *   - The package already published; pass its publish JSON with --publish-json <file>.
 *   - Circuit artifacts in circuits/build*: transfer, withdraw, compliance (wasm + final zkey + vk).
 *
 * Usage:
 *   node gas-local.mjs --publish-json /path/to/publish.json [--rpc http://127.0.0.1:9000]
 *                      [--epoch-ms 60000] [--out results.json]
 *
 * Output: a table of {entry point, computationCost, storageCost, storageRebate,
 * nonRefundableStorageFee, net} in MIST, plus a JSON dump of the raw gasUsed objects.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { fromBase64 } from "@mysten/sui/utils";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");

const { values: args } = parseArgs({
  options: {
    "publish-json": { type: "string" },
    rpc: { type: "string", default: "http://127.0.0.1:9000" },
    "epoch-ms": { type: "string", default: "60000" },
    out: { type: "string" },
    "pvk-publish-json": { type: "string" },
  },
});
if (!args["publish-json"]) throw new Error("--publish-json required");
const EPOCH_MS = Number(args["epoch-ms"]);
const CLOCK = "0x6";
const THRESHOLD = 1_000_000_000n;
const DENOM_SMALL = 100_000_000n;
const GAS_BUDGET = 2_000_000_000;
const MERKLE_DEPTH = 20;
const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RCPT: 8n };

// ── proof/VK → Sui byte encodings (same algorithm as scripts/src/proof-converter.ts) ──
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const Q_HALF = (Q - 1n) / 2n;
function le32(n) {
  const b = new Uint8Array(32);
  let v = BigInt(n);
  for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
function g1(x, y) { const b = le32(x); if (BigInt(y) > Q_HALF) b[31] |= 0x80; return b; }
function g2(x0, x1, y0, y1) {
  const r = new Uint8Array(64);
  r.set(le32(x0), 0); r.set(le32(x1), 32);
  y0 = BigInt(y0); y1 = BigInt(y1);
  if (y1 > Q_HALF || (y1 === Q_HALF && y0 > Q_HALF)) r[63] |= 0x80;
  return r;
}
function cat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function proofBytes(p) {
  return cat([g1(p.pi_a[0], p.pi_a[1]), g2(p.pi_b[0][0], p.pi_b[0][1], p.pi_b[1][0], p.pi_b[1][1]), g1(p.pi_c[0], p.pi_c[1])]);
}
function inputsBytes(sig) { return cat(sig.map(le32)); }
function vkBytes(vk) {
  const ic = vk.IC.map((pt) => g1(pt[0], pt[1]));
  const len = new Uint8Array(8); new DataView(len.buffer).setBigUint64(0, BigInt(ic.length), true);
  return cat([
    g1(vk.vk_alpha_1[0], vk.vk_alpha_1[1]),
    g2(vk.vk_beta_2[0][0], vk.vk_beta_2[0][1], vk.vk_beta_2[1][0], vk.vk_beta_2[1][1]),
    g2(vk.vk_gamma_2[0][0], vk.vk_gamma_2[0][1], vk.vk_gamma_2[1][0], vk.vk_gamma_2[1][1]),
    g2(vk.vk_delta_2[0][0], vk.vk_delta_2[0][1], vk.vk_delta_2[1][0], vk.vk_delta_2[1][1]),
    len, ...ic,
  ]);
}
const arr = (u8) => Array.from(u8);

// ── artifacts ──
function artifact(name) {
  for (const dir of ["build", `build-${name}`]) {
    const base = join(CIRCUITS, dir);
    const wasm = join(base, `${name}_js`, `${name}.wasm`);
    const zkey = join(base, `${name}_final.zkey`);
    const vk = join(base, `${name}_vk.json`);
    if (existsSync(wasm) && existsSync(zkey) && existsSync(vk)) return { wasm, zkey, vk: JSON.parse(readFileSync(vk, "utf8")) };
  }
  throw new Error(`artifacts for ${name} not found under circuits/build*`);
}

// ── client / signer ──
function loadSigner() {
  const ks = JSON.parse(readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf8"));
  const cfg = readFileSync(join(homedir(), ".sui", "sui_config", "client.yaml"), "utf8");
  const active = cfg.match(/active_address:\s*"?(0x[0-9a-f]+)/)?.[1];
  for (const k of ks) {
    const raw = fromBase64(k);
    if (raw[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (!active || kp.toSuiAddress() === active) return kp;
  }
  throw new Error("no ed25519 key for active address");
}
// sui >= 1.84 fullnodes serve gRPC only (JSON-RPC returns 404), so this uses the gRPC client.
const client = new SuiGrpcClient({ baseUrl: args.rpc, network: "localnet" });
const signer = loadSigner();
const me = signer.toSuiAddress();

const results = [];
async function exec(label, build, { expectFailure = false, allowEither = false } = {}) {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);
  let res;
  try {
    res = await client.signAndExecuteTransaction({
      transaction: tx, signer, include: { effects: true, objectTypes: true },
    });
  } catch (e) {
    // The SDK simulates the transaction while resolving it; a Move abort there means the tx never
    // reaches the chain and no gas is charged. Record the rejection honestly (no gas numbers).
    if (!(expectFailure || allowEither) || !e?.executionError) throw e;
    const abort = e.executionError?.MoveAbort;
    const st = { status: "rejected-in-simulation", error: abort ? `MoveAbort ${abort.abortCode} in ${abort.location?.module}::${abort.location?.functionName}` : String(e.message) };
    results.push({ label, status: st.status, error: st.error, digest: null, gasUsed: null, net: null });
    console.log(`[gas] ${label.padEnd(44)} status=${st.status} (${st.error}) — not executed, no gas charged`);
    return { digest: null, effects: { status: st, gasUsed: null }, objectChanges: [] };
  }
  await client.waitForTransaction({ result: res });
  const t = res.Transaction ?? res.FailedTransaction;
  const ok = t.effects.status.success;
  const st = { status: ok ? "success" : "failure", error: ok ? undefined : JSON.stringify(t.effects.status.error) };
  if (!allowEither && ok === expectFailure) {
    throw new Error(`${label}: unexpected status ${JSON.stringify(st)}`);
  }
  // Normalise to the shape the rest of this script uses.
  const r = {
    digest: t.digest, effects: { status: st, gasUsed: t.effects.gasUsed },
    objectChanges: t.effects.changedObjects.filter((c) => c.idOperation === "Created").map((c) => ({
      type: "created", objectId: c.objectId, objectType: t.objectTypes?.[c.objectId] ?? "",
      owner: c.outputOwner ? { AddressOwner: c.outputOwner.AddressOwner } : null,
    })),
  };
  const g = r.effects.gasUsed;
  const net = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
  results.push({ label, status: st.status, error: st.error ?? null, digest: r.digest, gasUsed: g, net: net.toString() });
  console.log(`[gas] ${label.padEnd(44)} status=${st.status.padEnd(7)} comp=${g.computationCost} storage=${g.storageCost} rebate=${g.storageRebate} nonRefundable=${g.nonRefundableStorageFee} net=${net}`);
  return r;
}
const created = (r, typeSuffix) => r.objectChanges.find((c) => c.type === "created" && c.objectType.endsWith(typeSuffix))?.objectId;

async function chainTimeMs() {
  // Clock { id: UID (32 bytes), timestamp_ms: u64 } — read the BCS content directly.
  const { object } = await client.getObject({ objectId: CLOCK, include: { content: true } });
  return new DataView(object.content.buffer, object.content.byteOffset).getBigUint64(32, true);
}
async function waitForEpoch(target) {
  for (;;) {
    const now = await chainTimeMs();
    const e = now / BigInt(EPOCH_MS);
    if (e >= target) return e;
    const waitMs = Number(target * BigInt(EPOCH_MS) - now) + 1500;
    console.log(`[wait] pool epoch ${e} -> ${target} (~${Math.ceil(waitMs / 1000)}s)`);
    await new Promise((res) => setTimeout(res, Math.min(waitMs, 15000)));
  }
}

async function prove(name, input) {
  const a = artifact(name);
  const s = {};
  for (const [k, v] of Object.entries(input)) s[k] = Array.isArray(v) ? v.map(String) : String(v);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(s, a.wasm, a.zkey);
  if (!(await snarkjs.groth16.verify(a.vk, publicSignals, proof))) throw new Error(`${name}: local verify failed`);
  return { proof: proofBytes(proof), inputs: inputsBytes(publicSignals), publicSignals };
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (xs) => F.toObject(poseidon(xs));

  const pub = JSON.parse(readFileSync(args["publish-json"], "utf8"));
  const pkg = pub.objectChanges.find((c) => c.type === "published").packageId;
  const treasury = pub.objectChanges.find((c) => c.type === "created" && c.objectType.includes("TreasuryCap"))?.objectId;
  const pg = pub.effects.gasUsed;
  results.push({ label: "publish (package)", status: pub.effects.status.status, gasUsed: pg,
    net: (BigInt(pg.computationCost) + BigInt(pg.storageCost) - BigInt(pg.storageRebate)).toString(), digest: pub.digest ?? pub.effects.transactionDigest });
  console.log(`[info] package ${pkg}, treasury ${treasury}, signer ${me}`);
  const rgp = await client.getReferenceGasPrice();
  console.log(`[info] reference gas price: ${JSON.stringify(rgp)}`);

  const tA = artifact("transfer"), wA = artifact("withdraw"), cA = artifact("compliance");
  const tVk = vkBytes(tA.vk), wVk = vkBytes(wA.vk), cVk = vkBytes(cA.vk);
  console.log(`[info] vk bytes: transfer=${tVk.length} withdraw=${wVk.length} compliance=${cVk.length}`);

  // ── admin setup ──
  const rPool = await exec("create_pool", (tx) => tx.moveCall({ target: `${pkg}::pool::create_pool`,
    arguments: [tx.pure.vector("u8", arr(tVk)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] }));
  const pool = created(rPool, "::pool::Pool");
  const cap = created(rPool, "::pool::AdminCap");
  await exec("propose_withdraw_vk", (tx) => tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`,
    arguments: [tx.object(pool), tx.object(cap), tx.pure.vector("u8", arr(wVk)), tx.object(CLOCK)] }));

  const rMint = await exec("token_faucet::faucet (mint 1000 TOKEN)", (tx) => tx.moveCall({
    target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] }));
  const coin = created(rMint, "::token::TOKEN>");

  // ── user notes: A (shielded_transfer), B (compliant_transfer), W (zk_withdraw) ──
  const secretA = 1111n, secretB = 2222n, secretW = 3333n, secretX = 4444n;
  const rA = 101n, rB = 202n, rW = 303n, rX = 404n;
  const cumW = DENOM_SMALL; // withdraw circuit treats cumulativeOld as the note balance
  const CA = H([D.COMMIT, 0n, rA, secretA]);
  const CB = H([D.COMMIT, 0n, rB, secretB]);
  const CW = H([D.COMMIT, cumW, rW, secretW]);
  const CX = H([D.COMMIT, cumW, rX, secretX]);
  for (const [label, c] of [["deposit_and_register (note A)", CA], ["deposit_and_register (note B)", CB],
    ["deposit_and_register (note W)", CW], ["deposit_and_register (note X)", CX]]) {
    await exec(label, (tx) => {
      const [d] = tx.splitCoins(tx.object(coin), [tx.pure.u64(DENOM_SMALL)]);
      tx.moveCall({ target: `${pkg}::pool::deposit_and_register`,
        arguments: [tx.object(pool), d, tx.pure.vector("u8", arr(le32(c))), tx.object(CLOCK)] });
    });
  }

  // ── commitment Merkle tree (depth 20, empty leaves = 0, node = Poseidon(l, r)) ──
  const leaves = [CA, CB, CW, CX];
  const levels = [leaves.slice()];
  for (let d = 0; d < MERKLE_DEPTH; d++) {
    const cur = levels[d], next = [];
    for (let i = 0; i < Math.max(1, Math.ceil(cur.length / 2)); i++) next.push(H([cur[2 * i] ?? 0n, cur[2 * i + 1] ?? 0n]));
    levels.push(next);
  }
  const root = levels[MERKLE_DEPTH][0];
  function pathFor(idx) {
    const pe = [], pi = [];
    let i = idx;
    for (let d = 0; d < MERKLE_DEPTH; d++) {
      const sib = i ^ 1;
      pe.push(levels[d][sib] ?? 0n);
      pi.push(BigInt(i & 1));
      i >>= 1;
    }
    return { pe, pi };
  }
  // Recompute root along path 0 to make sure the tree construction is self-consistent.
  {
    const { pe, pi } = pathFor(0); let n = CA;
    for (let d = 0; d < MERKLE_DEPTH; d++) n = pi[d] === 0n ? H([n, pe[d]]) : H([pe[d], n]);
    if (n !== root) throw new Error("merkle self-check failed");
  }
  await exec("update_commitment_root", (tx) => tx.moveCall({ target: `${pkg}::pool::update_commitment_root`,
    arguments: [tx.object(pool), tx.object(cap), tx.pure.vector("u8", arr(le32(root))), tx.object(CLOCK)] }));

  // ── compliance config (credential tree with one leaf for note B's owner) ──
  const kyc = 2n, issuer = 42n, now0 = (await chainTimeMs()) / BigInt(EPOCH_MS);
  const expiry = now0 + 1000n;
  let credNode = H([D.CRED, secretB, kyc, expiry, issuer]);
  for (let d = 0; d < MERKLE_DEPTH; d++) credNode = H([credNode, 0n]);
  const credRoot = credNode;
  const auditorKey = new Uint8Array(33).fill(2);
  const rCfg = await exec("create_compliance_config", (tx) => tx.moveCall({ target: `${pkg}::compliance::create_compliance_config`,
    arguments: [tx.object(cap), tx.object(pool), tx.pure.vector("u8", arr(cVk)), tx.pure.vector("u8", arr(le32(credRoot))),
      tx.pure.u64(1n), tx.pure.vector("u8", arr(auditorKey))] }));

  // ── wait one pool epoch: notes mature, root + withdraw VK become active ──
  const e1 = await waitForEpoch(now0 + 1n);

  // shielded_transfer of note A
  const tIn = (secret, r, rNew, epoch, leafIdx) => {
    const { pe, pi } = pathFor(leafIdx);
    const oldC = H([D.COMMIT, 0n, r, secret]);
    return {
      oldCommitment: oldC, newCommitment: H([D.COMMIT, 100n, rNew, secret]), threshold: THRESHOLD, epochId: epoch,
      nullifier: H([D.NULL, secret, epoch, r]), txAmountHash: H([D.TXAMT, 100n, 99n]), merkleRoot: root,
      cumulativeOld: 0n, cumulativeNew: 100n, txAmount: 100n, randomnessOld: r, randomnessNew: rNew,
      userSecret: secret, salt: 99n, pathElements: pe, pathIndices: pi,
    };
  };
  const pT = await prove("transfer", tIn(secretA, rA, 9001n, e1, 0));
  await exec("shielded_transfer", (tx) => tx.moveCall({ target: `${pkg}::pool::shielded_transfer`,
    arguments: [tx.object(pool), tx.pure.vector("u8", arr(pT.proof)), tx.pure.vector("u8", arr(pT.inputs)), tx.object(CLOCK)] }));
  // replay the same proof: must abort (nullifier/commitment spent). Gas for a rejected replay.
  await exec("shielded_transfer (replay, aborts)", (tx) => tx.moveCall({ target: `${pkg}::pool::shielded_transfer`,
    arguments: [tx.object(pool), tx.pure.vector("u8", arr(pT.proof)), tx.pure.vector("u8", arr(pT.inputs)), tx.object(CLOCK)] }),
    { expectFailure: true });

  // zk_withdraw of 40 TOKEN from note W to `me`
  // Recipient as a BN254 field element: address mod r (no client convention exists in the repo yet).
  const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const recipientField = BigInt(me) % R;
  const wAmt = 40_000_000n;
  const withdrawInput = (secret, r, rNew) => ({
    commitment: H([D.COMMIT, cumW, r, secret]), withdrawAmount: wAmt, nullifier: H([D.WNULL, secret, r, cumW]),
    recipientHash: H([D.RCPT, recipientField]), newCommitment: H([D.COMMIT, cumW - wAmt, rNew, secret]),
    cumulativeOld: cumW, randomnessOld: r, userSecret: secret, recipient: recipientField, randomnessNew: rNew,
  });
  const pW = await prove("withdraw", withdrawInput(secretW, rW, 3030n));
  await exec("zk_withdraw", (tx) => tx.moveCall({ target: `${pkg}::pool::zk_withdraw`,
    arguments: [tx.object(pool), tx.pure.vector("u8", arr(pW.proof)), tx.pure.vector("u8", arr(pW.inputs)),
      tx.pure.address(me), tx.object(CLOCK)] }));

  // Recipient-binding probe (threat-model E7): a proof made for recipient = `me`, submitted with a
  // different `recipient` argument. If the contract binds recipientHash to the argument this aborts.
  const attacker = "0x" + "ab".repeat(32);
  const pX = await prove("withdraw", withdrawInput(secretX, rX, 4040n));
  const rSteal = await exec("zk_withdraw (recipient substituted)", (tx) => tx.moveCall({ target: `${pkg}::pool::zk_withdraw`,
    arguments: [tx.object(pool), tx.pure.vector("u8", arr(pX.proof)), tx.pure.vector("u8", arr(pX.inputs)),
      tx.pure.address(attacker), tx.object(CLOCK)] }), { allowEither: true });
  const stolen = rSteal.effects.status.status === "success"
    ? rSteal.objectChanges.find((c) => c.type === "created" && c.objectType.endsWith("::token::TOKEN>") && c.owner?.AddressOwner === attacker)
    : null;
  console.log(`[E7] recipient substitution: status=${rSteal.effects.status.status} ${rSteal.effects.status.error ?? ""}` +
    (stolen ? ` — Coin<TOKEN> ${stolen.objectId} now owned by ${attacker} (proof was generated for ${me})` : ""));
  results.push({ label: "E7 probe", substitutionSucceeded: !!stolen, stolenCoin: stolen?.objectId ?? null, attacker, provenFor: me });

  // turn compliance on (effective next epoch), then compliant_transfer of note B
  await exec("propose_compliance_toggle", (tx) => tx.moveCall({ target: `${pkg}::pool::propose_compliance_toggle`,
    arguments: [tx.object(pool), tx.object(cap), tx.pure.bool(true), tx.object(CLOCK)] }));
  const e2 = await waitForEpoch(e1 + 1n);
  const tB = tIn(secretB, rB, 9002n, e2, 1);
  const pTB = await prove("transfer", tB);
  const ctxId = H([D.CTX, tB.nullifier, secretB]);
  const pC = await prove("compliance", {
    merkleRoot: credRoot, currentEpoch: e2, contextId: ctxId, requiredKycLevel: 1n,
    nullifier: H([D.CNULL, secretB, ctxId]), validCredential: 1n,
    userSecret: secretB, kycLevel: kyc, expiryEpoch: expiry, issuerId: issuer,
    pathElements: Array(MERKLE_DEPTH).fill(0n), pathIndices: Array(MERKLE_DEPTH).fill(0n), transferNullifier: tB.nullifier,
  });
  const encAmount = new Uint8Array(93).fill(7);
  await exec("compliant_transfer", (tx) => tx.moveCall({ target: `${pkg}::compliance::compliant_transfer`,
    arguments: [tx.object(pool), tx.object(created(rCfg, "::compliance::ComplianceConfig")),
      tx.pure.vector("u8", arr(pTB.proof)), tx.pure.vector("u8", arr(pTB.inputs)),
      tx.pure.vector("u8", arr(pC.proof)), tx.pure.vector("u8", arr(pC.inputs)),
      tx.pure.vector("u8", arr(encAmount)), tx.object(CLOCK)] }));

  // ── VK-preparation micro-benchmark (scripts/bench/move-pvk) ──
  if (args["pvk-publish-json"]) {
    const pp = JSON.parse(readFileSync(args["pvk-publish-json"], "utf8"));
    const bpkg = pp.objectChanges.find((c) => c.type === "published").packageId;
    for (const [name, vk, pr] of [["transfer", tVk, pT], ["withdraw", wVk, pW], ["compliance", cVk, pC]]) {
      const rs = await exec(`pvkbench::create (${name} vk)`, (tx) => tx.moveCall({ target: `${bpkg}::pvk::create`,
        arguments: [tx.pure.vector("u8", arr(vk))] }));
      const st = created(rs, "::pvk::Stored");
      for (const fn of ["touch", "prepare_only"]) {
        await exec(`pvkbench::${fn} (${name})`, (tx) => tx.moveCall({ target: `${bpkg}::pvk::${fn}`, arguments: [tx.object(st)] }));
      }
      for (const fn of ["verify_raw", "verify_cached"]) {
        await exec(`pvkbench::${fn} (${name})`, (tx) => tx.moveCall({ target: `${bpkg}::pvk::${fn}`,
          arguments: [tx.object(st), tx.pure.vector("u8", arr(pr.proof)), tx.pure.vector("u8", arr(pr.inputs))] }));
      }
      // Looped: k = 20 and k = 40 iterations; per-call units = (cost40 - cost20) / 20 / RGP.
      for (const k of [20, 40]) {
        for (const fn of ["touch_n", "prepare_only_n"]) {
          await exec(`pvkbench::${fn} k=${k} (${name})`, (tx) => tx.moveCall({ target: `${bpkg}::pvk::${fn}`,
            arguments: [tx.object(st), tx.pure.u64(k)] }));
        }
        for (const fn of ["verify_raw_n", "verify_cached_n"]) {
          await exec(`pvkbench::${fn} k=${k} (${name})`, (tx) => tx.moveCall({ target: `${bpkg}::pvk::${fn}`,
            arguments: [tx.object(st), tx.pure.vector("u8", arr(pr.proof)), tx.pure.vector("u8", arr(pr.inputs)), tx.pure.u64(k)] }));
        }
      }
    }
  }

  // misc admin ops
  await exec("freeze_pool", (tx) => tx.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [tx.object(pool), tx.object(cap), tx.object(CLOCK)] }));
  await exec("unfreeze_pool", (tx) => tx.moveCall({ target: `${pkg}::pool::unfreeze_pool`, arguments: [tx.object(pool), tx.object(cap)] }));

  if (args.out) writeFileSync(args.out, JSON.stringify({ rpc: args.rpc, package: pkg, epochMs: EPOCH_MS, referenceGasPrice: rgp, results }, null, 2));
  console.log("\n| Entry point | Status | Computation (MIST) | Storage (MIST) | Rebate (MIST) | Net (MIST) |");
  console.log("|---|---|---:|---:|---:|---:|");
  for (const r of results) {
    if (!r.gasUsed) continue;
    const g = r.gasUsed;
    console.log(`| \`${r.label}\` | ${r.status} | ${g.computationCost} | ${g.storageCost} | ${g.storageRebate} | ${r.net} |`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
