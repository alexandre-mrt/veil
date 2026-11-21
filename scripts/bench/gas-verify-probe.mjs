#!/usr/bin/env node
/**
 * gas-verify-probe.mjs — per-call gas of sui::groth16 (prepare_verifying_key, verify), measured
 * above the per-transaction computation floor by looping N times inside one transaction.
 *
 * Every Veil entry point lands on the computation floor (1000 units) in gas-localnet.mjs, so a
 * single verification's cost is invisible at transaction granularity. This probe publishes a
 * bench-only package (scripts/bench/gas-probe/, never deployed anywhere real) and reports
 * computation units for N ∈ {1, 5, 10, 20, 40} under three variants, for all three Veil circuits.
 *
 * Prereqs: same as gas-localnet.mjs (sui CLI, compiled circuits, `sui start --with-faucet --force-regenesis`).
 * Usage:   NO_PROXY=127.0.0.1,localhost node scripts/bench/gas-verify-probe.mjs
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const C = join(__dirname, "..", "..", "circuits");
const client = new SuiGrpcClient({ network: "localnet", baseUrl: process.env.SUI_RPC ?? "http://127.0.0.1:9000" });
const kp = new Ed25519Keypair();
const NS = [1, 5, 10, 20, 40];
const CIRCUITS = [["transfer", "build"], ["compliance", "build-compliance"], ["withdraw", "build-withdraw"]];

async function run(build) {
  const tx = new Transaction();
  tx.setGasBudget(5_000_000_000);
  build(tx);
  const r = await client.signAndExecuteTransaction({ transaction: tx, signer: kp, include: { effects: true } });
  const t = r.Transaction ?? r.FailedTransaction;
  await client.waitForTransaction({ digest: t.digest });
  if (!t.effects.status.success) throw new Error(JSON.stringify(t.effects.status.error));
  return t;
}

const poseidon = await buildPoseidon(); setPoseidonField(poseidon.F);
const { referenceGasPrice: rgp } = await client.getReferenceGasPrice();
console.log(`=== sui::groth16 per-call gas probe — ${execFileSync("sui", ["--version"], { encoding: "utf8" }).trim()}, RGP ${rgp} ===`);
await requestSuiFromFaucetV2({ host: process.env.SUI_FAUCET ?? "http://127.0.0.1:9123", recipient: kp.toSuiAddress() });
await new Promise((r) => setTimeout(r, 2000));
const built = JSON.parse(execFileSync("sui", ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", join(__dirname, "gas-probe")],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const pub = await run((tx) => tx.transferObjects([tx.publish({ modules: built.modules, dependencies: built.dependencies })], kp.toSuiAddress()));
const pkg = pub.effects.changedObjects.find((o) => o.outputState === "PackageWrite").objectId;

console.log(`\n| circuit | public inputs | variant | N | computation units |`);
console.log(`|---|---|---|---|---|`);
for (const [name, dir] of CIRCUITS) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInputs(WITNESS_BUILDERS[name](poseidon)),
    join(C, dir, `${name}_js`, `${name}.wasm`), join(C, dir, `${name}_final.zkey`));
  const vk = Array.from(vkToSuiBytes(JSON.parse(readFileSync(join(C, dir, `${name}_vk.json`), "utf8"))));
  const p = Array.from(proofToSuiBytes(proof)), x = Array.from(publicInputsToSuiBytes(publicSignals));
  for (const [variant, fn, args] of [
    ["prepare+verify ×N", "prepare_and_verify_n", (tx) => [tx.pure.vector("u8", vk), tx.pure.vector("u8", p), tx.pure.vector("u8", x)]],
    ["prepare ×1, verify ×N", "verify_prepared_n", (tx) => [tx.pure.vector("u8", vk), tx.pure.vector("u8", p), tx.pure.vector("u8", x)]],
    ["prepare ×N only", "prepare_n", (tx) => [tx.pure.vector("u8", vk)]],
  ]) {
    for (const n of NS) {
      const t = await run((tx) => tx.moveCall({ target: `${pkg}::probe::${fn}`, arguments: [...args(tx), tx.pure.u64(n)] }));
      console.log(`| ${name} | ${publicSignals.length} | ${variant} | ${n} | ${BigInt(t.effects.gasUsed.computationCost) / BigInt(rgp)} |`);
    }
  }
}
process.exit(0);
