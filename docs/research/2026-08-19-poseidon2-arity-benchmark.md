# 2026-08-19 — Poseidon vs Poseidon2, measured at Veil's actual hash arities (queue item #2)

## Hypothesis

Swapping Veil's four Poseidon instances for Poseidon2 reduces the R1CS constraint count (and
therefore Groth16 proving time) of `transfer.circom` and `compliance.circom`, the two circuits
that dominate the 2026-07-22 baseline's proving-time numbers. This experiment measures the real
constraint-count and proving-time delta, per hash arity, using a real third-party Poseidon2
circom implementation — not an estimate — and answers it directly: **no**, not with the
off-the-shelf Poseidon2 parameter set, for the two arities Veil actually calls most.

This is queue item #2. It does **not** modify `transfer.circom`, `compliance.circom`, or
`withdraw.circom` — see Approach for why, and Verdict for what would need to be true before a
real swap is worth attempting.

## Threat / privacy model

This experiment adds new circuit code to the repository (`circuits/research/poseidon2/`) but
does not wire it into any live entry point — no proof Veil's Move contracts verify is affected,
no VK changes, no new public inputs. So there is no new adversary to model against the protocol
itself, and no STRIDE entry in `docs/threat-model.md` changes.

What *is* at stake is narrower, and still real: **trusting third-party crypto code enough to cite
its numbers.** `circuits/research/poseidon2/vendor/` vendors `poseidon2.circom` +
`poseidon2_constants.circom` from `@taceo/circom-lib` 0.6.0 (MIT), whose README states these
files are "pulled from the audited repository for TACEO:OPRF" — an external claim I did not
independently audit line-by-line. The mitigation applied here, not a full audit:

- **Round-constant provenance**: the vendored t=3 constants were diffed byte-for-byte against
  `HorizenLabs/poseidon2` (commit `055bde3f`), the Poseidon2 paper authors' own reference
  repository, cloned read-only for comparison — they match exactly (see Results).
- **Independent re-execution, not just constant comparison**: `circuits/research/poseidon2/verify/verify.mjs`
  computes the real permutation output two ways for two arities and confirms they agree bit-for-bit:
  - t=3: a permutation written from scratch in this session directly against HorizenLabs'
    `poseidon2.rs`/`poseidon2_instance_bn256.rs` (`reference_permute_t3.mjs`), vs. the compiled
    circom circuit's actual witness.
  - t=4: `@zkpassport/poseidon2`'s `permute()` — a second, separately-authored TypeScript
    implementation, unrelated to `@taceo/circom-lib` — vs. the compiled circom circuit's witness.
- **Negative test** (`negative_test.cjs`): a witness with a tampered claimed output, and
  separately a tampered internal round-state wire, are both rejected by `circom_tester`'s
  constraint check — the vendored circuit's `<==` actually constrains the permutation rather than
  merely computing it during witness generation.

What this does **not** establish: full correctness of the t=8/t=12/t=16 branches (only t=3 and
t=4 were cross-checked against a second source — those are the only arities with a compact,
findable independent reference), or that the vendored code is free of subtle circuit bugs outside
what a black-box input/output/negative-witness check can catch (e.g. a malleability bug that
still produces the correct output for the tested inputs). It is not a substitute for the kind of
audit `@taceo/circom-lib`'s own README claims for its source repository.

Assumptions carried over unchanged from the existing threat model: Groth16/BN254 soundness, the
dev-only trusted setup (RR2, unchanged — this experiment's own local zkeys are single-contributor
test setups, never claimed otherwise).

## Approach

**What I built.**

- `circuits/research/poseidon2/vendor/` — `poseidon2.circom` + `poseidon2_constants.circom`,
  copied verbatim from `@taceo/circom-lib` 0.6.0 (MIT, `LICENSE-taceo` alongside), with an
  attribution header. Supports state sizes t ∈ {2, 3, 4, 8, 12, 16} only.
- `circuits/research/poseidon2/hash.circom` — `Poseidon2Hash(nInputs)`, a thin wrapper matching
  circomlib's `Poseidon(nInputs)` convention exactly (capacity element = 0, output = permuted
  `state[0]`) so constraint counts are comparable apples-to-apples; and
  `Poseidon2HashPadded(nInputs, tFixed)` for arities with no native parameter set, zero-padding
  up to the nearest supported `tFixed`.
- `circuits/research/poseidon2/bench/` — eight standalone `main` circuits: circomlib's
  `Poseidon(2)`/`(3)`/`(4)`/`(5)` and the Poseidon2 equivalents, at Veil's four actual call
  arities (see README below for where each is used).
- `circuits/research/poseidon2/verify/` — the correctness cross-checks and negative test
  described above.
- `scripts/bench/poseidon2-bench-setup.sh` + `scripts/bench/poseidon2-prove-latency.mjs` —
  reusable compile/setup and timing scripts (a fresh local pot12 ptau, generated in seconds, no
  network fetch needed since every bench circuit is under 4096 constraints).

**Veil's actual Poseidon call sites** (from `transfer.circom`, `withdraw.circom`,
`compliance.circom`):

| Arity (nInputs) | circomlib call | Used for | Poseidon2 t needed | Native params? |
|---|---|---|---|---|
| 2 | `Poseidon(2)` | recipientHash (withdraw), Merkle sibling pairs | 3 | Yes |
| 3 | `Poseidon(3)` | txAmountHash, credential nullifier/context | 4 | Yes |
| 4 | `Poseidon(4)` | **commitment hash** — called 2–3× per circuit, the single most-used gadget | 5 | **No** |
| 5 | `Poseidon(5)` | compliance credential leaf hash | 6 | **No** |

The vendored library only ships parameters for t ∈ {2, 3, 4, 8, 12, 16} — it has **no** native
parameter set for t=5 or t=6, which is exactly where Veil's heaviest-used hash (the commitment
hash, `Poseidon(4)`) lands. This alone is a real finding: "swap to Poseidon2" is not a drop-in
change for Veil without either (a) generating new round constants for t=5/t=6 — a real
cryptographic parameter-generation exercise, not attempted here — or (b) padding up to the next
supported width (t=8), which is what this experiment measures as the practical fallback.

**What I rejected.** Wiring Poseidon2 directly into `transfer.circom`/`compliance.circom` for a
live-circuit comparison — rejected because (a) it would touch Veil's actual proving/verification
paths on the strength of one night's due diligence on third-party crypto code, which is a much
higher bar than a standalone measurement circuit; and (b) the arity gap above means a live swap
would have to choose *now* between t=8-padding (this experiment) or custom parameter generation
(unattempted, out of scope) — better to measure both options' costs first, in isolation, before
committing the live circuits to either. Generating custom t=5/t=6 round constants was rejected
for the same reason `docs/threat-model.md`-adjacent crypto changes generally are on a single
night: it's a distinct, higher-risk piece of work that deserves its own experiment if item 2's
numbers justify it (see Verdict — they don't, for the padded case).

**Toolchain.** circom 2.2.2 (built from source, same as the 2026-07-22 baseline — this session's
container is fresh, nothing persists between nights). `@taceo/circom-lib` 0.6.0,
`@zkpassport/poseidon2` 0.6.2, and `circom_tester` 0.0.24 installed from the npm registry (in
`noProxy` — no blocker). No blockers hit this session for anything in this experiment's scope.

## Results

### Constraint counts (`circom --r1cs` + `snarkjs r1cs info`, reproduce with `scripts/bench/poseidon2-bench-setup.sh`)

| nInputs | Poseidon (circomlib) NL / Lin / **Total** | Poseidon2 NL / Lin / **Total** | Total Δ |
|---|---|---|---|
| 2 (t=3, native) | 243 / 274 / **517** | 240 / 340 / **580** | **+12.2%** |
| 3 (t=4, native) | 264 / 341 / **605** | 264 / 588 / **852** | **+40.8%** |
| 4 (t=8, padded) | 300 / 436 / **736** | 363 / 1300 / **1663** | **+126.0%** |
| 5 (t=8, padded) | 324 / 511 / **835** | 363 / 1300 / **1663** | **+99.2%** |

Non-linear (S-box) constraints are roughly at parity or slightly favor Poseidon2 for the two
native arities, and only ~20% worse for the padded ones — the real cost is **linear constraints**,
which roughly double to quadruple. This is not an inherent property of the Poseidon2
*construction*; it traces to how `@taceo/circom-lib`'s `Acc`/`ExternalMatMulT`/`InternalMatMulT`
templates decompose matrix multiplication into chains of intermediate signals, versus circomlib's
`Mix` template, which computes each output element as a single dense linear combination in one
constraint. A more R1CS-optimized Poseidon2 implementation could plausibly close much of this gap
— this experiment measures *this* implementation, not the theoretical floor for Poseidon2 on
BN254. (No `--O2` optimization flag was used for either side, matching the default-optimization
methodology of the 2026-07-22 baseline, so the two sides remain comparable to each other and to
`BASELINE.md`.)

Raw command and output (all eight circuits, abbreviated — full output in
`circuits/research/poseidon2/bench/`):

```
$ circom research/poseidon2/bench/poseidon_n4.circom --r1cs --wasm --output build
non-linear constraints: 300
linear constraints: 436
$ npx snarkjs r1cs info build/poseidon_n4.r1cs
[INFO]  snarkJS: # of Constraints: 736

$ circom research/poseidon2/bench/poseidon2_n4_padded_t8.circom --r1cs --wasm --output build
non-linear constraints: 363
linear constraints: 1300
$ npx snarkjs r1cs info build/poseidon2_n4_padded_t8.r1cs
[INFO]  snarkJS: # of Constraints: 1663
```

Extrapolating to production scale (informational, not separately measured): `transfer.circom`
calls `Poseidon(4)` twice (`oldHash`, `newHash`) and `Poseidon(2)`-arity gadgets elsewhere; if
those two `Poseidon(4)` calls alone were replaced with t=8-padded Poseidon2, that's roughly
+1,854 constraints (2 × (1663 − 736)) added to a circuit currently at 13,611 — a **~13.6%
increase** in total constraints, working against the goal, not for it.

### Proving time (`node scripts/bench/poseidon2-prove-latency.mjs --runs 15`, mean of 15 `groth16.fullProve` calls, real local Groth16 setup per circuit — pot12, generated fresh, no network fetch)

| nInputs | Poseidon (ms) | Poseidon2 (ms) | Δ |
|---|---|---|---|
| 2 (native) | 139.4 (σ 11.3) | 109.7 (σ 8.9) | **−21.3%** |
| 3 (native) | 137.7 (σ 10.9) | 118.5 (σ 9.7) | **−13.9%** |
| 4 (padded) | 146.4 (σ 6.5) | 148.9 (σ 6.2) | +1.7% |
| 5 (padded) | 157.0 (σ 11.2) | 157.0 (σ 17.1) | +0.0% |

```
=== Poseidon vs Poseidon2 arity benchmark: proving time (15 runs each) ===
node v22.22.2, linux/x64

--- poseidon_n2 (Poseidon (circomlib), 2 inputs) ---
  mean: 139.364 ms   stddev: 11.276 ms   min: 121.946 ms   max: 163.283 ms

--- poseidon2_n2 (Poseidon2 (t=3, native), 2 inputs) ---
  mean: 109.717 ms   stddev: 8.925 ms   min: 97.999 ms   max: 133.847 ms

--- poseidon_n4 (Poseidon (circomlib), 4 inputs) ---
  mean: 146.447 ms   stddev: 6.507 ms   min: 137.711 ms   max: 163.773 ms

--- poseidon2_n4_padded_t8 (Poseidon2 (t=8, padded), 4 inputs) ---
  mean: 148.880 ms   stddev: 6.159 ms   min: 140.787 ms   max: 163.408 ms
```
(full output, all 8 circuits: `circuits/research/poseidon2/bench/` after running the setup
script, or the JSON summary the script prints.)

**This does not cleanly confirm the constraint-count story, and I'm reporting that honestly
rather than picking whichever number supports a cleaner narrative.** At 500–1700 constraints,
every circuit here is two orders of magnitude smaller than `transfer.circom` (13,611). At that
scale, wall-clock `fullProve` time is dominated by fixed per-call overhead — zkey file I/O, WASM
instantiation — not by the constraint-proportional FFT/MSM work Groth16 theory says should scale
with total R1CS constraints. That's consistent with what's measured: the padded-t=8 cases (the
ones with a genuine 99–126% constraint-count increase) show only ~0–2% proving-time difference,
and the native cases show Poseidon2 *faster* despite having more total constraints. The
constraint-count table is the reliable signal for what happens at Veil's actual circuit scale (it's
a static property, not subject to per-call I/O noise); the proving-time table is real, measured,
and included in full, but should be read as "not yet informative at this scale" rather than
"contradicts the constraint-count finding" — resolving that tension needs a same-scale test (see
Open questions).

### Correctness cross-check (`node circuits/research/poseidon2/verify/verify.mjs`)

```
[t=3] independent-JS-reference out[0] = 0x0bb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033
[t=3] circom witness         main.out = 0x0bb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033
[t=3] MATCH
[t=4] @zkpassport/poseidon2  out[0] = 0x01bd538c2ee014ed5141b29e9ae240bf8db3fe5b9a38629a9647cf8d76c01737
[t=4] circom witness      main.out = 0x01bd538c2ee014ed5141b29e9ae240bf8db3fe5b9a38629a9647cf8d76c01737
[t=4] MATCH

All cross-checks passed.
```

### Negative test (`node circuits/research/poseidon2/verify/negative_test.cjs`)

```
[PASS] genuine witness satisfies constraints
[PASS] tampered-output witness rejected: Constraint doesn't match
[PASS] tampered-internal-wire witness rejected: Constraint doesn't match

All negative-test checks passed.
```

### Test suite (run in full, per README.md)

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs) | **108/108 pass** (unchanged from 2026-07-22 baseline) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** — see below | `cd contracts && sui move test` |

No test was loosened, skipped, or given new tolerance. Nothing in this experiment touches
`transfer.circom`, `compliance.circom`, `withdraw.circom`, or any Move module, so the identical
108/108 + 109/109 + 19/19 pass counts are the expected (and confirmed) result, not a claim this
experiment improved anything protocol-side.

**On-chain gas / Move tests (queue item #1) — re-confirmed BLOCKED, upgraded severity.** Before
touching item #2, I re-attempted item #1 with a fresh angle: a direct JSON-RPC read against the
public `fullnode.testnet.sui.io` endpoint (the fallback the 2026-07-22 report couldn't attempt
because the read was denied before it executed). This time the call executed and failed cleanly:

```
$ curl -sS "https://fullnode.testnet.sui.io:443" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'
curl: (56) CONNECT tunnel failed, response 403
```

Same result for `github.com/MystenLabs/sui/releases/...` and `crates.io`. Per
`/root/.ccr/README.md` (this session's egress proxy documentation): *"403/407 from the proxy: the
destination host is not allowed by your organization's egress policy for this session. Do not
retry or route around it."* This reclassifies item #1 from "blocked twice, for different
session-specific reasons" (2026-07-22's framing) to **blocked by a standing organizational egress
policy** — every plausible path to a `sui` CLI or a testnet RPC read is denied by the same
mechanism, not by transient tool failures. It should stay top of the queue, but the next attempt
should not be "try again" — it should be requesting a policy exception for
`fullnode.testnet.sui.io` (a single read-only JSON-RPC host) from whoever administers this
session's egress policy, since building the `sui` CLI from source was already judged impractical
within a night's budget on 2026-07-22 and nothing about that judgment has changed.

## Verdict: **REJECT** (the tested hypothesis — direct Poseidon2 replacement via `@taceo/circom-lib`)

For Veil's two most-used hash arities (`Poseidon(4)`, called 2–3× per circuit for the commitment
hash; `Poseidon(5)`, the compliance leaf hash), this vendored Poseidon2 library has no native
parameters, and the practical fallback (pad to t=8) very nearly **doubles** the R1CS constraint
count of those Poseidon calls — the opposite of item #2's hypothesis. For the two arities where
native parameters do exist, the constraint-count picture is a wash (fewer non-linear, more linear,
net worse) even though proving time measured faster — and I don't trust that proving-time result
at this circuit scale enough to call it a win (see Results). Swapping Veil's live circuits to this
library is not justified by tonight's numbers. `BASELINE.md` is unaffected — no protocol circuit
was touched.

This is not a dead end for Poseidon2 generally, just for *this* implementation applied naively at
*these* arities. See Open questions for what would need to be true before revisiting.

## Where this could be used

- **The negative finding matters beyond Veil**: any Circom/Groth16 project considering
  Poseidon2 for a *fixed, off-the-shelf* library should check native parameter coverage for its
  actual arities before assuming a win — "Poseidon2 is asymptotically cheaper" (true for the
  S-box-dominated non-linear count) does not imply "this specific vendored circuit is cheaper for
  my hash arity" once linear-constraint overhead and parameter-padding are accounted for.
- **The correctness-cross-check method** (independent from-scratch reimplementation against the
  primary paper reference, plus a second unrelated library, plus a negative-witness test) is a
  reusable due-diligence pattern for any protocol vendoring third-party circuit code it hasn't
  audited itself — cheap (a few hours) relative to a real audit, and catches transcription errors
  a pure "the README says it's audited" trust decision would miss.
- **A thesis chapter on Poseidon2 adoption costs** has a concrete, sourced counter-example here to
  the common "Poseidon2 is strictly better" framing — useful precisely because it's a negative
  result with real numbers, not a hedge.

## Open questions (next queue)

1. **On-chain gas (queue item #1)** — re-confirmed as an organizational egress-policy block, not
   a transient failure (see Results). Needs a policy exception request, not another retry. Stays
   top of the queue with that reframing.
2. **Custom Poseidon2 round constants for t=5/t=6** — the arities Veil actually needs most have no
   native Poseidon2 parameter set in the library checked tonight. Generating them (or finding a
   library that already has, e.g. a wider survey than the two packages checked here) and
   re-running this exact benchmark is the natural follow-up before Poseidon2 can be fairly
   evaluated for `Poseidon(4)`/`Poseidon(5)`.
3. **A more R1CS-optimized Poseidon2 circom implementation** — the linear-constraint blow-up
   traced to this library's matrix-multiplication gadget style, not the Poseidon2 construction
   itself. Worth checking whether `circomlib`'s own dense-linear-combination style (`Mix`) can be
   applied to Poseidon2's external/internal matrices to close the gap.
4. **Resolve the constraint-count vs. proving-time disagreement** by re-running the timing
   comparison embedded at production scale (e.g., a throwaway circuit with `Poseidon(4)` called
   3× as `transfer.circom` effectively does, vs. the t=8-padded Poseidon2 equivalent) instead of
   isolated ~500–1700-constraint circuits, where fixed per-call overhead dominates and swamps the
   signal this experiment was trying to measure.
5. Re-rank: with item #2 answered (negatively, for now), item #5 (independent circuit soundness
   audit) or item #4 (Merkle accumulator at scale) are reasonable next picks — see re-ranked
   `EXPERIMENTS.md`.
