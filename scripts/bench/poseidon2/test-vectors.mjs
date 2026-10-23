#!/usr/bin/env node
/**
 * test-vectors.mjs — check the circom Poseidon2 permutation (t=3, t=4) against an independent JS
 * implementation (@zkpassport/poseidon2's Poseidon2 class) on random inputs, by computing real
 * witnesses from the compiled wasm. Exits non-zero on any mismatch.
 *
 * Usage: node test-vectors.mjs --build <dir with perm3_js/perm3.wasm, perm4_js/perm4.wasm> --rs <HorizenLabs inst.rs>
 */
import { readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as snarkjs from "snarkjs";
import { Poseidon2, F1Field, getPoseidon2Params, permute } from "@zkpassport/poseidon2";

const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const F = new F1Field(P);
const hexes = (s) => [...s.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => BigInt(m[0]));

const rs = readFileSync(arg("--rs"), "utf8");
const rc3flat = hexes(rs.slice(rs.indexOf("RC3"), rs.indexOf("POSEIDON2_BN256_PARAMS")));
const rc3 = Array.from({ length: 64 }, (_, r) => rc3flat.slice(r * 3, r * 3 + 3));
const diag3 = hexes(rs.slice(rs.indexOf("MAT_DIAG3_M_1"), rs.indexOf("MAT_INTERNAL3")));
const p3 = new Poseidon2(getPoseidon2Params(3, 5, 8, 56, diag3, [], rc3), F);

const rnd = () => BigInt("0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")) % P;
const tmp = mkdtempSync(join(tmpdir(), "p2-"));
let bad = 0;
for (const [T, ref] of [[3, (x) => p3.permute([...x])], [4, (x) => permute([...x])]]) {
  const wasm = join(arg("--build"), `perm${T}_js`, `perm${T}.wasm`);
  for (let k = 0; k < 20; k++) {
    const input = Array.from({ length: T }, () => (k === 0 ? 0n : rnd()));
    const want = ref(input).map(BigInt);
    const wtns = join(tmp, `w${T}.wtns`);
    await snarkjs.wtns.calculate({ in: input.map(String) }, wasm, wtns);
    const w = await snarkjs.wtns.exportJson(wtns);
    const got = w.slice(1, 1 + T).map(BigInt); // outputs are the first wires after the constant 1
    if (got.some((g, i) => g !== want[i])) { bad++; console.log(`MISMATCH t=${T} k=${k}`); }
  }
  console.log(`t=${T}: 20/20 random permutations ${bad ? "FAILED" : "match the JS reference"}`);
}
process.exit(bad ? 1 : 0);
