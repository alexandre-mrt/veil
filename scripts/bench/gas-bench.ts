/**
 * gas-bench.ts — On-chain gas per Veil entry point, measured on a local Sui network with REAL
 * Groth16 proofs (not mocks).
 *
 * Usage (run from repo root):
 *   sui start --force-regenesis --with-faucet --committee-size 1 &     # localnet on :9000, faucet :9123
 *   node scripts/bench/gas-bench.ts [--json out.json] [--rpc http://127.0.0.1:9000] [--faucet http://127.0.0.1:9123]
 *
 * Prerequisites:
 *   - circuits compiled + zkeys built: circuits/build{,-withdraw,-compliance}/ (see prove-latency.mjs header)
 *   - `sui` on PATH (only used for `sui move build --dump-bytecode-as-base64`)
 *   - `bun install` in scripts/ (provides @mysten/sui, snarkjs, circomlibjs)
 *
 * The pool uses the minimum epoch (60 s), and timelocked ops (commitment root, withdraw VK) need one
 * full epoch, so the run takes ~2-3 minutes of wall-clock. Reported gas is the chain's own
 * `effects.gasUsed`; "units" = computationCost / reference gas price.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error snarkjs ships no types
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : dflt;
};
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123");
const JSON_OUT = arg("--json", "");

const EPOCH_MS = 60_000; // contract minimum
const THRESHOLD = 1_000_000_000n;
const DEPTH = 20;
const DENOM_SMALL = 100_000_000;
const GAS_BUDGET = 500_000_000;
const N_TRANSFER = 3;
const N_COMPLIANT = 2;

const CIRCUIT = {
  transfer: { dir: "build", name: "transfer" },
  withdraw: { dir: "build-withdraw", name: "withdraw" },
  compliance: { dir: "build-compliance", name: "compliance" },
} as const;
type CircuitKey = keyof typeof CIRCUIT;
const art = (c: CircuitKey) => {
  const { dir, name } = CIRCUIT[c];
  const base = join(ROOT, "circuits", dir);
  return {
    wasm: join(base, `${name}_js`, `${name}.wasm`),
    zkey: join(base, `${name}_final.zkey`),
    vk: JSON.parse(readFileSync(join(base, `${name}_vk.json`), "utf-8")),
  };
};

// ---------------------------------------------------------------------------
// Poseidon / Merkle helpers (match circuits/test + scripts/bench/witnesses.mjs)
// ---------------------------------------------------------------------------
const D_COMMIT = 1n, D_NULL = 2n, D_TXAMT = 3n, D_CRED = 4n, D_CNULL = 5n, D_CTX = 6n, D_WNULL = 7n, D_RECIP = 8n;
let H: (xs: bigint[]) => bigint;

/** Sparse depth-20 tree; empty subtrees use zero-hash of that level. Returns root + per-leaf path. */
function buildTree(leaves: bigint[]) {
  const zeros: bigint[] = [0n];
  for (let i = 0; i < DEPTH; i++) zeros.push(H([zeros[i], zeros[i]]));
  let level = new Map<number, bigint>(leaves.map((l, i) => [i, l]));
  const levels = [level];
  for (let l = 0; l < DEPTH; l++) {
    const next = new Map<number, bigint>();
    for (const idx of new Set([...level.keys()].map((i) => i >> 1))) {
      const left = level.get(idx * 2) ?? zeros[l];
      const right = level.get(idx * 2 + 1) ?? zeros[l];
      next.set(idx, H([left, right]));
    }
    level = next;
    levels.push(level);
  }
  const root = levels[DEPTH].get(0)!;
  const path = (leafIdx: number) => {
    const pathElements: bigint[] = [], pathIndices: bigint[] = [];
    let idx = leafIdx;
    for (let l = 0; l < DEPTH; l++) {
      pathElements.push(levels[l].get(idx ^ 1) ?? zeros[l]);
      pathIndices.push(BigInt(idx & 1));
      idx >>= 1;
    }
    return { pathElements, pathIndices };
  };
  return { root, path };
}

const strInputs = (o: Record<string, bigint | bigint[]>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

async function prove(c: CircuitKey, input: Record<string, bigint | bigint[]>) {
  const a = art(c);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(strInputs(input), a.wasm, a.zkey);
  if (!(await snarkjs.groth16.verify(a.vk, publicSignals, proof))) throw new Error(`${c}: local verify failed`);
  return { proofBytes: proofToSuiBytes(proof), inputsBytes: publicInputsToSuiBytes(publicSignals) };
}

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------
const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const signer = Ed25519Keypair.generate();
const sender = signer.toSuiAddress();
let RGP = 1000n;

interface GasRow { label: string; ok: boolean; computation: bigint; storage: bigint; rebate: bigint; units: bigint; net: bigint; error?: string }
const rows: GasRow[] = [];

async function exec(label: string, tx: Transaction, opts: { expectFail?: boolean; record?: boolean } = {}) {
  tx.setGasBudget(GAS_BUDGET);
  const r = await client.signAndExecuteTransaction({
    transaction: tx, signer, options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  const ok = r.effects?.status?.status === "success";
  if (!ok && !opts.expectFail) throw new Error(`${label} failed: ${JSON.stringify(r.effects?.status)}`);
  if (ok && opts.expectFail) throw new Error(`${label} unexpectedly succeeded`);
  const g = r.effects!.gasUsed;
  const computation = BigInt(g.computationCost), storage = BigInt(g.storageCost), rebate = BigInt(g.storageRebate);
  if (opts.record !== false) {
    rows.push({
      label, ok, computation, storage, rebate, units: computation / RGP, net: computation + storage - rebate,
      error: ok ? undefined : r.effects?.status?.error,
    });
    console.log(`  ${label.padEnd(44)} ${ok ? "ok  " : "ABRT"} comp=${computation} (${computation / RGP} units) storage=${storage} rebate=${rebate}`);
  }
  return r;
}

async function chainEpoch(): Promise<bigint> {
  const o = await client.getObject({ id: "0x6", options: { showContent: true } });
  const ts = (o.data!.content as any).fields.timestamp_ms as string;
  return BigInt(ts) / BigInt(EPOCH_MS);
}
async function waitUntilEpoch(target: bigint) {
  while ((await chainEpoch()) < target) await new Promise((r) => setTimeout(r, 2000));
  await new Promise((r) => setTimeout(r, 1500)); // settle: next tx must see a clock inside the epoch
}
const bytes = (u: Uint8Array) => Array.from(u);
const le32 = (n: bigint) => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; }
  return b;
};

// ---------------------------------------------------------------------------
async function main() {
  const poseidon = await buildPoseidon();
  H = (xs) => poseidon.F.toObject(poseidon(xs)) as bigint;

  console.log(`=== Veil on-chain gas benchmark (localnet ${RPC}) ===`);
  console.log(`sui ${execSync("sui -V", { encoding: "utf-8" }).trim()}  node ${process.version}`);
  RGP = BigInt(await client.getReferenceGasPrice());
  console.log(`reference gas price: ${RGP} MIST/unit\n`);

  for (let i = 0; i < 2; i++) await requestSuiFromFaucetV2({ host: `${FAUCET}/v2/gas`, recipient: sender });
  await new Promise((r) => setTimeout(r, 3000));

  // --- build + publish ----------------------------------------------------
  const built = JSON.parse(execSync(`sui move build --dump-bytecode-as-base64 --no-tree-shaking --path ${join(ROOT, "contracts")}`, {
    encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  }));
  console.log("-- publish");
  let tx = new Transaction();
  const upgradeCap = tx.publish({ modules: built.modules, dependencies: built.dependencies });
  tx.transferObjects([upgradeCap], sender);
  const pub = await exec("publish (all 6 modules)", tx);
  const pkg = pub.objectChanges!.find((c: any) => c.type === "published")!.packageId;
  const treasuryId = pub.objectChanges!.find((c: any) => c.objectType?.includes("TreasuryCap"))!.objectId;

  // --- witnesses that don't depend on timing ------------------------------
  const tVk = vkToSuiBytes(art("transfer").vk);
  const wVk = vkToSuiBytes(art("withdraw").vk);
  const cVk = vkToSuiBytes(art("compliance").vk);

  const userSecret = 987654321n;
  const mkLeaf = (i: number) => {
    const randomnessOld = BigInt(1000 + i);
    return { randomnessOld, oldCommitment: H([D_COMMIT, 0n, randomnessOld, userSecret]) };
  };
  const transferLeaves = Array.from({ length: N_TRANSFER + N_COMPLIANT }, (_, i) => mkLeaf(i));
  const tree = buildTree(transferLeaves.map((l) => l.oldCommitment));

  // withdraw commitments (partial withdraw, no merkle membership in this circuit)
  const wRandOld = [555n, 556n];
  const wCommit = wRandOld.map((r) => H([D_COMMIT, 500n, r, userSecret]));

  // --- create pool, withdraw VK, compliance config ------------------------
  console.log("\n-- admin / setup");
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [tx.pure.vector("u8", bytes(tVk)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
  const cp = await exec("create_pool", tx);
  const poolId = (cp.objectChanges as any[]).find((c) => c.objectType?.endsWith("::pool::Pool")).objectId;
  const adminCapId = (cp.objectChanges as any[]).find((c) => c.objectType?.endsWith("::pool::AdminCap")).objectId;
  const CLOCK = "0x6";

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", bytes(wVk)), tx.object(CLOCK)] });
  await exec("propose_withdraw_vk (timelocked)", tx);

  // compliance credential tree (single credential, same construction as circuit tests)
  const kycLevel = 2n, issuerId = 42n, expiry = 10_000_000_000n;
  const credLeaf = H([D_CRED, userSecret, kycLevel, expiry, issuerId]);
  let credRoot = credLeaf;
  for (let i = 0; i < DEPTH; i++) credRoot = H([credRoot, 0n]);
  const auditorKey = new Uint8Array(33).fill(2);
  tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::compliance::create_compliance_config`,
    arguments: [tx.object(adminCapId), tx.object(poolId), tx.pure.vector("u8", bytes(cVk)), tx.pure.vector("u8", bytes(le32(credRoot))),
      tx.pure.u64(1), tx.pure.vector("u8", bytes(auditorKey))],
  });
  const cc = await exec("create_compliance_config", tx);
  const configId = (cc.objectChanges as any[]).find((c) => c.objectType?.endsWith("::compliance::ComplianceConfig")).objectId;

  // --- mint, pre-split, deposit ------------------------------------------
  const nDeposits = transferLeaves.length + wCommit.length;
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasuryId)] });
  const mint = await exec("token_faucet::faucet (setup, mint 1000)", tx, { record: false });
  const coinId = (mint.objectChanges as any[]).find((c) => c.type === "created" && c.objectType?.includes("::token::TOKEN")).objectId;
  tx = new Transaction();
  const parts = tx.splitCoins(tx.object(coinId), Array.from({ length: nDeposits }, () => tx.pure.u64(DENOM_SMALL)));
  tx.transferObjects(Array.from({ length: nDeposits }, (_, i) => parts[i]), sender);
  const split = await exec("splitCoins (setup)", tx, { record: false });
  const depCoins = (split.objectChanges as any[]).filter((c) => c.type === "created" && c.objectType?.includes("::token::TOKEN")).map((c) => c.objectId);

  console.log("\n-- deposits");
  const allCommits = [...transferLeaves.map((l) => l.oldCommitment), ...wCommit];
  let maxEpoch = 0n;
  for (let i = 0; i < nDeposits; i++) {
    tx = new Transaction();
    tx.moveCall({
      target: `${pkg}::pool::deposit_and_register`,
      arguments: [tx.object(poolId), tx.object(depCoins[i]), tx.pure.vector("u8", bytes(le32(allCommits[i]))), tx.object(CLOCK)],
    });
    await exec(`deposit_and_register #${i + 1}`, tx);
    const e = await chainEpoch();
    if (e > maxEpoch) maxEpoch = e;
  }

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", bytes(le32(tree.root))), tx.object(CLOCK)] });
  await exec("update_commitment_root (timelocked)", tx);
  maxEpoch = (await chainEpoch()) > maxEpoch ? await chainEpoch() : maxEpoch;

  const target = maxEpoch + 1n;
  console.log(`\n-- waiting for epoch ${target} (commitments mature + timelocks apply)...`);
  await waitUntilEpoch(target);

  // --- shielded transfers -------------------------------------------------
  const transferProof = async (i: number, mutate?: (inputs: Uint8Array) => void) => {
    const epochId = await chainEpoch();
    const { randomnessOld, oldCommitment } = transferLeaves[i];
    const randomnessNew = BigInt(9000 + i), txAmount = 100n, salt = 99n;
    const input = {
      oldCommitment,
      newCommitment: H([D_COMMIT, txAmount, randomnessNew, userSecret]),
      threshold: THRESHOLD, epochId,
      nullifier: H([D_NULL, userSecret, epochId, randomnessOld]),
      txAmountHash: H([D_TXAMT, txAmount, salt]),
      merkleRoot: tree.root,
      cumulativeOld: 0n, cumulativeNew: txAmount, txAmount, randomnessOld, randomnessNew, userSecret, salt,
      ...tree.path(i),
    };
    const p = await prove("transfer", input);
    mutate?.(p.inputsBytes);
    return p;
  };

  console.log("\n-- shielded_transfer");
  // negative path first (does not consume state): valid-looking inputs, proof does not verify -> E_INVALID_PROOF
  {
    const p = await transferProof(0, (inp) => { inp[130] ^= 1; }); // flip a nullifier bit, stays < field w.h.p.
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(poolId), tx.pure.vector("u8", bytes(p.proofBytes)), tx.pure.vector("u8", bytes(p.inputsBytes)), tx.object(CLOCK)] });
    await exec("shielded_transfer — INVALID proof (abort)", tx, { expectFail: true });
  }
  for (let i = 0; i < N_TRANSFER; i++) {
    const p = await transferProof(i);
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(poolId), tx.pure.vector("u8", bytes(p.proofBytes)), tx.pure.vector("u8", bytes(p.inputsBytes)), tx.object(CLOCK)] });
    await exec(`shielded_transfer #${i + 1}`, tx);
  }

  // --- compliant transfers ------------------------------------------------
  console.log("\n-- compliant_transfer (transfer proof + compliance proof)");
  for (let j = 0; j < N_COMPLIANT; j++) {
    const i = N_TRANSFER + j;
    const tp = await transferProof(i);
    const epochId = await chainEpoch();
    const transferNullifier = H([D_NULL, userSecret, epochId, transferLeaves[i].randomnessOld]);
    const contextId = H([D_CTX, transferNullifier, userSecret]);
    const cInput = {
      merkleRoot: credRoot, currentEpoch: epochId, contextId, requiredKycLevel: 1n,
      nullifier: H([D_CNULL, userSecret, contextId]), validCredential: 1n,
      userSecret, kycLevel, expiryEpoch: expiry, issuerId,
      pathElements: Array.from({ length: DEPTH }, () => 0n), pathIndices: Array.from({ length: DEPTH }, () => 0n),
      transferNullifier,
    };
    const cp2 = await prove("compliance", cInput);
    tx = new Transaction();
    tx.moveCall({
      target: `${pkg}::compliance::compliant_transfer`,
      arguments: [tx.object(poolId), tx.object(configId),
        tx.pure.vector("u8", bytes(tp.proofBytes)), tx.pure.vector("u8", bytes(tp.inputsBytes)),
        tx.pure.vector("u8", bytes(cp2.proofBytes)), tx.pure.vector("u8", bytes(cp2.inputsBytes)),
        tx.pure.vector("u8", Array.from({ length: 93 }, (_, k) => k)), tx.object(CLOCK)],
    });
    await exec(`compliant_transfer #${j + 1}`, tx);
  }

  // --- zk_withdraw --------------------------------------------------------
  console.log("\n-- zk_withdraw");
  const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const recipients = [Ed25519Keypair.generate().toSuiAddress(), Ed25519Keypair.generate().toSuiAddress()];
  const wRecipientField = (addr: string) => BigInt(addr) % FIELD;
  const withdrawProof = (k: number, hashedRecipient: string) => {
    const withdrawAmount = 100n, randomnessNew = BigInt(7000 + k), cumulativeOld = 500n, randomnessOld = wRandOld[k];
    return prove("withdraw", {
      commitment: wCommit[k], withdrawAmount,
      nullifier: H([D_WNULL, userSecret, randomnessOld, cumulativeOld]),
      recipientHash: H([D_RECIP, wRecipientField(hashedRecipient)]),
      newCommitment: H([D_COMMIT, cumulativeOld - withdrawAmount, randomnessNew, userSecret]),
      cumulativeOld, randomnessOld, userSecret, recipient: wRecipientField(hashedRecipient), randomnessNew,
    });
  };
  // #1: honest — proof bound to recipients[0], submitted for recipients[0]
  {
    const p = await withdrawProof(0, recipients[0]);
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(poolId), tx.pure.vector("u8", bytes(p.proofBytes)), tx.pure.vector("u8", bytes(p.inputsBytes)), tx.pure.address(recipients[0]), tx.object(CLOCK)] });
    await exec("zk_withdraw #1 (recipient == proof's recipient)", tx);
  }
  // #2: proof bound to recipients[0] but submitted with an ATTACKER recipient. Docs claim the proof
  // is invalidated by changing `recipient`; the contract never compares recipientHash to `recipient`.
  {
    const p = await withdrawProof(1, recipients[0]);
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(poolId), tx.pure.vector("u8", bytes(p.proofBytes)), tx.pure.vector("u8", bytes(p.inputsBytes)), tx.pure.address(recipients[1]), tx.object(CLOCK)] });
    const r = await exec("zk_withdraw #2 (SUBSTITUTED recipient)", tx, { expectFail: false });
    const bal = await client.getBalance({ owner: recipients[1], coinType: `${pkg}::token::TOKEN` });
    console.log(`  >> substituted-recipient withdraw ${r.effects?.status?.status}; attacker balance = ${bal.totalBalance}`);
    (globalThis as any).__substitution = { status: r.effects?.status?.status, attackerBalance: bal.totalBalance };
  }

  // --- admin ops ----------------------------------------------------------
  console.log("\n-- admin ops");
  const adm = async (label: string, fn: string, extra: (t: Transaction) => any[]) => {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::${fn}`, arguments: extra(t) });
    await exec(label, t);
  };
  await adm("freeze_pool", "freeze_pool", (t) => [t.object(poolId), t.object(adminCapId), t.object(CLOCK)]);
  await adm("unfreeze_pool", "unfreeze_pool", (t) => [t.object(poolId), t.object(adminCapId)]);
  await adm("propose_withdrawal", "propose_withdrawal", (t) => [t.object(poolId), t.object(adminCapId), t.pure.u64(1000), t.pure.address(sender), t.object(CLOCK)]);
  await adm("cancel_withdrawal", "cancel_withdrawal", (t) => [t.object(poolId), t.object(adminCapId)]);

  // --- report -------------------------------------------------------------
  console.log("\n=== SUMMARY (MIST; units = computation / RGP) ===");
  console.log("label | ok | computation | units | storage | rebate | net");
  for (const r of rows) console.log(`${r.label} | ${r.ok ? "ok" : "abort"} | ${r.computation} | ${r.units} | ${r.storage} | ${r.rebate} | ${r.net}`);
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ rgp: RGP.toString(), rows: rows.map((r) => ({ ...r, computation: r.computation.toString(), storage: r.storage.toString(), rebate: r.rebate.toString(), units: r.units.toString(), net: r.net.toString() })), substitution: (globalThis as any).__substitution }, null, 2));
    console.log(`wrote ${JSON_OUT}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
