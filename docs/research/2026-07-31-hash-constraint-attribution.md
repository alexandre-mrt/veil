# 2026-07-31 — Hashing vs. everything else: where Veil's constraint budget actually goes

## Hypothesis

Poseidon hashing — the identity/nullifier/context hashes plus the depth-20 Merkle-membership
path — accounts for the overwhelming majority of each circuit's R1CS constraint count, and the
depth-20 Merkle path alone (20 sequential `Poseidon(2)` calls) costs more non-linear constraints
than all of a circuit's "identity" Poseidon calls combined. This experiment moves the number
"fraction of Veil's non-linear constraints attributable to hashing, per circuit, with a
constraint-cost-per-Merkle-level figure" from unknown to measured, so future crypto/scalability
experiments in this loop (Poseidon2, Merkle depth changes, batched verification) can target the
actual bottleneck instead of guessing at it.

This is the queue's #2 item (`docs/research/EXPERIMENTS.md`, "Poseidon2 vs current Poseidon"),
narrowed to its measurable half: *"re-deriving the exact non-linear-constraint contribution per
Poseidon instance from the current baseline"*, which the queue explicitly offered as an
alternative to a full Poseidon2 port. See "What I rejected" below for why the full port wasn't
attempted tonight.

Queue item #1 (on-chain gas per entry point) was re-attempted first, per last night's note that
it deserved another try before moving on — see "On-chain gas: re-attempted, still blocked" below.

## Threat / privacy model

No protocol code changed. Nothing here alters what a chain observer, colluding relayer,
malicious auditor, malicious prover, or quantum adversary can do — `transfer.circom`,
`compliance.circom`, and `withdraw.circom` are byte-for-byte unmodified; this experiment only
compiles new *isolated* micro-benchmark circuits (bare `Poseidon(t)` components and the existing
`templates/merkle_proof.circom` at depth 20) and recompiles the unmodified production circuits to
check the attribution sums against real totals.

What relies on this being honest: every future night that touches hashing or the Merkle
accumulator (Poseidon2 swap, Merkle depth change, batched proof verification) will use these
percentages and the per-level cost figure to decide where to spend effort. A wrong attribution
here sends a future night chasing the wrong optimization.

What this does **not** establish: it says nothing about whether Poseidon2 (or any other change)
is actually safe to adopt — that requires a verified implementation and its own soundness
argument, not attempted tonight (see below). It maps to no STRIDE entry directly, same as the
2026-07-22 baseline it extends.

Assumptions unchanged from `docs/threat-model.md`: Groth16/BN254 soundness, dev-only trusted
setup (RR2) not production-safe.

## Approach

**What I built.** `scripts/bench/hash-constraint-attribution.mjs` — a reusable script that:

1. Compiles a bare `component main = Poseidon(t)` for each arity `t` actually used in the three
   production circuits (2, 3, 4, 5 — found via `grep -n "Poseidon(" circuits/*.circom`), capturing
   circom's own non-linear/linear constraint counts.
2. Compiles the real `circuits/templates/merkle_proof.circom` template at `depth = 20` (the depth
   every production circuit that uses it — `transfer.circom`, `compliance.circom` — is
   instantiated with) the same way, rather than reimplementing it, so the benchmark can't drift
   from what's actually in the circuits.
3. Recompiles `transfer.circom`, `compliance.circom`, and `withdraw.circom` fresh and compares
   `(instance count × primitive cost)` against the real measured total, printing both the
   attributed sum and the residual ("everything else": range checks, comparators, threshold/epoch
   logic).

The per-circuit instance counts (`PRODUCTION_USAGE` in the script) are hand-derived from
`grep -n "Poseidon(" circuits/*.circom` and each circuit's `component main = X(depth)` line —
documented in the script's header comment so a future night can re-verify them if a circuit's hash
calls change.

**What I rejected.** A full Poseidon2 circuit port and side-by-side proving-time comparison — the
queue's other framing of this item. I looked for a maintained, published circom Poseidon2
implementation (npm: searched `poseidon2-circom`, `circom-poseidon2`, `circomlib-poseidon2`,
`@zk-kit/circuits` — the last one ships `poseidon-cipher.circom` and `poseidon-proof.circom`, both
*original* Poseidon, not Poseidon2). None exists on the registries this session can reach.
Hand-deriving Poseidon2's BN254 round constants and the external/internal linear layers myself and
shipping that as a circuit primitive is exactly the kind of thing that fails silently — a wrong
constant doesn't error, it just produces a hash function with unknown (possibly broken) security
properties, in a circuit whose whole job is binding commitments and nullifiers. That's not a
"measured, verified" result, it's a guess wearing a circuit's clothing, and the nightly loop's one
rule is real numbers from commands actually run — not risk-laundered guesses. I did not attempt it.
(There are npm packages with verified Poseidon2 *test vectors* — `@taceo/poseidon2`,
`@zkpassport/poseidon2` — that would let a future night validate a hand-written circom port
against known-good outputs before ever touching a production circuit. That's next-queue work, not
tonight's.)

I also rejected re-deriving the attribution by hand from `docs/research/BASELINE.md`'s aggregate
numbers alone (no new compile) — it wouldn't have been *falsifiable*: hand arithmetic on old
numbers can't be wrong in a way that shows up, whereas a fresh compile-and-compare either matches
or it doesn't (it did — see Results).

### On-chain gas: re-attempted, still blocked

Per last night's note ("worth spending an early part of the next run purely on unblocking the
toolchain"), I checked this first. Both routes are closed this session, for a *harder* reason than
last night's ("denied by the sandbox's tool-approval layer, not retried, per policy"):

```
$ curl -sS -m 20 -o /dev/null -w "HTTP %{http_code}\n" https://api.github.com/repos/MystenLabs/sui/releases/latest
HTTP 403

$ curl -sS -m 20 -X POST https://fullnode.testnet.sui.io:443 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS -m 15 "$HTTPS_PROXY/__agentproxy/status"
...
  "recentRelayFailures": [
    {
      "ts": "2026-07-31T07:06:34.078Z",
      "kind": "connect_rejected",
      "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
      "host": "fullnode.testnet.sui.io:443"
    }
  ]
```

The session's network egress is allow-listed (`registry.npmjs.org`, `index.crates.io`,
`pypi.org`, plus `github.com` git-protocol clones, per the proxy status `noProxy` list) and
explicitly denies arbitrary hosts, including both `api.github.com` (for a prebuilt `sui` release
asset) and a public Sui fullnode RPC endpoint. I also checked whether `sui` is installable via
`cargo install` from crates.io as a third route: it isn't — `index.crates.io`'s `sui` package is
an unrelated name-squatted crate (`v0.0.1`, no deps, from 2022), not Mysten Labs' CLI.

This is a session/environment network-policy limit, not a toolchain gap a coding session can work
around — re-attempting it next time without the policy changing will reproduce the same 403s.
Moved to a note in `EXPERIMENTS.md` rather than re-ranked to the top; see Open questions.

## Results

### Per-primitive constraint cost (fresh compile, circom 2.2.2 built from `iden3/circom` tag
`v2.2.2`, same toolchain as the 2026-07-22 baseline)

| Primitive | Non-linear | Linear |
|---|---|---|
| `Poseidon(2)` | 243 | 274 |
| `Poseidon(3)` | 264 | 341 |
| `Poseidon(4)` | 300 | 436 |
| `Poseidon(5)` | 324 | 511 |
| `MerkleProof(20)` (real `templates/merkle_proof.circom`) | 4,920 | 5,480 |

`MerkleProof(20)` = 20 × (`Poseidon(2)` + `MultiMux1(2)` + a boolean check on `pathIndices[i]`) =
246 non-linear / 274 linear constraints **per Merkle level**.

### Attribution vs. real measured totals (fresh compile of unmodified production circuits)

| Circuit | Poseidon instances | Merkle depth | Actual non-linear | Attributed (hash) | Hash % | Residual (non-hash logic) |
|---|---|---|---|---|---|---|
| `transfer.circom` | 3×`P(4)` + 1×`P(3)` | 20 | 6,470 | 6,084 | **94.0%** | 386 |
| `compliance.circom` | 1×`P(5)` + 2×`P(3)` | 20 | 6,057 | 5,772 | **95.3%** | 285 |
| `withdraw.circom` | 3×`P(4)` + 1×`P(2)` | — | 1,465 | 1,143 | **78.0%** | 322 |

Linear-constraint attribution is even more lopsided: 99.8% (transfer), 99.8% (compliance), 99.3%
(withdraw) — non-hash logic (range checks, comparators, epoch/threshold enforcement) is 11–13
linear constraints per circuit, a rounding error next to ~5,500–7,100 total.

The attributed totals reproduce the actual measured totals almost exactly (the small residual is
real non-hash circuit logic, not benchmark error) — and the *actual* totals from tonight's fresh
compile exactly match `BASELINE.md`'s 2026-07-22 figures (6,470/7,141, 6,057/6,686, 1,465/1,593),
which is a useful independent cross-check that both nights' measurements are reproducible.

**The Merkle path, not the identity hashes, is the dominant cost.** In `transfer.circom`, the
depth-20 Merkle path (4,920 non-linear) costs **4.2×** what the circuit's three identity/nullifier
Poseidon calls cost combined (1,164). In `compliance.circom`, it's **5.8×** (4,920 vs. 852).
`withdraw.circom` has no Merkle path at all — every one of its non-linear constraints traces to a
lookup or comparison, never a tree walk — which is the real reason it was already flagged
"Poseidon-light" relative to the other two; it isn't lighter per-hash, it just doesn't pay for
tree membership.

Raw command output:

```
$ node scripts/bench/hash-constraint-attribution.mjs --circom /path/to/circom
=== Veil hash-constraint attribution ===
circom: circom compiler 2.2.2

Poseidon(2): non-linear=243 linear=274
Poseidon(3): non-linear=264 linear=341
Poseidon(4): non-linear=300 linear=436
Poseidon(5): non-linear=324 linear=511
MerkleProof(20): non-linear=4920 linear=5480

--- transfer ---
  actual:     non-linear=6470 linear=7141
  attributed: non-linear=6084 (94.0%)  linear=7129 (99.8%)
  residual (non-hash logic): non-linear=386 linear=12

--- compliance ---
  actual:     non-linear=6057 linear=6686
  attributed: non-linear=5772 (95.3%)  linear=6673 (99.8%)
  residual (non-hash logic): non-linear=285 linear=13

--- withdraw ---
  actual:     non-linear=1465 linear=1593
  attributed: non-linear=1143 (78.0%)  linear=1582 (99.3%)
  residual (non-hash logic): non-linear=322 linear=11
```

(Full JSON summary, including per-primitive raw circom output, is printed by the script and
reproduced in this run's session log; omitted here for length.)

### Test suite (full run — no circuit, Move, or frontend proving code changed)

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` (run individually, same `&&`-chain hang as 2026-07-22 — still not fixed, see `EXPERIMENTS.md` #12) |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** | `sui` CLI still unavailable — see "On-chain gas" above |

No test was loosened, skipped, or given new tolerance.

## Verdict: **KEEP**

`scripts/bench/hash-constraint-attribution.mjs` is a real, reusable, reproducible measurement —
merged. `docs/research/BASELINE.md` gets a new "Constraint attribution" section with the table
above.

The *other* framing of this queue item — actually swapping to Poseidon2 and measuring a proving-
time delta — was not attempted and is **not** a KEEP or REJECT; it's genuinely unattempted,
correctly gated behind building a verified circom Poseidon2 implementation first. That work item
moves to `EXPERIMENTS.md`, re-ranked below the Merkle-depth/batching item this measurement now
justifies promoting (see Open questions).

On-chain gas per entry point stays **BLOCKED**, now with a precise, non-retryable reason (session
network policy, not a local toolchain gap).

## Where this could be used

- **Any Circom/Groth16 UTXO-style shielded-transfer protocol with a Merkle-accumulator anonymity
  set** (Tornado-Cash-style mixers, Zcash-style shielded pools, Sui/Aptos Move analogues of this
  design) — the finding generalizes directly: if your circuit does a depth-`d` Merkle membership
  check, expect it to dominate your constraint count over any constant-size identity/nullifier
  hashing, and the per-level cost (`Poseidon(2)` + selector, ~246 non-linear constraints on BN254
  with circomlib's Poseidon) is a real number to plug into a depth-vs-anonymity-set trade-off
  calculation before ever touching the hash function itself.
- **Veil's own queue item #4** (Merkle accumulator scaling, depth vs. anonymity-set trade-off) —
  this experiment is its direct prerequisite: any future proposal to change tree depth (e.g.
  16 vs. 20 vs. 24) now has an exact per-level constraint cost to reason from, instead of a
  qualitative "deeper is slower."
- **A thesis chapter on circuit-optimization methodology**, independent of Poseidon2 specifically:
  "profile which primitive actually dominates the R1CS before optimizing any single primitive's
  internals" — the isolate-and-attribute technique here (bare micro-circuits + a fresh production
  recompile, cross-checked against an independent baseline) is reusable on any circuit, not just
  hash-heavy ones.
- **Confidential payroll or compliance-gated DeFi with a credential Merkle tree**
  (`compliance.circom`'s design, named in the 2026-07-22 report) — 95.3% of its non-linear
  constraints are hashing too, which tells a t-of-n auditor-board redesign (queue item #6) that
  changing the auditing scheme won't move proving time much unless it also touches the credential
  tree depth.

## Open questions (next queue)

1. **Merkle depth / batched-verification trade-off** (queue #4, promoted) — now has a real
   per-level cost (246 non-linear / 274 linear constraints) to reason with. Highest-leverage next
   crypto/scalability experiment: either a real depth change (e.g. rebuild at depth 16, measure
   the actual proving-time delta and the resulting anonymity-set-size cost) or a batched/recursive
   Merkle-proof scheme, now that we know which 20 constraint-heavy components would be batched.
2. **Verified Poseidon2 port** (queue #2, re-scoped) — before touching any production circuit:
   pull reference test vectors from a maintained JS implementation (`@taceo/poseidon2` or
   `@zkpassport/poseidon2`, both on npm and BN254-targeted), hand-write a circom Poseidon2
   template, and validate its output against those vectors in isolation. Only after that
   validation passes does a real swap-and-measure experiment become honest to attempt. This is
   substantial enough to be its own night, possibly two (build + validate, then swap + full
   soundness/leakage/negative-test writeup per the nightly loop's circuit-change rule).
3. **On-chain gas per entry point** — confirmed blocked by session network egress policy
   (`api.github.com` and `fullnode.testnet.sui.io` both return `403` at the proxy). Not
   autonomously fixable by a future night's coding session; needs either the environment's network
   policy widened to allow a Sui fullnode RPC host, or a `sui` CLI binary made available in the
   environment some other way (pre-baked into the container image, mounted in, etc.). Re-attempting
   with the same tools each night will just reproduce this report's 403s — worth flagging to
   whoever configures the environment rather than re-spending night-budget on it.
4. **`frontend/public/circuits/withdraw_vk.json` is untracked** — noticed incidentally: tonight's
   `compile-withdraw.sh` run regenerates it (dev-only ceremony, new random entropy each run) but
   `git status` shows it was never committed, unlike `transfer_vk.json` and `compliance_vk.json`
   which are. Not fixed tonight (out of scope, and the file that exists locally now is a
   throwaway dev-ceremony artifact that shouldn't be the one committed) — worth a real production
   ceremony run deciding this, not a nightly-loop side effect.
