/**
 * gas-probe.ts — raw (un-bucketed) cost of Groth16 primitives on Sui, recovered from bucket crossings.
 *
 * Why: Sui charges `computationCost` in coarse buckets (1000 / 5000 / 10000 / ... gas units), and every
 * Veil entry point lands in the lowest (1000-unit) bucket, so per-entry-point totals (gas-bench.ts) cannot
 * show what a verification costs or what batching/prepared-VKs would save. This probe publishes
 * scripts/bench/gas-probe-move (n x primitive inside ONE tx), then for each primitive finds
 *   n1 = smallest n whose computationCost leaves the 1000-unit bucket
 *   n2 = smallest n whose computationCost leaves the 5000-unit bucket
 * Since raw(n) = base + n*c, (n2 - n1) * c ~= 4000 units (base cancels), i.e. c ~= 4000 / (n2 - n1).
 * The bucket edges are verified from the observed costs, not assumed (printed in the output).
 *
 * Usage:  node scripts/bench/gas-probe.ts [--json out.json]   (localnet up, circuits built; see gas-bench.ts)
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
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d; };
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123");
const JSON_OUT = arg("--json", "");
const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const signer = Ed25519Keypair.generate();
const bytes = (u: Uint8Array) => Array.from(u);
const DIRS = { transfer: "build", withdraw: "build-withdraw", compliance: "build-compliance" } as const;

let pkg = "";
let RGP = 1000n;
const seen = new Set<bigint>();

/** computation units charged (cost / RGP) for fn(n), or null if the tx failed (e.g. hit an execution limit) */
async function unitsAt(build: (tx: Transaction, n: number) => void, n: number): Promise<bigint | null> {
  const tx = new Transaction();
  tx.setGasBudget(9_000_000_000);
  build(tx, n);
  const r = await client.signAndExecuteTransaction({ transaction: tx, signer, options: { showEffects: true } });
  await client.waitForTransaction({ digest: r.digest });
  if (r.effects?.status?.status !== "success") return null;
  const u = BigInt(r.effects.gasUsed.computationCost) / RGP;
  seen.add(u);
  return u;
}

/** smallest n in (0, cap] with units(n) > threshold, via doubling then bisection */
async function firstAbove(f: (n: number) => Promise<bigint | null>, threshold: bigint, cap = 40000): Promise<number | null> {
  let lo = 0, hi = 1;
  for (;;) {
    const u = await f(hi);
    if (u === null) return null;
    if (u > threshold) break;
    lo = hi; hi *= 2;
    if (hi > cap) return null;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const u = await f(mid);
    if (u === null) return null;
    if (u > threshold) hi = mid; else lo = mid;
  }
  return hi;
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  RGP = BigInt(await client.getReferenceGasPrice());
  console.log(`=== Veil gas probe (localnet ${RPC}); sui ${execSync("sui -V", { encoding: "utf-8" }).trim()}; RGP ${RGP} ===`);
  for (let i = 0; i < 3; i++) await requestSuiFromFaucetV2({ host: `${FAUCET}/v2/gas`, recipient: signer.toSuiAddress() });
  await new Promise((r) => setTimeout(r, 3000));

  const built = JSON.parse(execSync(`sui move build --dump-bytecode-as-base64 --no-tree-shaking --path ${join(__dirname, "gas-probe-move")}`, {
    encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
  let tx = new Transaction();
  tx.setGasBudget(500_000_000);
  tx.transferObjects([tx.publish({ modules: built.modules, dependencies: built.dependencies })], signer.toSuiAddress());
  const pub = await client.signAndExecuteTransaction({ transaction: tx, signer, options: { showObjectChanges: true, showEffects: true } });
  pkg = (pub.objectChanges as any[]).find((c) => c.type === "published").packageId;
  await client.waitForTransaction({ digest: pub.digest });

  const out: any = { rgp: RGP.toString(), primitives: {} };
  // Second, independent estimate: two-point slope well above the 1000-unit floor, (u(2*n2) - u(n2)) / n2.
  const report = async (label: string, f: (n: number) => Promise<bigint | null>, n1: number | null, n2: number | null) => {
    const c = n1 !== null && n2 !== null && n2 > n1 ? 4000 / (n2 - n1) : null;
    let slope: number | null = null;
    if (n2 !== null) {
      const ua = await f(n2), ub = await f(2 * n2);
      if (ua !== null && ub !== null) slope = Number(ub - ua) / n2;
    }
    console.log(`  ${label.padEnd(40)} n1=${n1} n2=${n2}  crossing: ~${c === null ? "n/a" : c.toFixed(3)} units/call | two-point slope: ~${slope === null ? "n/a" : slope.toFixed(3)} units/call`);
    out.primitives[label] = { n1, n2, unitsPerCallCrossing: c, unitsPerCallSlope: slope };
  };

  const loopFn = (tx: Transaction, n: number) => tx.moveCall({ target: `${pkg}::probe::loop_n`, arguments: [tx.pure.u64(n)] });
  console.log("\n-- baseline: empty loop");
  const lf = (n: number) => unitsAt(loopFn, n);
  await report("loop_n (empty iteration)", lf, await firstAbove(lf, 1000n), await firstAbove(lf, 5000n));

  for (const name of ["transfer", "withdraw", "compliance"] as const) {
    console.log(`\n-- ${name}`);
    const base = join(ROOT, "circuits", DIRS[name]);
    const w = (WITNESS_BUILDERS as any)[name](poseidon);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInputs(w), join(base, `${name}_js`, `${name}.wasm`), join(base, `${name}_final.zkey`));
    const vkJson = JSON.parse(readFileSync(join(base, `${name}_vk.json`), "utf-8"));
    if (!(await snarkjs.groth16.verify(vkJson, publicSignals, proof))) throw new Error("local verify failed");
    const vk = vkToSuiBytes(vkJson), pr = proofToSuiBytes(proof), inp = publicInputsToSuiBytes(publicSignals);

    const variants: [string, (tx: Transaction, n: number) => void][] = [
      [`${name}: prepare_verifying_key x n`, (t, n) => t.moveCall({ target: `${pkg}::probe::prepare_n`, arguments: [t.pure.vector("u8", bytes(vk)), t.pure.u64(n)] })],
      [`${name}: verify (VK pre-prepared) x n`, (t, n) => t.moveCall({ target: `${pkg}::probe::verify_prepared_n`, arguments: [t.pure.vector("u8", bytes(vk)), t.pure.vector("u8", bytes(pr)), t.pure.vector("u8", bytes(inp)), t.pure.u64(n)] })],
      [`${name}: prepare+verify x n (today)`, (t, n) => t.moveCall({ target: `${pkg}::probe::full_n`, arguments: [t.pure.vector("u8", bytes(vk)), t.pure.vector("u8", bytes(pr)), t.pure.vector("u8", bytes(inp)), t.pure.u64(n)] })],
    ];
    for (const [label, fn] of variants) {
      const f = (n: number) => unitsAt(fn, n);
      await report(label, f, await firstAbove(f, 1000n), await firstAbove(f, 5000n));
    }
  }
  console.log(`\nobserved distinct computation-unit values (bucket edges): ${[...seen].sort((a, b) => Number(a - b)).join(", ")}`);
  out.observedBuckets = [...seen].map(String);
  if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(out, null, 2)); console.log(`wrote ${JSON_OUT}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
