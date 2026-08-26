# 2026-08-26 — Poseidon2 vs Poseidon at Veil's actual arities (queue item #2)

## Hypothesis

Swapping Veil's Poseidon(n) calls (circomlib, BN254) for Poseidon2 (a real, audited-lineage
implementation, `@taceo/circom-lib`) reduces total R1CS constraint count — and therefore Groth16
proving time — at every arity Veil's circuits actually call Poseidon with: n = 2 (Merkle path
siblings, recipient hash), n = 3 (tx-amount hash, compliance nullifier/context hash), n = 4
(commitment/nullifier hashes — Veil's heaviest-used arity), n = 5 (compliance credential leaf hash).
This experiment moves "R1CS constraint delta and Groth16 proving-time delta between Poseidon and
Poseidon2, at Veil's real arities" from a guess (queue item #2's framing) to four real, measured
numbers per arity.

Before tonight this was pure speculation: `docs/research/EXPERIMENTS.md` queued it as "the
highest-leverage next number" based only on Poseidon2's known algebraic improvements (fewer full
rounds, cheaper linear layer) — never checked against what happens when a specific state size isn't
available off the shelf, which turns out to be exactly Veil's situation for its two most-used
arities.

## Threat / privacy model

**Adversary and assumptions carried over unchanged.** No production circuit, Move module, or
frontend code changed tonight — `circuits/transfer.circom`, `withdraw.circom`, and
`compliance.circom` are byte-for-byte what they were before this experiment. Groth16 soundness
under BN254 discrete log, and the dev-only trusted setup's toxic waste not being production-safe
(`docs/threat-model.md` RR2), are unchanged. Nothing here touches `docs/threat-model.md`'s S2/S3
(proof forgery/replay) or E4/E7 (amount/recipient binding) mitigations, because the hash function
those mitigations rely on was not swapped.

**What this experiment's own numbers are relied on for**: the same audience as the 2026-07-22
baseline report — this research loop's own future nights, deciding whether a Poseidon2 migration
is worth a multi-night circuit-rewrite-plus-new-ceremony effort. A wrong number here would send a
future night down a real engineering effort (new circuits, new trusted setup, new on-chain
verifying keys, frontend/relayer updates) chasing a proving-time win that doesn't exist. That is the
concrete cost of an unverified number in this specific report.

**Domain-separation angle (why this matters for I2/I6/S3).** Veil's current convention bakes a
domain tag into `in[0]` of every `Poseidon(n)` call — e.g. `nullifier = Poseidon(2, userSecret,
epochId, randomnessOld)` in `transfer.circom`, where `2` is the tag. The tag is *data*: it occupies
one of the `n` rate-equivalent input slots and is hashed exactly like real data would be.
`Poseidon2Sponge(n, t, DS)` (the construction benched tonight) instead places `DS` in the sponge's
**capacity** element — a state slot the absorbed inputs never touch. This is architecturally a
stronger separation (the tag lives outside the space an attacker's chosen inputs can reach at all,
rather than merely being one more value XORed into that space), which is relevant to
`docs/threat-model.md` I6 (nullifier pseudorandomness / no cross-context collision) and S3
(replay via a colliding hash across two circuits/domains) if Veil ever revisits its domain-tagging
scheme. Tonight's `poseidon2-domain-separation-check.mjs` (see Results) confirms this behaves as
expected for the exact circuit benched — same inputs, same tag → same output; same inputs,
different tag → different output — but this is a sanity check on the one construction as used here,
**not** a new soundness proof and not a claim that circomlib's current in-band tagging is broken
(it isn't; S3/I6 are marked Mitigated for a reason, and this experiment doesn't change that).

**What this does NOT establish.** It says nothing about Poseidon2's cryptanalytic security margin
relative to Poseidon (that's a settled question in the literature, not something this experiment
tests), and nothing about whether the projected production-circuit numbers in Results (computed,
not measured — see caveat there) would hold exactly if someone actually rewrote the circuits.

## Approach

**What I built.**

- `circuits/bench-poseidon2/templates.circom` — two wrapper templates: `PoseidonHashN(n)`
  (circomlib `Poseidon(n)`, exactly Veil's existing call convention) and `Poseidon2HashN(n, t)`
  (`@taceo/circom-lib`'s `Poseidon2Sponge(n, t, DS)`, one fixed compile-time domain tag).
- Eight tiny entry circuits (`poseidon_n{2,3,4,5}.circom`, `poseidon2_n{2,3,4,5}.circom`) — each is
  just `component main = <template>(...)`, isolating one hash call so constraint counts and proving
  time measure the hash alone, not a whole production circuit.
- `poseidon2_ds_test.circom` — one more circuit exposing the domain tag as a circuit *input*
  (`Poseidon2SpongeWithDs`, runtime `ds` signal) rather than a compile-time constant, so a single
  compiled circuit can be re-witnessed under two different tags for the domain-separation check.
- `scripts/bench/compile-poseidon2-bench.sh` — compiles all 9 circuits and runs a full (throwaway,
  local, single-contribution) Groth16 setup for the 8 hash-comparison circuits.
- `scripts/bench/poseidon2-arity-bench.mjs` — reads real `snarkjs r1cs info` output and times 10
  `groth16.fullProve` runs per circuit (same methodology as `prove-latency.mjs`).
- `scripts/bench/poseidon2-domain-separation-check.mjs` — the determinism/no-collision sanity check
  described above.

**Arity → Poseidon2 state-size mapping.** `@taceo/circom-lib`'s `Poseidon2(t)` only ships round
constants for `t ∈ {2, 3, 4, 8, 12, 16}` (fixed at the permutation level, not something this
experiment can safely change — see Results). `Poseidon2Sponge(n, t, DS)` absorbs at rate `t - 1`.
To keep the comparison a single-permutation call (matching circomlib's `Poseidon(n)`, which is also
exactly one permutation), I chose the smallest supported `t` with `t - 1 >= n`:

| Veil arity (n) | Poseidon2 state size (t) | Rate (t-1) | Slack |
|---|---|---|---|
| 2 | 3 | 2 | 0 |
| 3 | 4 | 3 | 0 |
| 4 | 8 | 7 | 3 (wasted) |
| 5 | 8 | 7 | 2 (wasted) |

This slack — no supported state size between t=4 and t=8 — is the central finding. It is not a bug
in the bench; it is a real, load-bearing gap in the off-the-shelf library that directly determines
whether the swap is worth doing (see Results).

**What I rejected.**

- *Modifying the production circuits directly.* A real swap needs a new trusted-setup ceremony,
  new on-chain verifying keys (`transfer_vk`/`withdraw_vk`/`compliance_vk`, each timelocked —
  `docs/threat-model.md` T3), and frontend/relayer updates — a multi-night effort that should only
  start once the constraint/proving-time delta is known to be a real win. Isolating the hash calls
  in standalone circuits gets a real, reproducible per-instance number without any of that risk, and
  without touching anything a `sui move test` or the deployed testnet package depends on.
- *Generating custom Poseidon2 round constants for t=5 or t=6* to match Veil's n=4/n=5 arities
  exactly (no waste). This would close the gap this experiment found, but round-constant generation
  for a novel permutation instance is itself a security-sensitive undertaking (the constants must
  resist known attacks — see the Poseidon2 paper's generation procedure) that deserves its own
  careful night, not a shortcut taken to make tonight's numbers look better. Queued below.
- *Using `Poseidon2Sponge`'s multi-permutation path for n > t-1* (e.g. forcing t=3 for n=4 by
  absorbing in two chunks) instead of jumping to the next supported t. Rejected because it changes
  the security argument (two permutation calls instead of one, different collision-resistance
  bookkeeping) in a way that would need its own analysis, and circomlib's `Poseidon(n)` — the
  baseline being compared against — is always a single permutation, so a fair single-variable
  comparison keeps Poseidon2 single-permutation too.

## Results

### Constraint counts (raw `circom`/`snarkjs r1cs info` output, both compiled with identical
default optimization — no `-O` flag, matching `circuits/scripts/compile*.sh`)

| n | Poseidon(n) constraints | Poseidon2 t | Poseidon2Sponge constraints | Δ (constraints) | Δ (%) |
|---|---|---|---|---|---|
| 2 | 517 (243 non-linear + 274 linear) | 3 | 580 (240 non-linear + 340 linear) | **+63** | +12% |
| 3 | 605 (264 non-linear + 341 linear) | 4 | 852 (264 non-linear + 588 linear) | **+247** | +41% |
| 4 | 736 (300 non-linear + 436 linear) | 8 | 1663 (363 non-linear + 1300 linear) | **+927** | +126% |
| 5 | 835 (324 non-linear + 511 linear) | 8 | 1663 (363 non-linear + 1300 linear) | **+828** | +99% |

Non-linear-constraint counts (the actual multiplication gates) are close for n=2/n=3 and only
moderately higher for n=4/n=5 — Poseidon2's per-round algebra genuinely is cheaper. The blowup is
almost entirely in **linear constraints**, driven by the bigger `ExternalMatMulT`/`InternalMatMulT`
linear layers at t=8 versus t=5/6 that don't exist, and by 3–2 wasted rate slots per call at n=4/n=5.

Raw compile output (`bash scripts/bench/compile-poseidon2-bench.sh`, full log has all 8):

```
── compiling poseidon_n4 ──
non-linear constraints: 300
linear constraints: 436
public inputs: 0
private inputs: 4
[INFO]  snarkJS: # of Wires: 741
[INFO]  snarkJS: # of Constraints: 736

── compiling poseidon2_n4 ──
non-linear constraints: 363
linear constraints: 1300
public inputs: 0
private inputs: 4
[INFO]  snarkJS: # of Wires: 1668
[INFO]  snarkJS: # of Constraints: 1663

── compiling poseidon_n5 ──
non-linear constraints: 324
linear constraints: 511
[INFO]  snarkJS: # of Constraints: 835

── compiling poseidon2_n5 ──
non-linear constraints: 363
linear constraints: 1300
[INFO]  snarkJS: # of Constraints: 1663
```

### Proving time (`node scripts/bench/poseidon2-arity-bench.mjs --runs 10`, mean of 10 runs,
Node.js v22.22.2, linux/x64, same machine as the 2026-07-22 baseline)

| n | Poseidon(n) mean (σ) | Poseidon2 mean (σ) | Δ | Verdict at this arity |
|---|---|---|---|---|
| 2 | 125.27 ms (9.85) | 101.05 ms (4.13) | **-19.3%** | Poseidon2 faster |
| 3 | 129.79 ms (10.45) | 105.32 ms (7.19) | **-18.9%** | Poseidon2 faster |
| 4 | 137.01 ms (7.38) | 143.24 ms (6.70) | **+4.5%** | Poseidon2 slower |
| 5 | 138.92 ms (9.05) | 145.79 ms (2.23) | **+4.9%** | Poseidon2 slower |

Raw output:

```
--- n=2 (Poseidon2 t=3) ---
Poseidon(2) proving:  mean 125.275 ms  stddev 9.854 ms
Poseidon2(2) proving: mean 101.050 ms  stddev 4.133 ms

--- n=3 (Poseidon2 t=4) ---
Poseidon(3) proving:  mean 129.790 ms  stddev 10.451 ms
Poseidon2(3) proving: mean 105.318 ms  stddev 7.189 ms

--- n=4 (Poseidon2 t=8) ---
Poseidon(4) proving:  mean 137.007 ms  stddev 7.378 ms
Poseidon2(4) proving: mean 143.244 ms  stddev 6.696 ms

--- n=5 (Poseidon2 t=8) ---
Poseidon(5) proving:  mean 138.924 ms  stddev 9.045 ms
Poseidon2(5) proving: mean 145.794 ms  stddev 2.230 ms
```

**Why n=2/n=3 prove faster despite more constraints, while n=4/n=5 prove slower**: at this tiny
scale, both circuits round up to the *same* Groth16 QAP domain size regardless of the exact
constraint count within a power-of-2 bracket (n=2: 517 and 580 both round to 1024; n=3: 605 and 852
both round to 1024), so the constraint-count delta barely moves the FFT/MSM cost, and fixed overhead
(WASM witness calculation, artifact loading) dominates the ~100–150ms measured — Poseidon2's cheaper
per-round arithmetic wins on that overhead. n=4 (736 → 1663) and n=5 (835 → 1663) each cross from a
1024 domain to a 2048 domain — real domain-size growth — yet proving time only rose ~5%, again
because total time is still overhead-dominated at this scale. **Neither effect is what would
determine the outcome inside a 13,000+ constraint production circuit, where FFT/MSM cost is the
dominant term, not fixed overhead** — see the projection below.

### Domain-separation check (`node scripts/bench/poseidon2-domain-separation-check.mjs`)

```
same in[], ds=111        -> out: 13027772101444621329955239757582538978981999789264178538603725174510733255067
same in[], ds=222        -> out: 21267787072668683788878775671459530466581090556815129311716321797089124602055
same in[], ds=111 repeat -> out: 13027772101444621329955239757582538978981999789264178538603725174510733255067

same (in, ds) -> same output (determinism):        true
different ds -> different output (no collision):    true

PASS
```

### Test suite

No production circuit changed, so the existing suites are unaffected by this experiment; run in
full anyway per the loop's standing rule:

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs) | **108/108 pass** | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` (run individually — the `&&`-chain hang from 2026-07-22 is still open, queue item unchanged) |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** — `sui` CLI still unavailable this session (see below) | `sui move test` |

No test was loosened, skipped, or given new tolerance.

### On-chain gas re-check (queue item #1, re-attempted before starting tonight's experiment)

Per the queue's note to spend early time unblocking this before moving on: re-tested both paths
blocked on 2026-07-22. Both are still denied, now confirmed as **organization egress policy**, not
a transient failure:

```
$ curl -sS -o /dev/null -w "HTTP %{http_code}\n" https://github.com/MystenLabs/sui/releases
HTTP 403
$ curl -sS -X POST ... https://fullnode.testnet.sui.io:443
curl: (56) CONNECT tunnel failed, response 403
$ curl -sS http://127.0.0.1:35021/__agentproxy/status
"recentRelayFailures": [{"kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "fullnode.testnet.sui.io:443"}]
```

Per the proxy's own guidance ("do not retry or route around it — report the blocked host"), I did
not retry further and moved to tonight's queue item #2. Still top of `EXPERIMENTS.md` for the next
run — needs either an explicit egress-policy exception for `fullnode.testnet.sui.io` /
`github.com/MystenLabs/sui/releases`, or a `sui` binary reachable another way (npm has none; checked
tonight while investigating circom's own npm-availability — see next paragraph).

**Bonus toolchain finding, not this experiment's hypothesis but worth recording**: 2026-07-22's
`circom`-unavailable blocker (which required a `cargo build --release` of a cloned `iden3/circom`)
has a simpler fix — `circom2` (npm, WASM build of the same compiler, `circom compiler 2.2.3`)
reproduces `transfer.circom`'s exact documented constraint counts (13,611 total, 6,470 non-linear,
7,141 linear, matching `BASELINE.md` exactly) with no build step and no GitHub access needed.
`compile-poseidon2-bench.sh` uses it as a fallback when no `circom` binary is on `PATH`. Not applied
to `circuits/scripts/compile*.sh` tonight (out of scope — those scripts work fine when `circom` is
already installed, which is the common case) but worth a future night if the native-build path
keeps needing GitHub access this sandbox doesn't reliably have.

### Projected effect on production circuits (computed, NOT measured — see caveat)

Summing tonight's real per-instance deltas by how many times each arity is called in each
production circuit (call counts from grep against `transfer.circom`, `withdraw.circom`,
`compliance.circom`, `templates/merkle_proof.circom`; both use a depth-20 Merkle proof, i.e. 20×
`Poseidon(2)` calls each):

| Circuit | Current total (BASELINE.md) | Poseidon(n) calls | Projected Δ | Projected total | Current domain | Projected domain |
|---|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 3×n=4 (+927 ea) + 1×n=3 (+247) + 20×n=2 (+63 ea) | **+4,288** | **17,899** | 16,384 | **32,768 (2x)** |
| `compliance.circom` | 12,743 | 1×n=5 (+828) + 2×n=3 (+247 ea) + 20×n=2 (+63 ea) | **+2,582** | **15,325** | 16,384 | 16,384 (no change) |
| `withdraw.circom` | 3,058 | 3×n=4 (+927 ea) + 1×n=2 (+63) | **+2,844** | **5,902** | 4,096 | **8,192 (2x)** |

**This row is a computed projection, not a measurement** — it sums isolated single-hash-call
constraint counts, which is structurally reasonable here (each Poseidon call in these circuits
operates on independent wires — no cross-call signal sharing for the optimizer to exploit either
way) but has not been verified by actually rewriting and compiling the full circuits. Labeled
UNMEASURED per the loop's rule; do not cite the "17,899" / "15,325" / "5,902" figures as measured
facts.

Even as a projection, the qualitative result is decisive: **swapping to Poseidon2 via this library,
as-is, would very likely push both `transfer.circom` and `withdraw.circom` across a Groth16 domain-
size doubling** (16,384→32,768 and 4,096→8,192 respectively) — i.e., roughly double the real FFT/MSM
cost that dominates proving time at production scale, for a mostly proving-*slower* swap once
overhead stops masking it. `compliance.circom` alone stays under its current domain threshold, but
gains no proving-time benefit either, since its arities are the two `Poseidon2` handles worst (n=5,
n=3-with-large-jump).

## Verdict: **REJECT**

The hypothesis — "Poseidon2 reduces constraint count and proving time at Veil's actual arities" —
is falsified by real measurement for n=4 and n=5, which are Veil's two most heavily used arities
(seven of the eleven total production Poseidon calls across the three circuits, once Merkle-path
calls are excluded — transfer.circom's 3×n=4, withdraw.circom's 3×n=4, compliance.circom's 1×n=5).
Only n=2 and n=3 show a real, measured proving-time win, and it's a small-circuit
overhead artifact, not evidence the swap helps at production scale — the domain-size projection
above argues the opposite for the circuits that matter most (`transfer.circom`, `withdraw.circom`).

Adopting `@taceo/circom-lib`'s `Poseidon2Sponge` as a drop-in, off-the-shelf replacement for
circomlib's `Poseidon(n)` in Veil's circuits is **not worth doing** in its current form. The root
cause is narrow and specific — no supported Poseidon2 state size between t=4 and t=8 — not a general
verdict against Poseidon2 as a primitive. The knowledge (exact deltas per arity, exact projected
effect per circuit, a reusable bench harness) survives on this branch and in this report for the
next night that wants to revisit it with custom-generated t=5/t=6 round constants (queued below).

`BASELINE.md` is unchanged — nothing here is a KEEP, so there's no baseline number to update.

## Where this could be used

- **Any Circom/Groth16 project evaluating a Poseidon2 migration off a general-purpose library**
  should check the same thing first: does the library's supported permutation width set actually
  cover your circuit's real arities, or will you silently pay a "round up to the next supported
  width" tax? The three-line rule from tonight (`rate = t - 1`, pick smallest supported `t` with
  `t - 1 >= n`, check the gap) generalizes directly.
- **A thesis chapter or writeup comparing hash primitives inside SNARK circuits** needs exactly this
  caveat: constraint-count comparisons from isolated micro-benchmarks can flip sign relative to
  production-scale proving time, because small circuits are overhead-dominated and large ones are
  FFT/MSM-dominated. The domain-size-doubling framing (Results, last table) is the right lens for
  "will this actually matter," not raw constraint deltas alone.
- **Any team about to generate custom round constants for a novel Poseidon2 state width** (the
  natural next step this experiment points at) should budget it as its own security-reviewed
  effort, not a two-line parameter tweak — the finding here is precisely that skipping that step
  (by over-provisioning to the next available width instead) has a real, measured cost.

## Open questions (next queue)

1. **Custom Poseidon2 round constants for t=5 and t=6** — would close the gap this experiment found
   for n=4 (Veil's heaviest arity: 3 of 4 non-Merkle Poseidon calls in both `transfer.circom` and
   `withdraw.circom`) and n=5 (`compliance.circom`'s credential leaf). Real potential win if it
   closes even half the n=4 gap, but round-constant generation is security-sensitive and needs its
   own careful night (see Approach, "What I rejected").
2. **Does the domain-size-doubling projection actually hold?** The only way to know for certain is
   to actually rewrite one circuit (`withdraw.circom` is the smallest and cheapest to verify) with
   Poseidon2 at t=8 for its three n=4 calls and compile it for real. Worth doing specifically to
   validate or refute tonight's projection methodology before trusting it for a bigger decision.
3. **On-chain gas per entry point** — still blocked, now confirmed as an organization egress-policy
   denial (see Results) rather than a toolchain gap. Needs either a policy exception or a `sui`
   binary reachable some other way. Top of the queue, unchanged priority.
4. Tonight's domain-separation check only tried two arbitrary tags on one circuit. A more thorough
   pass (all of Veil's real domain tags 1–8, checked pairwise) would be cheap and is a natural
   extension if queue item 5 (independent circuit soundness audit) gets picked up.
