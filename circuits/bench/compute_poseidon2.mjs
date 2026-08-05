#!/usr/bin/env node
// Computes a Poseidon2 digest by running the *actual compiled circuit* through
// snarkjs's witness calculator and reading out `main.out` — avoids a hand-rolled
// JS reimplementation of the permutation (and the risk of it silently diverging
// from the audited circom source) when building a valid witness for
// withdraw_poseidon2.circom.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, "build");

function outWireIndex(symPath) {
  const line = readFileSync(symPath, "utf8").split("\n").find((l) => l.endsWith(",main.out"));
  return parseInt(line.split(",")[0], 10);
}

export async function poseidon2(name, inputs) {
  const wasmPath = join(BUILD, `${name}_js`, `${name}.wasm`);
  const symPath = join(BUILD, `${name}.sym`);
  const wtns = { type: "mem" };
  await snarkjs.wtns.calculate({ in: inputs.map((x) => x.toString()) }, wasmPath, wtns);
  const exported = await snarkjs.wtns.exportJson(wtns);
  return BigInt(exported[outWireIndex(symPath)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const h1 = await poseidon2("poseidon2_t8_n4", [1n, 500n, 12345n, 987654321n]);
  console.log("poseidon2_t8_n4([1,500,12345,987654321]) =", h1.toString());
  const h2 = await poseidon2("poseidon2_t3_n2", [8n, 0xABCDEF123456n]);
  console.log("poseidon2_t3_n2([8, 0xABCDEF123456]) =", h2.toString());
}
