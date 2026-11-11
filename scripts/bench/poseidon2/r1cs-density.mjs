/**
 * r1cs-density.mjs <file.r1cs>... — constraint count AND non-zero coefficient count (A, B, C).
 * Groth16 prover work scales with non-zeros (witness-to-QAP evaluation) and wires (MSMs), not
 * with the constraint count alone; this is the number that explains equal-constraint/unequal-time.
 */
import { readR1cs } from "r1csfile";
for (const f of process.argv.slice(2)) {
  const r = await readR1cs(f, { loadConstraints: true, loadMap: false });
  let a = 0, b = 0, c = 0;
  for (const [A, B, C] of r.constraints) { a += Object.keys(A).length; b += Object.keys(B).length; c += Object.keys(C).length; }
  console.log(`${f.split("/research/")[1].padEnd(30)} constraints ${String(r.nConstraints).padStart(6)}  nnz A ${String(a).padStart(7)}  B ${String(b).padStart(6)}  C ${String(c).padStart(6)}  total ${String(a + b + c).padStart(7)}`);
}
process.exit(0);
