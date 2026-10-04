/**
 * gas.ts — On-chain gas per Veil entry point, measured on a local Sui network with real proofs.
 *
 * Publishes contracts/ to a local Sui network (`sui start --force-regenesis --with-faucet`),
 * then drives every proof-carrying entry point (deposit_and_register, shielded_transfer,
 * zk_withdraw, compliant_transfer) with real Groth16 proofs from circuits/build{,-withdraw,
 * -compliance}/, plus the main admin entry points, and prints effects.gasUsed for each.
 *
 * Usage (from scripts/bench, after `npm install` and circuits compiled):
 *   sui start --force-regenesis --with-faucet &        # local network, RPC :9000, faucet :9123
 *   bun run gas.ts [--samples 3] [--epoch-ms 60000] [--json out.json]
 *
 * Why a local network: gas *units* (computation) and storage *bytes* are deterministic across
 * networks for the same bytecode + inputs; only the prices (reference gas price, storage price)
 * differ. The script therefore reports computation in gas units (computationCost / RGP) and
 * storage in MIST at the local storage price, and prints both prices so a testnet/mainnet cost
 * can be re-derived. Aborted-after-verify transactions give a "verification floor": Sui charges
 * computation up to the abort, and the abort sites below sit right after the Groth16 check.
 */
import { execSync } from "child_process";
import { cpSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";
import { buildComplianceWitness, buildTransferWitness, buildWithdrawWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : dflt;
};
const SAMPLES = parseInt(arg("--samples", "3"), 10);
const EPOCH_MS = parseInt(arg("--epoch-ms", "60000"), 10);
const JSON_OUT = arg("--json", "");
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123");
const CLOCK = "0x6";
const DENOM_SMALL = 100_000_000n;
const THRESHOLD = 1_000_000_000n;
const GAS_BUDGET = 2_000_000_000n;
const DEPTH = 20;

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" as any });
const kp = Ed25519Keypair.generate();
const me = kp.toSuiAddress();

interface Row { op: string; status: string; computation: number; storage: number; rebate: number; nonRefundable: number; rgp: number }
const rows: Row[] = [];
let RGP = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const epochNow = () => Math.floor(Date.now() / EPOCH_MS);
async function waitForEpochStart(minRemainingMs = 0): Promise<number> {
  // Block until at least `minRemainingMs` of a fresh epoch remain, return that epoch.
  for (;;) {
    const e = epochNow();
    const left = (e + 1) * EPOCH_MS - Date.now();
    if (left >= minRemainingMs && (Date.now() - e * EPOCH_MS) < 4000) return e;
    await sleep(500);
  }
}

async function exec(op: string, tx: Transaction, opts: { allowAbort?: boolean } = {}) {
  tx.setGasBudget(GAS_BUDGET);
  const r = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  const g = r.effects!.gasUsed;
  const status = r.effects!.status.status;
  if (status !== "success" && !opts.allowAbort) throw new Error(`${op} failed: ${JSON.stringify(r.effects!.status)}`);
  rows.push({
    op, status: status === "success" ? "ok" : `abort(${r.effects!.status.error?.replace(/\s+/g, " ").slice(-60)})`,
    computation: Number(g.computationCost), storage: Number(g.storageCost),
    rebate: Number(g.storageRebate), nonRefundable: Number(g.nonRefundableStorageFee), rgp: RGP,
  });
  return r;
}

const bytes = (u: Uint8Array) => Array.from(u);
const created = (r: any, frag: string) =>
  r.objectChanges.find((c: any) => c.type === "created" && c.objectType?.includes(frag))?.objectId as string;

// ---- Merkle tree over transfer commitments, literal-0 siblings above the populated levels (matches witnesses.mjs) ----
function buildTree(poseidon: any, leaves: bigint[]) {
  const F = poseidon.F;
  const H = (a: bigint, b: bigint): bigint => F.toObject(poseidon([a, b]));
  const size = 1 << Math.ceil(Math.log2(Math.max(2, leaves.length)));
  let level = Array.from({ length: size }, (_, i) => leaves[i] ?? 0n);
  const levels: bigint[][] = [level];
  while (level.length > 1) {
    level = Array.from({ length: level.length / 2 }, (_, i) => H(level[2 * i], level[2 * i + 1]));
    levels.push(level);
  }
  let top = level[0];
  for (let l = levels.length - 1; l < DEPTH; l++) top = H(top, 0n);
  const pathFor = (idx: number) => {
    const pathElements: bigint[] = [], pathIndices: bigint[] = [];
    let i = idx;
    for (let l = 0; l < DEPTH; l++) {
      if (l < levels.length - 1) { pathElements.push(levels[l][i ^ 1]); pathIndices.push(BigInt(i & 1)); i >>= 1; }
      else { pathElements.push(0n); pathIndices.push(0n); }
    }
    return { pathElements, pathIndices };
  };
  return { root: top, pathFor };
}
const le32 = (n: bigint) => { const b = new Uint8Array(32); let x = n; for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

async function prove(circuit: string, dir: string, input: any) {
  const wasm = join(CIRCUITS, dir, `${circuit}_js`, `${circuit}.wasm`);
  const zkey = join(CIRCUITS, dir, `${circuit}_final.zkey`);
  const { proof, publicSignals } = await (snarkjs as any).groth16.fullProve(stringifyInputs(input), wasm, zkey);
  return { proofBytes: proofToSuiBytes(proof), inputsBytes: publicInputsToSuiBytes(publicSignals) };
}
const vkBytes = (dir: string, c: string) => vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, dir, `${c}_vk.json`), "utf-8")));

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const sui = (n: string) => process.env.SUI_BIN ? process.env.SUI_BIN : "sui";

  RGP = Number(await client.getReferenceGasPrice());
  console.log(`rpc=${RPC} rgp=${RGP} epoch_ms=${EPOCH_MS} samples=${SAMPLES}`);
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await sleep(2000);

  // ---- publish ----
  const built = JSON.parse(execSync(`${sui("sui")} move build --dump-bytecode-as-base64 --no-tree-shaking --path ${join(ROOT, "contracts")}`, { encoding: "utf-8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }));
  const ptx = new Transaction();
  const [upg] = ptx.publish({ modules: built.modules, dependencies: built.dependencies });
  ptx.transferObjects([upg], me);
  const pub = await exec("publish (package, once)", ptx);
  const pkg = pub.objectChanges!.find((c: any) => c.type === "published")!.packageId as string;
  const treasury = created(pub, "::coin::TreasuryCap");
  console.log(`package=${pkg}`);

  // ---- users / commitments ----
  const DOM_C = 1n;
  const mkUser = (i: number) => {
    const userSecret = 1000n + BigInt(i);
    const commitment = F(poseidon([DOM_C, 0n, 0n, userSecret]));
    return { userSecret, commitment };
  };
  const F = (x: any) => poseidon.F.toObject(x) as bigint;
  const tUsers = Array.from({ length: SAMPLES }, (_, i) => mkUser(i));
  const cUsers = Array.from({ length: SAMPLES }, (_, i) => mkUser(100 + i));
  const BATCH = 4; // transfers packed into one PTB
  const bUsers = Array.from({ length: BATCH }, (_, i) => mkUser(200 + i));
  const tree = buildTree(poseidon, [...tUsers, ...cUsers, ...bUsers].map((u) => u.commitment));
  // withdraw commitments: Poseidon(1, 500, randomnessOld, userSecret) — a distinct randomnessOld per sample
  const wRand = Array.from({ length: SAMPLES }, (_, i) => 5000n + BigInt(i));
  const wCommit = wRand.map((r) => F(poseidon([DOM_C, 500n, r, 987654321n])));

  // ---- fund: mint DENOM_SMALL coins for every deposit ----
  const nDeposits = tUsers.length + cUsers.length + bUsers.length + wCommit.length + 1; // +1 spare
  const mtx = new Transaction();
  for (let i = 0; i < nDeposits; i++) mtx.moveCall({ target: `${pkg}::token::mint`, arguments: [mtx.object(treasury), mtx.pure.u64(DENOM_SMALL), mtx.pure.address(me)] });
  const mr = await exec("(setup) mint coins", mtx);
  const coins: string[] = mr.objectChanges!.filter((c: any) => c.type === "created" && c.objectType?.includes("::token::TOKEN")).map((c: any) => c.objectId);

  // ---- create pool ----
  await waitForEpochStart(20_000); // keep all pre-transfer admin work inside one epoch E
  const E = epochNow();
  const ctx = new Transaction();
  ctx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [ctx.pure.vector("u8", bytes(vkBytes("build", "transfer"))), ctx.pure.u64(THRESHOLD), ctx.pure.u64(BigInt(EPOCH_MS))] });
  const cr = await exec("create_pool (transfer VK 4025 B)", ctx);
  const pool = created(cr, "::pool::Pool"), adminCap = created(cr, "::pool::AdminCap");

  // ---- deposits ----
  const allGenesis = [...tUsers.map((u) => u.commitment), ...cUsers.map((u) => u.commitment), ...bUsers.map((u) => u.commitment), ...wCommit];
  for (let i = 0; i < allGenesis.length; i++) {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [t.object(pool), t.object(coins[i]), t.pure.vector("u8", bytes(le32(allGenesis[i]))), t.object(CLOCK)] });
    await exec(`deposit_and_register`, t);
  }

  // ---- admin ops (all in epoch E) ----
  const adm = async (op: string, build: (t: Transaction) => void) => { const t = new Transaction(); build(t); return exec(op, t); };
  await adm("update_commitment_root (propose)", (t) => t.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [t.object(pool), t.object(adminCap), t.pure.vector("u8", bytes(le32(tree.root))), t.object(CLOCK)] }));
  await adm("propose_withdraw_vk (withdraw VK 3656 B)", (t) => t.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [t.object(pool), t.object(adminCap), t.pure.vector("u8", bytes(vkBytes("build-withdraw", "withdraw"))), t.object(CLOCK)] }));

  // compliance config: credential root of the single credential holder
  const cw0 = buildComplianceWitness(poseidon, { currentEpoch: BigInt(E + 1), expiryEpoch: BigInt(E + 100_000) });
  const auditorKey = new Uint8Array(33).fill(2);
  const cc = await adm("create_compliance_config (compliance VK 3841 B)", (t) => t.moveCall({ target: `${pkg}::compliance::create_compliance_config`, arguments: [t.object(adminCap), t.object(pool), t.pure.vector("u8", bytes(vkBytes("build-compliance", "compliance"))), t.pure.vector("u8", bytes(le32(cw0.merkleRoot))), t.pure.u64(1), t.pure.vector("u8", bytes(auditorKey))] }));
  // (create_compliance_config reborrows pool — `cc` is the tx result; config id is the created ComplianceConfig)
  const config = created(await client.getTransactionBlock({ digest: cc.digest, options: { showObjectChanges: true } }), "::compliance::ComplianceConfig");

  if (epochNow() !== E) throw new Error("setup spilled into the next epoch — rerun (use a larger --epoch-ms)");

  // ---- pre-generate all proofs for epoch E+1 (the epoch every proof-carrying tx below runs in) ----
  const P = BigInt(E + 1);
  const transferProofs = [], compProofs = [], withdrawProofs = [];
  for (let i = 0; i < SAMPLES; i++) {
    const { pathElements, pathIndices } = tree.pathFor(i);
    const w = buildTransferWitness(poseidon, { userSecret: tUsers[i].userSecret, epochId: P, pathElements, pathIndices });
    if (w.merkleRoot !== tree.root || w.oldCommitment !== tUsers[i].commitment) throw new Error("tree/witness mismatch");
    transferProofs.push(await prove("transfer", "build", w));
  }
  // compliant transfers: pair each compliance proof (contextId bound to the transfer nullifier) with a transfer proof
  for (let i = 0; i < SAMPLES; i++) {
    const { pathElements, pathIndices } = tree.pathFor(SAMPLES + i);
    const tw = buildTransferWitness(poseidon, { userSecret: cUsers[i].userSecret, epochId: P, pathElements, pathIndices });
    const cw = buildComplianceWitness(poseidon, { currentEpoch: P, expiryEpoch: BigInt(E + 100_000), transferNullifier: tw.nullifier });
    compProofs.push({ t: await prove("transfer", "build", tw), c: await prove("compliance", "build-compliance", cw) });
  }
  const batchProofs = [];
  for (let i = 0; i < BATCH; i++) {
    const { pathElements, pathIndices } = tree.pathFor(2 * SAMPLES + i);
    batchProofs.push(await prove("transfer", "build", buildTransferWitness(poseidon, { userSecret: bUsers[i].userSecret, epochId: P, pathElements, pathIndices })));
  }
  // an extra transfer proof against a *wrong* root (verifies, then aborts at E_MERKLE_ROOT_MISMATCH) for the verification floor
  const wrongW = buildTransferWitness(poseidon, { userSecret: 424242n, epochId: P });
  const floorTransfer = await prove("transfer", "build", wrongW);
  const wUser = 987654321n;
  for (let i = 0; i < SAMPLES; i++) {
    withdrawProofs.push(await prove("withdraw", "build-withdraw", buildWithdrawWitness(poseidon, { randomnessOld: wRand[i], userSecret: wUser, randomnessNew: 90000n + BigInt(i) })));
  }
  const floorWithdraw = await prove("withdraw", "build-withdraw", buildWithdrawWitness(poseidon, { randomnessOld: 31337n })); // commitment never deposited
  const encAmt = new Uint8Array(96).fill(7);

  // ---- wait for E+1, then run every proof-carrying entry point ----
  while (epochNow() < E + 1) await sleep(500);
  const t0 = Date.now();
  const recipient = Ed25519Keypair.generate().toSuiAddress();

  // verification floors first (abort after the Groth16 check, no state change)
  {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [t.object(pool), t.pure.vector("u8", bytes(floorTransfer.proofBytes)), t.pure.vector("u8", bytes(floorTransfer.inputsBytes)), t.object(CLOCK)] });
    await exec("shielded_transfer, aborted right after verify (floor: 1 transfer verify)", t, { allowAbort: true });
  }
  {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [t.object(pool), t.pure.vector("u8", bytes(floorWithdraw.proofBytes)), t.pure.vector("u8", bytes(floorWithdraw.inputsBytes)), t.pure.address(recipient), t.object(CLOCK)] });
    await exec("zk_withdraw, aborted right after verify (floor: 1 withdraw verify)", t, { allowAbort: true });
  }
  for (let i = 0; i < SAMPLES; i++) {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [t.object(pool), t.pure.vector("u8", bytes(transferProofs[i].proofBytes)), t.pure.vector("u8", bytes(transferProofs[i].inputsBytes)), t.object(CLOCK)] });
    await exec("shielded_transfer", t);
  }
  {
    const t = new Transaction();
    for (const b of batchProofs) t.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [t.object(pool), t.pure.vector("u8", bytes(b.proofBytes)), t.pure.vector("u8", bytes(b.inputsBytes)), t.object(CLOCK)] });
    await exec(`shielded_transfer x${BATCH} in ONE PTB`, t);
  }
  for (let i = 0; i < SAMPLES; i++) {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::compliance::compliant_transfer`, arguments: [t.object(pool), t.object(config), t.pure.vector("u8", bytes(compProofs[i].t.proofBytes)), t.pure.vector("u8", bytes(compProofs[i].t.inputsBytes)), t.pure.vector("u8", bytes(compProofs[i].c.proofBytes)), t.pure.vector("u8", bytes(compProofs[i].c.inputsBytes)), t.pure.vector("u8", bytes(encAmt)), t.object(CLOCK)] });
    await exec("compliant_transfer (transfer + compliance proof)", t);
  }
  for (let i = 0; i < SAMPLES; i++) {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [t.object(pool), t.pure.vector("u8", bytes(withdrawProofs[i].proofBytes)), t.pure.vector("u8", bytes(withdrawProofs[i].inputsBytes)), t.pure.address(recipient), t.object(CLOCK)] });
    await exec("zk_withdraw", t);
  }
  // PROBE (docs/threat-model.md E7 claims "changing recipient invalidates the proof"): the proofs above commit to
  // recipientHash = Poseidon(8, 0xABCDEF123456), yet funds went to a fresh, unrelated Sui address and every tx succeeded.
  const got = await client.getBalance({ owner: recipient, coinType: `${pkg}::token::TOKEN` });
  console.log(`PROBE recipient-binding: proofs commit to recipient field 0xABCDEF123456; unrelated address ${recipient} received ${got.totalBalance} base units from ${SAMPLES} zk_withdraw txs`);
  console.log(`proof-carrying txs ran in ${((Date.now() - t0) / 1000).toFixed(1)}s (must stay < ${EPOCH_MS / 1000}s)`);

  // ---- remaining admin ops ----
  await adm("freeze_pool", (t) => t.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [t.object(pool), t.object(adminCap), t.object(CLOCK)] }));
  await adm("unfreeze_pool", (t) => t.moveCall({ target: `${pkg}::pool::unfreeze_pool`, arguments: [t.object(pool), t.object(adminCap)] }));
  await adm("propose_withdrawal", (t) => t.moveCall({ target: `${pkg}::pool::propose_withdrawal`, arguments: [t.object(pool), t.object(adminCap), t.pure.u64(1000), t.pure.address(me), t.object(CLOCK)] }));
  await adm("cancel_withdrawal", (t) => t.moveCall({ target: `${pkg}::pool::cancel_withdrawal`, arguments: [t.object(pool), t.object(adminCap)] }));

  await verifyScaling(sui("sui"), floorTransfer, vkBytes("build", "transfer"));
  report();
}

// Sui bills computation in buckets (min 1000 units), so a single verify disappears into the floor.
// To see its real size, publish a throwaway harness module *inside a copy of the package* (verifier fns are
// public(package)) that runs the Groth16 check n times in one tx, and watch where the bucket steps.
async function verifyScaling(suiBin: string, tp: any, tvk: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "veil-bench-"));
  cpSync(join(ROOT, "contracts"), dir, { recursive: true, filter: (s) => !s.includes("/build") });
  writeFileSync(join(dir, "sources", "bench_verify.move"), `module veil::bench_verify;
use sui::groth16;
use veil::verifier;
public fun verify_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let mut i = 0;
    while (i < n) { assert!(verifier::verify_transfer_proof(&vk, copy proof, copy inputs), 1); i = i + 1; };
}
public fun prepare_n(vk: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let mut i = 0;
    while (i < n) { groth16::prepare_verifying_key(&curve, &vk); i = i + 1; };
}
public fun verify_prepared_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &vk);
    let mut i = 0;
    while (i < n) {
        assert!(groth16::verify_groth16_proof(&curve, &pvk, &groth16::public_proof_inputs_from_bytes(copy inputs), &groth16::proof_points_from_bytes(copy proof)), 1);
        i = i + 1;
    };
}
`);
  const built = JSON.parse(execSync(`${suiBin} move build --dump-bytecode-as-base64 --no-tree-shaking --path ${dir}`, { encoding: "utf-8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }));
  const ptx = new Transaction();
  const [upg] = ptx.publish({ modules: built.modules, dependencies: built.dependencies });
  ptx.transferObjects([upg], me);
  const r = await exec("(harness) publish bench_verify copy", ptx);
  const pkg = r.objectChanges!.find((c: any) => c.type === "published")!.packageId as string;
  const NS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
  for (const n of NS) {
    const a = new Transaction();
    a.moveCall({ target: `${pkg}::bench_verify::verify_n`, arguments: [a.pure.vector("u8", bytes(tvk)), a.pure.vector("u8", bytes(tp.proofBytes)), a.pure.vector("u8", bytes(tp.inputsBytes)), a.pure.u64(n)] });
    await exec(`scale: prepare_vk+verify (transfer) x n=${String(n).padStart(2)}`, a);
  }
  for (const n of NS) {
    const a = new Transaction();
    a.moveCall({ target: `${pkg}::bench_verify::prepare_n`, arguments: [a.pure.vector("u8", bytes(tvk)), a.pure.u64(n)] });
    await exec(`scale: prepare_vk only (transfer VK) x n=${String(n).padStart(2)}`, a);
  }
  for (const n of NS) {
    const a = new Transaction();
    a.moveCall({ target: `${pkg}::bench_verify::verify_prepared_n`, arguments: [a.pure.vector("u8", bytes(tvk)), a.pure.vector("u8", bytes(tp.proofBytes)), a.pure.vector("u8", bytes(tp.inputsBytes)), a.pure.u64(n)] });
    await exec(`scale: prepare_vk once + verify x n=${String(n).padStart(2)}`, a);
  }
}

function report() {
  // group by op: mean over samples
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const k = r.op; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log("\nop | n | status | computation (gas units = cost/RGP) | computation (MIST) | storage cost (MIST) | storage rebate | net (MIST)");
  const out: any[] = [];
  for (const [op, rs] of groups) {
    const comp = mean(rs.map((r) => r.computation)), st = mean(rs.map((r) => r.storage)), rb = mean(rs.map((r) => r.rebate));
    const net = comp + st - rb;
    const spread = rs.length > 1 ? ` [${Math.min(...rs.map((r) => r.computation))}..${Math.max(...rs.map((r) => r.computation))}]` : "";
    console.log(`${op} | ${rs.length} | ${rs[0].status} | ${(comp / RGP).toFixed(0)}${spread ? " (MIST range" + spread + ")" : ""} | ${comp.toFixed(0)} | ${st.toFixed(0)} | ${rb.toFixed(0)} | ${net.toFixed(0)}`);
    out.push({ op, n: rs.length, status: rs[0].status, computationUnits: comp / RGP, computationMist: comp, storageMist: st, rebateMist: rb, netMist: net, rgp: RGP, raw: rs });
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); report(); process.exit(1); });
