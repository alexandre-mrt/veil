#!/usr/bin/env node
// prove-for-gas.mjs — helper for gas-localnet.ts: one real Groth16 proof as JSON on stdout.
// Usage: node prove-for-gas.mjs <transfer|withdraw> [epochId]
// (Runs under Node because snarkjs' worker threads exit silently under bun.)
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildTransferWitness, buildWithdrawWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const C = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "circuits");
const [kind, epoch] = process.argv.slice(2);
const poseidon = await buildPoseidon();
setPoseidonField(poseidon.F);
const art = kind === "transfer"
  ? { w: buildTransferWitness(poseidon, { epochId: BigInt(epoch) }), d: "build" }
  : { w: buildWithdrawWitness(poseidon), d: "build-withdraw" };
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  stringifyInputs(art.w), join(C, art.d, `${kind}_js`, `${kind}.wasm`), join(C, art.d, `${kind}_final.zkey`));
console.log(JSON.stringify({ proof, publicSignals }));
process.exit(0);
