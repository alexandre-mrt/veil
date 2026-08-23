# 2026-08-23 — Poseidon2 vs Poseidon: a measured constraint and proving-time delta (queue item #2)

## Hypothesis

Swapping circomlib's Poseidon for a Poseidon2 permutation, with domain tags moved from a rate
element into the sponge's capacity element, measurably reduces non-linear R1CS constraints and
Groth16 proving time for Veil's `transfer.circom` and `withdraw.circom` circuits — the number this
experiment moves is **non-linear constraint count and proving-time (ms) for a full, compiled,
provable fork of each circuit**, not an isolated microbenchmark.

This is queue item #2. It follows up directly on open question #4 from the 2026-07-22 baseline
report ("what fraction of Poseidon-dominated constraints would a Poseidon2 swap actually save").

## What shipped, and what didn't

**Not a change to the deployed protocol.** `pool.move`, the verifying keys, and
`frontend/src/hooks/useProofGeneration.ts` are untouched. Everything below lives under
`scripts/bench/poseidon2/` as a benchmark fork: real `.circom` files, real compiles, real Groth16
proofs that really verify — but not wired into Sui, not the circuit whose proof `sui::groth16`
checks on-chain today. See Verdict for why this stops at PARK rather than KEEP.

## Threat / privacy model

**Leakage delta: none.** A chain observer sees the same five public values for `shielded_transfer`
today (`oldCommitment`, `newCommitment`, `nullifier`, `txAmountHash`, `merkleRoot`) and would see the
same five under this fork — same BN254 field elements, same Groth16 proof shape (3 fixed group
elements, 128 bytes compressed either way, per `BASELINE.md`). This experiment changes which
arithmetic circuit computes those already-public values from private witnesses; it does not change
what becomes public, so it doesn't touch `docs/threat-model.md`'s STRIDE entries or the residual
risks table (RR1–RR6) at all — no new row, no row resolved.

**Adversary this doesn't help against.** PRIV-002 (sender identity visible on-chain), the admin
trust assumptions, the single-auditor key, Sybil resistance — none of that moves. This is a pure
performance experiment.

**Soundness of the redesign.** Two independent changes are bundled and worth separating:

1. **Permutation swap** (Poseidon → Poseidon2). The circom template
   (`circuits/lib/poseidon2.circom`, vendored from `@taceo/circom-lib@0.6.0`, itself sourced from
   TACEO's audited `oprf-circom` repository) was cross-checked against the independent
   `@taceo/poseidon2@0.2.0` JS reference implementation — same team, different codebase and
   language, so a real implementation-bug check, not a tautology. For `t=3`, input `[1,2,3]`:
   circuit witness and JS `bn254.t3.permutation([1n,2n,3n])` agree bit-for-bit (see Results). Round
   constants and the S-box (`x^5`) come from the published Poseidon2 parameter generation, not
   custom-derived — same posture BASELINE.md already takes toward circomlib's Poseidon.
2. **Domain separation moved from rate to capacity.** Today, `Poseidon(4)` for `oldHash` is called
   with `inputs = [1, cumulativeOld, randomnessOld, userSecret]` — the domain tag `1` sits in a rate
   slot indistinguishable, algebraically, from a message element. `Poseidon2Hash(N, T, DS)`
   (`circuits/lib/poseidon2_hash.circom`) instead sets the **capacity** element to `DS` and only
   places real message elements in the rate — `state = [DS, msg[0], ..., msg[N-1], 0-pad]`, one
   `Poseidon2(T)` permutation, digest squeezed from `state[0]`. This is the standard sponge
   domain-separation pattern (it's literally what `@taceo/circom-lib`'s own `Poseidon2SpongeWithDs`
   does in `compression.circom`, of which `Poseidon2Hash` is the fixed single-block case), and if
   anything is *more* conservative than the current rate-tag scheme, not less — the tag is now
   structurally distinguished from the message rather than merely constant-valued. Both schemes
   inherit their collision/preimage resistance from the same source: the permutation's own security
   argument (Poseidon2, like Poseidon, is a permutation-based sponge over BN254's scalar field with
   the same `x^5` S-box and a similar full/partial round structure — no new hardness assumption is
   introduced).
3. **Nullifier/commitment domain separation across circuits is preserved.** Transfer's tags
   (1 = commitment, 2 = nullifier, 3 = tx-amount) and withdraw's (1, 7, 8) remain distinct
   compile-time constants occupying the capacity element per call — cross-tag collision resistance
   is the same property the current design already relies on, just relocated.

**A negative test confirms the constraint is still load-bearing, not decorative** — see Results.

**Assumption this experiment adds, if it were ever merged**: a real deployment would need a **new**
Groth16 trusted-setup ceremony (different R1CS ⇒ different circuit-specific CRS) — the existing
`transfer_final.zkey`/verifying key cannot be reused. That's a real operational cost RR2 already
flags for any circuit change, not a new risk category.

## Approach

**What I built** (all under `scripts/bench/poseidon2/`, `circuits/` reproduces the file tree
described below):

- `circuits/lib/poseidon2.circom`, `poseidon2_constants.circom` — vendored unmodified from
  `@taceo/circom-lib@0.6.0` (MIT, `LICENSE-taceo-circom-lib`). Supports state widths
  `t ∈ {2, 3, 4, 8, 12, 16}` — notably **not** `t=5` or `t=6`, which matters below.
- `circuits/lib/poseidon2_hash.circom` — `Poseidon2Hash(N, T, DS)`, the capacity-domain-separated
  single-block sponge described above, plus `Poseidon2Compress2()` for the no-domain-tag 2-to-1
  Merkle case.
- `circuits/lib/merkle_proof_poseidon2.circom` — structural copy of
  `circuits/templates/merkle_proof.circom` with only the hash line swapped
  (`Poseidon(2)` → `Poseidon2Compress2()`), so any constraint delta is attributable to the hash
  alone.
- `circuits/shapes/shape_{a,b,c,d}_{poseidon,poseidon2}.circom` — 8 tiny isolated circuits, one pair
  per hash *shape* Veil actually uses (by message-length + domain-tag pattern), for a clean
  per-call-shape comparison independent of any full circuit's other constraints:
  - **A**: 2-to-1, no domain tag (the Merkle-path hash, called **20×** per transfer/compliance proof)
  - **B**: 1 tag + 2 message elements (`txHash`; compliance's `nfHash`/`ctxHash`)
  - **C**: 1 tag + 3 message elements (`oldHash`/`newHash`/transfer-`nfHash`; withdraw's
    `commHash`/`changeHash`/`nfHash` — Veil's single most common hash shape, 6 instances total)
  - **D**: 1 tag + 4 message elements (compliance's `leafHash` — the one shape that needs `t=5`,
    which Poseidon2 doesn't have a parameter set for; forced up to `t=8` instead)
- `circuits/forked/transfer_poseidon2.circom`, `withdraw_poseidon2.circom` — full, line-for-line
  forks of the production circuits with every `Poseidon(n)` call replaced by the matching
  `Poseidon2Hash` call. Every non-hash line (range checks, comparators, the cumulative-sum equation)
  is character-identical to the original.
- `witness-transfer-poseidon2.mjs` — witness builders using `@taceo/poseidon2`'s JS permutation,
  with the **same numeric values** as the existing `scripts/bench/witnesses.mjs` builders (same
  `cumulativeOld`, `txAmount`, `userSecret`, etc.), so the only variable between a Poseidon witness
  and a Poseidon2 witness is the hash function.
- `prove-bench.mjs` — Groth16 `fullProve` + `verify` timing harness, same shape as the existing
  `scripts/bench/prove-latency.mjs`.

**What I rejected.** Compiling only at `--O1` (circom's default, and what `circuits/scripts/compile.sh`
uses, so what `BASELINE.md`'s existing numbers reflect) turned out to make Poseidon2 look strictly
*worse* — see Results. I considered reporting only O1 numbers to stay consistent with the existing
baseline's methodology, and rejected it: it would hide the actual reason (unswept linear
intermediate signals in the permutation's matrix-multiplication gadgets, not the permutation itself)
behind a number that looks like a verdict on Poseidon2. Both O1 and O2 numbers are reported below,
labeled.

I did not attempt to generate custom Poseidon2 round constants for `t=5`/`t=6` to give
`leafHash` a native-width parameter set — deriving fresh round constants for an unpublished state
size and then arguing their security is a materially bigger, riskier undertaking than benchmarking
with what's already published and audited-adjacent; flagged as an open question instead.

I did not fork `compliance.circom`. It's the one circuit containing the `t=5`-shaped `leafHash`
(shape D, measured *worse* with Poseidon2 in isolation) mixed with two `t=3`-shaped calls (shape B,
measured *better*) and its own 20× Merkle path (shape A, roughly flat) — the net direction for the
whole circuit isn't obvious from the shape-level deltas alone and I did not want to report a guess
as a circuit-level number. Queued as an open question.

## Results

### Poseidon2 permutation correctness (cross-check against independent JS reference)

```
$ circom circuits/lib/perm_check_t3.circom --r1cs --wasm --sym --output build/perm_check
$ echo '{"in": ["1","2","3"]}' > build/perm_check/input.json
$ npx snarkjs wtns calculate build/perm_check/perm_check_t3_js/perm_check_t3.wasm \
    build/perm_check/input.json build/perm_check/witness.wtns
$ npx snarkjs wtns export json build/perm_check/witness.wtns build/perm_check/witness.json
$ python3 -c "import json; print(json.load(open('build/perm_check/witness.json'))[1:4])"
['4737982494702600552753609419126955242994596445692557044681458296415162795880',
 '9698155156890762076414037574068404457164720954413259397447872502075783415658',
 '18259628997120261506554896720810362547891614655348127750921457211768261324825']
```

```js
// JS reference, @taceo/poseidon2@0.2.0
> m.bn254.t3.permutation([1n,2n,3n]).map(x=>x.toString())
[ '4737982494702600552753609419126955242994596445692557044681458296415162795880',
  '9698155156890762076414037574068404457164720954413259397447872502075783415658',
  '18259628997120261506554896720810362547891614655348127750921457211768261324825' ]
```

**Bit-for-bit match.** The vendored circom permutation and the independent JS implementation agree.

### Negative test — a malicious witness is rejected

```
$ node -e "... inputs.oldCommitment = (BigInt(inputs.oldCommitment) + 1n).toString(); ..."
$ npx snarkjs wtns calculate \
    build/transfer_poseidon2_o2/transfer_poseidon2_js/transfer_poseidon2.wasm \
    build/transfer_poseidon2_o2/malicious_input.json \
    build/transfer_poseidon2_o2/malicious_witness.wtns

ERROR:  4 Error in template TransferPoseidon2_29 line: 41
[ERROR] snarkJS: Error: Error: Assert Failed. Error in template TransferPoseidon2_29 line: 41
```

Line 41 is `oldCommitment === oldHashOut;` — flipping one bit of the public `oldCommitment` input,
with everything else left as a real, otherwise-valid witness, makes witness generation fail outright
(not "produces an invalid proof that verification would later catch" — the constraint is unsatisfiable
before a proof can even be constructed). The domain-separated-capacity commitment binding is
load-bearing, not decorative.

### Shape-level constraint counts (isolated single-hash circuits, `--O2`, fully reduced)

At `--O2` all four pairs compile to **zero linear constraints** (full R1CS simplification sweeps
every purely-additive intermediate signal), so non-linear count *is* the total.

| Shape | Pattern | Where in Veil | Poseidon | Poseidon2 | Δ |
|---|---|---|---|---|---|
| A | 2-to-1, no tag | Merkle path, ×20/proof | 240 | 240 | 0 |
| B | 1 tag + 2 msg | `txHash`; compliance `nfHash`/`ctxHash` | 258 | 240 | **−7.0%** |
| C | 1 tag + 3 msg | `oldHash`/`newHash`/`nfHash`; withdraw `commHash`/`changeHash`/`nfHash` | 294 | 264 | **−10.2%** |
| D | 1 tag + 4 msg | compliance `leafHash` (forced t=8, no native t=5) | 318 | 363 | **+14.2%** |

```
$ circom circuits/shapes/shape_c_poseidon.circom  --r1cs --sym --O2 --output build/shapes_o2
non-linear constraints: 294
$ circom circuits/shapes/shape_c_poseidon2.circom --r1cs --sym --O2 --output build/shapes_o2
non-linear constraints: 264
```
(all 8 raw compiler outputs in the PR diff / `build/shapes_o2/` — gitignored, reproducible via the
commands above)

### Full-circuit constraint counts

**At `--O1` (circom's default, and `circuits/scripts/compile.sh`'s flag — same methodology as the
existing `BASELINE.md`):**

| Circuit | Poseidon (baseline) | Poseidon2 fork | Δ total |
|---|---|---|---|
| `transfer.circom` | 13,611 (6,470 NL / 7,141 L) | 15,194 (6,278 NL / 8,916 L) | **+11.6% (worse)** |
| `withdraw.circom` | 3,058 (1,465 NL / 1,593 L) | 3,372 (1,330 NL / 2,042 L) | **+10.3% (worse)** |

**At `--O2` (full simplification — what the isolated shapes above also used):**

| Circuit | Poseidon (baseline, recompiled) | Poseidon2 fork | Δ non-linear |
|---|---|---|---|
| `transfer.circom` | 6,384 NL / 0 L | 6,276 NL / 0 L | **−1.7%** |
| `withdraw.circom` | 1,439 NL / 0 L | 1,328 NL / 0 L | **−7.7%** |

Raw output:

```
$ circom circuits/forked/transfer_poseidon2.circom --r1cs --wasm --sym --output build/transfer_poseidon2
non-linear constraints: 6278
linear constraints: 8916

$ circom circuits/forked/transfer_poseidon2.circom --r1cs --wasm --sym --O2 --output build/transfer_poseidon2_o2
non-linear constraints: 6276
linear constraints: 0

$ circom transfer.circom --r1cs --sym --O2 --output .../transfer_orig_o2 -l node_modules   # (recompiled from circuits/)
non-linear constraints: 6384
linear constraints: 0

$ circom circuits/forked/withdraw_poseidon2.circom --r1cs --sym --output build/withdraw_poseidon2_o1
non-linear constraints: 1330
linear constraints: 2042

$ circom withdraw.circom --r1cs --sym --output .../withdraw_orig_o1 -l node_modules
non-linear constraints: 1465
linear constraints: 1593

$ circom circuits/forked/withdraw_poseidon2.circom --r1cs --wasm --sym --O2 --output build/withdraw_poseidon2_o2
non-linear constraints: 1328
linear constraints: 0

$ circom withdraw.circom --r1cs --wasm --sym --O2 --output .../withdraw_orig_o2 -l node_modules
non-linear constraints: 1439
linear constraints: 0
```

**Why O1 and O2 disagree in direction.** Poseidon2's `ExternalMatMulT`/`InternalMatMulT` gadgets
(`circuits/lib/poseidon2.circom`) introduce many purely-additive intermediate signals (`sum`,
`t_0`..`t_5`, `double_in1`, etc. — see the vendored source). circom's default `--O1` only performs
signal-to-signal/signal-to-constant simplification, not full Gaussian elimination, so those
intermediates survive into the R1CS as extra linear constraints — more of them than circomlib's
hand-tuned `Mix`/`MixS` templates leave behind at the same flag. `--O2` sweeps every one of them
away for both circuits, at which point Poseidon2's real non-linear-constraint advantage (fewer,
higher-degree rounds needing fewer `Sbox` calls per bit of security margin) shows through. **This
means `circuits/scripts/compile.sh` not passing `--O2` is costing Veil real, measurable proving
budget today, independent of Poseidon2 entirely** — see Open questions.

### Proving time (`--O2`-compiled circuits, real Groth16 setup + dev contribution, mean of 10 `groth16.fullProve` runs, both circuits' proofs `groth16.verify`d `true`)

| Circuit | Poseidon (mean, σ) | Poseidon2 (mean, σ) | Δ |
|---|---|---|---|
| `transfer.circom` | 640.34 ms (σ 12.11) | 578.38 ms (σ 11.76) | **−9.7%** |
| `withdraw.circom` | 226.72 ms (σ 5.32) | 187.99 ms (σ 3.26) | **−17.1%** |

```
=== Veil Poseidon vs Poseidon2 Groth16 proving-time bench (10 runs each) ===
node v22.22.2, linux/x64

--- transfer.circom (circomlib Poseidon, --O2) ---
  verify(warm-up proof): true
  runs: 10
  mean: 640.34 ms   stddev: 12.11 ms   min: 616.91 ms   max: 654.08 ms

--- transfer_poseidon2.circom (Poseidon2, --O2) ---
  verify(warm-up proof): true
  runs: 10
  mean: 578.38 ms   stddev: 11.76 ms   min: 565.68 ms   max: 604.39 ms

--- withdraw.circom (circomlib Poseidon, --O2) ---
  verify(warm-up proof): true
  runs: 10
  mean: 226.72 ms   stddev: 5.32 ms   min: 219.38 ms   max: 236.17 ms

--- withdraw_poseidon2.circom (Poseidon2, --O2) ---
  verify(warm-up proof): true
  runs: 10
  mean: 187.99 ms   stddev: 3.26 ms   min: 181.54 ms   max: 192.71 ms
```

Reproduce: `node scripts/bench/poseidon2/prove-bench.mjs --runs 10` (needs the `--O2` `build/*_o2/`
artifacts + Groth16 setup — commands above and in the script header).

The proving-time reduction (−9.7% to −17.1%) is proportionally larger than the non-linear
constraint reduction (−1.7% to −7.7%). Plausible reading: Groth16 prover cost isn't purely linear
in constraint count — witness-generation cost (evaluating the `x^5` S-box fewer times per hash) and
MSM/FFT overhead both contribute, and this experiment doesn't isolate which. Flagged as an open
question rather than explained away.

### Test suite (production circuits, unmodified by this experiment — run in full)

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `cd circuits && npm test` (the `&&`-chaining hang noted in the 2026-07-22 report was fixed by PR #17 on 2026-07-28 — re-confirmed working tonight, former queue item 13 removed) |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz | **6/6 properties, 500 runs each, all passed** | `cd scripts && bun run src/fuzz-tests.ts` |
| Move contracts | **NOT RUN** | `sui` CLI unavailable this session (see on-chain gas section above); no Move code touched by this experiment, so risk from skipping is the same pre-existing gap noted in the 2026-07-22 report, not a new one |

This experiment adds no new production test file — the production circuits are untouched.
Correctness of the benchmark fork itself rests on the permutation cross-check and negative test
above, both reproducible from this document.

### On-chain gas (queue item #1) — re-attempted, still BLOCKED, now precisely diagnosed

Before starting Poseidon2, I retried unblocking item #1 per `EXPERIMENTS.md`'s own note ("worth
spending an early part of the next run purely on unblocking the toolchain"). This session's sandbox
network proxy allowlists a fixed set of hosts (`registry.npmjs.org`, `pypi.org`, `crates.io`'s
index, `proxy.golang.org`, Anthropic endpoints, and a few more — see `/root/.ccr/README.md`).
Direct HTTPS to both plausible sources returned **403 at the CONNECT layer**, confirmed this session:

```
$ curl -sSIL https://api.github.com/repos/MystenLabs/sui/releases/latest
403
$ curl -sS -X POST https://fullnode.testnet.sui.io:443 -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'
curl: (56) CONNECT tunnel failed, response 403
```

This is a **hard network-policy block**, not the transient tool-approval denial the 2026-07-22
report hit — no amount of retrying either path will change the outcome without the proxy allowlist
changing. `git clone https://github.com/...` *does* work (the proxy special-cases git's smart-HTTP
protocol — confirmed by cloning `iden3/circom` v2.2.2 for this experiment's toolchain), so a
from-source Sui build is technically reachable in a way plain HTTPS downloads aren't — but building
the full Sui workspace (validator, Move VM, RocksDB) from source remains a multi-night undertaking
on its own, not something to start as a side effect of a Poseidon2 experiment. Still top of the
queue, diagnosis updated.

## Verdict: **PARK**

The core hypothesis is **confirmed true for the dominant hash shapes**, with real, cross-validated,
verifying numbers: Poseidon2 measurably reduces both non-linear constraints (−1.7% to −7.7% at full
circuit scale, −7% to −10% at the isolated single-hash level for shapes B/C) and Groth16 proving
time (−9.7% to −17.1%) for `transfer.circom` and `withdraw.circom`, **provided the circuit is
compiled with `--O2`**.

It doesn't reach KEEP tonight because:

1. **Not a clean sweep.** Shape D (`leafHash`, compliance's one `t=5`-shaped hash) is measurably
   *worse* with the available Poseidon2 parameter sets (no native `t=5`, forced to `t=8`:
   +14.2% non-linear in isolation). `compliance.circom`'s net direction is unmeasured.
2. **Compiler-flag sensitivity discovered mid-experiment.** At Veil's actual current build flags
   (`circuits/scripts/compile.sh`, no `--O2`), this exact same swap makes both forked circuits
   *worse* (+10–12% total constraints) — the win is real but conditional on a build-tooling change
   that hasn't happened yet and is itself untested against the full existing test suite.
3. **A real migration needs a fresh trusted-setup ceremony** for new verifying keys, Move-side
   verifier updates, and frontend hashing changes — none of which is one night's work, and none of
   which was attempted here.

Branch and forked circuits stay in the repo (`scripts/bench/poseidon2/`) — the knowledge and the
reproducible harness survive even though nothing is merged into the deployed protocol.

## Where this could be used

- **Any Circom/Groth16 protocol computing domain-separated commitments/nullifiers over a small,
  fixed message length** (2–3 field elements plus a tag — the majority shape in note-based UTXO
  designs) gets a real, measured proving-time win from this exact swap, provided their build
  pipeline uses full R1CS simplification. The capacity-domain-separation pattern
  (`Poseidon2Hash(N, T, DS)`) is directly reusable, not Veil-specific.
- **Any protocol whose message length needs `t=5` or `t=6`** (5- or 6-element domain-separated
  hashes) hits the exact gap this experiment found: the most common off-the-shelf Poseidon2
  parameter sets skip those widths, and padding up to `t=8` can cost more than it saves. Worth
  knowing before committing to a Poseidon2 migration sight-unseen.
- **A thesis chapter or protocol audit checklist on "does switching hash primitives actually help"**
  — the O1-vs-O2 finding here is the more broadly reusable lesson: constraint-count and
  proving-time claims about a hash-function swap are meaningless without stating the compiler
  optimization level, because unswept linear intermediates can flip the sign of the result.

## Open questions (next queue)

1. **Does `--O2` help the *existing* production circuits too, independent of Poseidon2?** This
   experiment only compiled `transfer.circom`/`withdraw.circom` at `--O2` as a comparison baseline
   for the fork — it didn't check whether `circuits/scripts/compile.sh` switching to `--O2` changes
   proving time, witness-generation time, or `groth16 setup` time for the *deployed* circuits, and
   whether that's safe (same `.zkey`/verifying-key output, or does R1CS structure change enough to
   need a new setuo just from the flag?). Cheap, high-value, no protocol change — good candidate for
   a lighter night.
2. **`leafHash` (shape D) and `compliance.circom`'s net direction.** Either derive/verify Poseidon2
   round constants for `t=5`/`t=6` (bigger, needs real security justification for
   non-published parameters) or redesign `leafHash` as two chained `t=4` calls (message length 4
   split 3+1 or 2+2, still domain-separated) and measure whether that beats both the current
   Poseidon(5) and the padded-to-t=8 Poseidon2 approach.
3. **Fork `compliance.circom` fully** once (2) has an answer, to get the complete three-circuit
   picture this report is missing.
4. **The proving-time delta exceeds the constraint-count delta proportionally** (−9.7%/−17.1% vs
   −1.7%/−7.7%) — worth isolating whether that's witness-generation cost (fewer `x^5` evaluations)
   or Groth16 MSM/FFT structure, with a witness-generation-only timing split.
5. On-chain gas (queue item #1) — still blocked on `sui` CLI / RPC network access; now precisely
   diagnosed as a proxy allowlist rather than a retriable denial.
