// Constraint-count comparison: circomlib Poseidon vs. a structural Poseidon2 (BN254, x^5) in R1CS.
//
// Usage: node scripts/bench/poseidon-constraints.mjs [--circom <path>]
//   circom compiler defaults to `circom`; `npm i circom2` provides a WASM build at node_modules/.bin/circom2.
//
// IMPORTANT: Poseidon2 round constants / internal-diagonal below are derived from SHA-256(counter) mod p,
// NOT the audited HorizenLabs parameters. R1CS constraint count depends only on circuit structure
// (number of S-boxes), never on constant values, so counts are valid; hash outputs are NOT a usable
// Poseidon2 instance. Do not wire this into the protocol without real parameters.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const circom = args.includes('--circom') ? args[args.indexOf('--circom') + 1] : 'circom';
const libs = join(root, 'circuits/node_modules');
const snarkjs = join(root, 'circuits/node_modules/.bin/snarkjs');
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const rc = (tag, i) => BigInt('0x' + createHash('sha256').update(`${tag}:${i}`).digest('hex')) % P;
// Round counts from the Poseidon2 paper (BN254, alpha=5): RF=8; RP=56 (t=3,4), 57 (t=8)
const RP = { 3: 56, 4: 56, 8: 57 };
const RF = 8;

function m4(v) { // M4 from the Poseidon2 paper, applied to 4 expressions
  const [a, b, c, d] = v;
  return [`5*${a}+7*${b}+${c}+3*${d}`, `4*${a}+6*${b}+${c}+${d}`, `${a}+3*${b}+5*${c}+7*${d}`, `${a}+${b}+4*${c}+6*${d}`];
}
function poseidon2Circom(t) {
  const rp = RP[t];
  const L = [];
  L.push(`template Sbox5() { signal input in; signal output out; signal x2; signal x4; x2 <== in*in; x4 <== x2*x2; out <== x4*in; }`);
  L.push(`template Poseidon2Perm${t}() {`);
  L.push(`  signal input in[${t}]; signal output out[${t}];`);
  let cur = Array.from({ length: t }, (_, i) => `in[${i}]`);
  let n = 0;
  const lin = (name, exprs) => { // materialise a linear layer as signals (free after O1 simplification)
    L.push(`  signal ${name}[${t}];`);
    exprs.forEach((e, i) => L.push(`  ${name}[${i}] <== ${e};`));
    return exprs.map((_, i) => `${name}[${i}]`);
  };
  const extMat = (v) => {
    if (t === 3) { const s = `(${v.join('+')})`; return v.map((x) => `${s}+${x}`); }
    if (t === 4) return m4(v);
    // t=8: circ(2*M4, M4) block structure: out_block = M4(b_i) + sum_j M4(b_j)
    const blocks = [m4(v.slice(0, 4)), m4(v.slice(4, 8))];
    const sum = blocks[0].map((_, k) => `(${blocks[0][k]})+(${blocks[1][k]})`);
    return blocks.flatMap((blk) => blk.map((e, k) => `(${e})+${sum[k]}`));
  };
  const intMat = (v) => { const s = `(${v.join('+')})`; return v.map((x, i) => `${s}+${rc('diag' + t, i)}*${x}`); };
  cur = lin('init', extMat(cur));
  const full = (r) => {
    const names = cur.map((x, i) => { L.push(`  component s${r}_${i} = Sbox5(); s${r}_${i}.in <== ${x} + ${rc('rcF' + t, n++)};`); return `s${r}_${i}.out`; });
    cur = lin(`f${r}`, extMat(names));
  };
  for (let r = 0; r < RF / 2; r++) full(r);
  for (let r = 0; r < rp; r++) {
    L.push(`  component p${r} = Sbox5(); p${r}.in <== ${cur[0]} + ${rc('rcP' + t, r)};`);
    cur = lin(`q${r}`, intMat([`p${r}.out`, ...cur.slice(1)]));
  }
  for (let r = RF / 2; r < RF; r++) full(r);
  cur.forEach((x, i) => L.push(`  out[${i}] <== ${x};`));
  L.push('}');
  // 2->1 compression with capacity 1 (t=3) / hash-of-(t-1) inputs
  L.push(`template Poseidon2Hash${t}() { signal input in[${t - 1}]; signal output out; component p = Poseidon2Perm${t}();`);
  for (let i = 0; i < t - 1; i++) L.push(`  p.in[${i}] <== in[${i}];`);
  L.push(`  p.in[${t - 1}] <== 0; out <== p.out[0]; }`);
  return L.join('\n');
}

const merkle = (hasher, rate) => `
template Merkle(depth) {
  signal input leaf; signal input pathElements[depth]; signal input pathIndices[depth]; signal output root;
  signal nodes[depth+1]; nodes[0] <== leaf;
  component mux[depth]; component h[depth];
  for (var i = 0; i < depth; i++) {
    pathIndices[i]*(1-pathIndices[i]) === 0;
    mux[i] = MultiMux1(2);
    mux[i].c[0][0] <== nodes[i]; mux[i].c[0][1] <== pathElements[i];
    mux[i].c[1][0] <== pathElements[i]; mux[i].c[1][1] <== nodes[i]; mux[i].s <== pathIndices[i];
    h[i] = ${hasher};
    h[i].${rate}[0] <== mux[i].out[0]; h[i].${rate}[1] <== mux[i].out[1];
    nodes[i+1] <== h[i].out;
  }
  root <== nodes[depth];
}`;

// Arity-4 tree, same 2^20 capacity (depth 10). The prover supplies all 4 slots; the circuit only has to
// prove the running node sits at slot `pos` (sum_j ind_j * slot_j == node), so siblings need no ordering.
const merkle4 = `
template Merkle4(depth) {
  signal input leaf; signal input slots[depth][4]; signal input bits[depth][2]; signal output root;
  signal nodes[depth+1]; nodes[0] <== leaf;
  component h[depth];
  signal b01[depth]; signal ind[depth][4]; signal sel[depth][4];
  for (var i = 0; i < depth; i++) {
    bits[i][0]*(1-bits[i][0]) === 0; bits[i][1]*(1-bits[i][1]) === 0;
    b01[i] <== bits[i][0]*bits[i][1];
    ind[i][0] <== 1 - bits[i][0] - bits[i][1] + b01[i];
    ind[i][1] <== bits[i][0] - b01[i];
    ind[i][2] <== bits[i][1] - b01[i];
    ind[i][3] <== b01[i];
    var acc = 0;
    for (var j = 0; j < 4; j++) { sel[i][j] <== ind[i][j]*slots[i][j]; acc += sel[i][j]; }
    acc === nodes[i];
    h[i] = Poseidon(4);
    for (var j = 0; j < 4; j++) h[i].inputs[j] <== slots[i][j];
    nodes[i+1] <== h[i].out;
  }
  root <== nodes[depth];
}`;

const dir = mkdtempSync(join(tmpdir(), 'pos2-'));
function count(name, body, main) {
  const f = join(dir, name + '.circom');
  writeFileSync(f, `pragma circom 2.1.0;\ninclude "circomlib/circuits/poseidon.circom";\ninclude "circomlib/circuits/mux1.circom";\n${body}\ncomponent main = ${main};\n`);
  const out = execFileSync(circom, [f, '--r1cs', '-l', libs, '-o', dir], { encoding: 'utf8' });
  const info = execFileSync(snarkjs, ['r1cs', 'info', join(dir, name + '.r1cs')], { encoding: 'utf8' });
  const total = +/# of Constraints: (\d+)/.exec(info)[1];
  const nl = +/non-linear constraints: (\d+)/.exec(out)?.[1];
  return { name, total, nonLinear: nl };
}
const rows = [];
for (const n of [2, 3, 4, 5]) rows.push(count(`circomlib_Poseidon${n}`, '', `Poseidon(${n})`));
for (const t of [3, 4, 8]) rows.push(count(`poseidon2_t${t}`, poseidon2Circom(t), `Poseidon2Hash${t}()`));
rows.push(count('merkle20_circomlib', merkle('Poseidon(2)', 'inputs'), 'Merkle(20)'));
rows.push(count('merkle20_poseidon2_t3', poseidon2Circom(3) + merkle('Poseidon2Hash3()', 'in'), 'Merkle(20)'));
rows.push(count('merkle4x10_circomlib_Poseidon4', merkle4, 'Merkle4(10)'));
console.log('name\ttotal_constraints\tnon_linear');
for (const r of rows) console.log(`${r.name}\t${r.total}\t${r.nonLinear}`);
