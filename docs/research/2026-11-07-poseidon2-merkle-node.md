# 2026-11-07 — Poseidon2 as the Merkle node hash (queue item #2)

**Verdict: REJECT.** The branch and `scripts/bench/poseidon2/` stay; nothing in `circuits/`,
`contracts/` or `frontend/` was modified.

## Hypothesis

Replacing circomlib `Poseidon(2)` with Poseidon2 (t=3, x⁵, R_F=8, R_P=56, BN254) as the 2-to-1
Merkle node hash in `merkle_proof.circom` reduces `transfer.circom`'s total R1CS constraints and its
Node Groth16 proving time by ≥ 5 %. The Merkle path is 20 × `Poseidon(2)` ≈ 4,860 of transfer's
6,470 non-linear constraints (75 %), so this is where a cheaper permutation would pay off.

**Falsified.** Non-linear constraints fell 0.9 %, total constraints *rose* 9.3 %, proving time did not
change measurably.

## Tonight's other finding: gas is blocked a third time

Queue #1 (on-chain gas) was attempted first, as the queue asked. `github.com/MystenLabs/sui/releases`
and `fullnode.testnet.sui.io:443` both return **403 from the sandbox egress proxy** (`curl` output:
`403` / `CONNECT tunnel failed, response 403`; proxy status lists `fullnode.testnet.sui.io:443` under
`recentRelayFailures`). Building circom from a cloned source tree was also refused by the tool-approval
layer, so the circuit toolchain came from the npm registry instead (`circom2` 0.2.23, compiler
2.2.3), which is reachable. That compiler reproduces the 2026-07-22 baseline constraint counts exactly
(see the baseline rows in Results). Gas needs an owner action — see Open questions.

## Threat / privacy model

No new adversary is introduced; this experiment asks whether a cheaper hash could be swapped in
without weakening anything.

- **Adversary in scope:** a malicious prover trying to forge membership of a commitment in the
  depth-20 tree (tampering), and a chain observer trying to link a spend to a leaf. Both depend only
  on the Merkle hash being collision- and preimage-resistant and the circuit constraining the path.
  The variant keeps every constraint of `MerkleProof` (boolean path index, mux, hash chain,
  `merkleRoot === root`); only the permutation inside the node hash differs.
- **Leakage:** none new. Public inputs are unchanged (`merkleRoot` is still the only tree-derived
  public value). A chain observer learns nothing it did not before.
- **Not defended / residual:** Poseidon2 (2023) has far less public cryptanalysis than Poseidon
  (2019); the instance used here is the HorizenLabs BN254 t=3 reference, not a parameter set
  Veil has audited. The Merkle hash is also *not* the only Poseidon use (commitments, nullifiers,
  tx-amount hash are Poseidon(3–5), t=4–6) and **no standardised Poseidon2 instance exists for
  t=5**, so the experiment could only swap the t=3 node hash, not the whole circuit.
- **Assumptions:** same Groth16 trusted setup as today (dev-only, RR2 in `docs/threat-model.md`);
  hash security of Poseidon2 at the stated round counts.
- **STRIDE mapping:** Tampering (forged membership proof / root); Information Disclosure unaffected;
  RR2 unaffected.
- **Deployment note:** `contracts/sources` contains no Poseidon call (`grep -rn poseidon contracts/sources`
  returns nothing) — the root is supplied off-chain, so a node-hash swap would not need a Move
  Poseidon2. It would still force the frontend `merkle-tree.ts`, indexer and seed scripts to change in
  lock-step, and invalidate every existing commitment tree.

## Approach

Built (all under `scripts/bench/poseidon2/`):

- `poseidon2.mjs` — BigInt reference implementation; **passes the HorizenLabs BN254 known-answer
  vector** `perm([0,1,2])` (raw output below).
- `gen.mjs` — emits a Poseidon2-t=3 circom template (constants from the HorizenLabs
  instance, saved with provenance in `constants-bn254-t3.json`) and variants of `merkle_proof.circom`
  / `transfer` / `compliance` whose *only* diff is the node hash. Production circuits untouched.
- `run.sh` → `setup-keys.sh` → `compare.mjs` — compile, dev-only Groth16 keys on a locally generated
  pot15, N proofs, snarkjs verification, and two negative tests.

Rejected before building: (a) Poseidon2 for all hashes — blocked, no t=5 instance, hand-deriving
constants would be an unaudited parameter set; (b) Poseidon2 t=4 sponge for the 4-input hashes —
4 inputs at rate 3 need two permutations, strictly worse; (c) custom partial-round reduction —
changes the security margin, out of scope for a cost experiment.

## Results

| Metric | Baseline | Poseidon2 node hash | Δ |
|---|---|---|---|
| Single node hash, non-linear | 243 | 240 | −3 |
| Single node hash, linear | 274 | 340 | +66 |
| `transfer` non-linear | 6,470 | 6,410 | −60 (−0.9 %) |
| `transfer` total constraints | 13,611 | 14,871 | **+1,260 (+9.3 %)** |
| `compliance` total constraints | 12,743 | 14,003 | +1,260 (+9.9 %) |
| `transfer` zkey bytes | 6,001,417 | 6,399,337 | +6.6 % |
| `transfer` Node prove ms (mean, n=10) | 749.4 (σ 33.8) | 741.4 (σ 27.2) | −1.1 %, within noise |
| `compliance` Node prove ms (mean, n=10) | 741.8 (σ 17.3) | 730.9 (σ 28.4) | −1.5 %, within noise |

A first, independent full run gave the same constraints and proving times of 741.9 / 758.0 ms
(transfer) and 724.1 / 720.1 ms (compliance): the sign of the difference flips between runs, so there
is **no measurable proving-time effect**. Baseline reproduces `BASELINE.md` (751.9 ms transfer).

Why: an x⁵ S-box costs 3 R1CS constraints either way and both hashes have 80 S-boxes (8×3 + 56), so
non-linear cost is equal. Poseidon2's cheaper linear layers help native and Plonkish/AIR provers; in
R1CS linear combinations are free in principle, yet the measured linear count still rose by 66 per
hash (I did not isolate the cause; the extra mixing structure surviving simplification is the likely
suspect, untested). Both variants sit in the same 2¹⁴ FFT domain (≤ 16,384), so FFT cost is identical and
the extra ~1,260 wires are a small share of MSM work.

Negative tests (both circuits, both variants; all `true` below): a wrong `merkleRoot`, and a valid-boolean
but wrong `pathIndices` bit, are each rejected at witness generation (the `ERROR: Error in template
Transfer/Compliance … line` lines in the raw output are those rejections). Valid proofs verify.

Reproduce: `bash scripts/bench/poseidon2/run.sh 10`.

### Raw output (second, from-scratch run)

```
KAT: PASS (matches HorizenLabs reference vector)
== hash_circomlib2   non-linear constraints: 243  linear constraints: 274  wires: 520
== hash_poseidon2    non-linear constraints: 240  linear constraints: 340  wires: 583
== transfer          non-linear constraints: 6410 linear constraints: 8461 wires: 14892
== compliance        non-linear constraints: 5997 linear constraints: 8006 wires: 14022
== withdraw          non-linear constraints: 1465 linear constraints: 1593 wires: 3058
{"circuit":"transfer","variant":"baseline","constraints":13611,"wires":13632,"zkeyBytes":6001417,"verifies":true,"rejectsBadRoot":true,"rejectsBadPath":true,"proveMs":749.4,"sdMs":33.8,"runs":10}
{"circuit":"transfer","variant":"poseidon2-merkle","constraints":14871,"wires":14892,"zkeyBytes":6399337,"verifies":true,"rejectsBadRoot":true,"rejectsBadPath":true,"proveMs":741.4,"sdMs":27.2,"runs":10}
{"circuit":"compliance","variant":"baseline","constraints":12743,"wires":12762,"zkeyBytes":5682141,"verifies":true,"rejectsBadRoot":true,"rejectsBadPath":true,"proveMs":741.8,"sdMs":17.3,"runs":10}
{"circuit":"compliance","variant":"poseidon2-merkle","constraints":14003,"wires":14022,"zkeyBytes":6080061,"verifies":true,"rejectsBadRoot":true,"rejectsBadPath":true,"proveMs":730.9,"sdMs":28.4,"runs":10}
```

KAT vector: `perm([0,1,2])` = `0x0bb61d24…3033, 0x303b6f7c…3570, 0x1ed25194…6ec8` (full values in `poseidon2.mjs` output).

Caveats: single machine (4 cores), dev-only ptau generated locally, Node only (no browser run), one
t=3 instance. Circuits were measured with circom2 compiler 2.2.3, not the 2.2.2 binary used on
2026-07-22; the constraint counts match exactly.

The existing circuit/Move test suites were **not** re-run: no production file changed
(`git diff` against the branch base touches only `.gitignore`, docs and `scripts/bench/poseidon2/`),
and there is no `CLAUDE.md` in this checkout to define "the full suite".

## Verdict

**REJECT.** Poseidon2 does not pay for itself in a Groth16/R1CS circuit: same S-box count, +9 % total
constraints, no proving-time gain. It would also force a flag-day tree rebuild across frontend, indexer
and scripts. Revisit only if Veil moves to a Plonkish/folding prover where linear layers cost
something. Keep the branch — the harness and constants are reusable.

## Where this could be used — beyond Veil

- A thesis-chapter datapoint: "arithmetization-friendly hash ≠ cheaper in every proof system"; the
  R1CS vs Plonkish cost split for Poseidon vs Poseidon2 is the argument for choosing the hash *after*
  the proof system.
- Any Circom/Groth16 deployment on a chain with a native Poseidon precompile (Sui, and similar
  verifiers) — e.g. a Semaphore-style group membership system or a Tornado-style note pool — should
  not expect a win from Poseidon2 and loses the native precompile.
- `scripts/bench/poseidon2/gen.mjs` is a drop-in template for evaluating other hash/arity swaps
  (Rescue, Anemoi, Griffin) in the same circuits.

## Open questions

1. Merkle depth is the real lever: 75 % of transfer's non-linear constraints are the 20-level path.
   What does depth 16 / 24 / 32 cost in proving time, and where does the 2¹⁴ → 2¹⁵ FFT-domain cliff
   fall (transfer is at 14,871 / 16,384)? → promoted to queue #1.
2. Can the 66 extra linear constraints per Poseidon2 hash be removed by a smarter partial-round
   encoding (fusing the internal matrix into the next S-box input)? Only matters for a non-R1CS prover.
3. On-chain gas: needs an owner to allow-list egress to the Sui release host or a testnet fullnode
   (or supply a `sui` binary in the environment image). Without that, gas stays unmeasured.
