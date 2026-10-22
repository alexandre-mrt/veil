#!/usr/bin/env node
/**
 * gas-verify-sweep.mjs — How much native Groth16 work fits inside one Sui computation-gas bucket?
 *
 * Sui charges computation gas in buckets (floor 1000 units), so the per-entry-point numbers from
 * gas-localnet.mjs cannot resolve the cost of one verification. This script publishes
 * move-gas/ (a loop of verify calls) and sweeps the loop count N; the N at which the charged
 * bucket steps up, combined with the bucket boundaries, brackets the true per-verify cost.
 *
 * Usage: sui start --force-regenesis --with-faucet &  ;  node scripts/bench/gas-verify-sweep.mjs [--out f.json]
 * Env: SUI_BIN, RPC_URL, FAUCET_URL (as gas-localnet.mjs).
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUI = process.env.SUI_BIN || "sui";
const client = new SuiJsonRpcClient({ url: process.env.RPC_URL || "http://127.0.0.1:9000", network: "localnet" });
const FAUCET = process.env.FAUCET_URL || "http://127.0.0.1:9123";
const OUT = (() => { const i = process.argv.indexOf("--out"); return i !== -1 ? process.argv[i + 1] : null; })();
const kp = Ed25519Keypair.generate();
const me = kp.toSuiAddress();
const vec = (tx, b) => tx.pure.vector("u8", Array.from(b));

async function run(build) {
  for (let attempt = 0; ; attempt++) {
    const tx = new Transaction();
    tx.setGasBudget(50_000_000_000n);
    build(tx);
    try {
      const r = await client.signAndExecuteTransaction({ transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true } });
      await client.waitForTransaction({ digest: r.digest });
      return r;
    } catch (e) {
      // gas-coin version race between back-to-back txs on a fast localnet: rebuild and retry
      if (attempt >= 4 || !String(e.message).includes("rebuilt")) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const b = join(__dirname, "..", "..", "circuits", "build");
  const vkJson = JSON.parse(readFileSync(join(b, "transfer_vk.json"), "utf8"));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInputs(WITNESS_BUILDERS.transfer(poseidon)), join(b, "transfer_js", "transfer.wasm"), join(b, "transfer_final.zkey"));
  const vk = vkToSuiBytes(vkJson), pr = proofToSuiBytes(proof), inp = publicInputsToSuiBytes(publicSignals);

  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await new Promise((r) => setTimeout(r, 3000));
  const built = JSON.parse(execFileSync(SUI, ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", join(__dirname, "move-gas")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const pub = await run((tx) => { const [c] = tx.publish({ modules: built.modules, dependencies: built.dependencies }); tx.transferObjects([c], me); });
  const pkg = pub.objectChanges.find((c) => c.type === "published").packageId;

  const Ns = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
  const variants = {
    full_n: (tx, n) => tx.moveCall({ target: `${pkg}::gasbench::full_n`, arguments: [vec(tx, vk), vec(tx, pr), vec(tx, inp), tx.pure.u64(n)] }),
    prepare_n: (tx, n) => tx.moveCall({ target: `${pkg}::gasbench::prepare_n`, arguments: [vec(tx, vk), tx.pure.u64(n)] }),
    prepared_n: (tx, n) => tx.moveCall({ target: `${pkg}::gasbench::prepared_n`, arguments: [vec(tx, vk), vec(tx, pr), vec(tx, inp), tx.pure.u64(n)] }),
  };
  const results = {};
  for (const [name, f] of Object.entries(variants)) {
    results[name] = [];
    for (const n of Ns) {
      const r = await run((tx) => f(tx, n));
      const ok = r.effects.status.status === "success";
      const units = Number(BigInt(r.effects.gasUsed.computationCost) / 1000n);
      results[name].push({ n, ok, computationUnits: units, error: ok ? undefined : JSON.stringify(r.effects.status) });
      console.log(`${name.padEnd(11)} N=${String(n).padStart(3)} ok=${ok} computationUnits=${units}${ok ? "" : " " + r.effects.status.error}`);
      if (!ok) break;
    }
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ sui: execFileSync(SUI, ["--version"], { encoding: "utf8" }).trim(), results }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
