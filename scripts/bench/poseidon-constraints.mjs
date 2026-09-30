#!/usr/bin/env node
// Constraint cost of circomlib Poseidon vs a STRUCTURAL Poseidon2 shim (placeholder constants, see
// poseidon2/poseidon2_structural.circom — R1CS cost depends on structure, not constants).
//   Part A: standalone Poseidon(N) vs Poseidon2Shim(N), N=1..5.
//   Part B: the real transfer/withdraw/compliance circuits, unmodified vs every `Poseidon(N)`
//           (including the 20 Merkle-path hashers) replaced by Poseidon2Shim(N).
// Usage: node scripts/bench/poseidon-constraints.mjs [--circom <path>]
// Prereqs: `npm ci` in circuits/; circom on PATH or --circom (npm `circom2` bin works too).
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const circuits = path.resolve(here, '../../circuits')
const ci = process.argv.indexOf('--circom')
const circom = ci > 0 ? process.argv[ci + 1] : 'circom'
// tmp under circuits/ + cwd=circuits/: the WASM-packaged circom2 can't read paths outside its cwd.
const tmp = mkdtempSync(path.join(circuits, 'build-poseidon-bench-'))
const rel = (p) => path.relative(circuits, p)
copyFileSync(path.join(here, 'poseidon2/poseidon2_structural.circom'), path.join(tmp, 'poseidon2_structural.circom'))
cpSync(path.join(circuits, 'templates'), path.join(tmp, 'templates'), { recursive: true })

function compile(file, flags) {
  const out = execFileSync(circom, [rel(file), '--r1cs', '--output', rel(tmp), '-l', 'node_modules', ...flags],
    { cwd: circuits, stdio: 'pipe' }).toString().replace(/\x1b\[[0-9;]*m/g, '')
  const g = (re) => Number(out.match(re)[1])
  const nl = g(/^non-linear constraints: (\d+)/m), lin = g(/^linear constraints: (\d+)/m)
  return { nonlinear: nl, linear: lin, total: nl + lin }
}
const write = (name, src) => { const f = path.join(tmp, name); writeFileSync(f, src); return f }

const A = []
for (const flags of [[], ['--O2']]) for (const n of [1, 2, 3, 4, 5]) {
  const c = compile(write(`P${n}.circom`, `pragma circom 2.0.0;\ninclude "circomlib/circuits/poseidon.circom";\ncomponent main = Poseidon(${n});`), flags)
  const q = compile(write(`Q${n}.circom`, `pragma circom 2.0.0;\ninclude "poseidon2_structural.circom";\ncomponent main = Poseidon2Shim(${n});`), flags)
  A.push({ N: n, flags: flags.join('') || 'default', circomlib_total: c.total, circomlib_nl: c.nonlinear, poseidon2_total: q.total, poseidon2_nl: q.nonlinear })
}
console.log('Part A: standalone hash cost (constraints)'); console.table(A)

const B = []
for (const c of ['transfer', 'withdraw', 'compliance']) {
  let src = readFileSync(path.join(circuits, `${c}.circom`), 'utf8')
  const orig = write(`${c}.circom`, src)
  // templates/merkle_proof.circom lives in tmp/templates with its include of "../node_modules/..." -> repoint
  const mp = path.join(tmp, 'templates/merkle_proof.circom')
  const mpSrc = readFileSync(path.join(circuits, 'templates/merkle_proof.circom'), 'utf8')
  writeFileSync(mp, mpSrc.replace('../node_modules/circomlib', 'circomlib'))
  const swapSrc = src.replace(/component (\w+) = Poseidon\((\d+)\);/g, 'component $1 = Poseidon2Shim($2);')
    .replace('include "node_modules/circomlib/circuits/poseidon.circom";', 'include "poseidon2_structural.circom";')
  writeFileSync(path.join(tmp, 'templates/merkle_proof.circom'), mpSrc.replace('../node_modules/circomlib/circuits/poseidon.circom', '../poseidon2_structural.circom')
    .replace(/Poseidon\(2\)/g, 'Poseidon2Shim(2)').replace('../node_modules/circomlib', 'circomlib'))
  const swapped = write(`${c}_p2.circom`, swapSrc.replace(/"node_modules\/circomlib/g, '"circomlib'))
  // baseline (circomlib) needs the original merkle template
  const baseTmp = path.join(tmp, 'templates')
  writeFileSync(path.join(baseTmp, 'merkle_proof_orig.circom'), mpSrc.replace('../node_modules/circomlib', 'circomlib'))
  const baseSrc = src.replace(/"node_modules\/circomlib/g, '"circomlib').replace('templates/merkle_proof.circom', 'templates/merkle_proof_orig.circom')
  const base = write(`${c}_base.circom`, baseSrc)
  for (const flags of [[], ['--O2']]) {
    const b = compile(base, flags), s = compile(swapped, flags)
    B.push({ circuit: c, flags: flags.join('') || 'default', base_total: b.total, base_nl: b.nonlinear, p2_total: s.total, p2_nl: s.nonlinear,
      d_total: s.total - b.total, d_pct: ((s.total - b.total) / b.total * 100).toFixed(1) + '%' })
  }
}
console.log('Part B: full circuits, circomlib Poseidon vs Poseidon2Shim'); console.table(B)
// Part C: Merkle-path cost by depth (circomlib Poseidon(2) per level) — the dominant term in transfer.
const C = []
for (const d of [10, 16, 20, 24, 32]) {
  const r = compile(write(`M${d}.circom`, `pragma circom 2.0.0;\ninclude "templates/merkle_proof_orig.circom";\ncomponent main = MerkleProof(${d});`), [])
  C.push({ depth: d, nonlinear: r.nonlinear, total: r.total, nl_per_level: (r.nonlinear / d).toFixed(1) })
}
console.log('Part C: MerkleProof(depth), default flags'); console.table(C)
console.log(JSON.stringify({ A, B, C }))
rmSync(tmp, { recursive: true, force: true })
