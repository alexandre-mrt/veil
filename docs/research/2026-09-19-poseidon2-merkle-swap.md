# 2026-09-19 — Poseidon2 for the depth-20 Merkle-hash path (queue item #2)

## Hypothesis

Swapping circomlib's `Poseidon(2)` (used for the depth-20 Merkle-membership sibling hash in
`transfer.circom` and `compliance.circom`, and for `withdraw.circom`'s `recipientHash`) for
Poseidon2 — using the *published*, peer-reviewed BN254 parameter set (Grassi, Khovratovich,
Schofnegger, "Poseidon2: A Faster Version of the Poseidon Hash Function",
[eprint.iacr.org/2023/323](https://eprint.iacr.org/2023/323), reference implementation
[github.com/HorizenLabs/poseidon2](https://github.com/HorizenLabs/poseidon2)) — measurably reduces
R1CS constraint count and Groth16 proving time for `transfer.circom` and `compliance.circom`, the
two circuits where this hash is called 20 times per proof (once per Merkle-tree level).

This is queue item #2, ranked directly behind the (still-blocked) on-chain gas measurement — see
"What I tried first" below for why this run went to #2 instead.

## What I tried first: unblocking on-chain gas (queue item #1)

Before starting the Poseidon2 work, per `EXPERIMENTS.md`'s note to spend an early part of this run
on unblocking the toolchain, I re-checked both paths that failed on 2026-07-22:

- **Direct JSON-RPC read against the deployed testnet package.** `fullnode.testnet.sui.io:443` is
  denied by the execution sandbox's network proxy with a hard `403` (`connect_rejected`, "gateway
  answered 403 to CONNECT — policy denial"), not the softer per-call tool-approval denial the last
  run hit. This is an organization-level egress policy, not a retryable permission prompt.
- **Building the `sui` CLI from source.** `cargo` and the `crates.io` index (via `index.crates.io`)
  are reachable — confirmed by successfully building `circom` v2.2.2 from source for this same
  session (see Approach). But `sui` itself is not a published crate (`cargo install sui` and
  variants all fail with "could not find `sui`"; `sui_cli`/`sui_client` on crates.io are unrelated
  placeholder reservations). Building it means compiling the full Sui workspace from
  `github.com/MystenLabs/sui` — GitHub API/releases access from this session is scoped to
  `alexandre-mrt/veil` only (`api.github.com` returns "GitHub access to this repository is not
  enabled for this session" for any other repo), so even fetching a prebuilt release asset is
  unavailable, and a full-workspace source build remains the multi-night effort the last run
  correctly judged it to be.

Conclusion: on-chain gas is genuinely still **BLOCKED**, for a documented, harder reason than last
time (an org-level network policy, not a one-off approval denial). It stays at the top of
`EXPERIMENTS.md`; unblocking it now needs either a policy exception for `fullnode.testnet.sui.io`,
a prebuilt `sui` binary reachable from an allowed host, or GitHub access widened beyond this repo.
I did not spend further budget re-trying the same blocked paths a third way — moved to the
next-ranked, tractable item instead.

## Threat / privacy model

**Adversary:** a chain observer watching Sui transaction data (the same adversary `docs/threat-model.md`
already models for I2/I4/I6 and RR5). They see: commitments, nullifiers, Merkle roots, Groth16
proof bytes, and public signals. They do **not** see: any private circuit input (amounts,
`userSecret`, Merkle authentication paths, the specific leaf a transfer's `oldCommitment` matches
against).

**What this experiment changes about that picture: nothing.** Swapping the internal hash function
used to build one Merkle level does not change which signals are public vs private — `merkleRoot`,
`nullifier`, `oldCommitment`/`newCommitment` are public before and after, and the Merkle
authentication path (`pathElements`, `pathIndices`) stays private before and after. A chain
observer learns exactly as much from a `transfer_poseidon2` proof as from a `transfer` proof: that
*some* commitment in the tree was spent, nothing about which one. The anonymity-set size (RR5) is
unchanged — same depth-20 tree, same accumulator design, only the sibling-hash function differs.

**What this does NOT defend against (residual surface, unchanged from today):** sender identity is
still visible (`PRIV-002`, README), deposit-to-commitment timing/amount correlation is still
possible (I4/RR5), and this experiment does nothing about the Sybil gap (E6) or the single-auditor
key (asset #6). None of those are in scope here.

**Assumptions.** Two, both new to this specific change:

1. **Poseidon2's algebraic security margin is sound at these parameters.** The BN254 instance used
   (`t=3`, `d=5`, RF=8, RP=56) is exactly the parameter set the reference implementation ships and
   the paper analyzes — not self-derived, not extrapolated to an untested width. This is a strictly
   *lower*-risk assumption than authoring new round constants, but it is still a different
   cryptanalysis history than circomlib's Poseidon (which has ~5 years of additional scrutiny that
   Poseidon2, published 2023, does not yet have).
2. **Groth16 + the existing dev-only trusted setup (RR2) carries over unchanged** — swapping the
   in-circuit hash function doesn't touch the proving system or the ceremony; a new circuit still
   needs its own `zkey` (a new circuit is a new statement), which this experiment generates the
   same dev-only way `compile.sh` already does, not a new production ceremony.

**Correctness hazard, not a privacy hazard, but worth stating precisely:** Poseidon2(t=3) and
circomlib's Poseidon(2) are different functions — for the same two inputs they produce different
outputs (checked directly, see Approach). This means the swap is **all-or-nothing per Merkle tree**:
every node in a given tree must be hashed with the same function, on-chain and off-chain, or
honest provers cannot reconstruct a path that matches the root. This is exactly what the negative
tests in "Approach" check for.

## Approach

**What I built:**

- `circuits/templates/poseidon2_bn254_t3.circom` — the Poseidon2 permutation over 3 BN254 field
  elements, and `Poseidon2Hash2to1`, a 2-to-1 compression wrapper matching the reference
  implementation's own `MerkleTreeHash::compress` convention (`permutation([a, b, 0])[0]`). Round
  constants and the external (`circ(2,1,1)`) / internal (`diag(1,1,2)+J`) linear-layer matrices are
  transcribed directly from `HorizenLabs/poseidon2`'s
  `plain_implementations/src/poseidon2/poseidon2_instance_bn256.rs` — nothing is self-derived.
- `circuits/templates/merkle_proof_poseidon2.circom` — `MerkleProofPoseidon2(depth)`, identical to
  the existing `MerkleProof(depth)` except the sibling hash is `Poseidon2Hash2to1` instead of
  circomlib's `Poseidon(2)`.
- `circuits/{transfer,compliance,withdraw}_poseidon2.circom` — byte-for-byte copies of the
  production circuits with exactly one substitution each (the Merkle-proof include/call for
  transfer and compliance; the `recipHash` component for withdraw). Diffed at authoring time to
  confirm nothing else changed (see the diffs below). **These are research circuits, not deployed**
  — the production `transfer.circom` / `compliance.circom` / `withdraw.circom` are untouched.
- `scripts/bench/poseidon2.mjs` — a JS port of the same permutation, for building test witnesses
  and bench inputs the same way `circomlibjs`'s `buildPoseidon()` is used for the production
  circuits. Validated against the reference implementation's own known-answer test before being
  used anywhere else (see "Validation" below).
- `circuits/test/poseidon2-merkle.test.mjs` — correctness tests (JS reference vs. compiled-circuit
  witness output) plus, per circuit, one accepted-witness test and 1–2 negative tests.
- `circuits/scripts/compile-poseidon2.sh` — reproducible build script for the three research
  circuits, matching the existing `compile*.sh` convention, with a documented local-ptau fallback
  (see "Toolchain gaps" below).

**Validation, before any circuit used these parameters for anything:**

```
$ cd /tmp && git clone --depth 1 https://github.com/HorizenLabs/poseidon2.git
$ cd poseidon2/plain_implementations && cargo test --release poseidon2_tests_bn256 -- --nocapture
running 2 tests
test poseidon2::poseidon2::poseidon2_tests_bn256::kats ... ok
test poseidon2::poseidon2::poseidon2_tests_bn256::consistent_perm ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 59 filtered out; finished in 0.00s
```

This confirms the reference implementation's own KAT (`permutation([0,1,2])` on the BN254 instance)
against its own hardcoded assertions — i.e. that the hex constants I was about to transcribe are
the ones the paper's authors actually ship and test. I then:

1. Ported the permutation to JS (`scripts/bench/poseidon2.mjs`) and checked it against the same KAT
   — first attempt silently produced wrong output because `JSON.parse` collapses 254-bit decimal
   integers to lossy `number` doubles before `BigInt()` sees them; fixed by keeping the round
   constants as strings through the JSON round-trip. Caught by the KAT mismatch, not by luck.
2. Wrote the circom template, compiled a standalone circuit exposing `Poseidon2Perm3` directly, and
   compared its witness output for input `[0,1,2]` against the same KAT:

```
$ circom scratch_test/kat_test.circom --r1cs --wasm -o scratch_test -l node_modules
non-linear constraints: 240
linear constraints: 275
$ node scratch_test/kat_test_js/generate_witness.cjs ... input.json witness.wtns
$ npx snarkjs wtns export json witness.wtns witness.json
# witness[1..3] (the 3 outputs), converted to hex:
0xbb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033
0x303b6f7c86d043bfcbcc80214f26a30277a15d3f74ca654992defe7ff8d03570
0x1ed25194542b12eef8617361c3ba7c52e660b145994427cc86296242cf766ec8
```

Matches the reference KAT exactly. Both the JS reference and the circom template are traced back to
the same audited source, not to each other — the JS port isn't "the circuit's own logic copied
twice," it's an independent transcription of the same published constants, and both were checked
against ground truth before being checked against each other.

**What I rejected:**

- **Self-deriving Poseidon2 parameters for `t=4`/`t=5`** (the widths circomlib's `Poseidon(3)` and
  `Poseidon(4)` actually run internally, used for `txAmountHash`, commitments, and nullifiers — the
  *other* three Poseidon call sites in these circuits). The reference implementation only publishes
  audited BN254 parameters for `t=3`. Generating fresh round constants for other widths means
  running the paper's own constant-generation script and getting the algebraic security margin
  right without an existing KAT to check against — a materially different, higher-risk task than
  transcribing published constants. Scoped out; flagged as a PARK candidate below, not attempted.
- **A full production swap** (replacing `MerkleProof` in the actual `transfer.circom` /
  `compliance.circom`, bumping the on-chain verifying key). Two reasons: first, the measured
  benefit turned out to be far smaller than the swap's complexity/audit cost would justify (see
  Results — decide this from numbers, not from doing the migration and hoping). Second, a
  production swap is a breaking change to every already-built Merkle tree (correctness hazard,
  above) and needs a real migration plan (rebuild the tree, or version the hash per sub-tree),
  which is out of scope for a hash-primitive experiment.
- **Wrapping the linear layers as separate circom components** (`Poseidon2ExternalLinear3`,
  `Poseidon2InternalLinear3`), my first working implementation. It compiled and passed the KAT, but
  cost 60 *more* linear R1CS constraints than the flat, `var`-accumulator version circomlib itself
  uses (component boundaries in circom can't be constraint-folded the way an inlined `var` linear
  combination can — see Results for the actual before/after numbers). Rewrote to match circomlib's
  own style (a `var lc` accumulator, one constraint per output element) before taking any
  measurement seriously; the first version's numbers would have understated Poseidon2's real
  potential and are not reported here.

**Toolchain gaps hit along the way:**

- `circom` was not installed. Cloned `iden3/circom` tag `v2.2.2` (same version the 2026-07-22
  baseline used) and built it with `cargo build --release` — `crates.io`'s index is reachable via
  `index.crates.io` (in the sandbox's proxy allowlist) even though `crates.io` itself and
  `storage.googleapis.com` (the pinned Powers-of-Tau host) are not. Installed to `/root/.cargo/bin/circom`.
- The pinned `pot15_final.ptau` (Hermez, hosted on `storage.googleapis.com`) is unreachable (`403`
  through the proxy, same policy as the Sui fullnode above). Generated a local dev Powers-of-Tau
  file instead: `snarkjs powersoftau new bn128 15` → one dev contribution → `prepare phase2`. This
  is cryptographically equivalent for benchmarking purposes (same curve, same power — proving time
  and constraint counts don't depend on which specific ptau ceremony output backs the setup) and is
  exactly as non-production as the existing `compile*.sh` scripts' single-contributor setup already
  is (RR2) — not a new risk, just a locally-sourced instance of the same already-accepted one.
  `powersoftau prepare phase2` for `2^15` took roughly 20 minutes of wall time on this machine —
  worth knowing for the next person who hits the same download block.
- Lost roughly 15 minutes of that step once, self-inflicted: I ran `rm -rf build` to clear stale
  circuit outputs while a `powersoftau prepare phase2` was still writing into the old `build/`
  directory. Linux let the process keep writing to the now-unlinked file, but the output could
  never be `ln`'d back into the tree (`/proc/<pid>/fd/N` hardlinking hit `Invalid cross-device
  link` in this sandbox), so I killed it and reran cleanly rather than racing the copy. Logged here
  so the compile script's comments warn against touching `build/` mid-ceremony.

## Results

### Constraint counts (real `circom` compile output, `--r1cs`)

Single-call comparison, the primitive in isolation (`Poseidon(2)` vs `Poseidon2Hash2to1`, both
internally a width-3 permutation):

| | Non-linear | Linear | Total | Wires |
|---|---|---|---|---|
| circomlib `Poseidon(2)` | 243 | 274 | 517 | 520 |
| `Poseidon2Hash2to1` (this experiment) | 240 | 275 | **515** | 518 |
| Delta | −3 | +1 | **−2 (−0.4%)** | −2 |

Full circuits (production vs. the `*_poseidon2` research variant — every other constraint is
identical, confirmed by diffing the `.circom` source before compiling):

| Circuit | Non-linear (before → after) | Linear (before → after) | Total (before → after) | Delta |
|---|---|---|---|---|
| `transfer.circom` (20 Merkle-hash calls) | 6,470 → 6,410 | 7,141 → 7,161 | 13,611 → 13,571 | **−40 (−0.29%)** |
| `compliance.circom` (20 Merkle-hash calls) | 6,057 → 5,997 | 6,686 → 6,706 | 12,743 → 12,703 | **−40 (−0.31%)** |
| `withdraw.circom` (1 recipientHash call) | 1,465 → 1,462 | 1,593 → 1,594 | 3,058 → 3,056 | **−2 (−0.07%)** |

Raw compiler output:

```
$ circom transfer.circom --r1cs --wasm --sym -o build -l node_modules
non-linear constraints: 6470
linear constraints: 7141
wires: 13632
$ circom transfer_poseidon2.circom --r1cs --wasm --sym -o build -l node_modules
non-linear constraints: 6410
linear constraints: 7161
wires: 13592

$ circom compliance.circom --r1cs --wasm --sym -o build -l node_modules
non-linear constraints: 6057
linear constraints: 6686
wires: 12762
$ circom compliance_poseidon2.circom --r1cs --wasm --sym -o build -l node_modules
non-linear constraints: 5997
linear constraints: 6706
wires: 12722

$ circom withdraw.circom --r1cs --wasm --sym -o build -l node_modules
non-linear constraints: 1465
linear constraints: 1593
wires: 3058
$ circom withdraw_poseidon2.circom --r1cs --wasm --sym -o build -l node_modules
non-linear constraints: 1462
linear constraints: 1594
wires: 3056
```

Every one of the 20 Merkle-hash calls in `transfer`/`compliance` saves exactly 2 total constraints
(40 ÷ 20), matching the single-call delta above exactly — internally consistent, not noise.

**This is a real but small number, and it contradicts the naive read of the Poseidon2 paper's
headline claims.** The paper's biggest reported gains come from two structural changes: (1) the
full-round linear layer becomes free (additions only, no field multiplications) instead of a dense
random MDS matrix, and (2) partial rounds use a cheaper structured matrix. circomlib's existing
`Poseidon(2)` implementation, however, is *already* heavily optimized — the whitepaper's own
"equivalent round constants" trick pre-folds the partial-round matrix multiplication into the round
constants (`Ark`/`MixS` in `poseidon_constants.circom`), and circom's compiler itself folds a dense
linear layer into one constraint per output rather than one per matrix entry. Against that already-
optimized baseline, at the smallest possible state width (`t=3`), most of Poseidon2's structural
advantage has nowhere left to go: circomlib was already paying close to the same per-round linear-
layer cost. Poseidon2's real edge — free full rounds vs. a dense `O(t²)` matrix multiply — grows
with `t`; at `t=3` a 3×3 dense multiply is already cheap, so the two are close. (This is exactly
why I did not attempt to self-derive `t=4`/`t=5` parameters this session, per Approach — even if the
theoretical gap is larger there, replicating it needs a much bigger, harder-to-validate lift, and I
wanted a real number here before deciding whether that's worth doing.)

### Proving time (`node scripts/bench/prove-latency.mjs --runs 10`)

| Circuit | Before (mean, σ) | After (mean, σ) | Delta |
|---|---|---|---|
| `transfer.circom` | 861.92 ms (σ 22.59) | 827.62 ms (σ 7.45) | **−34.3 ms (−4.0%)** |
| `compliance.circom` | 825.19 ms (σ 15.10) | 806.96 ms (σ 11.99) | **−18.2 ms (−2.2%)** |
| `withdraw.circom` | 285.22 ms (σ 11.20) | 269.26 ms (σ 8.52) | **−16.0 ms (−5.6%)** |

Raw output (final, uncontended run — see "A measurement mistake worth flagging" below for why this
is the third and only trusted run):

```
=== Veil Groth16 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- transfer ---
  runs: 10
  mean: 861.92 ms   stddev: 22.59 ms   min: 826.59 ms   max: 892.30 ms
  proof JSON size: 722 bytes, public signals: 7

--- withdraw ---
  runs: 10
  mean: 285.22 ms   stddev: 11.20 ms   min: 268.09 ms   max: 309.61 ms
  proof JSON size: 723 bytes, public signals: 5

--- compliance ---
  runs: 10
  mean: 825.19 ms   stddev: 15.10 ms   min: 796.23 ms   max: 850.41 ms
  proof JSON size: 723 bytes, public signals: 6

--- transfer_poseidon2 ---
  runs: 10
  mean: 827.62 ms   stddev: 7.45 ms   min: 813.44 ms   max: 842.26 ms
  proof JSON size: 721 bytes, public signals: 7

--- withdraw_poseidon2 ---
  runs: 10
  mean: 269.26 ms   stddev: 8.52 ms   min: 256.31 ms   max: 287.26 ms
  proof JSON size: 722 bytes, public signals: 5

--- compliance_poseidon2 ---
  runs: 10
  mean: 806.96 ms   stddev: 11.99 ms   min: 785.95 ms   max: 822.52 ms
  proof JSON size: 723 bytes, public signals: 6
```

**A measurement mistake worth flagging, because it's the kind that silently produces plausible-
looking wrong numbers.** The first attempt at this benchmark piped `prove-latency.mjs`'s output
through `tail -100` in a backgrounded shell. `snarkjs`/`ffjavascript` leaves a lingering handle
open after `fullProve` finishes (the same known issue `2026-07-22`'s report flagged for the
`circuits` test suite) — the *numbers* are done and correct the moment they're computed, but the
*process* never exits, so it never sends EOF, so `tail` (which needs EOF before it can know what
the "last 100 lines" are) printed nothing at all, forever. That looked like a hang, so I killed
what I believed was the stuck process and started a second run — except the kill targeted the
wrong PID (a bash wrapper's numbering, not the node process itself), so the first run kept running
underneath. That produced a real result, but computed while a second, independent proving run was
contending for the same CPU — a confound that would have inflated `transfer`'s mean by making it
look *slower* than either isolated circuit really is, without anything about the number itself
looking wrong. I only caught this because I actually checked `ps` before trusting the file. I killed
every `prove-latency.mjs` process, confirmed the process list was empty, then ran once more with
output going straight to a file — the numbers above. Reproducibility discipline in this loop
depends on catching this class of mistake before it becomes a cited number: don't trust a benchmark
you didn't watch run in isolation.

**These are larger, more consistent reductions than the ~0.3% constraint-count delta alone would
predict**, and the direction (Poseidon2 faster) held in all three independent attempts at this
measurement, including the CPU-contended one — a repeatable effect, not a coin flip. The likely
reason: `groth16.fullProve` time is witness generation (proportional to the WASM circuit
evaluation graph — the `wires` count, which drops by the same ~40 as constraints) *plus* the actual
Groth16 MSM/FFT (proportional to constraint count). A ~0.3% constraint change wouldn't move a
~850ms proving time by 15-35ms on its own; something in witness generation is contributing more
than the raw non-linear-constraint delta suggests. I did not chase this further to a root cause —
flagged as an open question below rather than guessed at.

### Tests

```
$ node --experimental-vm-modules test/poseidon2-merkle.test.mjs
=== Poseidon2 Merkle-hash swap — tests ===

--- JS reference correctness ---
  [PASS] KAT: poseidon2Permute3([0,1,2]) matches the published Horizen Labs BN254 test vector
  [PASS] poseidon2Hash2to1 is not the same function as circomlib Poseidon(2) (different hash families)

--- transfer_poseidon2.circom ---
  [PASS] PT1: valid transfer witness (Poseidon2 Merkle path) is accepted
  [PASS] PT2 (negative): sibling hashed with circomlib Poseidon instead of Poseidon2 is rejected
  [PASS] PT3 (negative): forged Merkle root (arbitrary value, no valid path) is rejected
  [PASS] PT4 (negative): claiming membership of a commitment never in the tree is rejected

--- compliance_poseidon2.circom ---
  [PASS] PC1: valid compliance witness (Poseidon2 credential Merkle path) is accepted
  [PASS] PC2 (negative): credential Merkle path forged with circomlib Poseidon is rejected

--- withdraw_poseidon2.circom ---
  [PASS] PW1: valid withdraw witness (Poseidon2 recipientHash) is accepted
  [PASS] PW2 (negative): recipientHash computed with circomlib Poseidon instead of Poseidon2 is rejected
  [PASS] PW3 (negative): recipientHash bound to a different recipient than the one paid out is rejected

11 passed, 0 failed, 0 skipped
```

This is real full-proof-mode output (zkeys built via `bash scripts/compile-poseidon2.sh`), not the
hash-only fallback — every `[PASS]` above ran an actual `groth16.fullProve` + `groth16.verify`.

PT2/PC2/PW2 are the soundness-relevant negative tests described in the threat model above: each
builds an otherwise-valid witness, then computes the one changed value (Merkle root /
recipientHash) with the *old* hash family instead of Poseidon2, and checks that `groth16.fullProve`
throws rather than producing a verifying proof. This directly demonstrates the correctness hazard
flagged above (you cannot silently mix Poseidon and Poseidon2 nodes in one proof) is caught by the
circuit's own constraints, not just by careful off-chain bookkeeping.

### Existing test suites (unaffected — production circuits untouched)

The production `transfer.circom` / `compliance.circom` / `withdraw.circom` files are byte-for-byte
unchanged by this experiment (only new `*_poseidon2.circom` files were added). Full suite run
before opening the PR:

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Poseidon2 swap (real Groth16, new) | **11/11 pass** | `node --experimental-vm-modules test/poseidon2-merkle.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (credential leaf, Merkle builder) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz (fast-check) | **6/6 properties, 500 cases each, all passed** | `cd scripts && bun run src/fuzz-tests.ts` |
| Move contracts | **NOT RUN** | `sui` CLI unavailable — see "What I tried first" (unchanged blocker from 2026-07-22; no Move code touched this session, so risk from skipping is low but this is a real gap, not a passing claim) |

No test was loosened, skipped, or given new tolerance to reach these numbers. Every suite above
that could run, ran and passed — this experiment adds new circuits and tests but touches no
existing production code path, so a regression here would have been a real surprise.

## Verdict: **REJECT** (for production adoption) — validated and kept as reference code

Poseidon2(t=3, BN254, official published parameters) is a **real, working, measured improvement**
for the depth-20 Merkle-hash path: −0.3% R1CS constraints, and a more interesting −2% to −6% real
Groth16 proving time across all three circuits, reproduced in an isolated benchmark run. The
implementation is validated against the reference authors' own known-answer test at both the JS and
circuit level, and the negative tests confirm a mismatched hash family is rejected, not silently
accepted.

It loses on cost, not on correctness. Adopting it in the actual `transfer.circom` /
`compliance.circom` / `withdraw.circom` means: (1) a new verifying key per circuit, which this
protocol's own design requires routing through the 1-epoch VK-update timelock (`docs/threat-model.md`
D6) — real governance overhead, not a flag flip; (2) the correctness hazard described above means
every already-inserted commitment's Merkle path becomes unreconstructible against a
Poseidon2-hashed root — the deposit accumulator would need a hard migration (rebuild the tree, or
version sub-trees by hash family), which this experiment does not attempt or scope; (3) Poseidon2
(published 2023) has meaningfully less cryptanalytic scrutiny than circomlib's Poseidon (in
production since ~2019) — a reasonable objection for a system currently pre-audit and pre-mainnet
(`README.md`, "Security posture"), where every added primitive is audit surface the project has to
pay for. A 2–6% proving-time win does not clearly clear that bar today.

**What's kept, and why this is still a KEEP-shaped result even though the verdict word is REJECT:**
`templates/poseidon2_bn254_t3.circom`, the three `*_poseidon2.circom` research circuits, the JS
reference implementation, and the test/bench tooling are merged as validated, tested reference
code — not deployed, not wired into `pool.move` or the frontend. `BASELINE.md` is **not** updated
(no production circuit changed) and `docs/threat-model.md` is **not** updated (no security property
of the deployed protocol changed). The branch and its numbers survive for whoever revisits this
once either the migration cost changes (e.g. a broader proof-system swap that's already rotating
every VK anyway — see "Where this could be used") or Poseidon2 accumulates more scrutiny.

## Where this could be used

- **Any circom/Groth16 circuit calling circomlib's `Poseidon(2)` at high volume** (Merkle-proof
  verification is the canonical case — nullifier-set trees, credential trees, state trees) gets the
  same small-but-real constraint reduction for free, with the same caveat: the gain is real but
  modest at `t=3` against an already-optimized baseline, so it's worth measuring before assuming
  the paper's headline numbers apply directly.
- **A protocol considering a proof-system migration that already touches every circuit** (e.g. the
  PLONK/Halo2 exploration further down this repo's own queue) is a much better moment to also adopt
  Poseidon2 — the migration cost of a new verifying key is already being paid, so a hash-family
  swap that would otherwise not clear the bar on its own rides along for free.
- **A thesis chapter benchmarking Poseidon2 adoption claims against a real, already-optimized
  circomlib baseline** — the actual contribution of this experiment, independent of Veil, is the
  measured evidence that Poseidon2's often-cited gains are `t`-dependent and largely already
  captured by circomlib's own optimizations at `t=3`; the paper's abstract doesn't say this, and I
  could not find a citable head-to-head benchmark against a modern circomlib baseline before running
  this myself.

## Open questions (next queue)

1. **Does the gap widen at `t=4`/`t=5`?** Those are the widths circomlib's `Poseidon(3)` and
   `Poseidon(4)` actually use internally for `txAmountHash`, commitments, and nullifiers — the
   *majority* of each circuit's Poseidon calls, and the widths where Poseidon2's `O(t)` vs `O(t²)`
   full-round advantage should matter more. No published, audited BN254 parameter set exists for
   these widths in the reference implementation; closing this needs running the paper's own
   constant-generation script and validating the result some other way than "the paper's authors
   already tested it" (their own consistency + KAT tests would need to be reproduced for
   self-generated constants, which is a meaningfully bigger lift). PARK candidate, not attempted
   this session.
2. **On-chain gas per entry point** — still blocked (see "What I tried first"), now for a harder,
   better-documented reason (org network policy, not a retryable approval prompt). Stays at the top
   of the queue; unblocking it needs an environment change (policy exception, a reachable prebuilt
   `sui` binary, or wider GitHub access), not another attempt at the same paths.
3. **Why is the proving-time drop (2–6%) so much larger than the constraint-count drop (0.3%)?**
   Measured, not guessed — see Results — but not root-caused. Two candidate explanations not yet
   distinguished: witness generation (proportional to the WASM evaluation graph / wire count, which
   also dropped, but only by the same ~0.3%) contributing disproportionately, or Groth16's FFT
   operating over a domain size that rounds up to the next power of two, where even a small
   constraint change can shift which power-of-two bucket a circuit falls into and change proving
   time by more than the raw delta suggests. Worth instrumenting `witnessCalculator` vs. the actual
   `groth16.prove` call separately next time, rather than only timing `fullProve` end-to-end.
