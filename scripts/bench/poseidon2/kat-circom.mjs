/**
 * kat-circom.mjs <buildDir> — checks circuits/research/poseidon2.circom against the published
 * HorizenLabs vector (via the compiled p2_perm3_kat circuit), then the negative test: the same
 * witness with out[0] bumped by one must violate the R1CS (`snarkjs wtns check` must fail).
 */
import * as snarkjs from "snarkjs";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { permute, P } from "./poseidon2.mjs";

const dir = process.argv[2];
const wasm = join(dir, "p2_perm3_kat_js", "p2_perm3_kat.wasm");
const r1cs = join(dir, "p2_perm3_kat.r1cs");
const good = join(dir, "p2_perm3_kat.good.wtns");
const bad = join(dir, "p2_perm3_kat.bad.wtns");
const silent = { info() {}, warn() {}, error() {}, debug() {} };

await snarkjs.wtns.calculate({ in: ["0", "1", "2"] }, wasm, good);
const w = await snarkjs.wtns.exportJson(good);
const outs = w.slice(1, 4).map(BigInt); // wire 0 is the constant 1, outputs come next
const expect = permute([0n, 1n, 2n]);
const katOk = outs.every((x, i) => x === expect[i]);
console.log(`circom Poseidon2Perm3([0,1,2]) == HorizenLabs KAT: ${katOk ? "PASS" : "FAIL"}`);
const goodOk = await snarkjs.wtns.check(r1cs, good, silent);
console.log(`honest witness satisfies R1CS: ${goodOk ? "PASS" : "FAIL"}`);

// Tamper: replace out[0] (wire 1) with out[0]+1 in the binary witness (values are 32-byte LE).
const le = (x) => { const b = Buffer.alloc(32); let v = x; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const buf = readFileSync(good);
const needle = le(outs[0]);
const at = buf.indexOf(needle);
if (at < 0 || buf.indexOf(needle, at + 1) >= 0) throw new Error("could not uniquely locate out[0] in wtns");
le((outs[0] + 1n) % P).copy(buf, at);
writeFileSync(bad, buf);
const badOk = await snarkjs.wtns.check(r1cs, bad, silent);
console.log(`NEGATIVE: tampered out[0]+1 rejected by R1CS: ${badOk ? "FAIL (accepted!)" : "PASS (rejected)"}`);
process.exit(katOk && goodOk && !badOk ? 0 : 1);
