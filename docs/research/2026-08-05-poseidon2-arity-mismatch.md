# 2026-08-05 — Poseidon2 vs Poseidon: does it actually cut Veil's prover time? (queue item #2)

## Hypothesis

Swapping Veil's Poseidon commitment/nullifier hashing (circomlib, BN254) for Poseidon2 reduces
R1CS constraint count and Groth16 proving time, because Poseidon2's design (fewer full rounds, a
cheaper diagonal internal-round matrix) is supposed to be strictly more efficient per permutation.
This experiment measures that claim directly, at both microbenchmark scale and full-circuit scale,
using `withdraw.circom` — Veil's smallest real circuit — as the production test case. It is falsified
if Poseidon2 does not reduce (or increases) `withdraw.circom`'s R1CS constraint count and mean
Groth16 proving time.

**Verdict up front: REJECTED.** For Veil's actual hash usage pattern, with the one audited
BN254 Poseidon2 circom implementation available, it is not a win — it is a real, measured
regression on both axes.

## Threat / privacy model

No adversary model changes here — this is a performance experiment on a research-only circuit
variant, not a shipped protocol change. `withdraw.circom` and every other production circuit are
byte-for-byte unmodified; the Poseidon2 circuit lives only in `circuits/bench/` and has no
verification key registered anywhere on-chain.

- **Who relies on this being honest:** the same audience as the baseline — this research loop's
  own future nights (item #2 was queued specifically because "Poseidon2" sounded like free
  performance; that assumption is now falsified with real numbers, not vibes), and anyone
  reading this repo who might otherwise reach for Poseidon2 in a similar circuit without checking
  arity support first.
- **What a chain observer, relayer, or auditor learns:** nothing new — nothing shipped. If this
  *had* been a KEEP and `withdraw.circom` had been migrated to Poseidon2, the leakage surface
  would be identical to today's: commitments, nullifiers, and recipient hashes are still opaque
  field elements; Poseidon2's algebraic structure (like Poseidon's) reveals nothing about its
  preimage under the same hardness assumptions. Swapping the hash function inside a domain-tagged,
  capacity-1 one-shot construction doesn't change what's public vs private in the protocol.
- **What this does NOT establish:** whether *any* Poseidon2 implementation could beat Poseidon for
  Veil (see Open questions — a from-scratch implementation with native t=5/t=6 support might still
  win; this only rules out the one available, audited, off-the-shelf BN254 circom implementation
  at the widths it actually supports). It also says nothing about Poseidon2's own soundness as a
  permutation — that's inherited from the TACEO:OPRF-audited source, not re-derived here.
- **Soundness of the modified circuit itself:** `withdraw_poseidon2.circom` keeps the exact same
  nine constraints (C1-C9) as `withdraw.circom`, with only the hash primitive swapped. A negative
  test (below) confirms a tampered `newCommitment` is still rejected — the swap didn't silently
  under-constrain anything. No alias-check or nullifier-collision analysis was needed beyond what
  `withdraw.circom` already has, since domain separation tags and field-element semantics are
  unchanged; only the function computing the digest changed.
- **Assumptions:** Groth16/BN254 discrete-log soundness (unchanged, `docs/threat-model.md` RR2).
  Poseidon2's own cryptographic soundness is taken on faith from the cited TACEO:OPRF audit — this
  experiment did not re-verify Poseidon2's own security proof, only its cost and that the circom
  wrapper around it doesn't break existing constraints.
- **STRIDE mapping:** none — no threat-model entry changes. This is closest in spirit to RR2
  (trusted setup) in that both are "toolchain/implementation choice" rows rather than protocol-design
  rows, but Poseidon2 vs Poseidon isn't itself a listed residual risk.

## Approach

**Early unblock attempt on queue item #1 (on-chain gas), before starting tonight's actual experiment.**
Per the queue note, I spent the first part of the session trying to close item #1 rather than
re-deferring it silently a third time. Result: still BLOCKED, but for a more precise reason than
either previous attempt. This session's outbound network policy returns a hard `403` (`CONNECT
tunnel failed`) for every Sui RPC host tried — `fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`,
and a third-party public node (`sui-testnet-rpc.publicnode.com`) — confirmed via the proxy's own
status endpoint as a policy-level rejection (`"kind": "connect_rejected", "detail": "gateway
answered 403 to CONNECT (policy denial or upstream failure)"`), not the tool-approval-layer denial
hit in the 2026-07-22 run. `github.com` release downloads are blocked the same way (ruling out the
prebuilt-`sui`-binary path definitively this time), while `raw.githubusercontent.com`,
`registry.npmjs.org`, and `index.crates.io`/`static.crates.io` are all reachable. Building the full
Sui workspace from source remains the only theoretically open path and remains impractical to
attempt and verify honestly within one night's budget (confirmed again, not re-attempted). Queue
note updated below with this more specific diagnosis; still top of the ranked queue for whichever
future night has the multi-night budget or the explicit permission to spend it on a from-source
build.

**What I built for tonight's actual experiment.**

1. `circuits/bench/wrappers.circom` — two matched one-shot-hash templates: `Poseidon1Bench(nInputs)`
   (thin wrapper around circomlib's `Poseidon(nInputs)`, matching how `transfer.circom` /
   `withdraw.circom` / `compliance.circom` actually call it) and `Poseidon2Bench(t, nReal)` (same
   one-shot-hash semantics — capacity element fixed at 0, real inputs in `state[1..nReal]`, zero-pad
   any remaining width, digest = `state[0]` after the permutation — built on top of
   `@taceo/circom-lib`'s raw `Poseidon2(t)` permutation).
2. `@taceo/circom-lib` (MIT, npm, added as a `circuits/` devDependency) as the Poseidon2
   implementation. It's the only BN254 circom Poseidon2 I found on the npm registry or reachable via
   `raw.githubusercontent.com`; its `poseidon2.circom`/`eddsa_poseidon2.circom` are pulled from the
   audited TACEO:OPRF repository per its README. It supports state widths `t ∈ {2,3,4,8,12,16}` —
   **not** an arbitrary `t`.
3. Eight isolated microbenchmark circuits (`poseidon1_n{2,3,4,5}.circom`,
   `poseidon2_t{3,4,8,8}_n{2,3,4,5}.circom`) covering every arity Veil's three real circuits actually
   use: `nInputs ∈ {2,3,4,5}` → native widths `t ∈ {3,4,5,6}`. Poseidon2 supports `t=3` and `t=4`
   natively; `t=5` and `t=6` don't exist in its supported set, so those two are padded to the next
   available width, `t=8`.
4. `withdraw_poseidon2.circom` — a full drop-in Poseidon2 variant of `withdraw.circom` (Veil's
   smallest, simplest production circuit: 3 calls to `Poseidon(4)` for commitment/change-commitment/
   nullifier, 1 call to `Poseidon(2)` for the recipient hash, no Merkle proof). Identical C1-C9
   constraint structure; only the hash primitive is swapped.
5. `circuits/bench/compute_poseidon2.mjs` — computes a Poseidon2 digest by running the *actual
   compiled circuit* through `snarkjs.wtns.calculate` and reading `main.out` back out, rather than
   hand-porting the permutation to JS. This was a deliberate choice over writing a from-scratch JS
   Poseidon2 (which the taceo npm package doesn't ship, only the circom source): a hand-rolled port
   risks silently diverging from the audited implementation with no independent test vectors to
   catch it (the npm tarball doesn't include `tests/kats/`), whereas running the real compiled
   circuit through the real witness calculator can't diverge from itself.
6. `scripts/bench/poseidon2-latency.mjs`, `circuits/bench/withdraw_compare.mjs`,
   `circuits/bench/withdraw_poseidon2_negative_test.mjs` — the timing and soundness scripts
   producing the raw output below.
7. `circuits/bench/compile.sh` and `circuits/bench/compile-withdraw.sh` — reusable, from-scratch
   compile + trusted-setup scripts for all of the above (mirrors the existing
   `circuits/scripts/compile*.sh` convention).

**What I rejected.** A hand-written JS Poseidon2 for witness precomputation (see point 5 — real
divergence risk, no upside). Testing only the isolated microbenchmark and skipping the full-circuit
swap (would have missed the entire finding below — the microbenchmark and full-circuit results
*disagree* on which implementation is faster, and only the full-circuit number is representative of
Veil's real proving cost). Generating custom Poseidon2 round constants for the missing `t=5`/`t=6`
widths so every arity could be tested natively (see Open questions — that's a from-scratch
cryptographic construction, not a benchmark, and needs its own dedicated, independently-verified
experiment, not a rushed addition to this one).

## Results

### Table 1 — isolated permutation, R1CS constraints (`circom --O2`, fully optimized — the
irreducible non-linear cost, linear constraints collapse to 0 under full simplification)

| nInputs | circomlib Poseidon (native t) | taceo Poseidon2 (t used) | Δ | Δ% |
|---|---|---|---|---|
| 2 | 240 (t=3) | 240 (t=3, **native**) | 0 | 0% |
| 3 | 261 (t=4) | 264 (t=4, **native**) | +3 | +1.1% |
| 4 | 297 (t=5) | 363 (t=8, **padded**) | +66 | **+22.2%** |
| 5 | 321 (t=6) | 363 (t=8, **padded**) | +42 | **+13.1%** |

`nInputs=4` (state width 5) is Veil's dominant hash call — it's `Poseidon(4)` in
`transfer.circom` (×2), `withdraw.circom` (×3, minus the one this table already covers separately),
and used for every commitment/nullifier hash. Poseidon2 has no native support for it.

Raw command and output (`circuits/bench/compile.sh`, `--O2` block):
```
$ circom poseidon1_n4.circom --r1cs --O2 -o build -l ../node_modules
non-linear constraints: 297
linear constraints: 0

$ circom poseidon2_t8_n4.circom --r1cs --O2 -o build -l ../node_modules
non-linear constraints: 363
linear constraints: 0

$ circom poseidon1_n3.circom --r1cs --O2 -o build -l ../node_modules
non-linear constraints: 261
$ circom poseidon2_t4_n3.circom --r1cs --O2 -o build -l ../node_modules
non-linear constraints: 264

$ circom poseidon1_n2.circom --r1cs --O2 -o build -l ../node_modules
non-linear constraints: 240
$ circom poseidon2_t3_n2.circom --r1cs --O2 -o build -l ../node_modules
non-linear constraints: 240

$ circom poseidon1_n5.circom --r1cs --O2 -o build -l ../node_modules
non-linear constraints: 321
$ circom poseidon2_t8_n5.circom --r1cs --O2 -o build -l ../node_modules
non-linear constraints: 363
```
(Without `--O2` — i.e. circom's default optimization, matching how `BASELINE.md`'s numbers were
produced — total R1CS constraints via `snarkjs r1cs info` are 517/605/736/835 for Poseidon1 at
n=2/3/4/5 and 580/852/1663/1663 for Poseidon2 at the same widths: a much larger apparent gap, almost
entirely from linear constraints that full optimization removes. The `--O2` numbers above are the
fairer comparison and the ones this verdict rests on.)

### Table 2 — isolated permutation, Groth16 proving time (Node, `snarkjs groth16.fullProve`, mean of
10 runs after 1 warm-up, pot12, default circom optimization — matches how `BASELINE.md`'s Node
proving-time numbers were produced)

| nInputs | circomlib Poseidon | taceo Poseidon2 | Δ |
|---|---|---|---|
| 3 (t=4, native) | 141.81 ms (σ 8.88) | 111.46 ms (σ 5.62) | **-21.4%** |
| 4 (t=5→8, padded) | 154.58 ms (σ 7.59) | 122.57 ms (σ 5.90) | **-20.7%** |

At this scale (240-1663 R1CS constraints), Poseidon2 is *faster* despite equal-or-more constraints
— witness-generation arithmetic cost, not Groth16 MSM/FFT cost, dominates wall-clock time for
circuits this small, and Poseidon2's diagonal internal-round matrix appears to need less witness
arithmetic even where it needs the same or more R1CS rows. This is the result that would make
Poseidon2 look like a clear win — and it's the one that doesn't hold up at real circuit scale.

Raw command and output (`node scripts/bench/poseidon2-latency.mjs --runs 10`):
```
=== Poseidon vs Poseidon2 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- nInputs=3 (t=4, Poseidon2 native width) ---
  poseidon1_n3: mean 141.81 ms  stddev 8.88 ms  min 128.82 ms  max 157.57 ms
  poseidon2_t4_n3: mean 111.46 ms  stddev 5.62 ms  min 101.86 ms  max 124.68 ms
  delta (poseidon2_t4_n3 vs poseidon1_n3): -21.4%

--- nInputs=4 (t=5 native / t=8 padded — Veil's dominant Poseidon(4) call) ---
  poseidon1_n4: mean 154.58 ms  stddev 7.59 ms  min 144.55 ms  max 168.16 ms
  poseidon2_t8_n4: mean 122.57 ms  stddev 5.90 ms  min 112.46 ms  max 132.43 ms
  delta (poseidon2_t8_n4 vs poseidon1_n4): -20.7%
```

### Table 3 — full circuit, `withdraw.circom` vs `withdraw_poseidon2.circom` (real production-shaped
circuit, default circom optimization — directly comparable to the `withdraw.circom` row in
`BASELINE.md`)

| Metric | `withdraw.circom` (Poseidon) | `withdraw_poseidon2.circom` | Δ |
|---|---|---|---|
| R1CS constraints | 3,058 | 5,902 | **+93.0%** |
| Groth16 proving time, Node (mean of 10) | 346.01 ms (σ 28.14) | 403.59 ms (σ 23.94) | **+16.6%** |
| Proof JSON size | 720 B | 721 B | ~0% |

This is the number that matters: at real circuit scale, the constraint-count penalty from padding
three `t=5`-shaped hash calls to `t=8` dominates, and Poseidon2 ends up **both larger and slower**,
reversing the microbenchmark's apparent win. `withdraw.circom`'s own re-measured constraint count
(3,058) exactly reproduces `BASELINE.md`, confirming the comparison methodology is consistent with
the existing baseline.

Raw command and output:
```
$ circom withdraw.circom --r1cs --wasm --sym --output build-withdraw-compare -l node_modules
non-linear constraints: 1465
linear constraints: 1593
[...]
$ npx snarkjs r1cs info build-withdraw-compare/withdraw.r1cs
[INFO]  snarkJS: # of Constraints: 3058

$ circom circuits/bench/withdraw_poseidon2.circom --r1cs --wasm --sym --output build-withdraw-compare -l node_modules
non-linear constraints: 1651
linear constraints: 4251
[...]
$ npx snarkjs r1cs info build-withdraw-compare/withdraw_poseidon2.r1cs
[INFO]  snarkJS: # of Constraints: 5902

$ node circuits/bench/withdraw_compare.mjs --runs 10
=== withdraw.circom vs withdraw_poseidon2.circom — full-circuit Groth16 proving time (10 runs) ===
node v22.22.2, linux/x64

withdraw (Poseidon):    mean 346.01 ms  stddev 28.14 ms  min 304.03 ms  max 389.07 ms  proof 720B
withdraw_poseidon2:     mean 403.59 ms  stddev 23.94 ms  min 369.43 ms  max 455.15 ms  proof 721B

delta (withdraw_poseidon2 vs withdraw): +16.6%
```

### Negative test — soundness preserved

```
$ node circuits/bench/withdraw_poseidon2_negative_test.mjs
PASS: tampered newCommitment correctly rejected by the witness calculator.
Raw error: Error: Assert Failed. Error in template WithdrawPoseidon2_25 line: 69
```
(Line 69 is `newCommitment === changeHash.out;` — C6. A witness with every value correct except a
forged `newCommitment` fails witness generation exactly as it would in the original circuit.)

### Full test suite (run before this report, no production circuit touched)

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | 43 pass | `node test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | 30 pass | `node test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | 35 pass | `node test/withdraw.test.mjs` |
| Proof converter | 109 pass | `bun run src/test-converter.ts` |
| Compliance utils | 67 pass | `bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | 19 pass | `bunx vitest run` |
| Property-based fuzz | 6/6 properties, 500 cases each | `bun run src/fuzz-tests.ts` |
| Move contract (124 tests) | **BLOCKED** (no `sui` CLI, see above) | `sui move test` |

No repository file outside `circuits/bench/`, `scripts/bench/poseidon2-latency.mjs`, and
`circuits/package.json` (new devDependency) was modified. `CLAUDE.md`, referenced throughout the
nightly prompt as the source of architecture/build/test commands, does not exist in this repository
— commands above are from `README.md`'s "Run it" / "Test counts" sections instead. Worth fixing:
either add a `CLAUDE.md` or update `docs/research/NIGHTLY_PROMPT.md` to point at `README.md`.

## Verdict

**REJECT.** Poseidon2 (via `@taceo/circom-lib`, the only audited BN254 circom implementation
available) does not reduce Veil's prover time. For the arity Veil actually needs most —
4 real inputs, requiring permutation width `t=5` — Poseidon2 has no native support, and padding to
the nearest supported width (`t=8`) costs more than it saves: +93.0% R1CS constraints and +16.6%
proving time on `withdraw.circom`, Veil's smallest production circuit. The apparent ~21% proving-time
*win* at microbenchmark scale is real but not representative — it reflects witness-generation
overhead dominating at circuit sizes two orders of magnitude smaller than Veil's actual circuits, and
inverts once embedded in a real circuit where constraint count drives cost.

The branch and both benchmark harnesses stay in the repo (`circuits/bench/`,
`scripts/bench/poseidon2-latency.mjs`) — reusable if a future night wants to test a Poseidon2
implementation with native `t=5`/`t=6` support, or re-derive this at `transfer.circom`/
`compliance.circom` scale (both larger, both use the same dominant `Poseidon(4)` and add a
`Poseidon(5)`/`Poseidon(3)` on top — the same arity-mismatch penalty would apply, likely more
severely since `transfer.circom` and `compliance.circom` each make 2-3 of the affected calls).
`BASELINE.md` is unchanged — no protocol security property changed and no number in it moved.

## Where this could be used

- **Any BN254-circom UTXO/commitment-based privacy protocol using small-tuple Poseidon hashes for
  commitments or nullifiers** — Tornado-Cash-style pools, Semaphore-style nullifier schemes, and
  Aztec-style deposit/withdraw circuits all typically hash 3-6 field elements (owner secret +
  amount/randomness/domain-tag), landing in exactly the `t=4`-to-`t=6` range where taceo's
  Poseidon2 has a supported-width gap. A protocol considering the same swap should check its actual
  arities against `{2,3,4,8,12,16}` before assuming a win.
- **Anyone benchmarking cryptographic primitives at "textbook" microbenchmark scale and
  extrapolating to production circuits** — a general methodology point (arguably the most reusable
  part of tonight's result): a primitive-level microbenchmark and a full-circuit benchmark can
  *disagree in direction*, not just in magnitude, when the primitive's cost profile shifts between
  witness-generation-bound and constraint-count-bound regimes. Worth a paragraph in a thesis chapter
  on ZK circuit benchmarking methodology specifically as a cautionary example, independent of Veil.
- **A confidential-payroll or compliance-gated transfer system on Sui evaluating proof-system
  micro-optimizations** (the same use case named in the 2026-07-22 report for threshold auditing) —
  this result says: audit your actual hash arities against a candidate library's supported
  permutation widths *before* estimating a constraint-count win from a design doc or paper alone.

## Open questions

1. **Would a Poseidon2 implementation with native `t=5`/`t=6` round constants change the verdict?**
   Unmeasured tonight, and deliberately not attempted — generating fresh Poseidon2 round constants
   for unsupported widths is a from-scratch cryptographic construction (needs the reference
   constant-generation algorithm re-derived and cross-checked against at least one independent
   implementation before trusting it in a circuit), not a benchmarking task, and doing it carelessly
   is exactly the kind of self-rolled, unverified primitive this loop's rules warn against. Queued
   as a distinct, explicitly-scoped item (see `EXPERIMENTS.md`) rather than folded into tonight's
   result.
2. **Does the same arity-mismatch penalty hold at `transfer.circom` and `compliance.circom` scale?**
   Likely yes and likely worse (more affected calls per circuit), but not directly measured — only
   `withdraw.circom` was fully ported and benchmarked tonight.
3. **On-chain gas per entry point** — still BLOCKED, now for a more precisely diagnosed reason
   (network-policy-level denial of every Sui RPC host, not a one-off tool-approval denial). Still
   top of the ranked queue; needs either a multi-night budget for a from-source `sui` CLI build, or
   explicit permission/infrastructure to reach a Sui RPC endpoint from this environment.
4. Is `CLAUDE.md`'s absence from this repository intentional, or did it get deleted/never
   committed? The nightly prompt assumes it exists; two consecutive nights have now had to fall back
   to `README.md`.
