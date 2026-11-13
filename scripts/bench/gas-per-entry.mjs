#!/usr/bin/env node
/**
 * gas-per-entry.mjs — Real on-chain gas per Veil entry point, measured on a Sui localnet.
 *
 * Drives the full protocol end to end with REAL Groth16 proofs (no mocked verifier):
 *   publish → create_pool → faucet → deposit_and_register → update_commitment_root →
 *   propose_withdraw_vk → create_compliance_config → [wait one pool epoch] →
 *   shielded_transfer ×R → compliant_transfer ×R → zk_withdraw ×R
 * and records `effects.gasUsed` for every transaction.
 *
 * Also runs two binding probes (see docs/research/2026-11-13-onchain-gas-per-entry.md):
 *   - withdraw-redirect: a zk_withdraw whose `recipient` argument is an address the proof never
 *     committed to. If it succeeds, recipientHash is not bound on-chain.
 *   - credential-lending: a compliant_transfer whose compliance proof uses a credential owned by
 *     a different userSecret than the transfer proof. If it succeeds, the compliance proof is not
 *     bound to the transfer's owner.
 *
 * Run with Node >= 22 (it imports the TypeScript proof converter directly via type stripping):
 *   node --experimental-strip-types --no-warnings scripts/bench/gas-per-entry.mjs --runs 3 --out gas.json
 * (Do NOT use bun: in the 2026-11-13 run, bun 1.x exited silently with status 0 inside
 *  snarkjs.groth16.fullProve — no proof, no error. Node is what produced the published numbers.)
 *
 * Prerequisites (all measured in the 2026-11-13 run; see that report for exact commands):
 *   - `sui` CLI on PATH whose framework matches contracts/Move.toml's pinned rev
 *     (rev 94ad8cc = sui 1.72.1; prebuilt: github.com/MystenLabs/sui/releases tag testnet-v1.72.1)
 *   - a running localnet (`sui start --with-faucet --force-regenesis`), active env named `local`,
 *     active address funded from the local faucet
 *   - circuits compiled: circuits/build{,-withdraw,-compliance}/<name>_final.zkey, <name>_vk.json,
 *     <name>_js/<name>.wasm  (circuits/scripts/compile*.sh)
 *   - `npm ci` in scripts/bench (snarkjs, circomlibjs)
 *
 * Refuses to run unless the active env is `local` — this script must never spend real gas.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "../src/proof-converter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CIRCUITS = join(ROOT, "circuits");

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const RUNS = Number(argVal("--runs", "3"));
const OUT = argVal("--out", null);

const EPOCH_MS = 60_000; // pool minimum (E_INVALID_EPOCH_DURATION)
const THRESHOLD = 1_000_000_000n;
const DEPTH = 20;
const GAS_BUDGET = "2000000000";
const CLOCK = "0x6";
const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED_LEAF: 4n, CRED_NULL: 5n, CTX: 6n, WNULL: 7n, RCPT: 8n };

// ── sui CLI helpers ──────────────────────────────────────────────────────────
function sui(cliArgs, { json = true, cwd } = {}) {
  const out = execFileSync("sui", ["client", ...cliArgs, ...(json ? ["--json"] : [])], {
    encoding: "utf8",
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!json) return out.trim();
  const start = out.indexOf("{");
  return JSON.parse(out.slice(start));
}

const records = [];
function record(entry, d, note = "") {
  const g = d.effects.gasUsed;
  const status = d.effects.status.status;
  const rec = {
    entry,
    status,
    computationCost: Number(g.computationCost),
    storageCost: Number(g.storageCost),
    storageRebate: Number(g.storageRebate),
    nonRefundableStorageFee: Number(g.nonRefundableStorageFee),
    net: Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate),
    digest: d.digest,
    note,
  };
  records.push(rec);
  console.log(
    `[gas] ${entry.padEnd(30)} ${status.padEnd(8)} comp=${rec.computationCost} storage=${rec.storageCost} ` +
      `rebate=${rec.storageRebate} net=${rec.net}${note ? `  (${note})` : ""}`,
  );
  if (status !== "success") throw new Error(`${entry} failed: ${JSON.stringify(d.effects.status)}`);
  return d;
}

function call(pkg, module, fn, callArgs, label, note) {
  const d = sui([
    "call", "--package", pkg, "--module", module, "--function", fn,
    "--args", ...callArgs.map(String), "--gas-budget", GAS_BUDGET,
  ]);
  return record(label ?? `${module}::${fn}`, d, note);
}

const created = (d, typeSub) =>
  d.objectChanges.find((o) => o.type === "created" && o.objectType?.includes(typeSub))?.objectId;

const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");

function clockMs() {
  const o = sui(["object", CLOCK]);
  return Number(o.content.fields?.timestamp_ms ?? o.content.timestamp_ms);
}
const epochOf = (ms) => Math.floor(ms / EPOCH_MS);

/** Block until the on-chain clock is in an epoch > `after`, and comfortably inside it. */
async function waitForEpochAfter(after) {
  for (;;) {
    const ms = clockMs();
    const e = epochOf(ms);
    const into = ms % EPOCH_MS;
    if (e > after && into >= 2_000 && into <= 40_000) return e;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

// ── crypto helpers ───────────────────────────────────────────────────────────
let poseidon, F;
const H = (xs) => F.toObject(poseidon(xs));

/** Sparse depth-20 Merkle tree with zero leaves = 0, same Poseidon(2) node hash as the circuits. */
function merkle(leaves) {
  const zeros = [0n];
  for (let i = 1; i <= DEPTH; i++) zeros.push(H([zeros[i - 1], zeros[i - 1]]));
  const levels = [leaves.slice()];
  for (let l = 0; l < DEPTH; l++) {
    const cur = levels[l];
    const next = [];
    for (let i = 0; i < Math.ceil(cur.length / 2); i++) {
      const left = cur[2 * i];
      const right = 2 * i + 1 < cur.length ? cur[2 * i + 1] : zeros[l];
      next.push(H([left, right]));
    }
    if (next.length === 0) next.push(zeros[l + 1]);
    levels.push(next);
  }
  const root = levels[DEPTH][0];
  const path = (idx) => {
    const pathElements = [], pathIndices = [];
    let i = idx;
    for (let l = 0; l < DEPTH; l++) {
      const sib = i ^ 1;
      pathElements.push(sib < levels[l].length ? levels[l][sib] : zeros[l]);
      pathIndices.push(BigInt(i & 1));
      i >>= 1;
    }
    return { pathElements, pathIndices };
  };
  return { root, path };
}

const art = (dir, name) => ({
  wasm: join(CIRCUITS, dir, `${name}_js`, `${name}.wasm`),
  zkey: join(CIRCUITS, dir, `${name}_final.zkey`),
  vk: JSON.parse(readFileSync(join(CIRCUITS, dir, `${name}_vk.json`), "utf8")),
});

const str = (o) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

async function prove(a, input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(str(input), a.wasm, a.zkey);
  if (!(await snarkjs.groth16.verify(a.vk, publicSignals, proof))) throw new Error("local verify failed");
  return { proof: hex(proofToSuiBytes(proof)), inputs: hex(publicInputsToSuiBytes(publicSignals)) };
}

// ── note owners ──────────────────────────────────────────────────────────────
const transferNote = (i) => ({ userSecret: 1_000_001n + BigInt(i), randomnessOld: 0n, cumulativeOld: 0n });
const transferCommit = (n) => H([D.COMMIT, n.cumulativeOld, n.randomnessOld, n.userSecret]);
const withdrawNote = (i) => ({ userSecret: 2_000_001n + BigInt(i), randomnessOld: 31337n + BigInt(i), cumulativeOld: 500n });

function transferWitness(note, epochId, tree, idx) {
  const txAmount = 100n, randomnessNew = 12345n, salt = 99n;
  const cumulativeNew = note.cumulativeOld + txAmount;
  return {
    oldCommitment: transferCommit(note),
    newCommitment: H([D.COMMIT, cumulativeNew, randomnessNew, note.userSecret]),
    threshold: THRESHOLD,
    epochId: BigInt(epochId),
    nullifier: H([D.NULL, note.userSecret, BigInt(epochId), note.randomnessOld]),
    txAmountHash: H([D.TXAMT, txAmount, salt]),
    merkleRoot: tree.root,
    cumulativeOld: note.cumulativeOld, cumulativeNew, txAmount,
    randomnessOld: note.randomnessOld, randomnessNew, userSecret: note.userSecret, salt,
    ...tree.path(idx),
  };
}

const CRED = { kycLevel: 2n, expiryEpoch: 1n << 40n, issuerId: 42n };
const credLeaf = (userSecret) => H([D.CRED_LEAF, userSecret, CRED.kycLevel, CRED.expiryEpoch, CRED.issuerId]);

function complianceWitness(credSecret, epochId, credTree, idx, transferNullifier) {
  const contextId = H([D.CTX, transferNullifier, credSecret]);
  return {
    merkleRoot: credTree.root,
    currentEpoch: BigInt(epochId),
    contextId,
    requiredKycLevel: 1n,
    nullifier: H([D.CRED_NULL, credSecret, contextId]),
    validCredential: 1n,
    userSecret: credSecret, kycLevel: CRED.kycLevel, expiryEpoch: CRED.expiryEpoch, issuerId: CRED.issuerId,
    ...credTree.path(idx),
    transferNullifier,
  };
}

function withdrawWitness(note, recipientField) {
  const withdrawAmount = 100n, randomnessNew = 77777n;
  return {
    commitment: H([D.COMMIT, note.cumulativeOld, note.randomnessOld, note.userSecret]),
    withdrawAmount,
    nullifier: H([D.WNULL, note.userSecret, note.randomnessOld, note.cumulativeOld]),
    recipientHash: H([D.RCPT, recipientField]),
    newCommitment: H([D.COMMIT, note.cumulativeOld - withdrawAmount, randomnessNew, note.userSecret]),
    cumulativeOld: note.cumulativeOld, randomnessOld: note.randomnessOld, userSecret: note.userSecret,
    recipient: recipientField, randomnessNew,
  };
}

const le32 = (x) => hex(publicInputsToSuiBytes([x.toString()]));

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const env = sui(["active-env"], { json: false });
  if (env !== "local") throw new Error(`active env is '${env}', refusing to run outside 'local'`);
  const sender = sui(["active-address"], { json: false });
  const rgp = Number(
    (await (await fetch("http://127.0.0.1:9000", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "suix_getReferenceGasPrice", params: [] }),
    })).json()).result,
  );
  console.log(`sui: ${execFileSync("sui", ["--version"], { encoding: "utf8" }).trim()}  env=${env}  RGP=${rgp} MIST`);
  console.log(`runs per proof-bearing entry point: ${RUNS}`);

  poseidon = await buildPoseidon();
  F = poseidon.F;
  const T = art("build", "transfer"), W = art("build-withdraw", "withdraw"), C = art("build-compliance", "compliance");
  for (const a of [T, W, C]) if (!existsSync(a.zkey)) throw new Error(`missing ${a.zkey}`);

  // 1. publish (temp copy so Move.lock / Pub files in the repo are untouched)
  const tmp = mkdtempSync(join(tmpdir(), "veil-gas-"));
  cpSync(join(ROOT, "contracts"), tmp, { recursive: true });
  const pub = record("publish (test-publish)", sui(
    ["test-publish", "--build-env", "testnet", "--gas-budget", GAS_BUDGET], { cwd: tmp }));
  rmSync(tmp, { recursive: true, force: true });
  const pkg = pub.objectChanges.find((o) => o.type === "published").packageId;
  const treasury = created(pub, "TreasuryCap");

  // 2. pool
  const cp = call(pkg, "pool", "create_pool", [hex(vkToSuiBytes(T.vk)), THRESHOLD, EPOCH_MS]);
  const pool = created(cp, "::pool::Pool");
  const cap = created(cp, "::pool::AdminCap");

  // Note layout:
  //   transfer leaves  [0, R)        : shielded_transfer runs
  //   transfer leaves  [R, 2R)       : compliant_transfer runs (credential owner == spender)
  //   transfer leaf    2R            : credential-lending probe (spender has NO credential)
  //   withdraw notes   [0, R]        : zk_withdraw runs + 1 redirect probe
  const nTransferLeaves = 2 * RUNS + 1;
  const tNotes = Array.from({ length: nTransferLeaves }, (_, i) => transferNote(i));
  const wNotes = Array.from({ length: RUNS + 1 }, (_, i) => withdrawNote(i));
  const deposits = [...tNotes.map(transferCommit), ...wNotes.map((n) => withdrawWitness(n, 1n).commitment)];

  // 3. mint + deposit
  for (let i = 0; i < deposits.length; i++) {
    const m = call(pkg, "token_faucet", "faucet", [treasury], "token_faucet::faucet (test-only)");
    const coin = created(m, "Coin<");
    call(pkg, "pool", "deposit_and_register", [pool, coin, le32(deposits[i]), CLOCK]);
  }

  // 4. admin: commitment root, withdraw VK, compliance config
  const tTree = merkle(tNotes.map(transferCommit));
  call(pkg, "pool", "update_commitment_root", [pool, cap, le32(tTree.root), CLOCK]);
  call(pkg, "pool", "propose_withdraw_vk", [pool, cap, hex(vkToSuiBytes(W.vk)), CLOCK]);
  // Credential tree holds ONLY the compliant-run spenders [R, 2R). Leaf 2R has no credential.
  const credOwners = tNotes.slice(RUNS, 2 * RUNS).map((n) => n.userSecret);
  const cTree = merkle(credOwners.map(credLeaf));
  const auditorKey = "0x02" + "11".repeat(32); // 33-byte compressed point placeholder (length-checked only)
  const cc = call(pkg, "compliance", "create_compliance_config",
    [cap, pool, hex(vkToSuiBytes(C.vk)), le32(cTree.root), 1, auditorKey]);
  const config = created(cc, "ComplianceConfig");

  // 5. wait for maturity (pool_epoch > created_epoch) + root/VK timelocks
  const depositEpoch = epochOf(clockMs());
  console.log(`waiting for pool epoch > ${depositEpoch} ...`);
  let epoch = await waitForEpochAfter(depositEpoch);
  console.log(`epoch ${epoch} reached`);

  const encryptedAmount = "0x" + "ab".repeat(93); // MIN_ENCRYPTED_AMOUNT_LEN; contents unchecked on-chain

  // 6. shielded_transfer ×R
  for (let i = 0; i < RUNS; i++) {
    epoch = epochOf(clockMs());
    const p = await prove(T, transferWitness(tNotes[i], epoch, tTree, i));
    call(pkg, "pool", "shielded_transfer", [pool, p.proof, p.inputs, CLOCK], "pool::shielded_transfer",
      i === 0 ? "first tx of epoch: also applies pending root" : "");
  }

  // 7. compliant_transfer ×R (honest: credential owner == transfer spender)
  for (let i = 0; i < RUNS; i++) {
    epoch = epochOf(clockMs());
    const idx = RUNS + i;
    const tw = transferWitness(tNotes[idx], epoch, tTree, idx);
    const tp = await prove(T, tw);
    const cp2 = await prove(C, complianceWitness(tNotes[idx].userSecret, epoch, cTree, i, tw.nullifier));
    call(pkg, "compliance", "compliant_transfer",
      [pool, config, tp.proof, tp.inputs, cp2.proof, cp2.inputs, encryptedAmount, CLOCK]);
  }

  // 8. zk_withdraw ×R (first call also applies pending withdraw VK)
  const recipientField = BigInt(sender) >> 8n; // < BN254 r; contract never hashes `recipient` anyway
  for (let i = 0; i < RUNS; i++) {
    const p = await prove(W, withdrawWitness(wNotes[i], recipientField));
    call(pkg, "pool", "zk_withdraw", [pool, p.proof, p.inputs, sender, CLOCK], "pool::zk_withdraw",
      i === 0 ? "first call: also applies pending withdraw VK" : "");
  }

  // 9. Binding probes — expected to ABORT if the binding exists on-chain.
  const probes = {};
  const attacker = "0x" + "be".repeat(32);
  try {
    const p = await prove(W, withdrawWitness(wNotes[RUNS], recipientField)); // proof commits to `sender`
    const d = sui(["call", "--package", pkg, "--module", "pool", "--function", "zk_withdraw",
      "--args", pool, p.proof, p.inputs, attacker, CLOCK, "--gas-budget", GAS_BUDGET]);
    const got = d.objectChanges?.find((o) => o.type === "created" && o.owner?.AddressOwner === attacker);
    probes.withdrawRedirect = { status: d.effects.status.status, coinSentTo: got ? attacker : null, digest: d.digest };
  } catch (e) {
    probes.withdrawRedirect = { status: "aborted", error: String(e.stderr ?? e.message).slice(0, 400) };
  }
  try {
    epoch = epochOf(clockMs());
    const idx = 2 * RUNS; // spender with NO credential in cTree
    const tw = transferWitness(tNotes[idx], epoch, tTree, idx);
    const tp = await prove(T, tw);
    // borrow credential 0's owner secret (a different user) — bound to this transfer's nullifier
    const cp2 = await prove(C, complianceWitness(credOwners[0], epoch, cTree, 0, tw.nullifier));
    const d = sui(["call", "--package", pkg, "--module", "compliance", "--function", "compliant_transfer",
      "--args", pool, config, tp.proof, tp.inputs, cp2.proof, cp2.inputs, encryptedAmount, CLOCK,
      "--gas-budget", GAS_BUDGET]);
    probes.credentialLending = { status: d.effects.status.status, digest: d.digest };
  } catch (e) {
    probes.credentialLending = { status: "aborted", error: String(e.stderr ?? e.message).slice(0, 400) };
  }
  console.log(`[probe] withdraw-redirect:  ${JSON.stringify(probes.withdrawRedirect)}`);
  console.log(`[probe] credential-lending: ${JSON.stringify(probes.credentialLending)}`);

  // ── summary ────────────────────────────────────────────────────────────────
  const by = new Map();
  for (const r of records) (by.get(r.entry) ?? by.set(r.entry, []).get(r.entry)).push(r);
  console.log(`\n| Entry point | n | computation (MIST) | gas units @RGP ${rgp} | storage | rebate | net (MIST) | net (SUI) |`);
  console.log("|---|---|---|---|---|---|---|---|");
  for (const [entry, rs] of by) {
    const mean = (k) => Math.round(rs.reduce((s, r) => s + r[k], 0) / rs.length);
    const span = (k) => {
      const v = rs.map((r) => r[k]);
      const lo = Math.min(...v), hi = Math.max(...v);
      return lo === hi ? `${lo}` : `${lo}–${hi}`;
    };
    console.log(`| \`${entry}\` | ${rs.length} | ${span("computationCost")} | ${Math.round(mean("computationCost") / rgp)} | ` +
      `${span("storageCost")} | ${span("storageRebate")} | ${span("net")} | ${(mean("net") / 1e9).toFixed(6)} |`);
  }
  if (OUT) {
    writeFileSync(OUT, JSON.stringify({ rgp, runs: RUNS, records, probes }, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[FATAL]", e.stderr?.toString?.() ?? "", e);
  process.exit(1);
});
