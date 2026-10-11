#!/usr/bin/env node
/**
 * gas-proofs.mjs — real Groth16 proofs for gas-local.ts, produced under Node.
 * (snarkjs's worker threads never resolve under Bun, so proving cannot live in the .ts driver.)
 *
 * Usage: node gas-proofs.mjs <epochId>   → JSON on stdout:
 *   { transfer: {proof, publicSignals, vk, oldCommitment, merkleRoot},
 *     withdraw: {proof, publicSignals, vk, commitment, recipient} }
 */
import { buildPoseidon } from "circomlibjs";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { buildTransferWitness, buildWithdrawWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "circuits");
const epoch = BigInt(process.argv[2] ?? "1");

const poseidon = await buildPoseidon();
setPoseidonField(poseidon.F);
const toBI = (v) => (typeof v === "bigint" ? v : poseidon.F.toObject(v));

async function prove(circuit, dir, input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    stringifyInputs(input), join(CIRCUITS, dir, `${circuit}_js`, `${circuit}.wasm`), join(CIRCUITS, dir, `${circuit}_final.zkey`));
  const vk = JSON.parse(readFileSync(join(CIRCUITS, dir, `${circuit}_vk.json`), "utf-8"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("local verify failed");
  return { proof, publicSignals, vk };
}

const tw = buildTransferWitness(poseidon);
tw.epochId = epoch;
tw.nullifier = toBI(poseidon([2n, tw.userSecret, epoch, tw.randomnessOld])); // DOMAIN_NULLIFIER = 2
const ww = buildWithdrawWitness(poseidon);

const transfer = await prove("transfer", "build", tw);
const withdraw = await prove("withdraw", "build-withdraw", ww);
console.log(JSON.stringify({
  transfer: { ...transfer, oldCommitment: tw.oldCommitment.toString(), merkleRoot: tw.merkleRoot.toString() },
  withdraw: { ...withdraw, commitment: ww.commitment.toString(), recipient: ww.recipient.toString() },
}));
process.exit(0);
