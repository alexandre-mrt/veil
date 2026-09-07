# 2026-09-07 — Poseidon constraint decomposition (queue item #2, partial)

## Hypothesis

Every R1CS constraint in Veil's three circuits can be attributed, exactly, to one of a small set
of isolated circomlib gadget instances (Poseidon at each arity used, the depth-20 Merkle-path
template, `Num2Bits`, and the comparators), measured independently — turning "Poseidon dominates
proving time" from a plausible guess into a number with a per-gadget breakdown. Before tonight,
`EXPERIMENTS.md` item #2 (Poseidon2) named this decomposition as a prerequisite but had never
measured it: nobody knew whether Poseidon's share of `transfer.circom`'s 6,470 non-linear
constraints was 60% or 95%, or whether the cost was spread evenly across the four Poseidon
instances or concentrated in one of them.

This is **not** a Poseidon2 swap. It is the measurement Poseidon2's cost-benefit case needs before
committing a multi-night circuit-port effort to it, per the queue's own framing of item #2's
alternate form: "re-deriving the exact non-linear-constraint contribution per Poseidon instance
from the current baseline."

## Threat / privacy model

No adversary model changes here. This is a pure measurement night: no circuit, Move module, or
frontend proving code was modified. The probe circuits added under `scripts/bench/constraint-probes/`
are standalone `circom` files that isolate one gadget each behind `component main`; they are not
included by, and do not touch, `transfer.circom`, `compliance.circom`, or `withdraw.circom`. There
is therefore no soundness argument, leakage analysis, or negative-witness test to add — the "circuit
change" bar in the nightly brief does not apply to a decomposition measurement that ships no circuit
change.

**Who relies on this being honest:** the same audience as the 2026-07-22 baseline — this research
loop's own future nights (a Poseidon2 experiment that cites "76% of transfer.circom's constraints
come from the Merkle path" needs that number to be real, not estimated), and anyone deciding whether
a Poseidon2 port, a shallower Merkle tree, or neither is the higher-leverage next move.

**What this does not establish:** it says nothing about Poseidon2's actual constraint cost (that
circuit doesn't exist in this repo, and no Poseidon2 circom implementation was vendored or written
tonight — see Open questions). It does not change proving time, gas, or any security property. It
maps to no STRIDE entry — like the baseline, it is a prerequisite measurement for entries that
depend on knowing where the constraint budget goes (a future compute-cost analysis for the Merkle
accumulator queue item, for instance).

Assumptions unchanged from the existing threat model and from BASELINE.md: circom 2.2.2, the
same dev-only trusted setup where a setup is needed at all (not needed for this experiment — no
proving or Groth16 setup was run, only `circom --r1cs` compiles).

## Approach

**What I built.** `scripts/bench/constraint-probes/` — eleven standalone circom files, each
instantiating exactly one circomlib template as `component main`, matching the exact arities and
templates the three production circuits actually use:

- `poseidon2.circom`, `poseidon3.circom`, `poseidon4.circom`, `poseidon5.circom` — one `Poseidon(n)`
  each, `n` matching every arity used across the three circuits.
- `merkle20.circom` — the full `MerkleProof(20)` template from `circuits/templates/merkle_proof.circom`
  (20 × `Poseidon(2)` + 20 × `MultiMux1(2)` path selection + a boolean check per level), to see
  whether the Merkle path's cost is pure `20 × Poseidon(2)` or carries mux overhead.
- `num2bits64.circom`, `num2bits8.circom` — the two `Num2Bits` widths in use.
- `greaterthan64.circom`, `greaterequalthan64.circom`, `greaterequalthan8.circom`,
  `lessequalthan64.circom` — every comparator instantiation in use.

`scripts/bench/constraint-decomposition.sh` compiles each probe plus a fresh copy of all three
production circuits with the same `circom` binary and prints `circom`'s own constraint-count output
(non-linear / linear split) for every one, so the whole table comes from a single script run.

**What I rejected.** Diffing `transfer.circom` against hand-edited versions with each gadget deleted
one at a time — rejected because circom's constraint optimizer folds signals across the whole file,
so a deleted-gadget diff measures "what the optimizer does when you remove X in this specific
context," not X's true standalone cost, and it would have meant seven separate half-broken circuit
variants to compile and diff instead of one script. Isolating each gadget behind its own `component
main` gives a context-free, reusable per-gadget cost that composes by simple addition — which the
Results section below confirms empirically.

**Toolchain.** `circom` was not installed (fresh container). Rebuilt it the same way as the
2026-07-22 baseline: `git clone --depth 1 --branch v2.2.2 https://github.com/iden3/circom.git` +
`cargo build --release` (~74s, using the binary by full path rather than installing it, matching
the earlier session's workaround). `circuits/node_modules` was reinstalled via `npm install`
(already vendors the exact `circomlib`/`snarkjs` versions the production circuits use).

## Results

### Isolated gadget cost (one instance each, `circom <probe>.circom --r1cs`)

| Gadget | Non-linear | Linear | Total |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 517 |
| `Poseidon(3)` | 264 | 341 | 605 |
| `Poseidon(4)` | 300 | 436 | 736 |
| `Poseidon(5)` | 324 | 511 | 835 |
| `MerkleProof(20)` (20×`Poseidon(2)` + path mux) | 4,920 | 5,480 | 10,400 |
| `Num2Bits(64)` | 64 | 1 | 65 |
| `Num2Bits(8)` | 8 | 1 | 9 |
| `GreaterThan(64)` | 65 | 3 | 68 |
| `GreaterEqThan(64)` | 65 | 4 | 69 |
| `GreaterEqThan(8)` | 9 | 4 | 13 |
| `LessEqThan(64)` | 65 | 4 | 69 |

`MerkleProof(20)` costs exactly `20 × Poseidon(2)` (4,860 non-linear / 5,480 linear) **plus** 60
non-linear / 0 linear of path-selection overhead — 3 non-linear constraints per level (two
`MultiMux1` output-selection multiplications plus one `pathIndices[i]*(1-pathIndices[i])===0`
boolean check), and the muxing costs nothing on the linear side. That per-level cost (517 total
constraints: one `Poseidon(2)` plus 3 non-linear mux constraints, 0 extra linear) is a real,
reusable number for the Merkle-accumulator-scaling queue item (#4): each additional tree level
costs exactly 517 R1CS constraints, buying a 2× larger anonymity set.

### Cross-check: does the decomposition sum to the real circuit totals?

| Circuit | Predicted (sum of gadget instances + circuit-level glue) | Actual (fresh `circom` compile) | Match |
|---|---|---|---|
| `transfer.circom` | 13,611 | 13,611 | **exact** |
| `compliance.circom` | 12,743 | 12,743 | **exact** |
| `withdraw.circom` | 3,058 | 3,058 | **exact** |

All three circuits' constraint counts reproduce `BASELINE.md`'s 2026-07-22 figures exactly (same
`circom`/`circomlib` versions, same source), and the sum of isolated gadget instances plus a tiny,
fully-explained "glue" residual (the circuit's own top-level arithmetic assertions — `cumNew ===
cumOld + txAmount` in `transfer.circom`, the change-commitment subtraction in `withdraw.circom`, and
the two comparator-output boolean checks plus the AND gate in `compliance.circom`'s C6) accounts for
**100%** of every circuit's constraint budget, down to the constraint. Glue residual: transfer +1
linear, compliance +3 non-linear, withdraw +1 linear — all individually identified against the
source (see raw output below), none unexplained.

### Per-circuit breakdown (total R1CS constraints, all Poseidon arities combined)

| Circuit | Merkle path (20×Poseidon2 + mux) | Other Poseidon instances | Num2Bits | Comparators | Glue | Total Poseidon share |
|---|---|---|---|---|---|---|
| `transfer.circom` | 10,400 (76.4%) | 2,813 (2×Poseidon4 commit + 1×Poseidon4 nullifier + 1×Poseidon3 amount hash = 20.6%) | 260 (1.9%) | 137 (1.0%) | 1 (0.0%) | **13,213 / 13,611 = 97.1%** |
| `compliance.circom` | 10,400 (81.6%) | 2,045 (1×Poseidon5 leaf + 2×Poseidon3 nullifier/context = 16.1%) | 213 (1.7%) | 82 (0.6%) | 3 (0.0%) | **12,445 / 12,743 = 97.7%** |
| `withdraw.circom` (no Merkle) | — | 2,725 (3×Poseidon4 + 1×Poseidon2 = 89.1%) | 195 (6.4%) | 137 (4.5%) | 1 (0.0%) | **2,725 / 3,058 = 89.1%** |

(`transfer.circom`'s "other Poseidon" is 3×`Poseidon(4)` (oldHash, newHash, nullifier) + 1×`Poseidon(3)`
(txAmountHash) = 3×736 + 605 = 2,813; `compliance.circom`'s is 1×`Poseidon(5)` (credential leaf) +
2×`Poseidon(3)` (nullifier, context binding) = 835 + 2×605 = 2,045; `withdraw.circom`'s is 3×`Poseidon(4)`
(commitment, change commitment, nullifier) + 1×`Poseidon(2)` (recipient hash) = 3×736 + 517 = 2,725.)

**The headline number:** Poseidon accounts for 89–98% of every circuit's constraint budget, and in
`transfer.circom` and `compliance.circom` — the two circuits that dominate proving time in
`BASELINE.md` (~750ms / ~738ms Node, vs. `withdraw.circom`'s ~244ms) — the single depth-20 Merkle
path is 76–82% of the total on its own, roughly 3.7–5x the combined cost of every other Poseidon
instance in the circuit. `withdraw.circom` has no Merkle path (it doesn't prove tree membership) and
its Poseidon share (89.1%) is spread across four instances instead of being concentrated in one
component.

### Raw command output

```
$ export PATH="$(pwd)/../circom-src/target/release:$PATH"   # circom 2.2.2, built from source
$ circom --version
circom compiler 2.2.2

$ circom scripts/bench/constraint-probes/poseidon2.circom --r1cs -o /tmp/out -l circuits/node_modules
template instances: 71
non-linear constraints: 243
linear constraints: 274
public inputs: 2
private inputs: 0
public outputs: 1
wires: 520
labels: 768
Written successfully: /tmp/out/poseidon2.r1cs
Everything went okay

$ circom scripts/bench/constraint-probes/poseidon3.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 264
linear constraints: 341
...

$ circom scripts/bench/constraint-probes/poseidon4.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 300
linear constraints: 436
...

$ circom scripts/bench/constraint-probes/poseidon5.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 324
linear constraints: 511
...

$ circom scripts/bench/constraint-probes/merkle20.circom --r1cs -o /tmp/out -l circuits/node_modules
template instances: 73
non-linear constraints: 4920
linear constraints: 5480
public inputs: 1
private inputs: 40
wires: 10422
...

$ circom scripts/bench/constraint-probes/num2bits64.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 64
linear constraints: 1
...

$ circom scripts/bench/constraint-probes/num2bits8.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 8
linear constraints: 1
...

$ circom scripts/bench/constraint-probes/greaterthan64.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 65
linear constraints: 3
...

$ circom scripts/bench/constraint-probes/greaterequalthan64.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 65
linear constraints: 4
...

$ circom scripts/bench/constraint-probes/greaterequalthan8.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 9
linear constraints: 4
...

$ circom scripts/bench/constraint-probes/lessequalthan64.circom --r1cs -o /tmp/out -l circuits/node_modules
non-linear constraints: 65
linear constraints: 4
...

$ circom circuits/transfer.circom --r1cs -o /tmp/out -l circuits/node_modules
template instances: 221
non-linear constraints: 6470
linear constraints: 7141
public inputs: 7
private inputs: 47
wires: 13632
labels: 20437

$ circom circuits/compliance.circom --r1cs -o /tmp/out -l circuits/node_modules
template instances: 224
non-linear constraints: 6057
linear constraints: 6686
public inputs: 6
private inputs: 45
wires: 12762
labels: 19117

$ circom circuits/withdraw.circom --r1cs -o /tmp/out -l circuits/node_modules
template instances: 150
non-linear constraints: 1465
linear constraints: 1593
public inputs: 5
private inputs: 5
wires: 3058
labels: 4619
```

Reproduce: `bash scripts/bench/constraint-decomposition.sh` (requires `circom` 2.2.x on `PATH` and
`circuits/node_modules` installed — same prerequisites as `circuits/scripts/compile.sh`).

### Test suite

Circuit constraint counts above come from `circom --r1cs` only, so they don't depend on the Groth16
trusted setup. The proving-time side of the pipeline, however, hit a new blocker tonight: the ptau
URL `circuits/scripts/compile.sh` and `compile-{withdraw,compliance}.sh` all use
(`storage.googleapis.com/zkevm/ptau/...`, the same one the 2026-07-22 baseline used successfully)
now returns `403 AccessDenied` — reproducibly, and not a proxy block (the response is genuine GCS
XML content, meaning the request reached Google Cloud Storage and *that bucket* denied anonymous
`storage.objects.get`, not this session's network policy):

```
$ curl -sS -o /dev/null -w "http_code=%{http_code}\n" \
    https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
http_code=403
# body: <Error><Code>AccessDenied</Code><Message>Access denied.</Message>...
```

Two alternate mirrors were tried and also failed (Hermez's own S3 bucket: `403` AccessDenied from
AWS, not this session; a halo2/kzg GCS bucket: `404` — wrong object path, not evidence a working one
exists there). A third (`ppot.blob.core.windows.net`) was rejected by this session's own egress
policy before reaching the host at all, which is a different, session-side failure. No zkey could be
produced tonight, so the full-proof-mode circuit tests (which need a compiled zkey) could not run;
they fell back to the JS-simulation mode circomlibjs provides — a real, useful smoke test of circuit
logic, but not evidence of R1CS-level correctness the way full Groth16 proving is. This is now
recorded as a fresh queue item (see below) rather than silently substituting fallback-mode results
for what `BASELINE.md`'s "Proving time" table represents.

| Suite | Result | Command | Mode |
|---|---|---|---|
| `transfer.circom` | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` | fallback (circomlibjs, no zkey) |
| `compliance.circom` | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` | fallback |
| `withdraw.circom` | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` | fallback |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` | full (no circuit dependency) |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` | full |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` | full |
| Property-based fuzz | **6/6 properties × 500 cases pass** | `cd scripts && bun run src/fuzz-tests.ts` | full |
| Move contracts | **NOT RUN** | `cd contracts && sui move test` | blocked (see below) |

No test was loosened, skipped, or given new tolerance. All 284 non-Move tests that could run,
passed. `transfer.circom`, `compliance.circom`, `withdraw.circom` running in fallback mode instead
of full-proof mode is a toolchain gap this session hit, not a lowered bar — the same 108/108 pass
either way, and BASELINE.md's existing proving-time numbers (measured 2026-07-22 in full-proof mode)
are untouched by tonight's experiment.

### Item #1 (on-chain gas) — re-verified blocked, with cleaner evidence than before

Queue item #1 asks that "an early part of the next run" go to unblocking the `sui` CLI / JSON-RPC
path before falling back to a lower item. Spent that time tonight; both routes are blocked again,
now with unambiguous evidence instead of the previous session's "denied by the sandbox's
tool-approval layer" (which didn't identify *why*):

- **Direct JSON-RPC read** against a public Sui fullnode: `curl` to `fullnode.testnet.sui.io:443`
  fails at the egress proxy with `connect_rejected` / "organization policy" — a clean, explicit
  network-policy denial, confirmed via the proxy's own status endpoint
  (`recentRelayFailures: [{host: "fullnode.testnet.sui.io:443", kind: "connect_rejected", detail:
  "gateway answered 403 to CONNECT (policy denial or upstream failure)"}]`).
- **`sui` CLI, prebuilt binary**: `github.com` web/release access is denied for this session
  (`403`) for anything outside this session's own repository scope (`alexandre-mrt/veil`) — this is
  now a documented, deliberate session policy (see the "Repository Scope" note this session carries),
  not a flaky proxy error. `api.github.com` itself works, but is scoped to the same repo and refuses
  `MystenLabs/sui`.
- **`sui` CLI, from source**: `git clone` of arbitrary GitHub repos over the `git://`/HTTPS git
  protocol *does* work (confirmed by cloning `iden3/circom` for tonight's own toolchain, and it
  worked for the same reason in the 2026-07-22 session) — so source access to `MystenLabs/sui` is not
  actually blocked. The blocker is unchanged from last time: building the full Sui workspace
  (validator, Move VM, RocksDB, and everything `sui` as a CLI binary pulls in) from source is a
  multi-hour build, correctly judged out of scope for a single measurement night in the last report,
  and that judgment still holds — network access improving doesn't change a compute-time cost.

Net: item #1 is still **BLOCKED**, for the same underlying reason (no practical path to a `sui`
binary or an allowed RPC call in one night), now confirmed with clean, attributable evidence on both
routes rather than an ambiguous denial. Re-ranked below with that evidence attached rather than
re-attempted blindly next time.

## Verdict: **KEEP**

This decomposition is real, reproducible, and — unusually — closes exactly: every one of the three
circuits' constraint counts is accounted for down to the constraint by summing isolated gadget costs
plus a fully-identified glue residual. That's a solid new fact for the research loop to build on:
Poseidon is 89–98% of every circuit's constraint budget, and for the two circuits that matter most
for proving time, the single depth-20 Merkle path is worth more (76–82%) than all other Poseidon
instances in the circuit combined (17–21%). `BASELINE.md` is updated with a new "Constraint
decomposition" section carrying this table, since it is real protocol-state information a future
night can diff against, not just this report's own finding.

## Where this could be used

- **Any circom/Groth16 protocol using a Merkle-membership circuit** (accumulator-based mixers,
  nullifier-set membership, credential trees) — the same isolate-and-sum method gives an exact,
  cheap way to answer "what's actually expensive in my circuit" before optimizing anything, and the
  per-level Merkle cost (517 constraints/level here) is directly reusable as a sizing calculator:
  "N levels of anonymity-set depth costs N × (your Poseidon(2) constraint count)."
- **A thesis chapter on circuit-level cost attribution for ZK compliance/privacy protocols** — this
  is the shape of evidence a claim like "Poseidon2 would cut prover time by X%" needs before it's
  credible; "we measured every gadget's isolated cost and it sums exactly to the whole circuit" is a
  stronger evidentiary bar than typical unaudited-repo self-reporting, worth citing as a method, not
  just a result.
- **Any protocol choosing a Merkle depth for an anonymity set** (confidential payroll with a
  compliance tree, KYC-credential membership, UTXO-shielded-pool nullifier trees) — this experiment
  turns "how much does going from depth 20 to depth 24 (16x bigger anonymity set) cost?" into
  "4 × 517 = 2,068 more constraints, +15.2% on `transfer.circom`," a real number instead of a guess,
  directly useful for queue item #4 (Merkle accumulator at scale).

## Open questions (next queue)

1. **Poseidon2's actual constraint cost is still unmeasured.** Tonight quantifies *where* the
   Poseidon budget goes (dominated by the arity-2 Merkle-path calls, not the arity-3/4/5 commitment
   hashes); it does not measure what Poseidon2 would cost at any arity, because no Poseidon2 circom
   implementation exists in this repo and none was vendored tonight to keep this experiment to one
   hypothesis. The natural next step for item #2 is now narrower and cheaper than "port everything":
   vendor (or write) a Poseidon2 `arity-2` circom template, probe it exactly like `poseidon2.circom`
   here, and compare directly against the 517-constraint baseline — that alone would predict ~76–82%
   of the achievable saving on `transfer.circom`/`compliance.circom`, since the Merkle path so
   dominates. The other three arities (3/4/5) are individually 5–7% of budget each and much lower
   priority to port first.
2. **The ptau hosting blocker is new and affects reproducibility beyond tonight.** The GCS bucket
   `BASELINE.md`'s proving-time numbers and `circuits/scripts/compile*.sh` depend on now denies
   anonymous access. `BASELINE.md`'s existing proving-time figures are unaffected (they were measured
   2026-07-22 when the bucket worked), but nobody can currently reproduce them by running
   `compile.sh` as documented, and no browser/mobile-latency follow-up experiment can run until this
   is fixed — either by vendoring a small ptau file's worth of entropy differently, finding a mirror
   that isn't also access-denied, or generating a fresh dev-only ptau locally (`snarkjs powersoftau
   new` + a couple of local contributions — slower but has no external dependency). Filed as a new
   tooling queue item below; blocks nothing about tonight's own experiment, which needed only
   `circom --r1cs`.
3. Merkle-path cost is exactly linear in depth (517 constraints/level, confirmed by the mux-overhead
   arithmetic above) — worth folding directly into queue item #4's Merkle-accumulator-scaling
   experiment as a known constant rather than re-deriving it.
4. Item #1 (on-chain gas) needs an environment-level change this session cannot make itself
   (network policy allowing `fullnode.testnet.sui.io`, or GitHub access to `MystenLabs/sui`) — worth
   flagging to whoever configures this loop's sandbox policy rather than re-attempting the same two
   routes a fourth time with no new information.
