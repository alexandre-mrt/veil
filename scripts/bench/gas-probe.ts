/**
 * gas-probe.ts — isolate the computation cost of Groth16 verification on Sui.
 *
 * gas-localnet.ts showed every Veil entry point lands in Sui's *lowest* computation bucket, which
 * hides the real cost of the verifier. This probe publishes scripts/bench/gas-probe (a tiny package
 * that calls the same `sui::groth16` natives as veil::verifier, n times per transaction), dry-runs
 * it with real Veil proofs for n = 1,2,4,…, and prints the bucketed computation cost for each n.
 * The n at which the bucket steps up bounds the per-call cost.
 *
 * Usage (localnet up, `sui client` on `local`, circuits compiled):
 *   node --experimental-strip-types --no-warnings scripts/bench/gas-probe.ts [--json out.json]
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";
// @ts-ignore plain JS helper shared with the other benches
import { WITNESS_BUILDERS, stringifyInputs, setPoseidonField } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = join(__dirname, "..", "..", "circuits");
const RPC_URL = process.env.SUI_RPC_URL ?? "http://127.0.0.1:9000";
const LADDER = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

function loadKeypair(): Ed25519Keypair {
  const addr = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const ks: string[] = JSON.parse(readFileSync(join(homedir(), ".sui/sui_config/sui.keystore"), "utf-8"));
  for (const k of ks) {
    const raw = fromBase64(k);
    if (raw[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (kp.toSuiAddress() === addr) return kp;
  }
  throw new Error("active key not found");
}

async function main() {
  // @ts-ignore snarkjs has no types
  const snarkjs = await import("snarkjs");
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const kp = loadKeypair();
  const sender = kp.toSuiAddress();
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" as any });
  const price = BigInt(await client.getReferenceGasPrice());
  console.log(`[info] reference gas price = ${price} MIST/unit`);

  const pubOut = execSync(
    "sui client test-publish --build-env testnet --pubfile-path /tmp/gas-probe-pub.toml --gas-budget 500000000 --json",
    { cwd: join(__dirname, "gas-probe"), encoding: "utf-8", maxBuffer: 50 << 20 },
  );
  const pub = JSON.parse(pubOut.slice(pubOut.indexOf("{")));
  const pkg: string = pub.objectChanges.find((c: any) => c.type === "published").packageId;
  await client.waitForTransaction({ digest: pub.digest });

  const circuits: Array<[string, string]> = [["transfer", "build"], ["withdraw", "build-withdraw"], ["compliance", "build-compliance"]];
  const results: any[] = [];
  for (const [name, dir] of circuits) {
    const w = WITNESS_BUILDERS[name](poseidon);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      stringifyInputs(w), join(CIRCUITS, dir, `${name}_js`, `${name}.wasm`), join(CIRCUITS, dir, `${name}_final.zkey`));
    const vk = JSON.parse(readFileSync(join(CIRCUITS, dir, `${name}_vk.json`), "utf-8"));
    if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${name}: bad local proof`);
    const vkB = vkToSuiBytes(vk), pB = proofToSuiBytes(proof), iB = publicInputsToSuiBytes(publicSignals);

    for (const variant of ["noop", "prepare_n", "verify_prepared_n", "prepare_and_verify_n"]) {
      const line: Record<string, number> = {};
      for (const n of LADDER) {
        const tx = new Transaction();
        tx.setSender(sender);
        tx.setGasBudget(50_000_000_000n);
        const v = (b: Uint8Array) => tx.pure.vector("u8", Array.from(b));
        if (variant === "prepare_n") tx.moveCall({ target: `${pkg}::probe::prepare_n`, arguments: [v(vkB), tx.pure.u64(n)] });
        else tx.moveCall({ target: `${pkg}::probe::${variant}`, arguments: [v(vkB), v(pB), v(iB), tx.pure.u64(n)] });
        const bytes = await tx.build({ client });
        const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
        if (dry.effects.status.status !== "success") {
          line[n] = -1; // aborted / out of gas: stop the ladder
          break;
        }
        line[n] = Number(BigInt(dry.effects.gasUsed.computationCost) / price);
      }
      results.push({ circuit: name, variant, unitsByN: line });
      console.log(`[probe] ${name.padEnd(10)} ${variant.padEnd(22)} computation units by n: ${JSON.stringify(line)}`);
    }
  }
  const out = process.argv.indexOf("--json");
  if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify({ gasPrice: price.toString(), results }, null, 2));
  process.exit(0); // snarkjs leaves worker threads alive
}
main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
