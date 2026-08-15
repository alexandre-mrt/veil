# 2026-08-15 — Poseidon vs Poseidon2, measured at Veil's actual arities (queue item #2)

## Hypothesis

Swapping Veil's four Poseidon(4)/Poseidon(3)/Poseidon(2)/Poseidon(5) instances (the primitive that
dominates `transfer.circom`'s and `compliance.circom`'s non-linear constraints — 6,470 and 6,057
respectively per `BASELINE.md`) for Poseidon2 reduces R1CS constraint count and Groth16 proving
time, using a real, off-the-shelf, non-self-authored circom implementation
(`@taceo/circom-lib@0.6.0`, MIT, npm) rather than hand-derived round constants.

This is falsifiable in one number: R1CS constraints per hash call, measured with
`snarkjs r1cs info`, at nInputs = 2, 3, 4, 5 — the exact arities `transfer.circom`,
`compliance.circom`, and `withdraw.circom` actually call `Poseidon(n)` with.

## Threat / privacy model

No production circuit, Move module, or frontend code was touched tonight — the eight benchmark
circuits live under `circuits/bench/` and are not wired into `transfer.circom`, `compliance.circom`,
`withdraw.circom`, or any Move verifier. **Nothing about Veil's deployed threat surface changes as a
result of this experiment.** The soundness and leakage analysis below is written as if this were a
proposal to actually swap the hash primitive, because that's the decision this experiment informs —
not because anything is being deployed tonight.

**If Poseidon2 were adopted in `transfer.circom`/`compliance.circom`/`withdraw.circom`:**

- **Chain observer** (anyone reading Sui transaction data): learns nothing new. Commitments,
  nullifiers, and hashes are opaque field elements either way — swapping the hash function that
  produced them doesn't change what's visible on-chain (still just 128-byte compressed proofs, u64
  public inputs, dynamic-field commitment/nullifier sets). No new observable is introduced.
- **Malicious prover**: this is the adversary the negative test targets directly (see Results). The
  question is whether a prover can produce a *valid-looking* proof for a hash output that doesn't
  match the real Poseidon2 permutation of their claimed inputs — i.e. forge a commitment or
  nullifier. The sponge wrapper (`Poseidon2Hash`, `circuits/bench/circuits/poseidon2_hash.circom`)
  constrains the capacity element and every padding slot to `0` via `<==`, mirroring circomlib's
  `Poseidon(nInputs)` exactly (`pEx.initialState <== 0`). The negative test confirms a forged output
  is rejected by the R1CS.
- **Colluding relayer / statistical deanonymizer**: unaffected either way — neither the current
  Poseidon nor Poseidon2 changes what the relayer sees (it already sees the full transaction).
- **Malicious auditor**: unaffected — auditor decryption is ECDH+AES-GCM over `txAmountHash`, not
  the hash function itself.
- **Quantum adversary**: unaffected. Both Poseidon and Poseidon2 are symmetric-primitive
  constructions over BN254's scalar field; the field arithmetic's discrete-log hardness (broken by a
  sufficiently large quantum computer) is shared by Groth16 itself regardless of which hash feeds it.
  Neither hash choice makes this better or worse — that's `docs/research/2026-08-15` territory for a
  different night, tracked as its own queue item.

**What this does NOT establish:** whether `@taceo/circom-lib`'s Poseidon2 implementation itself has
been independently audited (it has not, to my knowledge — MIT-licensed, from a named ZK company,
but "not hand-rolled by me" is a lower bar than "audited"). Nothing here changes the RR2 assumption
(dev-only single-contributor trusted setup) — any circuit using this primitive in production would
need its own Groth16 setup ceremony, same as today. Maps to the "Domain-separated Poseidon hashes"
row in `docs/threat-model.md`'s Security Controls Summary Table (would need updating if this were
ever adopted) and RR2 (unchanged — a new circuit still needs a real ceremony before mainnet).

## Approach

**What I built.** Eight standalone, single-hash-call circuits under `circuits/bench/circuits/` — one
`Poseidon(n)` (circomlib) and one `Poseidon2Hash(n)` (wraps `@taceo/circom-lib`'s `Poseidon2(t)`
permutation in a capacity-then-absorb sponge, exactly matching circomlib's `Poseidon(nInputs)` shape)
for each n ∈ {2, 3, 4, 5} — plus:

- `circuits/bench/circuits/poseidon2_hash.circom` — the sponge wrapper. `@taceo/circom-lib`'s
  `Poseidon2(t)` template only ships round constants for t ∈ {2, 3, 4, 8, 12, 16} (not 5, 6, 7), so
  for nInputs = 4 and 5 (needing t = 5 and t = 6) the wrapper pads the state up to t = 8 with
  constrained zeros.
- `circuits/bench/compile.sh` — compiles all eight, runs a dev Groth16 setup (reusing pot15, same
  ptau the production circuits use), matching the existing `circuits/scripts/compile*.sh`
  convention.
- `scripts/bench/poseidon-hash-latency.mjs` — reusable Node proving-time benchmark, same
  warm-up-then-time-N-runs shape as `scripts/bench/prove-latency.mjs`.
- `circuits/bench/negative-test.mjs` — the malicious-witness test (see Results).

I isolated the comparison to single-hash-call circuits rather than swapping the primitive directly
inside `transfer.circom` for two reasons: (1) it isolates the actual variable under test — the hash
primitive's constraint cost — from everything else those circuits do (Merkle membership, range
checks, comparisons), so the delta is unambiguous; (2) it avoids touching a deployed, tested circuit
whose commitment/nullifier scheme every other module and the frontend depend on, before knowing
whether the swap is even worth it. Given tonight's result (see Verdict), that caution paid off.

**What I rejected.** I considered deriving Poseidon2 round constants for t = 5 and t = 6 myself
(directly matching Veil's Poseidon(4)/Poseidon(5) arities with no padding) using the reference
generation script from the Poseidon2 paper's methodology. I rejected this for tonight: verifying
self-derived cryptographic round constants without a trusted second source to diff against is exactly
the kind of "invent a benchmark" risk this loop is supposed to avoid, and getting it wrong produces a
circuit that looks fine in every test but is unsound. Using a named, independently-published
implementation with existing arities — even ones that don't perfectly match Veil's — was the safer
choice for a single-night experiment. This is exactly why the result below matters: it is not
Poseidon2 the permutation coming up short, it's this evaluation of the one concretely available
circom implementation.

I also considered timing the swap inside a full copy of `transfer.circom`. Rejected for the same
reason as above (isolation), plus budget — eight small circuits compile and prove in seconds; a
9,700-line change surface across three circuits with full re-verification would have consumed the
whole night before reaching a verdict.

## Results

### Constraint counts (raw `circom`/`snarkjs r1cs info` output)

| nInputs | Poseidon2 state width (t) | Poseidon (circomlib) constraints | Poseidon2 (`@taceo/circom-lib`) constraints | Delta |
|---|---|---|---|---|
| 2 | 3 (native) | 517 | 580 | **+12.2%** |
| 3 | 4 (native) | 605 | 852 | **+40.8%** |
| 4 | 8 (padded from 5) | 736 | 1,663 | **+126.0%** |
| 5 | 8 (padded from 6) | 835 | 1,663 | **+99.2%** |

Non-linear (S-box) constraints alone are actually competitive or better for Poseidon2 at n=2/n=3
(240 vs 243, 264 vs 264 — see raw output below); the entire regression comes from the **linear**
constraint count, which is far higher for `@taceo/circom-lib`'s implementation even at native widths
(340 vs 274 linear constraints at n=2, no padding involved). This traces to how its
`ExternalMatMulT`/`InternalMatMulT` templates expand the MDS/diagonal linear layer into many named
intermediate signals (`double_in1`, `t_0`..`t_5` per `ExternalMatMul4` call, a running-sum `Acc`
chain per round for t > 4) rather than circomlib's single dense linear combination per output wire
in `Mix`/`MixLast`. That's an implementation/codegen property of this specific library, not a
fundamental property of the Poseidon2 permutation — a hand-optimized implementation could plausibly
close some of this gap. But it is real, measured, and it is what's actually available today.

Raw command and output (transfer's actual arities: n=4 dominates at 4 instances, n=3 at 2-3
instances per circuit per `docs/threat-model.md` domain tags 1-8):

```
$ circom circuits/poseidon1_n4.circom --r1cs --wasm --sym -o build -l ../node_modules
non-linear constraints: 300
linear constraints: 436
wires: 741
$ npx snarkjs r1cs info build/poseidon1_n4.r1cs
[INFO]  snarkJS: # of Constraints: 736

$ circom circuits/poseidon2_n4.circom --r1cs --wasm --sym -o build -l ../node_modules
non-linear constraints: 363
linear constraints: 1300
wires: 1668
$ npx snarkjs r1cs info build/poseidon2_n4.r1cs
[INFO]  snarkJS: # of Constraints: 1663

$ circom circuits/poseidon1_n2.circom --r1cs --wasm --sym -o build -l ../node_modules
non-linear constraints: 243
linear constraints: 274
$ npx snarkjs r1cs info build/poseidon1_n2.r1cs
[INFO]  snarkJS: # of Constraints: 517

$ circom circuits/poseidon2_n2.circom --r1cs --wasm --sym -o build -l ../node_modules
non-linear constraints: 240
linear constraints: 340
$ npx snarkjs r1cs info build/poseidon2_n2.r1cs
[INFO]  snarkJS: # of Constraints: 580

$ circom circuits/poseidon1_n3.circom --r1cs --wasm --sym -o build -l ../node_modules
non-linear constraints: 264
linear constraints: 341
$ npx snarkjs r1cs info build/poseidon1_n3.r1cs
[INFO]  snarkJS: # of Constraints: 605

$ circom circuits/poseidon2_n3.circom --r1cs --wasm --sym -o build -l ../node_modules
non-linear constraints: 264
linear constraints: 588
$ npx snarkjs r1cs info build/poseidon2_n3.r1cs
[INFO]  snarkJS: # of Constraints: 852

$ circom circuits/poseidon1_n5.circom --r1cs --wasm --sym -o build -l ../node_modules
non-linear constraints: 324
linear constraints: 511
$ npx snarkjs r1cs info build/poseidon1_n5.r1cs
[INFO]  snarkJS: # of Constraints: 835

$ circom circuits/poseidon2_n5.circom --r1cs --wasm --sym -o build -l ../node_modules
non-linear constraints: 363
linear constraints: 1300
$ npx snarkjs r1cs info build/poseidon2_n5.r1cs
[INFO]  snarkJS: # of Constraints: 1663
```

### Artifact sizes (zkey / vk, bytes — `stat -c %s`)

| nInputs | Poseidon zkey | Poseidon2 zkey | Poseidon vk | Poseidon2 vk |
|---|---|---|---|---|
| 2 | 254,692 | 274,588 | 2,925 | 2,926 |
| 3 | 285,020 | 364,060 | 2,924 | 2,924 |
| 4 | 330,428 | 698,148 | 2,925 | 2,923 |
| 5 | 364,540 | 698,468 | 2,921 | 2,924 |

vk size is flat (fixed Groth16 verification key shape regardless of constraint count, as expected —
on-chain gas for `sui::groth16::verify` would be unaffected either way, once that number exists).
zkey size (what a client/relayer must fetch to prove) roughly tracks constraint count, so the n=4/n=5
padding cost shows up here too: +111% and +92% respectively.

### Proving time (`node scripts/bench/poseidon-hash-latency.mjs --runs 10`)

```
=== Poseidon vs Poseidon2 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- poseidon1_n2 ---
  mean: 126.49 ms   stddev: 9.22 ms   min: 115.37 ms   max: 142.91 ms
--- poseidon2_n2 ---
  mean: 95.51 ms   stddev: 3.34 ms   min: 89.90 ms   max: 99.93 ms
--- poseidon1_n3 ---
  mean: 126.81 ms   stddev: 6.21 ms   min: 118.35 ms   max: 137.95 ms
--- poseidon2_n3 ---
  mean: 105.55 ms   stddev: 4.55 ms   min: 97.00 ms   max: 114.78 ms
--- poseidon1_n4 ---
  mean: 127.48 ms   stddev: 5.92 ms   min: 120.79 ms   max: 140.34 ms
--- poseidon2_n4 ---
  mean: 144.76 ms   stddev: 7.41 ms   min: 133.36 ms   max: 154.75 ms
--- poseidon1_n5 ---
  mean: 135.19 ms   stddev: 8.53 ms   min: 123.76 ms   max: 152.93 ms
--- poseidon2_n5 ---
  mean: 135.52 ms   stddev: 7.12 ms   min: 125.58 ms   max: 149.89 ms
```

These numbers are real and measured, but at this circuit size (a few hundred to ~1,700 constraints)
proving time is dominated by fixed per-call overhead — WASM instantiation, zkey loading, multiexp
setup — not by constraint count, so the proving-time deltas here are noisy and in two cases (n=2,
n=3) go the *opposite* direction from the constraint-count deltas. `BASELINE.md`'s two real data
points (`withdraw.circom`: 3,058 constraints → 244.3ms; `transfer.circom`: 13,611 constraints →
751.9ms) fit a linear model of roughly 97ms fixed cost + 0.048ms per constraint — consistent with
the ~90-135ms floor seen here. **Extrapolating that model (labelled ESTIMATE, not measured)**: if
`transfer.circom`'s four `Poseidon(4)` instances were swapped for `Poseidon2Hash(4)`, the added
4 × (1,663 − 736) = 3,708 constraints would cost roughly 3,708 × 0.048ms ≈ **+178ms, a ~24% proving
time regression** (752ms → ~930ms) — this is a derived estimate from the baseline's own numbers, not
a fresh measurement, and is presented here only to make clear that the constraint-count result is
the number that would actually matter at production scale, not the noisy micro-benchmark timings
above.

### Soundness — negative test (`node circuits/bench/negative-test.mjs`)

```
Honest witness satisfies R1CS: true
main.out is witness index 1, honest value = 4613963970692078714133635070115442201190588274243934297374057596982776890045
··· aborting checking process at constraint 297
WITNESS IS NOT CORRECT
WITNESS CHECKING FINISHED UNSUCCESSFULLY
Malicious witness (out=4613963970692078714133635070115442201190588274243934297374057596982776890046) satisfies R1CS: false
PASS: malicious witness correctly rejected (R1CS constraint violated).
```

Method: computed an honest witness for `poseidon2_n2` with `inputs = [7, 11]`, confirmed it satisfies
the R1CS (`wtns check`), then tampered the witness vector's `main.out` entry (+1 mod the BN254
scalar field) — i.e. a prover claiming a hash output that doesn't match the real Poseidon2
permutation of the declared inputs — and confirmed `wtns check` rejects it. This is the forgery a
malicious prover would need for a fake commitment or nullifier; it fails at R1CS constraint 297.
I also checked what the .sym file reports for the sponge's capacity element (`main.state[0]`,
constrained `<== 0`): the compiler folds it away entirely (`wireId -1`, no separate witness slot) —
a stronger soundness signal than a checkable constraint, since it means the value literally cannot
exist as anything other than the compiled-in zero.

### Full test suite (production circuits and code — nothing touched by this experiment)

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (credential leaf, Merkle builder, depth-20 tree) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz (fast-check) | **6/6 properties × 500 cases pass** | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Move contracts | **NOT RUN — BLOCKED (see below)** | `cd contracts && sui move test` |

All three circuit test files were re-compiled fresh with real Groth16 setups tonight (`circom` built
from source, same as the 2026-07-22 baseline) to confirm full-proof mode, not the hash-only fallback
— nothing regressed, as expected, since no production circuit file changed.

### On-chain gas (queue item #1) — re-attempted, still BLOCKED, now with concrete evidence

Per `EXPERIMENTS.md`'s note ("worth spending an early part of the next run purely on unblocking the
toolchain"), I spent the first part of tonight on this before pivoting to Poseidon2. Both routes
identified in the 2026-07-22 report are now confirmed blocked at the network-policy layer, not just
"not attempted":

```
$ curl -sS -m 10 -o /dev/null -w "%{http_code}\n" https://fullnode.testnet.sui.io:443
000  (CONNECT tunnel failed, response 403)

$ curl -sS "$HTTPS_PROXY/__agentproxy/status" | jq .recentRelayFailures
[{"kind":"connect_rejected","detail":"gateway answered 403 to CONNECT (policy denial or upstream
  failure)","host":"fullnode.testnet.sui.io:443"}]

$ curl -sS -m 10 -o /dev/null -w "%{http_code}\n" https://github.com/MystenLabs/sui
403
$ curl -sS -m 15 https://api.github.com/repos/MystenLabs/sui/releases/latest
{"message":"GitHub access to this repository is not enabled for this session...

$ curl -sS -m 10 -o /dev/null -w "%{http_code}\n" https://static.crates.io
403
```

JSON-RPC to any public Sui fullnode is denied by this sandbox's egress policy (a hard 403 at the
proxy, not a tool-approval prompt this time). Building `sui` from source is denied two different
ways: this session's GitHub access is scoped to `alexandre-mrt/veil` only (confirmed via the GitHub
MCP server's explicit denial message for `MystenLabs/sui`), and `static.crates.io` — where `cargo`
would fetch crate tarballs from even for a from-source build — is separately blocked by the egress
proxy. Both are session/environment configuration, not something fixable from inside a session.
Genuinely unmeasured, not guessed. Still top of the queue for a future run in a session with
different network permissions.

## Verdict: **REJECT** (for adopting `@taceo/circom-lib`'s Poseidon2 at Veil's current arities)

The hypothesis — that swapping to Poseidon2 reduces constraint count — is false for the one concrete,
available implementation, at every arity Veil actually uses. n=2 and n=3 (Merkle-path hashing,
nullifier/context binding) cost 12-41% more constraints; n=4 and n=5 (commitments, nullifiers,
credential leaves — the highest-volume calls, 4 instances of Poseidon(4) alone in `transfer.circom`)
cost 99-126% more, because `@taceo/circom-lib` has no native round constants for t=5/t=6 and pads to
t=8. No production circuit was changed — there was nothing to revert.

This isn't a rejection of Poseidon2 the permutation. It's a rejection of "swap in the one
off-the-shelf circom implementation available without network access to a wider set of libraries,
at Veil's specific arities, tonight." A future attempt with either (a) an implementation that ships
native t=5/t=6 constants, or (b) independently-verifiable custom round constants for those widths,
could come out differently — see Open questions.

## Where this could be used

- **Any Groth16/Circom protocol evaluating a Poseidon-family hash swap** should measure at their
  *actual* arities before adopting a library, not at whatever widths the library happens to support
  well — the padding cost here (t=5→8, t=6→8) is the kind of thing that looks fine in a library's own
  README benchmarks (which likely test native widths) and turns into a 2x regression in a real
  protocol with odd-arity hash calls.
- **A thesis chapter on proof-system/primitive selection methodology**: the general lesson —
  "benchmark the primitive at the shape your protocol actually needs, not the shape the library
  ships examples for" — generalizes past Poseidon2 to any modular circom-gadget adoption decision
  (Merkle depth, hash arity, batch size).
  Confidential payroll or compliance-gated DeFi teams making the same Poseidon-family
  decision for a credential/commitment scheme should expect the same arity-dependent trap if their
  leaf/commitment hash isn't a round number of inputs.

## Open questions (next queue)

1. **Custom Poseidon2 round constants for t=5 and t=6** (native arities for Veil's `Poseidon(4)`
   and `Poseidon(5)` calls, no padding) — would need independently-verifiable derivation (the
   Poseidon2 paper's reference script or a second published implementation to diff against), not a
   single-session hand-roll. If someone has network access to a broader package/paper mirror in a
   future session, this is the natural follow-up: it could flip today's REJECT into a KEEP by
   removing the t=8 padding tax entirely.
2. **On-chain gas per entry point** (queue item #1) — now confirmed BLOCKED by session network
   policy specifically (not toolchain difficulty). Needs either a session with broader GitHub/crate
   registry access, or a prebuilt `sui` binary reachable from an allowed host. Re-ranked to the top
   again.
3. Could `@taceo/circom-lib`'s linear-layer codegen (the `ExternalMatMul4`/`Acc`-chain signal
   explosion that costs 340 linear constraints for a native t=3 permutation, vs circomlib's 274 for
   the equivalent Poseidon(2)) be collapsed by hand into dense linear combinations without touching
   the round constants? That's a scoped, low-risk optimization to the *implementation*, not the
   *parameters* — worth 30-60 minutes on a lighter night, and would make any future
   Poseidon2 attempt materially more competitive even without solving (1).
4. Mobile WASM proving latency (queue item #8, still open) and relayer throughput/leakage under
   load (queue item #11, still open) — untouched tonight, unchanged from the existing queue.
