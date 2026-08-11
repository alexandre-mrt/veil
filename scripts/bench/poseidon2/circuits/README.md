# Isolated measurement circuits (NOT production)

Each file here instantiates exactly one component so its R1CS cost can be measured in
isolation with `circom --r1cs` + `snarkjs r1cs info`. None of these ship; production
circuits (`circuits/*.circom`) are untouched by this experiment.

- `c_*.circom` — components Veil's production circuits actually use (circomlib Poseidon
  at the arities called in `transfer.circom` / `compliance.circom` / `withdraw.circom`,
  the production `MerkleProof` template, and the range-check/comparator components).
- `p2_*.circom` — Poseidon2 (t=3, BN254) equivalents from `../vendor/` (bkomuves/hash-circuits,
  MIT): the bare permutation, the 2-to-1 Merkle compression, sponge hashes at the input
  widths Veil uses (capacity 1 = same 128-bit level as circomlib Poseidon; capacity 2 =
  upstream default), and a depth-20 Merkle path verifier that mirrors
  `circuits/templates/merkle_proof.circom` with `Compression()` swapped in.

Compile + measure: `node scripts/bench/poseidon2/constraint-costs.mjs`
Prove head-to-head: `node scripts/bench/poseidon2/merkle-prove-latency.mjs --runs 10`
