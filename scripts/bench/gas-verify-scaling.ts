#!/usr/bin/env bun
/**
 * gas-verify-scaling.ts — marginal on-chain cost of one Groth16 verification (BN254, 7 public
 * inputs, a real Veil transfer proof) vs one verifying-key preparation, on a local Sui network.
 *
 * Usage: cd scripts && bun run bench/gas-verify-scaling.ts [--rpc http://127.0.0.1:9000]
 * Needs: local network up (see gas-localnet.ts) and circuits/build/transfer_* compiled.
 * Method: publish bench/verify-bench, call verify_n / prepare_n with n in a sweep inside ONE
 * transaction, read computationCost from the effects (dry-run is not used: the same effects are
 * returned by a real execution). Cost is bucketed by the protocol, so the sweep is what reveals
 * the slope; a single call cannot.
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const client = new SuiJsonRpcClient({ url: arg("--rpc", "http://127.0.0.1:9000"), network: "localnet" } as any);
const FAUCET = arg("--faucet", "http://127.0.0.1:9123/v2/gas");
const kp = Ed25519Keypair.generate();
const me = kp.toSuiAddress();

async function main() {
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await new Promise((r) => setTimeout(r, 3000));
  const build = JSON.parse(execSync(`sui move build --build-env testnet --dump-bytecode-as-base64 --path ${ROOT}/scripts/bench/verify-bench 2>/dev/null`, { encoding: "utf-8", maxBuffer: 1 << 26 }));
  const ptx = new Transaction();
  ptx.transferObjects([ptx.publish({ modules: build.modules, dependencies: build.dependencies })], me);
  ptx.setGasBudget(500_000_000);
  const pub = await client.signAndExecuteTransaction({ transaction: ptx, signer: kp, options: { showObjectChanges: true } });
  await client.waitForTransaction({ digest: pub.digest });
  const pkg = (pub.objectChanges as any[]).find((c) => c.type === "published").packageId;

  const p = JSON.parse(execSync(`node ${join(ROOT, "scripts/bench/prove-for-gas.mjs")} transfer 5`, { encoding: "utf-8", cwd: join(ROOT, "scripts") }));
  const vk = vkToSuiBytes(JSON.parse(readFileSync(`${ROOT}/circuits/build/transfer_vk.json`, "utf-8")));
  const proof = proofToSuiBytes(p.proof), inputs = publicInputsToSuiBytes(p.publicSignals);
  const rgp = Number(await client.getReferenceGasPrice());

  const call = async (label: string, build: (t: Transaction) => void) => {
    const t = new Transaction(); build(t); t.setGasBudget(50_000_000_000);
    const r = await client.signAndExecuteTransaction({ transaction: t, signer: kp, options: { showEffects: true } });
    await client.waitForTransaction({ digest: r.digest });
    const comp = Number(r.effects!.gasUsed.computationCost);
    console.log(`${label.padEnd(36)} ${r.effects!.status.status.padEnd(8)} computationCost=${comp} MIST = ${(comp / rgp).toFixed(0)} units`);
    return comp;
  };
  const v = (n: number, prep: boolean) => (t: Transaction) => t.moveCall({ target: `${pkg}::verify_bench::verify_n`, arguments: [t.pure.vector("u8", Array.from(vk)), t.pure.vector("u8", Array.from(proof)), t.pure.vector("u8", Array.from(inputs)), t.pure.u64(n), t.pure.bool(prep)] });
  console.log(`reference gas price ${rgp}; real transfer proof, ${inputs.length / 32} public inputs`);
  for (const n of [1, 5, 10, 25, 50, 100, 200]) await call(`verify x${n} (prepare once)`, v(n, false));
  for (const n of [1, 5, 10, 25, 50, 100]) await call(`verify x${n} (prepare each, as veil::verifier)`, v(n, true));
  for (const n of [1, 10, 50, 100]) await call(`prepare_verifying_key only x${n}`, (t) => t.moveCall({ target: `${pkg}::verify_bench::prepare_n`, arguments: [t.pure.vector("u8", Array.from(vk)), t.pure.u64(n)] }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
