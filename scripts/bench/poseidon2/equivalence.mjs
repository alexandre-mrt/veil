#!/usr/bin/env node
/**
 * equivalence.mjs — (1) circom Poseidon2 templates == BigInt reference on random inputs,
 * (2) transfer_p2_all accepts a valid witness, (3) negative tests: malicious witnesses rejected.
 *   node scripts/bench/poseidon2/equivalence.mjs <outdir used by constraints.sh> [O1|O2]
 */
import * as snarkjs from "snarkjs";
import { join } from "path";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { P, permute, hash2, hash3 } from "./reference.mjs";

const OUT = process.argv[2], OPT = process.argv[3] ?? "O1";
const wasm = (n) => join(OUT, OPT, n, `${n}_js`, `${n}.wasm`);
const tmp = mkdtempSync(join(tmpdir(), "p2eq-"));
const rnd = () => BigInt("0x" + randomBytes(32).toString("hex")) % P;
let pass = 0, fail = 0;
const ok = (c, msg) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${msg}`); };
async function wit(name, input) {
  const f = join(tmp, name + ".wtns");
  await snarkjs.wtns.calculate(input, wasm(name), f);
  return (await snarkjs.wtns.exportJson(f)).map(BigInt);
}
const rejects = async (name, input) => { try { await wit(name, input); return false; } catch { return true; } };

// (1) functional equivalence
for (let i = 0; i < 10; i++) {
  const [a, b, c] = [rnd(), rnd(), rnd()];
  const w3 = await wit("micro_poseidon2_t3", { inputs: [a, b].map(String) });
  ok(w3[1] === hash2(0n, a, b), `Poseidon2Hash2 vector ${i}`);
  const w4 = await wit("micro_poseidon2_t4", { inputs: [a, b, c].map(String) });
  ok(w4[1] === hash3(1n, a, b, c), `Poseidon2Hash3 vector ${i}`);
}
console.log("perm([0,1,2]) t=3 [0] =", "0x" + permute(3, [0n, 1n, 2n])[0].toString(16));

// (2) transfer_p2_all valid witness
const D = 20, [userSecret, rOld, rNew, salt] = [rnd(), rnd(), rnd(), rnd()];
const cumOld = 500n, txAmount = 100n, cumNew = 600n, epochId = 7n, threshold = 1000000n;
const oldC = hash3(1n, cumOld, rOld, userSecret), newC = hash3(1n, cumNew, rNew, userSecret);
const nf = hash3(2n, userSecret, epochId, rOld), txH = hash2(3n, txAmount, salt);
const pathElements = Array.from({ length: D }, rnd), pathIndices = Array.from({ length: D }, (_, i) => BigInt(i % 2));
let node = oldC;
for (let i = 0; i < D; i++) node = pathIndices[i] === 0n ? hash2(0n, node, pathElements[i]) : hash2(0n, pathElements[i], node);
const good = { oldCommitment: oldC, newCommitment: newC, threshold, epochId, nullifier: nf, txAmountHash: txH, merkleRoot: node,
  cumulativeOld: cumOld, cumulativeNew: cumNew, txAmount, randomnessOld: rOld, randomnessNew: rNew, userSecret, salt, pathElements, pathIndices };
const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));
const T = "transfer_p2_all";
try { await wit(T, str(good)); ok(true, "valid transfer witness accepted"); } catch (e) { ok(false, "valid transfer witness accepted: " + e.message.split("\n")[0]); }

// (3) negative tests — every one must be REJECTED at witness generation (constraint unsatisfied)
const neg = {
  "wrong merkleRoot": { merkleRoot: (node + 1n) % P },
  "wrong sibling in path": { pathElements: pathElements.map((x, i) => (i === 3 ? (x + 1n) % P : x)) },
  "non-boolean pathIndex (2)": { pathIndices: pathIndices.map((x, i) => (i === 0 ? 2n : x)) },
  "forged nullifier": { nullifier: (nf + 1n) % P },
  "forged oldCommitment (not in tree / not well-formed)": { oldCommitment: (oldC + 1n) % P },
  "cumulativeNew != cumulativeOld + txAmount": { cumulativeNew: 601n },
  "tag confusion: txAmountHash computed under tag 2": { txAmountHash: hash2(2n, txAmount, salt) },
  "commitment hashed with nullifier tag (domain swap)": { oldCommitment: hash3(2n, cumOld, rOld, userSecret) },
};
for (const [name, patch] of Object.entries(neg)) ok(await rejects(T, str({ ...good, ...patch })), `rejected: ${name}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
