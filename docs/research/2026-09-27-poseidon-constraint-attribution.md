# 2026-09-27 — Where transfer.circom's and compliance.circom's constraints actually come from

## Hypothesis

`README.md` and `docs/research/BASELINE.md` both frame `transfer.circom`'s and `compliance.circom`'s
non-linear constraint cost as dominated by "four Poseidon instances" (the domain-tagged commitment,
nullifier, and amount-hash calls). That framing never accounts for the depth-20 Merkle membership
check (`templates/merkle_proof.circom`), which calls `Poseidon(2)` once per tree level — 20 hash
calls, not counted among the "four."

**Falsifiable claim:** the 20-level Merkle membership proof, not the named domain-tagged Poseidon
calls, is the single largest contributor to `transfer.circom`'s and `compliance.circom`'s non-linear
constraint count — by a wide enough margin that Merkle depth, not a Poseidon2 swap of the named
hashes, is the higher-leverage lever on prover time for those two circuits. This experiment measures
the exact split, not an estimate of it, and re-ranks `docs/research/EXPERIMENTS.md` items #2 and #4
on the result.

This is a measurement-and-attribution night, not a protocol change: no circuit, Move module, or
frontend proving code was modified. `transfer.circom`, `compliance.circom`, and `withdraw.circom`
are byte-for-byte unchanged.

## Queue item #1 (on-chain gas) — attempted first, confirmed BLOCKED again

Before picking up item #2, I spent the first part of the run on item #1 per its own note ("worth
spending an early part of the next run purely on unblocking the toolchain"). Both previously-tried
paths were retested and both are blocked by the sandbox's egress allowlist, not by a tool-approval
prompt this time — a real, more precise finding than the 2026-07-22 report could give:

```
$ curl -sS -m 20 -o /dev/null -w "%{http_code}\n" -I https://github.com/MystenLabs/sui/releases
403

$ curl -sS -m 20 -X POST https://fullnode.testnet.sui.io:443 -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"suix_getLatestSuiSystemState","params":[]}'
curl: (56) CONNECT tunnel failed, response 403
```

`/root/.ccr/README.md` (this sandbox's egress-proxy documentation) is explicit: a 403 from the proxy
means "the destination host is not allowed by your organization's egress policy for this session...
do not retry or route around it." Both a `sui` CLI binary and a direct Sui RPC read are unreachable
hosts under that policy, categorically, not a one-off denial — so I did not try alternative RPC
providers (that would be routing around the same policy decision under a different hostname) and did
not retry. On-chain gas per entry point stays **BLOCKED**, third attempt, same root cause: this
sandbox's network allowlist does not include `github.com` or any Sui fullnode host. `registry.npmjs.org`
*is* allowlisted, which is what made tonight's experiment possible at all (see Approach).

I'm leaving item #1 at the top of the queue rather than re-ranking it down: it is still the highest
un-settled-value item once egress is ever permitted, and tonight's finding narrows what a future
session needs to ask for (specifically: `github.com` release downloads, or one named Sui fullnode
host, on the allowlist — either unblocks it).

## Threat / privacy model

No adversary model changes — this doesn't touch soundness, privacy, or trust boundaries; the three
production circuits are unmodified. The relevant framing, as with the 2026-07-22 baseline: **who
relies on the "four Poseidon instances" claim being accurate, and what happens if they act on it.**

- **This research loop's own queue** (`docs/research/EXPERIMENTS.md` items #2 and #4) currently
  reads "four Poseidon instances dominate... the highest-leverage next number" as its stated
  rationale for ranking a Poseidon2 swap above Merkle-depth work. If that premise is wrong, the
  ranking is wrong, and a future night could spend real effort building a correctness-sensitive new
  hash permutation for a smaller payoff than reworking the Merkle path would give.
- **`docs/threat-model.md` RR5** ("deposit-commitment linkability... Merkle accumulator provides
  anonymity set") already ties Merkle depth to a privacy property, not just a performance one. This
  experiment gives the first real per-level constraint cost for that tree, which item #4 (Merkle
  accumulator at scale) needs as its own starting number.
- **A future Poseidon2 experiment.** Without this breakdown, "swap to Poseidon2" has no target: the
  arity that actually matters (the `Poseidon(2)` used 20x per proof by the Merkle path, not the
  `Poseidon(3)`/`Poseidon(4)`/`Poseidon(5)` domain-tagged calls used once or twice each) was never
  identified.

What this does **not** establish: it says nothing about whether Poseidon2 would actually be faster
per call on BN254 (no Poseidon2 circuit was built or measured tonight — see Open questions), and it
does not change any STRIDE entry's mitigation status. It is a prerequisite measurement for RR5's
"Merkle accumulator provides anonymity set" line and for queue items #2 and #4, the same way the
2026-07-22 baseline was a prerequisite for every later diff.

Assumptions unchanged from the existing threat model and the 2026-07-22 baseline: Groth16 soundness
under BN254 discrete log, the dev trusted setup's toxic waste not being production-safe (RR2), and
`circomlib`'s existing Poseidon implementation being correct (unmodified, untouched tonight).

## Approach

**What I built:**

- `scripts/bench/circuit-probes/*.circom` — eleven single-gadget probe circuits (checked in), one
  `component main` each, isolating exactly the arities and templates the three production circuits
  actually instantiate: `Poseidon(2)`, `Poseidon(3)`, `Poseidon(4)`, `Poseidon(5)`, `Num2Bits(64)`,
  `Num2Bits(8)`, `GreaterThan(64)`, `LessEqThan(64)`, `GreaterEqThan(64)`, `GreaterEqThan(8)`.
- `scripts/bench/constraint-attribution.mjs` — compiles every probe plus fresh copies of
  `transfer.circom`/`compliance.circom`/`withdraw.circom`, reads real `non-linear constraints` /
  `linear constraints` / `wires` counts from the compiler's own verbose output (not `snarkjs r1cs
  info` this time — see toolchain note below), and reconciles a hand-written per-circuit "recipe"
  (which gadget, how many times, read directly off each circuit's source) against the real compiled
  total. The `MerkleProof(20)` probe isn't a hand-copied circuit: the script reads the real
  `circuits/templates/merkle_proof.circom` from disk at run time and rewrites only its two `include`
  lines (dropping a WASM-sandbox path limitation — see below), so the probe can never silently drift
  from the production template.
- Reused, not modified: `templates/merkle_proof.circom` itself, `circuits/node_modules/circomlib`.

**Toolchain note — circom2 (npm), not a `sui`/`circom` binary.** The same egress denial that blocks
item #1 also blocks `cargo build`ing `circom` from source (`static.crates.io` — the file host cargo
actually downloads crate tarballs from — returned 403, even though `index.crates.io`, the sparse
index, is on the allowlist and returns 200) and blocks a prebuilt `circom` release from GitHub.
`registry.npmjs.org` is allowlisted, though, and `circom2` (npm) ships the real Rust circom compiler
compiled to WASM *inside the npm tarball itself* — no GitHub release download, no `cargo build`, just
`npm install circom2`. Compiling all three production circuits with it reproduces the 2026-07-22
baseline's `circom` 2.2.2 numbers exactly, constraint-for-constraint:

```
$ node scripts/bench/constraint-attribution.mjs   # excerpt
--- Real circuits, recompiled fresh tonight with circom2 ---
transfer     non-linear:   6470   linear:   7141   wires:  13632
compliance   non-linear:   6057   linear:   6686   wires:  12762
withdraw     non-linear:   1465   linear:   1593   wires:   3058
```

(`13,611`/`12,743`/`3,058` total R1CS constraints = non-linear + linear, matching `README.md` and
`BASELINE.md` exactly.) That's a second, independent toolchain producing byte-identical constraint
counts to last time's native-binary `circom` — good evidence the 2026-07-22 numbers weren't an
artifact of that specific build. It's also a viable fallback path for any future night that hits the
same `cargo`/GitHub block and just needs to compile circuits (not run a trusted setup — `circom2`
doesn't help with `snarkjs`, which was already npm-only, or with `sui`, which has no WASM/npm
distribution).

**What I rejected:**
- *Hand-copying `merkle_proof.circom`'s content into the probe directory.* `circom2`'s WASI
  filesystem shim cannot resolve `../`-traversing `include` paths or `-l` search paths at all
  (confirmed empirically: a bare `include "circomlib/circuits/poseidon.circom"` resolved via a
  same-directory `-l node_modules` works; the *identical* target reached via
  `-l ../../circuits/node_modules` does not, with an "include not found" error, regardless of
  whether the target is a preopened WASI ancestor directory). A hand-copy would drift from the real
  template the next time someone edits it and nothing would catch that. Instead
  `constraint-attribution.mjs` reads the real file with plain Node `fs` (outside the WASM sandbox)
  and rewrites only the two `include` lines before handing it to `circom2` — self-updating, and the
  two rewritten lines are visible in the script's diff against the original for anyone auditing it.
- *Trusting the four-Poseidon framing and moving straight to a Poseidon2 port.* Building a
  correctness-sensitive new hash permutation (right round constants, right MDS/partial matrices for
  BN254, no independently-fetchable reference test vectors given tonight's GitHub block) for a
  hypothesis I hadn't verified yet risked exactly the kind of rushed crypto change the nightly
  instructions warn against. Measuring the real split first was cheap, safe, and turned out to
  change the target the swap should aim at.

## Results

### Isolated gadget costs (`node scripts/bench/constraint-attribution.mjs`)

| Gadget | Non-linear constraints | Linear constraints | Wires |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 520 |
| `Poseidon(3)` | 264 | 341 | 609 |
| `Poseidon(4)` | 300 | 436 | 741 |
| `Poseidon(5)` | 324 | 511 | 841 |
| `MerkleProof(20)` (full 20-level chain) | 4,920 | 5,480 | 10,422 |
| `Num2Bits(64)` | 64 | 1 | 66 |
| `Num2Bits(8)` | 8 | 1 | 10 |
| `GreaterThan(64)` | 65 | 3 | 70 |
| `LessEqThan(64)` | 65 | 4 | 71 |
| `GreaterEqThan(64)` | 65 | 4 | 71 |
| `GreaterEqThan(8)` | 9 | 4 | 15 |

Per-Merkle-level cost reconciles exactly: `4,920 / 20 = 246` per level = `243` (`Poseidon(2)`) + `2`
(`MultiMux1(2)`'s two output selections, each one non-linear constraint —
`node_modules/circomlib/circuits/mux1.circom`) + `1` (`pathIndices[i] * (1 - pathIndices[i]) === 0`
boolean check). No estimate — this is the isolated-probe number divided by 20 and cross-checked
against the mux template's own source.

### Attribution: predicted (sum of isolated probes × real recipe) vs. actual (fresh compile)

| Circuit | Merkle (20×Poseidon(2)) | Named Poseidon calls | Range checks + comparators | Glue (boolean/AND gates) | **Predicted total** | **Actual total** | Delta |
|---|---|---|---|---|---|---|---|
| `transfer.circom` | 4,920 (76.0%) | 1,164 (18.0%) — 3×`Poseidon(4)` + 1×`Poseidon(3)` | 386 (6.0%) — 4×`Num2Bits(64)` + `GT(64)` + `LEQ(64)` | 0 | 6,470 | 6,470 | **0** |
| `compliance.circom` | 4,920 (81.2%) | 852 (14.1%) — 1×`Poseidon(5)` + 2×`Poseidon(3)` | 282 (4.7%) — 3×`Num2Bits(64)` + 2×`Num2Bits(8)` + `GEQ(64)` + `GEQ(8)` | 3 (0.05%) | 6,054 | 6,057 | **3** |
| `withdraw.circom` (no Merkle path) | — | 1,143 (78.0%) — 3×`Poseidon(4)` + 1×`Poseidon(2)` | 322 (22.0%) — 3×`Num2Bits(64)` + `GT(64)` + `LEQ(64)` | 0 | 1,465 | 1,465 | **0** |

Two circuits reconcile to the constraint, zero delta. `compliance.circom`'s 3-constraint delta is
fully accounted for, not rounding noise: `compliance.circom` adds two defense-in-depth boolean
enforcements the isolated `GreaterEqThan` probes don't include (`expiryCheck.out * (1 -
expiryCheck.out) === 0`, `kycCheck.out * (1 - kycCheck.out) === 0` — both are single non-linear
constraints each), plus the AND gate `computedValid <== expiryCheck.out * kycCheck.out` — 3 total,
exactly matching the delta.

Raw command output (excerpt — full output has the per-probe and per-circuit `circom2 --verbose`
text and a JSON summary):

```
=== Veil constraint attribution (circom2 circom compiler 2.2.3) ===

--- Isolated gadget probes (scripts/bench/circuit-probes/*.circom) ---
Poseidon(2)          non-linear:    243   linear:    274   wires:    520
Poseidon(3)          non-linear:    264   linear:    341   wires:    609
Poseidon(4)          non-linear:    300   linear:    436   wires:    741
Poseidon(5)          non-linear:    324   linear:    511   wires:    841
MerkleProof(20)      non-linear:   4920   linear:   5480   wires:  10422
Num2Bits(64)         non-linear:     64   linear:      1   wires:     66
Num2Bits(8)          non-linear:      8   linear:      1   wires:     10
GreaterThan(64)      non-linear:     65   linear:      3   wires:     70
LessEqThan(64)       non-linear:     65   linear:      4   wires:     71
GreaterEqThan(64)    non-linear:     65   linear:      4   wires:     71
GreaterEqThan(8)     non-linear:      9   linear:      4   wires:     15

--- Real circuits, recompiled fresh tonight with circom2 ---
transfer     non-linear:   6470   linear:   7141   wires:  13632
compliance   non-linear:   6057   linear:   6686   wires:  12762
withdraw     non-linear:   1465   linear:   1593   wires:   3058

--- Predicted vs. actual non-linear constraints (sum of probe costs x recipe multiplicity) ---

transfer.circom:
  1xPoseidon(3)=264 + 3xPoseidon(4)=900 + 1xMerkleProof(20)=4920 + 4xNum2Bits(64)=256 + 1xGreaterThan(64)=65 + 1xLessEqThan(64)=65
  predicted (sum of isolated probes): 6470
  actual (fresh compile):             6470
  delta: 0 (0.0%)

compliance.circom:
  2xPoseidon(3)=528 + 1xPoseidon(5)=324 + 1xMerkleProof(20)=4920 + 3xNum2Bits(64)=192 + 2xNum2Bits(8)=16 + 1xGreaterEqThan(64)=65 + 1xGreaterEqThan(8)=9
  predicted (sum of isolated probes): 6054
  actual (fresh compile):             6057
  delta: 3 (0.0%)

withdraw.circom:
  1xPoseidon(2)=243 + 3xPoseidon(4)=900 + 3xNum2Bits(64)=192 + 1xGreaterThan(64)=65 + 1xLessEqThan(64)=65
  predicted (sum of isolated probes): 1465
  actual (fresh compile):             1465
  delta: 0 (0.0%)
```

Reproduce: `cd scripts/bench && npm install && node constraint-attribution.mjs`.

An earlier draft of this script had `withdraw.circom`'s recipe at 4× `Num2Bits(64)`, not 3 — copied
from `transfer.circom`'s count without re-reading `withdraw.circom`'s own source. That produced a
-64 delta (exactly one `Num2Bits(64)`'s cost), which is what caught the mistake: the recipe is meant
to reconcile to zero (or to a delta I can name), and a nonzero, unexplained delta is a bug in the
recipe, not noise. Fixed by re-reading `withdraw.circom` (it has 3: `amountBits`, `cumBits`,
`remBits` — no separate range check exists on `newCommitment` itself, only on the plaintext
`remainingBalance` that feeds it).

### Test suite

| Suite | Result | Command |
|---|---|---|
| Circuits, fallback/simulated mode (108 tests) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **pending** — long-running in this sandbox, see note | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** — `sui` CLI unavailable, same blocker as item #1 | `cd contracts && sui move test` |

Circuit tests ran in **fallback (circomlibjs-simulated) mode**, not real-proof mode: reproducing
`build{,-withdraw,-compliance}/` needs the pot15 Powers of Tau file, and
`storage.googleapis.com` — the host `circuits/scripts/compile*.sh` downloads it from — is blocked by
the same egress allowlist as `github.com` and the Sui RPC host (confirmed with a HEAD request, 403).
Per `README.md`'s own words, fallback mode is "a linting aid, not evidence" — it does confirm no
witness-generation-breaking change was introduced, but it is not the same claim as the 2026-07-22
baseline's real-proof 108/108. No production circuit file was touched tonight, so the risk this
gap represents is low, but it's a real gap, not a passing claim — recorded honestly rather than
implied away.

No test was loosened, skipped, or given new tolerance to reach these numbers.

## Verdict: **KEEP**

The measured split is real, reconciles to the constraint (two circuits exactly, one to a fully
explained 3-constraint delta), and corrects a specific, citable claim in `README.md` and
`BASELINE.md` that was feeding a queue-ranking decision. `docs/research/BASELINE.md` is updated with
the per-gadget breakdown table below. `README.md`'s "Four Poseidon instances and four `Num2Bits(64)`
range checks dominate the real cost" line is corrected for `transfer.circom` and `compliance.circom`,
where it materially understates the Merkle path's share (76.0% and 81.2% of non-linear constraints
respectively, vs. named Poseidon calls at only 18.0% and 14.1%); it stays accurate for
`withdraw.circom`, which has no Merkle path.

## Where this could be used

- **Any Circom circuit doing depth-D Merkle membership as one gadget among several** — the pattern
  here (isolate each gadget as its own single-`component main` probe, sum with real per-circuit
  multiplicities, and require the delta to reconcile to an explained number, not "close enough") is
  a cheap, general way to find out whether a "dominant cost" story in a README is actually true
  before optimizing on the strength of it. This would have caught the same mistake in any
  Tornado-Cash-style shielded-pool circuit with a Merkle-proof gadget bundled alongside a handful of
  named hashes.
- **A thesis chapter on constraint-count optimization for anonymity-set circuits** gets a concrete,
  reproducible example of "the anonymity-set proof (not the payload hashes) is the actual
  bottleneck" — a common but rarely quantified claim in ZK privacy-pool designs.
- **Any team deciding whether to spend engineering effort on a Poseidon2 port vs. a Merkle-depth /
  batching change** — the general lesson (name every gadget, measure each in isolation, multiply by
  the real recipe, and don't trust a total's stated cause until the sum reconciles) generalizes past
  Poseidon and past Veil.

## Open questions (next queue)

1. **A Poseidon2 experiment should target arity 2 first** (the Merkle-path hash, called 20x per
   proof), not the named domain-tagged calls — the opposite of what `EXPERIMENTS.md` item #2
   currently implies. Building and measuring an actual Poseidon2 `Poseidon(2)`-equivalent circuit
   (with correctness cross-checked against a reference implementation, not hand-derived) is real
   work for a future night; tonight only measured the existing Poseidon's cost, not a replacement's.
2. **Merkle depth is now a real, quotable dial**: each additional tree level costs exactly 246
   non-linear constraints in any circuit that includes `MerkleProof(depth)` (confirmed at depth 20;
   the per-level cost is architecture-fixed, not depth-dependent, so this should hold at other
   depths too, but that itself is only inferred from the depth-20 measurement, not separately
   verified at another depth — the natural first check for item #4's Merkle-accumulator work).
   Going from depth 20 (~2^20 anonymity set) to depth 32 (~2^32) would add 12 x 246 = 2,952
   non-linear constraints to `transfer.circom` alone, a computed number this experiment can hand to
   item #4, not a new guess.
3. **On-chain gas per entry point** (queue item #1) — still blocked. This sandbox's egress allowlist
   needs either `github.com` (for a `sui` CLI release) or one named Sui fullnode RPC host added
   before this is measurable at all. Worth stating precisely in any request to change the sandbox
   policy, since tonight narrowed it to exactly those two hosts.
4. **Circuit tests haven't run in real-proof mode since 2026-07-22** (`storage.googleapis.com` now
   also blocked, in addition to the `sui`/GitHub blockers) — worth flagging if this sandbox's egress
   policy is ever revisited, since real-proof mode is the only mode README calls "evidence."
5. Does `circuits`' chained `npm test` hang (queue item #12, not touched tonight) also affect the
   fallback-mode single-file runs used above? They completed fine individually tonight, same
   workaround as 2026-07-22.
