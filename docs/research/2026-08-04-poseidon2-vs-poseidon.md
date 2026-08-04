# 2026-08-04 — Poseidon2 vs Poseidon, and a free 53% constraint cut (queue item #2)

## Hypothesis

The bigger lever on Veil's Groth16 constraint count is compiler optimization depth, not hash-primitive
choice: compiling with circom's full constraint simplification (`--O2`) will cut R1CS constraints more
than swapping Poseidon for Poseidon2's linear layer does under Veil's current (default, `--O1`) compile
settings. Tested at t=3 — the one width `circomlib`'s Poseidon(2) shares with an official, published
Poseidon2 BN254 parameter set (Veil uses this width for Merkle-path steps and `recipientHash`).

This experiment started as queue item #2 (Poseidon2 vs Poseidon). Confirming the comparison required
compiling with both `--O1` and `--O2` to separate "real algebraic effect" from "artifact of how much the
optimizer folds" — and `--O2` alone turned out to move a much bigger number than the primitive swap does.
Both results are reported below as one experiment, since the second was only discovered while controlling
for it in the first.

Queue item #1 (on-chain gas per entry point) was attempted first and is still **BLOCKED** — see Results.

## Threat / privacy model

Neither change alters what Veil's circuits compute or what they reveal. This section is about who relies
on these numbers, and, for `--O2`, what changes operationally.

**Adversaries considered:**

- **A chain observer** watching `shielded_transfer`/`zk_withdraw` calls learns nothing new from either
  change. The `--O2` circuits compute the exact same relation as the `--O1` circuits (compiler-level
  constraint-system simplification, not a logic change); the Poseidon2 circuit computes a different hash
  function, but with the same public/private input shape, same one-way/collision-resistance assumption,
  and the same 128-byte compressed Groth16 proof regardless of which hash is inside. Domain-tag separation
  is unaffected either way.
- **A malicious prover** attempting to submit a proof for a false statement is the subject of this
  experiment's negative tests (see Results) — for both the `--O2` circuits (all 108 existing malicious-
  witness tests still fail to produce a valid proof) and the new Poseidon2 circuit (a witness claiming a
  false hash output fails constraint satisfaction).
- **What this does NOT establish**: `--O2` says nothing about whether circom's simplification pass has
  ever had a soundness bug for some other circuit shape (see Approach for what backs this claim); this
  experiment's evidence is empirical (108/108 tests, including every adversarial one already in the repo,
  pass identically against `--O2` builds) plus circom's own documented "full constraint simplification"
  behavior, not a from-scratch soundness proof of the optimizer.

**STRIDE mapping (`docs/threat-model.md`):**

- **T3** (`Modify VK to accept forged proofs`, Mitigated via 1-epoch timelock) is the entry this
  experiment actually touches operationally, not adversarially: switching `compile*.sh` to `--O2` changes
  the compiled R1CS, which changes every verifying key. **Any existing on-chain deployment must go
  through the same timelocked VK-update path T3 already mitigates against malicious VK changes** — this
  is not a new attack surface, it's the existing, audited path being the correct (not optional) route for
  what is otherwise a purely internal build-tooling change. Skipping it (i.e., silently redeploying) would
  be the same class of problem T3 defends against, just self-inflicted rather than adversarial.
- No other STRIDE entry changes. RR2 (dev-only trusted setup) is unchanged by either intervention — a new
  zkey still requires a new (still non-production) ceremony contribution either way, exactly as before.

**Assumptions carried over unchanged:** Groth16/BN254 soundness, the dev trusted setup's toxic waste not
being production-safe (RR2), and — new for the Poseidon2 half only — the eprint 2023/323 security
analysis for Poseidon2's t=3 parameters, which this experiment did not independently re-derive (see
Approach: parameters are copied verbatim from the authors' own reference implementation, not
re-generated).

## Approach

**What I built:**

1. `circuits/templates/poseidon2_t3.circom` — a Poseidon2 permutation, width t=3, BN254. Round count
   (`d=5`, `RF=8`, `RP=56`), the internal-layer diagonal, and all 64 rounds' constants are copied verbatim
   from the reference implementation published by the Poseidon2 authors' own group,
   [`HorizenLabs/poseidon2`](https://github.com/HorizenLabs/poseidon2)
   (`plain_implementations/src/poseidon2/poseidon2_instance_bn256.rs`) — fetched over the network this
   session (see "toolchain notes" below), not reconstructed from memory. t=3 is the **only** BN254 width
   that repository publishes.
2. `scripts/bench/poseidon2-verify-kat.mjs` — a standalone, out-of-circuit JS re-implementation of the
   permutation, checked against that same repository's own published known-answer test
   (`poseidon2_tests_bn256::kats()`, input `[0,1,2]`) *before* writing a single line of circom. This
   validated the round structure and constants independent of any circom translation bug.
3. `circuits/test/poseidon2.test.mjs` — validates the circom translation itself against the same KAT
   (via direct witness calculation, not a full proof, for speed), plus the negative test required for any
   circuit change: a `Poseidon2Commit` wrapper (`scripts/bench/poseidon2-vs-poseidon/main_poseidon2_commit.circom`)
   that constrains `expected === Poseidon2Hash2(in[0], in[1])`; a witness with the real hash proves and
   verifies, a witness with `real hash + 1` fails constraint satisfaction outright.
4. `scripts/bench/poseidon2-vs-poseidon/` — the reusable, checked-in comparison: `main_poseidon2_t3.circom`
   wraps the new template, `main_poseidon_t3.circom` wraps `circomlib`'s `Poseidon(2)` (same t=3 width,
   the exact template Veil's own circuits already `include`), and `build-circuits.sh` compiles and sets up
   both with one command.
5. `scripts/bench/o1-vs-o2-constraints.sh` — recompiles all three of Veil's real circuits at `--O1`
   (current default) and `--O2` and prints `snarkjs r1cs info` for each, the exact command behind the
   headline numbers below.

**What I rejected:** deriving Poseidon2 parameters for Veil's t=4 and t=5 calls (the ones that actually
dominate `transfer.circom`/`compliance.circom`'s constraint count) myself, by running the authors'
parameter-generation script for those widths. Rejected for tonight: the reference repository's own BN254
instance set stops at t=3 (Poseidon2's published widths are `{2, 3}` plus multiples of 4 — `{4, 8, 12,
...}` — t=5 isn't a defined width in the standard construction at all), so self-derived constants for an
unpublished width would be unaudited cryptography shipped in a research PR, not a "real number from a real
command." If Poseidon2 is worth pursuing further, deriving and independently verifying t=4/t=5 parameters
against the reference generator is its own night's work, not a rounding error on this one — queued below.

**Toolchain notes (network policy, differs from the 2026-07-22 report):**

- `circom` v2.2.2 built from source again this session (`cargo build --release`, ~1 min) — same as last
  time, still not installable any other way here.
- **Queue item #1 (on-chain gas) reattempted and reconfirmed BLOCKED, for a clearer reason than last
  time.** Direct JSON-RPC to `fullnode.testnet.sui.io` returns a hard `403` at the network proxy (`gateway
  answered 403 to CONNECT (policy denial)`) — not a per-call tool-approval prompt this time, a standing
  network-policy block. `cargo install`-ing the `sui` CLI is also blocked: `index.crates.io` (the registry
  index) is reachable, but `static.crates.io` (actual crate downloads) returns `403`, so no crate source
  is fetchable regardless of what's in the index. `github.com` and `objects.githubusercontent.com` are
  gated to the session's approved repo only. On-chain gas measurement needs either a different sandbox
  network policy or a prebuilt `sui` binary provided out-of-band; re-ranked but not re-attempted further
  tonight (see EXPERIMENTS.md).
- **`raw.githubusercontent.com` is reachable** (verified: `200` on a real file fetch, unlike the above)
  — this is what made fetching the authentic Poseidon2 reference implementation possible instead of
  reconstructing it from memory, which is what let this experiment use real, citable parameters rather
  than an approximation.
- Everything else (npm registry, `storage.googleapis.com` for the Powers-of-Tau file, the existing test
  toolchain) worked exactly as in the prior run.

## Results

### On-chain gas per entry point (queue item #1) — still BLOCKED

No new data. See Approach above for the more specific network-policy diagnosis than the 2026-07-22 run
had. Re-ranked in `EXPERIMENTS.md` with this diagnosis attached.

### Poseidon2 (t=3) vs `circomlib` Poseidon(2) — constraint count

Reproduce: `bash scripts/bench/poseidon2-vs-poseidon/build-circuits.sh`

```
$ circom main_poseidon2_t3.circom --r1cs --wasm --sym -o build -l <circuits>/node_modules
non-linear constraints: 240
linear constraints: 340
wires: 584

$ circom main_poseidon_t3.circom --r1cs --wasm --sym -o build -l <circuits>/node_modules/circomlib/circuits
non-linear constraints: 243
linear constraints: 274
wires: 520
```

| | Non-linear (S-box) | Linear | **Total** | Wires |
|---|---|---|---|---|
| `circomlib` Poseidon(2), t=3 (current) | 243 | 274 | **517** | 520 |
| Poseidon2, t=3 (official params) | 240 | 340 | **580** | 584 |
| Δ | −3 (−1.2%) | +66 (+24.1%) | **+63 (+12.2%)** | +64 |

Poseidon2 needs exactly 3 fewer non-linear constraints — one fewer partial round (`RP=56` vs
`circomlib`'s `RP=57` at this width, both `d=5`, both `RF=8`; 3 multiplication constraints per S-box in
circom's `x^5` gadget, `1 × 3 = 3`, matching exactly). But it costs *more total* constraints under
Veil's actual default compile flags, because of an extra linear layer Poseidon2 applies once before the
first round (absent in original Poseidon) and because the hand-written linear-layer templates here
introduce more distinct intermediate signals than `circomlib`'s hand-tuned `Mix`/`MixS` — and circom's
default (`--O1`) optimizer doesn't fold all of that away.

**That gap is an optimizer-interaction artifact, not an algebraic property of Poseidon2** — recompiling
both with `--O2` (full simplification) collapses it entirely:

```
$ circom main_poseidon2_t3.circom --r1cs -o build-O2 -l <circuits>/node_modules --O2
non-linear constraints: 240
linear constraints: 0

$ circom main_poseidon_t3.circom --r1cs -o build-O2 -l <circuits>/node_modules/circomlib/circuits --O2
non-linear constraints: 240
linear constraints: 0
```

At `--O2`, both circuits land on **exactly 240 non-linear constraints, zero linear constraints** — a tie.
Whatever advantage Poseidon2's one-fewer-partial-round buys is exactly offset by something else once the
optimizer is given full latitude; this experiment didn't chase down which specific substitution does it
(open question below), but the practical conclusion holds either way: **under the compile settings Veil
should actually be using (see the next section), Poseidon2 buys nothing extra at t=3.**

### Poseidon2 correctness and negative test

```
$ node --experimental-vm-modules test/poseidon2.test.mjs
=== Poseidon2 (t=3) research circuit tests ===
  [PASS] KAT: Poseidon2Permutation3([0,1,2]) matches HorizenLabs reference vector
  [PASS] Negative: Poseidon2Commit accepts a witness with the correct hash
ERROR:  4 Error in template Poseidon2Commit_5 line: 17
  [PASS] Negative: Poseidon2Commit rejects a witness claiming a false hash

=== Results: 3 passed, 0 failed ===
```

The KAT check confirms the circom translation is bit-exact against the authors' own reference vector
(not just "plausible" — the standalone JS reference in `poseidon2-verify-kat.mjs` was checked against the
same vector first, independent of circom, and both agree). The negative test confirms a witness that
claims an incorrect hash output cannot satisfy the R1CS constraints — `expected === h.out` really is
enforced, not silently droppable.

### The bigger number: `--O2` on Veil's real circuits

Reproduce: `bash scripts/bench/o1-vs-o2-constraints.sh` (constraints) and
`node scripts/bench/prove-latency.mjs --runs 10` (proving time, after compiling both build sets — see
that script's header for the exact setup sequence).

| Circuit | O1 constraints (current) | O2 constraints | Δ | O1 zkey | O2 zkey | Δ zkey | O1 proving (Node, mean/10) | O2 proving | Δ proving |
|---|---|---|---|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,384 | **−53.1%** | 6,001,417 B | 4,466,605 B | −25.6% | 769.8 ms | 613.8 ms | **−20.3%** |
| `compliance.circom` | 12,743 | 5,979 | **−53.1%** | 5,682,141 B | 3,785,549 B | −33.4% | 760.9 ms | 576.8 ms | **−24.2%** |
| `withdraw.circom` | 3,058 | 1,439 | **−52.9%** | 1,385,321 B | 1,608,141 B | **+16.1%** | 256.1 ms | 234.4 ms | **−8.5%** |

Raw command output (`transfer.circom`, representative):

```
$ circom transfer.circom --r1cs -o build-o1check -l node_modules
non-linear constraints: 6470
linear constraints: 7141
wires: 13632

$ circom transfer.circom --r1cs -o build-o2 -l node_modules --O2
non-linear constraints: 6384
linear constraints: 0
wires: 6407
```

Constraint count drops ~53% uniformly across all three circuits — the FFT domain size (`snarkjs`'s
`domainSize` field, which is what Groth16 proving time actually scales with) shrinks from `16384` to
`8192` for `transfer`/`compliance` and from `4096` to `2048` for `withdraw`. zkey size mostly follows
(`transfer` −25.6%, `compliance` −33.4%), but **not** `withdraw`, which grows +16.1% despite fewer
constraints and fewer wires (3,058 → 1,441) — zkey size is driven by the count of *nonzero coefficients*
across the sparse constraint matrices, not constraint count or domain size directly; O2's constraint
merging trades fewer, denser constraints for `withdraw`'s smaller circuit, and the net nonzero-coefficient
count went up even though everything else went down. Proving time, the number that actually matters,
still improved for all three (8.5–24.2% faster).

**Correctness: the existing 108-test suite (43 + 30 + 35) passes identically against fresh `--O2`
builds of all three circuits — including every one of the existing malicious-witness / adversarial
tests** (wrong commitments, tampered nullifiers, range-proof violations, non-boolean Merkle path
indices, and so on — all still correctly rejected):

```
$ node --experimental-vm-modules test/transfer.test.mjs    # against --O2 build
=== Results: 43 passed, 0 failed ===
$ node --experimental-vm-modules test/compliance.test.mjs  # against --O2 build
=== Results: 30 passed, 0 failed ===
$ node --experimental-vm-modules test/withdraw.test.mjs    # against --O2 build
=== Results: 35 passed, 0 failed ===
```

Rest of the suite (unaffected by this PR, run in full per policy):

| Suite | Result | Command |
|---|---|---|
| Circuits (against `--O2` builds) | **108/108 pass** | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Poseidon2 research circuit | **3/3 pass** | `node --experimental-vm-modules test/poseidon2.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz | **6/6 properties** (500 cases each) | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** — `sui` CLI unavailable (see Approach) | `cd contracts && sui move test` |

No test was loosened, skipped, or given new tolerance. `contracts/` was not touched by this PR, and the
Move-test blocker is identical in cause to the prior run's (network policy, not this PR).

## Verdict: **KEEP** (compile flag) / **REJECT** (Poseidon2 primitive swap) / **BLOCKED** (on-chain gas, unchanged)

**KEEP — `circuits/scripts/compile.sh`, `compile-compliance.sh`, `compile-withdraw.sh` now pass `--O2`.**
A 53% constraint-count cut and 8–24% faster real proving time, for free, with zero circuit-logic change
and full-suite-identical test results, is as close to a strict improvement as this loop is going to find.
`BASELINE.md` updated in place to reflect `--O2` as Veil's current build (the old `--O1` numbers are
superseded, not deleted — this file "reflects the current state of the protocol," per its own header).
**Operational note, not optional:** this changes every verifying key. Any live deployment must go through
the existing timelocked VK-update path (T3), which is exactly what it's for.

**REJECT — Poseidon2 (t=3) as a drop-in swap for Veil's arity-2 Poseidon calls.** It doesn't reduce
constraints under the compile settings that matter (ties at `--O2`, loses at `--O1`), and even a clean
win at t=3 wouldn't move Veil's actual bottleneck: `transfer.circom` and `compliance.circom`'s cost is
dominated by their Poseidon(4)/t=5 calls (5 of the 8 total Poseidon instances across all three circuits),
and Poseidon2 has no official BN254 parameter set at that width at all. Adopting Poseidon2 for real would
mean either an unaudited self-derived parameter set for an unpublished width, or restructuring those hash
calls to fit a supported width (padding to t=8, most likely) — a real circuit redesign, not a primitive
swap, and not worth it against a demonstrated-zero constraint benefit at the one width that *is* supported.
The branch/circuit stays in the repo (`circuits/templates/poseidon2_t3.circom`) — the knowledge (real
BN254 parameters, a verified circom translation, a working comparison harness) survives for whichever
future night tackles t=5 properly.

**BLOCKED — on-chain gas.** Unchanged from 2026-07-22, cause now more precisely diagnosed (see Approach).
Top of the queue again, with a note that the blocker looks structural to this sandbox's network policy
rather than something a from-source build can route around.

## Where this could be used

- **Any circom project not already compiling with `--O2`** gets the same class of result for free —
  this isn't Veil-specific. The 53%-uniform-across-three-different-circuits result suggests `circomlib`'s
  Poseidon gadget in particular (used in the overwhelming majority of production ZK-payment circuits)
  leaves a lot of `--O1`-unfolded linear bookkeeping on the table; anyone building on it should check.
- **The Poseidon2-at-unsupported-widths gap** (no official BN254 params past t=3, none for t=5/6/7 in
  general, only `{2,3}` and multiples of 4) is a real, citable constraint on any BN254 Groth16/PLONK
  circuit considering Poseidon2 — a thesis chapter comparing hash primitives for SNARK-friendliness should
  flag width coverage as a first-class adoption criterion, not just S-box/round-count efficiency.
- **A protocol integrator evaluating a "just switch to Poseidon2" claim** for a BN254 circuit now has a
  concrete, reproducible harness (`scripts/bench/poseidon2-vs-poseidon/`) to check whether the claim holds
  for their own circuit's compile flags before taking on the audit/re-ceremony cost of a primitive swap.

## Open questions (next queue)

1. **Why do Poseidon and Poseidon2 converge to exactly 240 non-linear constraints at `--O2`, both from
   different starting round counts (57 vs 56 partial rounds)?** Not chased down tonight — worth a look at
   which specific `--O2` substitution does it, since it might mean the "1 fewer partial round" framing of
   Poseidon2's efficiency claim doesn't actually translate to Groth16/R1CS the way it's often cited to.
2. **On-chain gas (queue item #1, still top-ranked).** The blocker now looks like sandbox network policy
   specifically (both `fullnode.testnet.sui.io` and `static.crates.io` hard-blocked at `403`, `github.com`
   gated to the approved repo) rather than something retriable within a session. Worth flagging to whoever
   configures this environment's network policy before spending another night on workarounds.
3. **Poseidon2 at t=5** (Veil's dominant width) needs either the authors' own parameter-generation script
   run and independently checked against a second implementation, or a redesign of the four Poseidon(4)
   calls to a supported width (t=8 most likely, meaning 3 unused capacity slots per hash — worth checking
   whether that's even a net constraint win before attempting it).
4. Extend `scripts/bench/o1-vs-o2-constraints.sh`'s finding: does `--O2` compile time stay acceptable as
   Veil's circuits grow (this run: <1s per circuit, all three well under a second)? Not a concern yet, but
   worth a note if a future circuit gets an order of magnitude larger.
