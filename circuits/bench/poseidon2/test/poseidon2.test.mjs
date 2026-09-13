/**
 * poseidon2.test.mjs — correctness + negative tests for the Poseidon vs Poseidon2 bench circuits.
 *
 * Two things this proves, per circuit:
 *   1. Correctness: the circom-computed hash matches an *independent* JS reference implementation
 *      (circomlibjs's Poseidon for the baseline circuits, @taceo/poseidon2's bn254 permutation —
 *      a separate package, separate author's TypeScript port of the same published parameter set —
 *      for the Poseidon2 circuits). This is what rules out "the wrapper template is silently
 *      hashing the wrong thing" before trusting any constraint-count comparison built on it.
 *   2. Soundness of the equality check: a forged `expectedHash` (the one public input) must be
 *      REJECTED, not silently accepted — i.e. `expectedHash === h.out` is a real, binding
 *      constraint and not something the R1CS optimizer or a witness-generation quirk left
 *      satisfiable for an arbitrary public value.
 *
 * Requires build artifacts from scripts/bench/poseidon2-constraints.sh (wasm + zkey per circuit
 * under build/). Falls back to a skip message (not a failure) if they're absent, matching
 * circuits/test/withdraw.test.mjs's "hash-only fallback" spirit — except here, without a compiled
 * circuit there is nothing meaningful left to check, since the entire point is comparing compiled
 * R1CS/witness behaviour.
 *
 * Run: node --experimental-vm-modules test/poseidon2.test.mjs
 */
import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

function artifacts(name) {
  return {
    wasm: join(BUILD_DIR, `${name}_js`, `${name}.wasm`),
    zkey: join(BUILD_DIR, `${name}_final.zkey`),
    vk: join(BUILD_DIR, `${name}_vk.json`),
  };
}

async function proveAndVerify(vk, wasm, zkey, inputs) {
  const stringInputs = {};
  for (const [k, v] of Object.entries(inputs)) {
    stringInputs[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringInputs, wasm, zkey);
  const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  return valid;
}

async function assertRejected(wasm, zkey, inputs, label) {
  let threw = false;
  try {
    await snarkjs.groth16.fullProve(
      { in: inputs.in.map((x) => x.toString()), expectedHash: inputs.expectedHash.toString() },
      wasm,
      zkey,
    );
  } catch {
    threw = true;
  }
  assert(threw, `${label}: proof generation must fail for a forged expectedHash`);
}

function poseidon2Hash(t, ins) {
  const state = [0n, ...ins];
  return bn254[`t${t}`].permutation(state)[0];
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toBI = (v) => (typeof v === "bigint" ? v : F.toObject(v));

  const CASES = [
    { name: "main_poseidon_t3", inputs: [11n, 22n], expected: (ins) => toBI(poseidon(ins)) },
    { name: "main_poseidon2_t3", inputs: [11n, 22n], expected: (ins) => poseidon2Hash(3, ins) },
    { name: "main_poseidon_t4", inputs: [11n, 22n, 33n], expected: (ins) => toBI(poseidon(ins)) },
    { name: "main_poseidon2_t4", inputs: [11n, 22n, 33n], expected: (ins) => poseidon2Hash(4, ins) },
  ];

  for (const c of CASES) {
    const { wasm, zkey, vk } = artifacts(c.name);
    if (!existsSync(wasm) || !existsSync(zkey)) {
      console.log(`[SKIP] ${c.name}: build artifacts not found — run scripts/bench/poseidon2-constraints.sh first`);
      continue;
    }
    const vkJson = JSON.parse(await (await import("fs/promises")).readFile(vk, "utf8"));
    const expectedHash = c.expected(c.inputs);

    await test(`${c.name}: correct witness proves and verifies (matches independent JS reference)`, async () => {
      const valid = await proveAndVerify(vkJson, wasm, zkey, { in: c.inputs, expectedHash });
      assert(valid, `${c.name}: Groth16 proof must verify`);
    });

    await test(`${c.name}: forged expectedHash (+1) is rejected`, async () => {
      await assertRejected(wasm, zkey, { in: c.inputs, expectedHash: expectedHash + 1n }, c.name);
    });

    await test(`${c.name}: forged expectedHash (0) is rejected`, async () => {
      await assertRejected(wasm, zkey, { in: c.inputs, expectedHash: 0n }, c.name);
    });
  }

  // Cross-check: the two "Poseidon2" JS reference calls above (via @taceo/poseidon2) must
  // themselves differ from circomlibjs's Poseidon for the same inputs — if the reference
  // implementations always agreed there'd be no experiment here, and it would suggest one of
  // them is accidentally computing the other function.
  await test("Poseidon and Poseidon2 reference implementations disagree on the same inputs (sanity check)", async () => {
    const a = toBI(poseidon([11n, 22n]));
    const b = poseidon2Hash(3, [11n, 22n]);
    assert(a !== b, "Poseidon and Poseidon2 must not compute the same function");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
