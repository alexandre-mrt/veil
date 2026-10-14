/**
 * gas-probe.mjs — resolve the per-call computation cost of Veil's Groth16 verification path.
 *
 * Sui rounds a transaction's computation charge UP to a fixed bucket (1000, 5000, 10000, ... units),
 * so a single verify (< 1000 units) always bills the 1000-unit floor and cannot be resolved by
 * looking at one transaction. This script repeats the primitive n times inside one PTB (package
 * scripts/bench/gas-probe) and dry-runs it, then locates each bucket transition by bisection on n.
 * At a transition the *raw* cost equals the previous bucket's upper bound, so
 *     raw(n*) ≈ B_prev   ->   slope = (B_prev - intercept) / n*   (least-squares over all transitions).
 *
 * Usage: node scripts/bench/gas-probe.mjs --sui <path-to-sui> [--json out.json]
 * Needs the same local network as gas-bench.mjs and circuits/build/ (transfer circuit).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const SUI = arg("sui", "sui");
const RPC = arg("rpc", "http://127.0.0.1:9000");
const FAUCET = arg("faucet", "http://127.0.0.1:9123/v2/gas");
const JSON_OUT = arg("json", null);
const CIRCUIT = arg("circuit", "transfer"); // transfer | withdraw | compliance
const DIRS = { transfer: "build", withdraw: "build-withdraw", compliance: "build-compliance" };
const MAX_N = 6000;

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const kp = new Ed25519Keypair();
const me = kp.toSuiAddress();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesArg = (tx, u8) => tx.pure.vector("u8", Array.from(u8));

async function fund(times) {
  for (let i = 0; i < times; i++) {
    const r = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ FixedAmountRequest: { recipient: me } }) });
    if (!r.ok) throw new Error(`faucet ${r.status}`);
  }
  for (let i = 0; i < 30; i++) {
    const c = await client.getCoins({ owner: me });
    if (c.data.length >= times) return;
    await sleep(500);
  }
}

async function main() {
  console.log(`sui CLI: ${execFileSync(SUI, ["--version"], { encoding: "utf8" }).trim()}`);
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  await fund(3);

  const built = JSON.parse(execFileSync(SUI, ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", join(HERE, "gas-probe")],
    { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }));
  const ptx = new Transaction();
  const [u] = ptx.publish({ modules: built.modules, dependencies: built.dependencies });
  ptx.transferObjects([u], me);
  ptx.setSender(me); ptx.setGasBudget(500_000_000n);
  const pub = await client.signAndExecuteTransaction({ transaction: ptx, signer: kp, options: { showObjectChanges: true } });
  await client.waitForTransaction({ digest: pub.digest });
  const pkg = pub.objectChanges.find((c) => c.type === "published").packageId;

  const w = WITNESS_BUILDERS[CIRCUIT](poseidon);
  const d = join(ROOT, "circuits", DIRS[CIRCUIT]);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInputs(w),
    join(d, `${CIRCUIT}_js/${CIRCUIT}.wasm`), join(d, `${CIRCUIT}_final.zkey`));
  const vkJson = JSON.parse(readFileSync(join(d, `${CIRCUIT}_vk.json`), "utf8"));
  const vk = vkToSuiBytes(vkJson), pr = proofToSuiBytes(proof), inp = publicInputsToSuiBytes(publicSignals);
  console.log(`${CIRCUIT} circuit: vk ${vk.length} B, proof ${pr.length} B, public inputs ${inp.length} B (${publicSignals.length} signals)`);

  const rgp = Number(await client.getReferenceGasPrice());
  const cost = async (fn, n) => {
    const tx = new Transaction();
    const a = { loop_prepare: [bytesArg(tx, vk)], loop_verify_full: [bytesArg(tx, vk), bytesArg(tx, pr), bytesArg(tx, inp)],
      loop_verify_prepared: [bytesArg(tx, vk), bytesArg(tx, pr), bytesArg(tx, inp)], loop_noop: [] }[fn];
    tx.moveCall({ target: `${pkg}::probe::${fn}`, arguments: [...a, tx.pure.u64(n)] });
    tx.setSender(me); tx.setGasBudget(2_000_000_000n);
    const bytes = await tx.build({ client });
    const res = await client.dryRunTransactionBlock({ transactionBlock: bytes });
    if (res.effects.status.status !== "success") return { ok: false, err: res.effects.status.error };
    return { ok: true, units: Number(res.effects.gasUsed.computationCost) / rgp };
  };

  const results = {};
  for (const fn of ["loop_noop", "loop_prepare", "loop_verify_prepared", "loop_verify_full"]) {
    // 1. coarse geometric scan to find bucket per n
    const seen = []; // [n, units]
    for (let n = 1; n <= MAX_N; n *= 2) {
      const r = await cost(fn, n);
      if (!r.ok) { console.log(`  ${fn} n=${n}: ${r.err?.slice(0, 80)}`); break; }
      seen.push([n, r.units]);
    }
    // 2. bisect each bucket transition: smallest n whose bucket exceeds the previous bucket
    const trans = [];
    for (let i = 1; i < seen.length; i++) {
      if (seen[i][1] > seen[i - 1][1]) {
        let lo = seen[i - 1][0], hi = seen[i][0]; // cost(lo) = prevBucket, cost(hi) > prevBucket
        const prevBucket = seen[i - 1][1];
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          const r = await cost(fn, mid);
          if (r.ok && r.units > prevBucket) hi = mid; else lo = mid;
        }
        trans.push({ n: hi, prevBucketUnits: prevBucket });
      }
    }
    // 3. least squares: prevBucket ≈ f + s*n at each transition (raw cost at n* just exceeds prevBucket)
    let fit = null;
    if (trans.length >= 2) {
      const N = trans.length, sx = trans.reduce((a, t) => a + t.n, 0), sy = trans.reduce((a, t) => a + t.prevBucketUnits, 0);
      const sxx = trans.reduce((a, t) => a + t.n * t.n, 0), sxy = trans.reduce((a, t) => a + t.n * t.prevBucketUnits, 0);
      const s = (N * sxy - sx * sy) / (N * sxx - sx * sx), f = (sy - s * sx) / N;
      fit = { slopeUnitsPerIter: s, interceptUnits: f };
    } else if (trans.length === 1) {
      fit = { slopeUnitsPerIter: trans[0].prevBucketUnits / trans[0].n, interceptUnits: null, note: "single transition: upper-bound estimate" };
    }
    results[fn] = { scan: seen, transitions: trans, fit };
    console.log(`\n${fn}: scan ${JSON.stringify(seen)}\n  transitions ${JSON.stringify(trans)}\n  fit ${JSON.stringify(fit)}`);
  }

  console.log("\n=== per-iteration computation (gas units; 1 unit = reference-gas-price MIST) ===");
  for (const [fn, r] of Object.entries(results)) console.log(`${fn.padEnd(22)} ${r.fit ? r.fit.slopeUnitsPerIter.toFixed(1) : "n/a"} units/iter`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ circuit: CIRCUIT, sui: execFileSync(SUI, ["--version"], { encoding: "utf8" }).trim(), rgp, results }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
