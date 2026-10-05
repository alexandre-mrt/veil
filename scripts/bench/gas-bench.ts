/**
 * gas-bench.ts — on-chain gas per Veil entry point, measured against a local Sui network
 * with REAL Groth16 proofs verified by `sui::groth16`.
 *
 * Usage (from repo root; see docs/research/2026-10-05-onchain-gas-baseline.md for the full recipe):
 *   sui start --force-regenesis --with-faucet            # terminal 1
 *   sui client new-env --alias local --rpc http://127.0.0.1:9000 && sui client switch --env local
 *   sui client faucet                                    # fund the active address
 *   (cd circuits && bash scripts/compile.sh --skip-ptau && bash scripts/compile-compliance.sh --skip-ptau \
 *      && bash scripts/compile-withdraw.sh --skip-ptau)  # needs circom + circuits/build/pot15_final.ptau
 *   cd scripts && bun install && bun run bench/gas-bench.ts
 *
 * Every row is `effects.gasUsed` of a transaction that actually executed on the local network.
 * The run also performs the ZK-withdraw recipient-binding probe (see PROBE at the bottom).
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

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");
const RPC = process.env.SUI_RPC ?? "http://127.0.0.1:9000";
const CLOCK = "0x6";
const EPOCH_MS = 60_000; // pool minimum
const THRESHOLD = 1_000_000_000n;
const DEPOSIT = 100_000_000; // DENOM_SMALL
const DEPTH = 20;
const OUT = process.env.GAS_BENCH_OUT ?? join(ROOT, "docs", "research", "raw", "gas-bench-result.json");

const ART = {
  transfer: { wasm: "build/transfer_js/transfer.wasm", zkey: "build/transfer_final.zkey", vk: "build/transfer_vk.json" },
  compliance: { wasm: "build-compliance/compliance_js/compliance.wasm", zkey: "build-compliance/compliance_final.zkey", vk: "build-compliance/compliance_vk.json" },
  withdraw: { wasm: "build-withdraw/withdraw_js/withdraw.wasm", zkey: "build-withdraw/withdraw_final.zkey", vk: "build-withdraw/withdraw_vk.json" },
} as const;
const p = (rel: string) => join(CIRCUITS, rel);

// ── setup ──────────────────────────────────────────────────────────────────
function loadKeypair(): Ed25519Keypair {
  const active = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const ks: string[] = JSON.parse(readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf-8"));
  for (const k of ks) {
    const raw = fromBase64(k);
    if (raw[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (kp.toSuiAddress() === active) return kp;
  }
  throw new Error("active address key not found in keystore");
}

type Row = { label: string; computation: number; storage: number; rebate: number; nonRefundable: number; net: number; digest: string };
const rows: Row[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const kp = loadKeypair();
const me = kp.toSuiAddress();
const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" as never });

async function run(label: string, tx: Transaction, record = true) {
  tx.setGasBudget(500_000_000);
  const r = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  const st = r.effects?.status;
  if (st?.status !== "success") throw new Error(`${label} failed: ${JSON.stringify(st)}`);
  const g = r.effects!.gasUsed;
  const row: Row = {
    label, computation: +g.computationCost, storage: +g.storageCost, rebate: +g.storageRebate,
    nonRefundable: +g.nonRefundableStorageFee,
    net: +g.computationCost + +g.storageCost - +g.storageRebate, digest: r.digest,
  };
  if (record) rows.push(row);
  console.log(`[gas] ${label.padEnd(34)} computation=${row.computation} storage=${row.storage} rebate=${row.rebate} net=${row.net}`);
  return r;
}

async function chainEpoch(): Promise<{ ms: number; epoch: number }> {
  const o = await client.getObject({ id: CLOCK, options: { showContent: true } });
  const ms = Number((o.data!.content as any).fields.timestamp_ms);
  return { ms, epoch: Math.floor(ms / EPOCH_MS) };
}

// ── crypto helpers (same domain tags as circuits/test/*.test.mjs) ─────────
const poseidon = await buildPoseidon();
const H = (xs: bigint[]): bigint => poseidon.F.toObject(poseidon(xs)) as bigint;
const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RECIP: 8n };

function merklePath(leaves: bigint[], idx: number) {
  let lv = leaves.slice();
  let i = idx;
  const pathElements: bigint[] = [], pathIndices: bigint[] = [];
  for (let d = 0; d < DEPTH; d++) {
    pathElements.push(lv[i ^ 1] ?? 0n);
    pathIndices.push(BigInt(i & 1));
    const next: bigint[] = [];
    for (let j = 0; j < lv.length; j += 2) next.push(H([lv[j], lv[j + 1] ?? 0n]));
    lv = next; i >>= 1;
  }
  return { root: lv[0], pathElements, pathIndices };
}
const le32 = (n: bigint) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
const arr = (u: Uint8Array) => Array.from(u);

async function prove(name: keyof typeof ART, input: Record<string, unknown>) {
  // @ts-expect-error snarkjs has no types
  const snarkjs = await import("snarkjs");
  const a = ART[name];
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, p(a.wasm), p(a.zkey));
  const vk = JSON.parse(readFileSync(p(a.vk), "utf-8"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${name}: local verify failed`);
  return { proof: arr(proofToSuiBytes(proof)), inputs: arr(publicInputsToSuiBytes(publicSignals)), signals: publicSignals as string[] };
}
const stringify = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));
const vkBytes = (name: keyof typeof ART) => arr(vkToSuiBytes(JSON.parse(readFileSync(p(ART[name].vk), "utf-8"))));

// ── 1. publish ────────────────────────────────────────────────────────────
console.log("== publish ==");
const pubOut = execSync(`sui client test-publish --build-env testnet --pubfile-path ${process.env.TMPDIR ?? "/tmp"}/veil-gas-bench-pub-${Date.now()}.toml --gas-budget 500000000 --json`, {
  cwd: join(ROOT, "contracts"), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26,
});
const pub = JSON.parse(pubOut.slice(pubOut.indexOf("{")));
const packageId: string = pub.objectChanges.find((c: any) => c.type === "published").packageId;
const treasuryCap: string = pub.objectChanges.find((c: any) => c.objectType?.includes("TreasuryCap")).objectId;
{
  const g = pub.effects.gasUsed;
  rows.push({ label: "publish package (6 modules)", computation: +g.computationCost, storage: +g.storageCost, rebate: +g.storageRebate, nonRefundable: +g.nonRefundableStorageFee, net: +g.computationCost + +g.storageCost - +g.storageRebate, digest: pub.digest });
  console.log(`[gas] publish package                    computation=${g.computationCost} storage=${g.storageCost} rebate=${g.storageRebate}`);
}
const rgp = Number(await client.getReferenceGasPrice());
console.log(`package=${packageId} referenceGasPrice=${rgp} MIST/unit`);

// ── 2. pool + deposits ────────────────────────────────────────────────────
console.log("== pool ==");
let r = await run("create_pool", (() => {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::create_pool`, arguments: [tx.pure.vector("u8", vkBytes("transfer")), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
  return tx;
})());
const poolId: string = r.objectChanges!.find((c: any) => c.type === "created" && c.objectType.endsWith("::pool::Pool"))!.objectId;
const adminCap: string = r.objectChanges!.find((c: any) => c.type === "created" && c.objectType.endsWith("::pool::AdminCap"))!.objectId;

// Users: T0..T2 (shielded_transfer), C0 (compliant_transfer), W0, W1 (zk_withdraw)
const secrets = [111n, 222n, 333n, 444n, 555n, 666n];
const randOld = [0n, 0n, 0n, 0n, 7001n, 7002n];
const cumOld = [0n, 0n, 0n, 0n, 500n, 500n];
const leaves = secrets.map((s, i) => H([D.COMMIT, cumOld[i], randOld[i], s]));
const treeLeaves = leaves.slice(0, 4); // only the transfer-family commitments are in the Merkle root

console.log("== mint ==");
r = await run("token::mint x6 (setup, not a Veil path)", (() => {
  const tx = new Transaction();
  for (let i = 0; i < 6; i++) tx.moveCall({ target: `${packageId}::token::mint`, arguments: [tx.object(treasuryCap), tx.pure.u64(DEPOSIT), tx.pure.address(me)] });
  return tx;
})(), false);
const coins: string[] = r.objectChanges!.filter((c: any) => c.type === "created" && c.objectType.includes("::coin::Coin<")).map((c: any) => c.objectId);
if (coins.length !== 6) throw new Error(`expected 6 coins, got ${coins.length}`);

console.log("== deposits ==");
for (let i = 0; i < 6; i++) {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::deposit_and_register`, arguments: [tx.object(poolId), tx.object(coins[i]), tx.pure.vector("u8", arg32(leaves[i])), tx.object(CLOCK)] });
  await run(`deposit_and_register #${i + 1}`, tx);
}
function arg32(n: bigint) { return arr(le32(n)); }

// ── 3. admin setup that real transfers depend on ──────────────────────────
console.log("== admin ==");
const transferTree = merklePath(treeLeaves, 0);
{
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::update_commitment_root`, arguments: [tx.object(poolId), tx.object(adminCap), tx.pure.vector("u8", arg32(transferTree.root)), tx.object(CLOCK)] });
  await run("update_commitment_root (propose)", tx);
}
{
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::propose_withdraw_vk`, arguments: [tx.object(poolId), tx.object(adminCap), tx.pure.vector("u8", vkBytes("withdraw")), tx.object(CLOCK)] });
  await run("propose_withdraw_vk", tx);
}
// Compliance: credential tree with a single credential leaf (userSecret of C0)
const KYC = 2n, REQ_KYC = 1n, EXPIRY = 1n << 40n, ISSUER = 42n;
const credLeaf = H([D.CRED, secrets[3], KYC, EXPIRY, ISSUER]);
const credTree = merklePath([credLeaf], 0);
{
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::compliance::create_compliance_config`,
    arguments: [tx.object(adminCap), tx.object(poolId), tx.pure.vector("u8", vkBytes("compliance")), tx.pure.vector("u8", arg32(credTree.root)), tx.pure.u64(REQ_KYC), tx.pure.vector("u8", new Array(33).fill(2))],
  });
  r = await run("create_compliance_config", tx);
}
const configId: string = r.objectChanges!.find((c: any) => c.type === "created" && c.objectType.endsWith("::compliance::ComplianceConfig"))!.objectId;

// ── 4. wait for the next epoch (maturity + timelocks) ─────────────────────
{
  const { ms, epoch } = await chainEpoch();
  const wait = (epoch + 1) * EPOCH_MS - ms + 3000;
  console.log(`== waiting ${(wait / 1000).toFixed(0)}s for epoch ${epoch + 1} ==`);
  await sleep(wait);
}
const { epoch: E } = await chainEpoch();
console.log(`chain epoch now ${E}`);

// ── 5. proofs ─────────────────────────────────────────────────────────────
console.log("== proving ==");
const nullifiers: bigint[] = [];
const transferProofs: Awaited<ReturnType<typeof prove>>[] = [];
for (let i = 0; i < 4; i++) {
  const txAmount = 100n, salt = 99n + BigInt(i), randNew = 9000n + BigInt(i);
  const nf = H([D.NULL, secrets[i], BigInt(E), randOld[i]]);
  nullifiers.push(nf);
  const path = merklePath(treeLeaves, i);
  transferProofs.push(await prove("transfer", stringify({
    oldCommitment: leaves[i], newCommitment: H([D.COMMIT, cumOld[i] + txAmount, randNew, secrets[i]]), threshold: THRESHOLD, epochId: E,
    nullifier: nf, txAmountHash: H([D.TXAMT, txAmount, salt]), merkleRoot: path.root,
    cumulativeOld: cumOld[i], cumulativeNew: cumOld[i] + txAmount, txAmount, randomnessOld: randOld[i], randomnessNew: randNew,
    userSecret: secrets[i], salt, pathElements: path.pathElements, pathIndices: path.pathIndices,
  })));
}
const contextId = H([D.CTX, nullifiers[3], secrets[3]]);
const complianceProof = await prove("compliance", stringify({
  merkleRoot: credTree.root, currentEpoch: E, contextId, requiredKycLevel: REQ_KYC, nullifier: H([D.CNULL, secrets[3], contextId]), validCredential: 1n,
  userSecret: secrets[3], kycLevel: KYC, expiryEpoch: EXPIRY, issuerId: ISSUER, pathElements: credTree.pathElements, pathIndices: credTree.pathIndices,
  transferNullifier: nullifiers[3],
}));
const HONEST_RECIPIENT_FIELD = 0xabcdef123456n;
async function withdrawProof(i: number) {
  const wAmt = 100n, randNew = 31337n + BigInt(i);
  return prove("withdraw", stringify({
    commitment: leaves[i], withdrawAmount: wAmt, nullifier: H([D.WNULL, secrets[i], randOld[i], cumOld[i]]),
    recipientHash: H([D.RECIP, HONEST_RECIPIENT_FIELD]), newCommitment: H([D.COMMIT, cumOld[i] - wAmt, randNew, secrets[i]]),
    cumulativeOld: cumOld[i], randomnessOld: randOld[i], userSecret: secrets[i], recipient: HONEST_RECIPIENT_FIELD, randomnessNew: randNew,
  }));
}
const w0 = await withdrawProof(4), w1 = await withdrawProof(5);

// ── 6. the measured entry points ──────────────────────────────────────────
console.log("== entry points ==");
for (let i = 0; i < 3; i++) {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::shielded_transfer`, arguments: [tx.object(poolId), tx.pure.vector("u8", transferProofs[i].proof), tx.pure.vector("u8", transferProofs[i].inputs), tx.object(CLOCK)] });
  await run(`shielded_transfer #${i + 1}`, tx);
}
{
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::compliance::compliant_transfer`,
    arguments: [tx.object(poolId), tx.object(configId), tx.pure.vector("u8", transferProofs[3].proof), tx.pure.vector("u8", transferProofs[3].inputs),
      tx.pure.vector("u8", complianceProof.proof), tx.pure.vector("u8", complianceProof.inputs), tx.pure.vector("u8", new Array(93).fill(7)), tx.object(CLOCK)],
  });
  await run("compliant_transfer (2 Groth16 verifies)", tx);
}
const honestRecipient = me;
{
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::zk_withdraw`, arguments: [tx.object(poolId), tx.pure.vector("u8", w0.proof), tx.pure.vector("u8", w0.inputs), tx.pure.address(honestRecipient), tx.object(CLOCK)] });
  await run("zk_withdraw", tx);
}

// ── PROBE: is `recipient` bound to the proof's recipientHash on-chain? ────
// w1 proves recipientHash = Poseidon(8, 0xabcdef123456). We submit it paying a DIFFERENT, fresh address.
// If the contract bound recipient to recipientHash this MUST abort (docs/threat-model.md E7 claims it does).
console.log("== PROBE: zk_withdraw with a recipient the proof never mentioned ==");
const attacker = Ed25519Keypair.generate().toSuiAddress();
let probe = "";
{
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::pool::zk_withdraw`, arguments: [tx.object(poolId), tx.pure.vector("u8", w1.proof), tx.pure.vector("u8", w1.inputs), tx.pure.address(attacker), tx.object(CLOCK)] });
  await run("zk_withdraw (swapped recipient PROBE)", tx, false);
  const bal = await client.getBalance({ owner: attacker, coinType: `${packageId}::token::TOKEN` });
  probe = `swapped-recipient withdrawal ACCEPTED; attacker ${attacker} now holds ${bal.totalBalance} units of TOKEN`;
}
console.log(`[PROBE] ${probe}`);

// ── report ────────────────────────────────────────────────────────────────
const result = { rgp, packageId, epochMs: EPOCH_MS, rows, probe };
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log("\n| entry point | computation (MIST) | computation (gas units) | storage cost | storage rebate | net MIST |\n|---|---|---|---|---|---|");
for (const x of rows) console.log(`| ${x.label} | ${x.computation} | ${x.computation / rgp} | ${x.storage} | ${x.rebate} | ${x.net} |`);
console.log(`\nraw json: ${OUT}`);
process.exit(0); // snarkjs worker threads otherwise keep the process alive
