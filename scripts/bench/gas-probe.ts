/**
 * gas-probe.ts — Bracket the computation cost of groth16 verification on a local Sui network.
 *
 * Sui rounds computationCost UP to a bucket (1000, 5000, 10000, 20000, 50000, ... units), so a
 * single tx cannot show the true cost. This publishes bench/gas-probe (n repeated verifies in one
 * tx) and sweeps n: the n at which the bucket steps up brackets the per-verify cost.
 *
 * Prerequisites: same as gas-localnet.ts (running localnet, compiled circuits).
 * Usage: cd scripts && node bench/gas-probe.ts
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error snarkjs has no types
import * as snarkjs from "snarkjs";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";
import { buildTransferWitness, buildWithdrawWitness, buildComplianceWitness, stringifyInputs, setPoseidonField } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const arg = (a: Uint8Array) => Array.from(a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NS = [1, 2, 5, 10, 20, 50, 100, 200];

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const client = new SuiJsonRpcClient({ url: "http://127.0.0.1:9000", network: "localnet" });
  const kp = Ed25519Keypair.generate();
  await requestSuiFromFaucetV2({ host: "http://127.0.0.1:9123", recipient: kp.toSuiAddress() });
  await sleep(2000);

  const built = JSON.parse(execSync("sui move build --dump-bytecode-as-base64 --no-tree-shaking", {
    cwd: join(__dirname, "gas-probe"), encoding: "utf-8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }));
  const ptx = new Transaction();
  const [cap] = ptx.publish({ modules: built.modules, dependencies: built.dependencies });
  ptx.transferObjects([cap], kp.toSuiAddress());
  ptx.setGasBudget(500_000_000n);
  const pub = await client.signAndExecuteTransaction({ transaction: ptx, signer: kp, options: { showObjectChanges: true } });
  await client.waitForTransaction({ digest: pub.digest });
  const pkg = (pub.objectChanges!.find((c) => c.type === "published") as { packageId: string }).packageId;

  const circuits: Array<[string, string, string, ReturnType<typeof buildTransferWitness>]> = [
    ["transfer (7 public inputs)", "build", "transfer", buildTransferWitness(poseidon)],
    ["withdraw (5 public inputs)", "build-withdraw", "withdraw", buildWithdrawWitness(poseidon)],
    ["compliance (6 public inputs)", "build-compliance", "compliance", buildComplianceWitness(poseidon)],
  ];


  for (const [label, dir, name, w] of circuits) {
    const base = join(ROOT, "circuits", dir);
    const vkJson = JSON.parse(readFileSync(join(base, `${name}_vk.json`), "utf-8"));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInputs(w), join(base, `${name}_js`, `${name}.wasm`), join(base, `${name}_final.zkey`));
    const vk = vkToSuiBytes(vkJson), pr = proofToSuiBytes(proof), inp = publicInputsToSuiBytes(publicSignals);
    console.log(`\n== ${label}`);
    for (const [fn, mk] of [
      ["verify_raw", (tx: Transaction, n: number) => [tx.pure.vector("u8", arg(vk)), tx.pure.vector("u8", arg(pr)), tx.pure.vector("u8", arg(inp)), tx.pure.u64(n)]],
      ["prepare_only", (tx: Transaction, n: number) => [tx.pure.vector("u8", arg(vk)), tx.pure.u64(n)]],
      ["verify_prepared", (tx: Transaction, n: number) => [tx.pure.vector("u8", arg(vk)), tx.pure.vector("u8", arg(pr)), tx.pure.vector("u8", arg(inp)), tx.pure.u64(n)]],
    ] as const) {
      const lines: string[] = [];
      for (const n of NS) {
        const tx = new Transaction();
        tx.setGasBudget(5_000_000_000n);
        tx.moveCall({ target: `${pkg}::probe::${fn}`, arguments: mk(tx, n) as never });
        const res = await client.signAndExecuteTransaction({ transaction: tx, signer: kp, options: { showEffects: true } });
        await client.waitForTransaction({ digest: res.digest });
        const st = res.effects!.status;
        if (st.status !== "success") { lines.push(`n=${n}: ${st.error}`); break; }
        lines.push(`n=${n}: ${Number(res.effects!.gasUsed.computationCost) / 1000} units`);
      }
      console.log(`  ${fn.padEnd(16)} ${lines.join(" | ")}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
