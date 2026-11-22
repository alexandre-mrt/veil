#!/usr/bin/env node
/**
 * gas-localnet-repro.mjs — Real on-chain gas for every Veil entry point, measured on a Sui localnet
 * with real Groth16 proofs (no mocks, no estimates). Also runs two adversarial probes against
 * zk_withdraw (recipient redirection, deposit-amount inflation) and records whether the chain
 * accepted them.
 *
 * Prerequisites (see scripts/bench/README.md):
 *   1. `sui` CLI on PATH (tested: 1.84.1, prebuilt testnet release binary)
 *   2. A running localnet:  sui start --with-faucet --force-regenesis
 *   3. Circuit artifacts:   circuits/build{,-withdraw,-compliance}/ (compile*.sh)
 *   4. npm install in scripts/bench
 *
 * Usage:
 *   node scripts/bench/gas-localnet-repro.mjs [--rpc http://127.0.0.1:9000] [--faucet http://127.0.0.1:9123]
 *                                       [--out scripts/bench/results/gas-localnet-repro.json]
 *
 * Gas accounting: every row reports the raw `effects.gasUsed` fields from the fullnode, plus
 * computation units (= computationCost / referenceGasPrice) and net cost
 * (= computationCost + storageCost - storageRebate), all in MIST.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

import {
  bigintToLE32,
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123");
const OUT = arg("--out", join(__dirname, "results", "gas-localnet-repro.json"));

const EPOCH_MS = 60_000; // pool.move minimum epoch duration — keeps the timelock waits short
const THRESHOLD = 1_000_000_000n;
const DENOM_SMALL = 100_000_000n;
const DENOM_MEDIUM = 500_000_000n;
const DENOM_LARGE = 1_000_000_000n;
const DEPTH = 20;
const CLOCK = "0x6";
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ART = {
  transfer: { wasm: "circuits/build/transfer_js/transfer.wasm", zkey: "circuits/build/transfer_final.zkey", vk: "circuits/build/transfer_vk.json" },
  withdraw: { wasm: "circuits/build-withdraw/withdraw_js/withdraw.wasm", zkey: "circuits/build-withdraw/withdraw_final.zkey", vk: "circuits/build-withdraw/withdraw_vk.json" },
  compliance: { wasm: "circuits/build-compliance/compliance_js/compliance.wasm", zkey: "circuits/build-compliance/compliance_final.zkey", vk: "circuits/build-compliance/compliance_vk.json" },
};

const client = new SuiGrpcClient({ baseUrl: RPC, network: "localnet" });
const rows = [];
let poseidon, F;
const H = (xs) => F.toObject(poseidon(xs));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function fund(addr) {
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: addr });
  for (let i = 0; i < 30; i++) {
    const b = await client.getBalance({ owner: addr });
    if (BigInt(b.balance.balance) > 0n) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`faucet never funded ${addr}`);
}

async function exec(label, signer, build, { expectFailure = false, record = true } = {}) {
  const tx = new Transaction();
  tx.setGasBudget(500_000_000);
  build(tx);
  let out;
  try {
    out = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      include: { effects: true, objectTypes: true, balanceChanges: true },
    });
  } catch (e) {
    // The SDK simulates before signing; a Move abort there means the transaction is rejected
    // before it ever reaches consensus (no gas is charged, no digest exists).
    if (!expectFailure || !e.executionError) throw e;
    console.log(`  rej ${label.padEnd(44)} rejected at simulation: ${e.executionError.message}`);
    return { digest: null, status: { success: false, error: { message: e.executionError.message } }, balanceChanges: [] };
  }
  const res = out.Transaction ?? out.FailedTransaction;
  await client.waitForTransaction({ digest: res.digest });
  const status = res.status.success ? "success" : "failure";
  if (status !== "success" && !expectFailure) {
    throw new Error(`${label} failed: ${JSON.stringify(res.status)}`);
  }
  if (status === "success" && expectFailure) {
    console.log(`  !! ${label}: expected failure but transaction SUCCEEDED`);
  }
  const g = res.effects.gasUsed;
  const row = {
    label,
    status,
    error: res.status.error ? res.status.error.message : null,
    digest: res.digest,
    computationCost: Number(g.computationCost),
    storageCost: Number(g.storageCost),
    storageRebate: Number(g.storageRebate),
    nonRefundableStorageFee: Number(g.nonRefundableStorageFee),
  };
  row.net = row.computationCost + row.storageCost - row.storageRebate;
  if (record) rows.push(row);
  console.log(`  ${status === "success" ? "ok " : "ERR"} ${label.padEnd(44)} comp=${row.computationCost} storage=${row.storageCost} rebate=${row.storageRebate} net=${row.net}${row.error ? "  [" + row.error + "]" : ""}`);
  return res;
}

const created = (res, typeFrag) =>
  res.effects.changedObjects.find((c) => c.idOperation === "Created" && (res.objectTypes[c.objectId] ?? "").includes(typeFrag)).objectId;

async function chainNowMs() {
  // Clock { id: UID (32 bytes), timestamp_ms: u64 LE }
  const { object } = await client.getObject({ objectId: CLOCK, include: { content: true } });
  return new DataView(object.content.buffer, object.content.byteOffset).getBigUint64(32, true);
}
const epochAt = (ms) => ms / BigInt(EPOCH_MS);
async function waitForEpochAfter(e) {
  process.stdout.write(`  waiting for pool epoch > ${e} `);
  for (;;) {
    const now = epochAt(await chainNowMs());
    if (now > e) { console.log(`→ ${now}`); return now; }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function prove(circuit, input) {
  const a = ART[circuit];
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    stringify(input), join(ROOT, a.wasm), join(ROOT, a.zkey),
  );
  const vk = JSON.parse(readFileSync(join(ROOT, a.vk), "utf8"));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error(`${circuit} proof failed off-chain verification`);
  console.log(`  proved ${circuit} (${(performance.now() - t0).toFixed(0)} ms, ${publicSignals.length} public signals)`);
  return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals), publicSignals };
}
function stringify(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = Array.isArray(v) ? v.map(String) : String(v);
  return out;
}
const vkBytes = (c) => vkToSuiBytes(JSON.parse(readFileSync(join(ROOT, ART[c].vk), "utf8")));
const le = (x) => Array.from(bigintToLE32(x));
const u8 = (tx, bytes) => tx.pure.vector("u8", Array.from(bytes));

// Merkle tree of depth 20 with leaves at index 0 and 1 and literal-zero siblings above level 0
// (matches the zero-sibling convention used by circuits/test/*.test.mjs).
function twoLeafPaths(leaf0, leaf1) {
  let node = H([leaf0, leaf1]);
  for (let i = 1; i < DEPTH; i++) node = H([node, 0n]);
  const zeros = Array(DEPTH - 1).fill(0n);
  return {
    root: node,
    path0: { pathElements: [leaf1, ...zeros], pathIndices: Array(DEPTH).fill(0n) },
    path1: { pathElements: [leaf0, ...zeros], pathIndices: [1n, ...Array(DEPTH - 1).fill(0n)] },
  };
}

const note = (secret, cumulative, randomness) => ({
  secret, cumulative, randomness, commitment: H([1n, cumulative, randomness, secret]),
});

function transferWitness(n, path, root, epochId, txAmount, randomnessNew, salt) {
  const cumulativeNew = n.cumulative + txAmount;
  return {
    oldCommitment: n.commitment,
    newCommitment: H([1n, cumulativeNew, randomnessNew, n.secret]),
    threshold: THRESHOLD,
    epochId,
    nullifier: H([2n, n.secret, epochId, n.randomness]),
    txAmountHash: H([3n, txAmount, salt]),
    merkleRoot: root,
    cumulativeOld: n.cumulative, cumulativeNew, txAmount,
    randomnessOld: n.randomness, randomnessNew, userSecret: n.secret, salt,
    ...path,
  };
}

function withdrawWitness(n, withdrawAmount, recipientField, randomnessNew) {
  const remaining = n.cumulative - withdrawAmount;
  return {
    commitment: n.commitment,
    withdrawAmount,
    nullifier: H([7n, n.secret, n.randomness, n.cumulative]),
    recipientHash: H([8n, recipientField]),
    newCommitment: H([1n, remaining, randomnessNew, n.secret]),
    cumulativeOld: n.cumulative, randomnessOld: n.randomness, userSecret: n.secret,
    recipient: recipientField, randomnessNew,
  };
}
const addrField = (addr) => BigInt(addr) % R;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  poseidon = await buildPoseidon();
  F = poseidon.F;

  const chainId = (await client.getChainIdentifier()).chainIdentifier;
  const rgp = Number((await client.getReferenceGasPrice()).referenceGasPrice);
  const suiVersion = execFileSync("sui", ["--version"]).toString().trim();
  console.log(`RPC ${RPC}  chain ${chainId}  RGP ${rgp} MIST  ${suiVersion}`);

  const admin = new Ed25519Keypair();
  const alice = new Ed25519Keypair();   // honest withdrawer
  const mallory = new Ed25519Keypair(); // adversary (front-runner / inflater)
  for (const k of [admin, alice, mallory]) await fund(k.toSuiAddress());

  // ── publish ────────────────────────────────────────────────────────────
  const build = JSON.parse(execFileSync("sui", [
    "move", "build", "--dump-bytecode-as-base64", "--build-env", "testnet",
    "--path", join(ROOT, "contracts"),
  ], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  const pub = await exec("publish (6 modules)", admin, (tx) => {
    const [cap] = tx.publish({ modules: build.modules, dependencies: build.dependencies });
    tx.transferObjects([cap], admin.toSuiAddress());
  });
  const pkg = pub.effects.changedObjects.find((c) => c.outputState === "PackageWrite").objectId;
  const treasury = created(pub, "TreasuryCap");

  // ── admin setup ────────────────────────────────────────────────────────
  const cp = await exec("create_pool", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::create_pool`,
    arguments: [u8(tx, vkBytes("transfer")), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)],
  }));
  const pool = created(cp, "::pool::Pool");
  const cap = created(cp, "::pool::AdminCap");

  await exec("token::mint", admin, (tx) => tx.moveCall({
    target: `${pkg}::token::mint`,
    arguments: [tx.object(treasury), tx.pure.u64(10n * DENOM_LARGE), tx.pure.address(admin.toSuiAddress())],
  }));
  await exec("token_faucet::faucet", admin, (tx) => tx.moveCall({
    target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)],
  }));
  // Mallory gets exactly one small deposit's worth of tokens.
  await exec("token::mint (to mallory, 100 TOKEN)", admin, (tx) => tx.moveCall({
    target: `${pkg}::token::mint`,
    arguments: [tx.object(treasury), tx.pure.u64(DENOM_SMALL), tx.pure.address(mallory.toSuiAddress())],
  }), { record: false });

  // ── notes ──────────────────────────────────────────────────────────────
  const rnd = () => BigInt("0x" + randomBytes(16).toString("hex"));
  const nA = note(rnd(), 0n, rnd());          // shielded_transfer
  const nC = note(rnd(), 0n, rnd());          // compliant_transfer
  const nB = note(rnd(), 500n, rnd());        // honest zk_withdraw (claims 500 units)
  const nD = note(rnd(), 500n, rnd());        // honest withdraw proof that Mallory redirects
  const nM = note(rnd(), 2n * DENOM_LARGE, rnd()); // Mallory's inflated note: claims 2000 TOKEN (pool holds ~2700)
  const tree = twoLeafPaths(nA.commitment, nC.commitment);

  const coinType = `${pkg}::token::TOKEN`;
  async function deposit(label, signer, n, amount, record = true) {
    const coins = (await client.listCoins({ owner: signer.toSuiAddress(), coinType })).objects;
    return exec(label, signer, (tx) => {
      const primary = tx.object(coins[0].objectId);
      if (coins.length > 1) tx.mergeCoins(primary, coins.slice(1).map((c) => tx.object(c.objectId)));
      const [c] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
      tx.moveCall({
        target: `${pkg}::pool::deposit_and_register`,
        arguments: [tx.object(pool), c, u8(tx, le(n.commitment)), tx.object(CLOCK)],
      });
    }, { record });
  }
  await deposit("deposit_and_register (1st, 500 TOKEN)", admin, nA, DENOM_MEDIUM);
  await deposit("deposit_and_register (2nd, 1000 TOKEN)", admin, nC, DENOM_LARGE);
  await deposit("deposit_and_register (3rd, 100 TOKEN)", admin, nB, DENOM_SMALL);
  await deposit("deposit_and_register (4th, 1000 TOKEN)", admin, nD, DENOM_LARGE);
  await deposit("deposit_and_register (mallory, 100 TOKEN)", mallory, nM, DENOM_SMALL, false);

  await exec("update_commitment_root (propose)", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::update_commitment_root`,
    arguments: [tx.object(pool), tx.object(cap), u8(tx, le(tree.root)), tx.object(CLOCK)],
  }));
  await exec("propose_withdraw_vk", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::propose_withdraw_vk`,
    arguments: [tx.object(pool), tx.object(cap), u8(tx, vkBytes("withdraw")), tx.object(CLOCK)],
  }));

  // Compliance credential tree: a single leaf at index 0 with literal-zero siblings.
  const kyc = { secret: nC.secret, level: 2n, issuer: 42n };
  const setupEpoch = epochAt(await chainNowMs());
  kyc.expiry = setupEpoch + 10_000n;
  const credLeaf = H([4n, kyc.secret, kyc.level, kyc.expiry, kyc.issuer]);
  let credRoot = credLeaf;
  for (let i = 0; i < DEPTH; i++) credRoot = H([credRoot, 0n]);
  const auditorKey = new Uint8Array([0x02, ...randomBytes(32)]);
  const cc = await exec("create_compliance_config", admin, (tx) => tx.moveCall({
    target: `${pkg}::compliance::create_compliance_config`,
    arguments: [tx.object(cap), tx.object(pool), u8(tx, vkBytes("compliance")),
      u8(tx, le(credRoot)), tx.pure.u64(1n), u8(tx, auditorKey)],
  }));
  const config = created(cc, "::compliance::ComplianceConfig");

  // ── wait one pool epoch: root + withdraw VK timelocks apply, commitments mature ──
  const epoch = await waitForEpochAfter(setupEpoch);

  // ── shielded_transfer ──────────────────────────────────────────────────
  const pA = await prove("transfer", transferWitness(nA, tree.path0, tree.root, epoch, 100n, rnd(), rnd()));
  // negative control first: tamper txAmountHash (public input 5) → proof must be rejected on-chain
  const bad = Uint8Array.from(pA.inputs); bad[160] ^= 1;
  await exec("shielded_transfer (tampered input → E_INVALID_PROOF)", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::shielded_transfer`,
    arguments: [tx.object(pool), u8(tx, pA.proof), u8(tx, bad), tx.object(CLOCK)],
  }), { expectFailure: true, record: false });
  await exec("shielded_transfer (applies pending root)", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::shielded_transfer`,
    arguments: [tx.object(pool), u8(tx, pA.proof), u8(tx, pA.inputs), tx.object(CLOCK)],
  }));
  await exec("shielded_transfer (replay → E_COMMITMENT_CHAIN_BROKEN)", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::shielded_transfer`,
    arguments: [tx.object(pool), u8(tx, pA.proof), u8(tx, pA.inputs), tx.object(CLOCK)],
  }), { expectFailure: true, record: false });

  // ── compliant_transfer ─────────────────────────────────────────────────
  const tC = transferWitness(nC, tree.path1, tree.root, epoch, 250n, rnd(), rnd());
  const pC = await prove("transfer", tC);
  const contextId = H([6n, tC.nullifier, kyc.secret]);
  const pK = await prove("compliance", {
    merkleRoot: credRoot, currentEpoch: epoch, contextId, requiredKycLevel: 1n,
    nullifier: H([5n, kyc.secret, contextId]), validCredential: 1n,
    userSecret: kyc.secret, kycLevel: kyc.level, expiryEpoch: kyc.expiry, issuerId: kyc.issuer,
    pathElements: Array(DEPTH).fill(0n), pathIndices: Array(DEPTH).fill(0n),
    transferNullifier: tC.nullifier,
  });
  await exec("compliant_transfer (2 proofs)", admin, (tx) => tx.moveCall({
    target: `${pkg}::compliance::compliant_transfer`,
    arguments: [tx.object(pool), tx.object(config), u8(tx, pC.proof), u8(tx, pC.inputs),
      u8(tx, pK.proof), u8(tx, pK.inputs), u8(tx, randomBytes(93)), tx.object(CLOCK)],
  }));

  // ── zk_withdraw (honest) ───────────────────────────────────────────────
  const pB = await prove("withdraw", withdrawWitness(nB, 100n, addrField(alice.toSuiAddress()), rnd()));
  await exec("zk_withdraw (applies pending withdraw VK)", alice, (tx) => tx.moveCall({
    target: `${pkg}::pool::zk_withdraw`,
    arguments: [tx.object(pool), u8(tx, pB.proof), u8(tx, pB.inputs),
      tx.pure.address(alice.toSuiAddress()), tx.object(CLOCK)],
  }));

  // ── PROBE 1: recipient redirection (threat-model E7) ───────────────────
  // Alice proves a withdrawal bound to recipientHash = Poseidon(8, alice). Mallory copies the
  // proof bytes and public inputs verbatim and submits them with recipient = mallory.
  console.log("\nPROBE 1 — recipient redirection (E7)");
  const pD = await prove("withdraw", withdrawWitness(nD, 400n, addrField(alice.toSuiAddress()), rnd()));
  const p1 = await exec("PROBE zk_withdraw (alice's proof, recipient=mallory)", mallory, (tx) => tx.moveCall({
    target: `${pkg}::pool::zk_withdraw`,
    arguments: [tx.object(pool), u8(tx, pD.proof), u8(tx, pD.inputs),
      tx.pure.address(mallory.toSuiAddress()), tx.object(CLOCK)],
  }), { expectFailure: true, record: false });
  const p1Gain = p1.balanceChanges?.find((b) => b.coinType === coinType && b.address === mallory.toSuiAddress());

  // ── PROBE 2: deposit-amount inflation (threat-model E4) ────────────────
  // Mallory deposited 100 TOKEN against a commitment claiming cumulativeOld = 2000 TOKEN.
  console.log("\nPROBE 2 — deposit-amount inflation (E4)");
  const pM = await prove("withdraw", withdrawWitness(nM, 2n * DENOM_LARGE, addrField(mallory.toSuiAddress()), rnd()));
  const p2 = await exec("PROBE zk_withdraw (100 TOKEN deposit → 2000 out)", mallory, (tx) => tx.moveCall({
    target: `${pkg}::pool::zk_withdraw`,
    arguments: [tx.object(pool), u8(tx, pM.proof), u8(tx, pM.inputs),
      tx.pure.address(mallory.toSuiAddress()), tx.object(CLOCK)],
  }), { expectFailure: true, record: false });
  const p2Gain = p2.balanceChanges?.find((b) => b.coinType === coinType && b.address === mallory.toSuiAddress());

  // ── admin ops (timelocked) ─────────────────────────────────────────────
  await exec("propose_withdrawal", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::propose_withdrawal`,
    arguments: [tx.object(pool), tx.object(cap), tx.pure.u64(1000n), tx.pure.address(admin.toSuiAddress()), tx.object(CLOCK)],
  }));
  await exec("freeze_pool", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::freeze_pool`, arguments: [tx.object(pool), tx.object(cap), tx.object(CLOCK)],
  }));
  await exec("unfreeze_pool", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::unfreeze_pool`, arguments: [tx.object(pool), tx.object(cap)],
  }));
  const e2 = await waitForEpochAfter(epoch);
  await exec("execute_pending_withdrawal", admin, (tx) => tx.moveCall({
    target: `${pkg}::pool::execute_pending_withdrawal`,
    arguments: [tx.object(pool), tx.object(cap), tx.object(CLOCK)],
  }));

  const result = {
    measuredAt: new Date().toISOString(),
    rpc: RPC, chainId, referenceGasPrice: rgp, sui: suiVersion, node: process.version,
    poolEpochs: { setup: String(setupEpoch), proving: String(epoch), final: String(e2) },
    rows: rows.map((r) => ({ ...r, computationUnits: r.computationCost / rgp })),
    probes: {
      E7_recipient_redirection: { status: p1.status.success ? "success" : "failure", error: p1.status.error?.message ?? null, digest: p1.digest, malloryTokenDelta: p1Gain?.amount ?? "0" },
      E4_deposit_inflation: { status: p2.status.success ? "success" : "failure", error: p2.status.error?.message ?? null, digest: p2.digest, malloryDeposited: String(DENOM_SMALL), malloryTokenDelta: p2Gain?.amount ?? "0" },
    },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");

  console.log(`\nRGP = ${rgp} MIST/unit`);
  console.log("| Entry point | status | computation (MIST) | units | storage | rebate | net (MIST) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of result.rows) {
    console.log(`| ${r.label} | ${r.status} | ${r.computationCost} | ${r.computationUnits} | ${r.storageCost} | ${r.storageRebate} | ${r.net} |`);
  }
  console.log("\nProbes:", JSON.stringify(result.probes, null, 2));
  console.log(`wrote ${OUT}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
