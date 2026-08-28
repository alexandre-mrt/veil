# Poseidon2 as the Merkle-node hash

## Hypothesis

Swapping `transfer.circom`'s and `compliance.circom`'s depth-20 Merkle inclusion
proof from circomlib's Poseidon (sponge) node hash to a Poseidon2-compression node
hash reduces each circuit's R1CS constraint count by at least 5% and its Node.js
Groth16 proving time by a measurable amount, with no other circuit behavior
changed.

## Threat / privacy model

This is **not** a change to what is proved or to what is public — `merkleRoot`,
`oldCommitment`/leaf, and every other public signal keep the same meaning and the
same 128-byte compressed on-chain proof size (Groth16 proof size is independent of
the circuit's internal constraint count or hash choice). It only changes how the
private witness computes one intermediate value (the Merkle node hash) inside an
already zero-knowledge circuit.

**Chain observer** (anyone reading the pool's on-chain state and transaction
history): sees the same things as today — a `merkleRoot` field element per
membership proof, a nullifier, a Groth16 proof. They cannot distinguish "this root
was computed with Poseidon1 nodes" from "this root was computed with Poseidon2
nodes" from the public data alone; the circuit's chosen VK implicitly fixes which
hash is in use, same as today. **No new information is leaked to this adversary.**

**Malicious prover**: unaffected by this change in the way that matters for
soundness — Groth16's proof-of-satisfiability guarantee is orthogonal to which
hash function the constraints happen to encode. The relevant new soundness
question is narrower: *is the Poseidon2-compression node hash itself as hard to
find a second preimage or collision for as the Poseidon1 sponge it replaces?* See
Approach/soundness below.

**What this does NOT defend against (residual surface, unchanged)**: RR2 (dev-only
single-contributor trusted setup — a production swap would need its own new
ceremony contribution, timelocked VK update, same as any VK change); RR5
(deposit-commitment linkability — this changes proving cost, not anonymity-set
size or deposit visibility); the four Poseidon(4)/(5) domain-tagged hashes
(commitment, nullifier, credential leaf) are **not** touched by this experiment —
see Approach for why, and Open questions for what closing that gap would take.

**Assumptions**: BN254 discrete-log hardness (unchanged — Groth16 itself).
Poseidon2's t=2 permutation over the BN254 scalar field targets the same security
margin as Poseidon1's HADES-based design (see soundness argument below) — I did
not independently re-derive or re-audit the round-constant/security-margin
computation myself; I cross-checked the *compiled circuit's output* against an
independently-published reference implementation for known inputs (Results,
below), which catches an integration bug but is not a substitute for an
independent cryptographic audit of the parameter generation. **STRIDE mapping**:
this experiment does not close or worsen any row in `docs/threat-model.md` — it
is a pure performance change to an Information Disclosure control (S2/membership
proof) that was already sound.

## Approach

**What was built.** A parallel, explicitly non-production Merkle template,
`circuits/templates/merkle_proof_poseidon2.circom` — same interface and
left/right `MultiMux1` selection logic as the production
`templates/merkle_proof.circom`, with the node hash replaced by a 2-to-1
compression built on the Poseidon2 permutation from `@taceo/circom-lib`
(`t=2`, pulled by that library from the audited `TaceoLabs/oprf-circom` repo):

```
node = Poseidon2Perm(t=2)([left, right])[0] + left    // Miyaguchi–Preneel feedforward
```

This is the same "compression mode" construction `@taceo/circom-lib`'s own
`binary_merkle_root.circom` uses (adapted from zk-kit's binary Merkle root
circuit). Five circuits under `circuits/experiments/` use it for measurement only
— **none are included by, or wired into, any production file, `contracts/`,
`scripts/src/`, or `frontend/`**:

- `merkle20_poseidon1.circom` / `merkle20_poseidon2.circom` — the depth-20 Merkle
  sub-circuit in isolation, old vs new hash, to measure the swap's own cost
  independent of everything else in `transfer.circom`.
- `transfer_poseidon2.circom` / `compliance_poseidon2.circom` — byte-for-byte
  clones of the production circuits with *only* the Merkle-node hash swapped, for
  an end-to-end constraint and proving-time delta.
- `poseidon2_perm_t2.circom` and `merkle_membership_poseidon2.circom` — smaller
  circuits used for the correctness/negative-test suite (below).

**Alternatives rejected before building this:**

1. **Hand-derive Poseidon2 parameters for t=5/6** (the widths `Poseidon(4)` and
   `Poseidon(5)` actually use for commitment/nullifier/credential-leaf hashing —
   the majority of each circuit's non-linear constraints). Rejected: no audited
   public Poseidon2 parameter set exists at those widths (`@taceo/circom-lib` and
   `@zkpassport/poseidon2` both stop at t=4, then jump to t=8/12/16 — sized for
   sponge absorption of many field elements at once, not narrow fixed-arity
   domain-tagged hashes). Re-deriving round constants and re-verifying the
   algebraic security margin (Gröbner-basis/interpolation attack bounds) for a
   new width is real cryptographic research, not a parameter tweak — not
   something to do casually inside one night's experiment. This is why the
   swap here is scoped to the arity-2 Merkle-node hash only, where audited
   parameters already exist.
2. **`@taceo/circom-lib`'s `binary_merkle_root.circom` directly**, instead of a
   new static-depth template. Rejected: it supports a *dynamic* depth up to a
   `MAX_DEPTH` parameter via per-level `IsEqual` selectors, which Veil doesn't
   need (`MerkleProof(20)`/`MerkleProof(merkleDepth)` are fixed at compile time)
   and which would have added constraints unrelated to the hash swap itself,
   understating Poseidon2's real per-level saving in a fixed-depth comparison.
3. **Swapping the production circuits directly.** Rejected: the Merkle root's
   meaning would change (a different node hash produces a different root for the
   same tree contents), which is a breaking change requiring synchronized updates
   to the off-chain tree builders (`frontend/src/lib/merkle-tree.ts`,
   `scripts/src/compliance-utils.ts`), a new VK behind the existing 1-epoch
   timelock, and a migration path for already-deposited commitments — none of
   which are in this PR. Landing it in the production files without that would
   leave the system either broken or silently inconsistent.

**Correctness verification.** The Poseidon2 permutation used here comes from an
already-published, independently-implemented library — it was not hand-rolled —
but the *circuit's* use of it (wiring, compression formula, integration into the
Merkle template) still needed checking against something outside the circuit
itself. `experiments/poseidon2-merkle.test.mjs` cross-checks the compiled
circuit's witness output against `@taceo/poseidon2` (the same organization's
published JS reference implementation, a separate codebase from the circom
library) for known permutation inputs, and includes negative tests that a
tampered witness is rejected (see Results).

## Results

### Constraint counts (`snarkjs r1cs info`, raw output below)

| Circuit | R1CS constraints | Non-linear | Linear | Wires |
|---|---|---|---|---|
| `transfer.circom` (production, baseline) | 13,611 | 6,470 | 7,141 | 13,632 |
| `experiments/transfer_poseidon2.circom` | **12,951** | 5,930 | 7,021 | 12,972 |
| **Delta** | **−660 (−4.85%)** | −540 (−8.35%) | −120 (−1.68%) | −660 |
| `compliance.circom` (production, baseline) | 12,743 | 6,057 | 6,686 | 12,762 |
| `experiments/compliance_poseidon2.circom` | **12,083** | 5,517 | 6,566 | 12,102 |
| **Delta** | **−660 (−5.18%)** | −540 (−8.92%) | −120 (−1.80%) | −660 |
| `merkle20_poseidon1.circom` (isolated, 20 levels) | 10,400 | 4,920 | 5,480 | 10,422 |
| `merkle20_poseidon2.circom` (isolated, 20 levels) | **9,740** | 4,380 | 5,360 | 9,762 |
| **Delta** | **−660 (−6.35%)** | −540 (−10.98%) | −120 (−2.19%) | −660 |

The delta is identical (−660 total constraints) across all three comparisons
because each production circuit contains exactly one `MerkleProof(20)` instance —
the entire saving is the Merkle sub-circuit's own, cleanly isolated by the
`merkle20_*` pair.

Raw output:

```
$ npx snarkjs r1cs info build/transfer.r1cs
Curve: bn-128
# of Wires: 13632
# of Constraints: 13611
# of Private Inputs: 47
# of Public Inputs: 7

$ npx snarkjs r1cs info build-experiments/transfer-p2/transfer_poseidon2.r1cs
Curve: bn-128
# of Wires: 12972
# of Constraints: 12951
# of Private Inputs: 47
# of Public Inputs: 7

$ npx snarkjs r1cs info build-experiments/compliance-p2/compliance_poseidon2.r1cs
Curve: bn-128
# of Wires: 12102
# of Constraints: 12083
# of Private Inputs: 45
# of Public Inputs: 6

$ npx snarkjs r1cs info build-experiments/merkle20-p1/merkle20_poseidon1.r1cs
Curve: bn-128
# of Wires: 10422
# of Constraints: 10400

$ npx snarkjs r1cs info build-experiments/merkle20-p2/merkle20_poseidon2.r1cs
Curve: bn-128
# of Wires: 9762
# of Constraints: 9740
```

(circom compile output for the same builds independently confirms the same
non-linear/linear split — e.g. `transfer.circom`: `non-linear constraints: 6470,
linear constraints: 7141`, matching `BASELINE.md` exactly, which is also how the
toolchain substitution below was validated.)

### Artifact size (Groth16 zkey / vk, transfer only)

| | zkey (bytes) | vk (bytes) |
|---|---|---|
| `transfer.circom` | 6,001,433 | 4,024 |
| `transfer_poseidon2.circom` | 5,742,713 | 4,019 |
| Delta | −258,720 (−4.31%) | −5 |

### Proving time — Node.js (mean of 20 runs, `transfer` only)

```
$ node scripts/bench/poseidon2-merkle-latency.mjs --runs 20
=== Poseidon2-Merkle proving-time benchmark (20 runs per circuit) ===
node v22.22.2, linux/x64

transfer.circom (Poseidon Merkle, production): mean 748.8 ms (sigma 80.3, n=20)
transfer_poseidon2.circom (Poseidon2 Merkle, experimental): mean 695.8 ms (sigma 25.6, n=20)
```

**−53.0 ms mean (−7.1%).** The baseline mean (748.8 ms) lines up closely with
`BASELINE.md`'s independently-measured 751.9 ms for the same circuit, but this
run's variance (σ 80.3) is far higher than `BASELINE.md`'s (σ 17.3) — this
container's CPU is noisier than the machine `BASELINE.md` was measured on. The
Poseidon2 variant's own variance (σ 25.6) is close to `BASELINE.md`'s original
figure, which is some evidence the mean delta is real and not just noise, but
this should be treated as a directionally-confident, not tightly-bounded, number.
`compliance.circom`'s proving-time delta was **not** independently re-measured
(only its constraint count was) — see Open questions.

### Correctness + negative tests

```
$ node experiments/poseidon2-merkle.test.mjs
=== Poseidon2 Merkle-hash correctness + negative tests ===

  [PASS] P1: valid witness accepted, root matches independent JS re-implementation
  [PASS] P2: known-answer vector matches @taceo/poseidon2 reference permutation directly
ERROR:  4 Error in template MerkleMembershipPoseidon2_11 line: 23
  [PASS] N1: tampered sibling (wrong pathElements[5]) is rejected
ERROR:  4 Error in template MerkleMembershipPoseidon2_11 line: 23
  [PASS] N2: tampered leaf (different leaf, same path/root) is rejected
ERROR:  4 Error in template MerkleProofPoseidon2_10 line: 36
Error in template MerkleMembershipPoseidon2_11 line: 21
  [PASS] N3: out-of-range pathIndices bit (2 instead of 0/1) is rejected
ERROR:  4 Error in template MerkleMembershipPoseidon2_11 line: 23
  [PASS] N4: forged root without a valid path (random expectedRoot) is rejected

6 passed, 0 failed
```

The `ERROR: 4` lines are `circom_runtime`'s own constraint-violation output
(not a test-harness failure) — each is the underlying `assert_equal`/boolean
constraint actually rejecting the tampered witness at witness-generation time,
before a proof would even be attempted. N3 in particular fails at *two*
constraints simultaneously (the template's own `pathIndices[i] * (1 -
pathIndices[i]) === 0` boolean check, line 36, and the downstream root-equality
check, line 21) — the boolean-range check on the path-index bit is doing real
work, not redundant with the equality check alone.

### Test suite (run in full; nothing here touches production circuits)

- `circuits`: `node test/transfer.test.mjs` — **43/43 passed** (full-proof mode,
  since `build/transfer_final.zkey` from this experiment's setup happens to
  satisfy `FULL_PROOF_AVAILABLE`); `node test/compliance.test.mjs` — **30/30**;
  `node test/withdraw.test.mjs` — **35/35** (hash-only mode, no
  `build-compliance`/`build-withdraw` artifacts built this run — not needed,
  those circuits are untouched).
- `frontend`: `bun run lint` (biome) — clean; `bun run test` (vitest) —
  **19/19 passed**.
- `scripts` (root, not `scripts/bench`): `bun run test` —
  **109/109 passed**.
- `contracts` (Move): **NOT RUN** — same blocker as `BASELINE.md`, see below.
  No contract code touched this session.

### Toolchain note

No `circom` binary available or buildable this session — `sui`'s and `circom`'s
own upstream GitHub repos are both blocked at the network-policy layer (`curl` to
`github.com` and `fullnode.testnet.sui.io` both return a `403` from the proxy
gateway itself, confirmed via `$HTTPS_PROXY/__agentproxy/status`, not a
tool-approval prompt this time — a third, distinct reason item 1 in
`EXPERIMENTS.md` is still blocked). Used `circom2` (npm, WASM build of circom
2.2.3) instead. Validated it produces identical output to the toolchain
`BASELINE.md` used (circom 2.2.2 built from source) by recompiling
`transfer.circom` unmodified and confirming an exact match: `non-linear
constraints: 6470, linear constraints: 7141, wires: 13632` — identical to
`BASELINE.md`'s recorded figures.

## Verdict: **PARK**

The saving is real and consistently measured (≈5–11% fewer constraints, ≈7%
faster Node proving on the affected circuits) but landing it in production needs
work well beyond one night:

1. **Off-chain tree-builder migration.** `frontend/src/lib/merkle-tree.ts` and
   `scripts/src/compliance-utils.ts` both build the Merkle tree client-side using
   circomlibjs's Poseidon(2) — they'd need to switch to the same Poseidon2
   compression, in lockstep with the circuit, or proofs would fail against a root
   computed with the wrong hash.
2. **A new VK, through the existing timelock.** `pool.move` verifies against a
   VK that's timelocked on update (README, `docs/threat-model.md` asset #4) — a
   different circuit means a different VK, which means a real production
   ceremony contribution (not the dev-only single-contributor setup used to
   produce tonight's numbers), not just a code change.
3. **A migration path for already-deposited commitments.** The existing Merkle
   tree's root only means anything under the *old* hash — there's no way to
   "reinterpret" it under Poseidon2. This isn't a Veil-specific problem tonight;
   it's true of any hash-function swap on a live accumulator.
4. **It only covers the Merkle-node hash.** The four domain-tagged
   `Poseidon(4)`/`Poseidon(5)` calls (commitment, nullifier, credential leaf) —
   which together outweigh the Merkle sub-circuit's own constraint count in both
   `transfer.circom` and `compliance.circom` — are untouched, for the reason in
   Approach (no audited Poseidon2 parameters at those widths).

**PARK, blocked on**: (a) a decision on whether the off-chain/on-chain migration
cost above is worth ~5–7% for a Merkle-node-only swap, weighed against item 4 in
`EXPERIMENTS.md` (Merkle accumulator at scale) — a deeper tree would amplify this
same per-level saving, which may change that calculus; and (b) resolving whether
the untouched arity-4/5 hashes are worth restructuring into chained arity-2
Poseidon2 compressions (Open questions, below) before committing to a single
migration.

## Where this could be used

Beyond Veil: any circom + Groth16/PLONK circuit on BN254 doing Merkle-membership
proofs where the tree's internal node hash is a free implementation choice, not
already fixed by an external protocol — Tornado-Cash-style mixers,
Semaphore/zk-kit-based anonymous signaling or voting (zk-kit's own
`binary-merkle-root` circuit is the unmodified base `@taceo/circom-lib` adapted
from), privacy-preserving allowlist/credential systems structurally identical to
Veil's compliance tree (the "confidential payroll on Sui with a t-of-n auditor
board" use case from the 2026-07-22 report has exactly this shape: a
medium-depth, high-proof-volume credential tree), and rollup/L2 state-commitment
trees already paying a Poseidon-per-level cost at scale, where a 5–11%
per-level cut compounds across a high proof volume. Thesis-chapter framing: a
chapter quantifying the crossover point between hand-deriving wider Poseidon2
parameters for arity>4 leaf/commitment hashes versus restructuring them into
chained arity-2 compressions to stay within already-audited parameter sets —
tonight's numbers are one data point (arity-2 in isolation) toward that
comparison, not the full answer (Open questions below).

## Open questions

1. What is the isolated per-instance constraint cost of a single
   `Poseidon(4)`/`Poseidon(5)` call at the widths Veil actually uses? Needed to
   tell whether chaining 2–3 sequential Poseidon2 compressions (t=2, audited) to
   replace one wide `Poseidon(4)`/`Poseidon(5)` call (t=5/6, no audited Poseidon2
   parameters) would be a net win or a net loss — not measured tonight.
2. Concretely, what does the off-chain migration in `scripts/src/compliance-utils.ts`
   and `frontend/src/lib/merkle-tree.ts` look like, and what's the
   already-deposited-commitments migration path (a proof-and-rebuild window vs. a
   pool redeploy)?
3. Does `compliance.circom`'s proving-time delta actually match `transfer.circom`'s
   ~7%, or does its different public/private input mix change that? Not
   independently measured tonight (only its constraint count was).
4. Is the swap worth doing on its own, or should it wait and be bundled with
   EXPERIMENTS.md item 4 (Merkle accumulator at scale), where a deeper tree would
   make the same per-level saving larger in absolute terms?
5. The network-policy block on `fullnode.testnet.sui.io` and `github.com` (this
   run's `/__agentproxy/status` shows an explicit `403`/`connect_rejected`, not a
   missing binary) is now the reason item 1 (on-chain gas) has failed three
   nights running for three different causes. Worth the user's explicit call on
   whether a scoped allowlist exception for one public Sui fullnode RPC endpoint
   is something to grant — building `sui` from source inside a single night's
   budget is not realistic (large Rust workspace, no warm build cache in this
   container).
