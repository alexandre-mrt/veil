# 2026-08-30 — Poseidon's exact share of Veil's constraint budget

## Hypothesis

The non-linear-constraint contribution of every named gadget in `transfer.circom`, `compliance.circom`,
and `withdraw.circom` — each Poseidon arity, each range check, the Merkle-membership template — can be
measured directly by compiling each gadget alone and reading circom's own reported constraint count,
not estimated from reading the circuit source. Doing so answers open question #4 from the
2026-07-22 baseline report exactly: **what fraction of each circuit's cost is Poseidon**, which sets a
hard ceiling on how much any future hash-function swap (Poseidon2 or otherwise) could ever save, before
committing a multi-night effort to a circuit port.

This is queue item #2, taken via its explicitly-allowed alternate framing ("or re-deriving the exact
non-linear-constraint contribution per Poseidon instance from the current baseline") rather than a live
Poseidon2 port — see **Approach** for why.

## Before this: re-verifying queue item #1 (on-chain gas)

Item #1 was blocked twice already (2026-07-22, for two different reasons: no `sui` CLI, and a denied
RPC call). Per the queue's own instruction, I spent the first part of tonight specifically trying to
unblock it rather than assuming it was still stuck for the same reasons. Result: it is blocked for a
*third*, more specific reason, and this one won't go away on its own.

- `sui` CLI: no prebuilt binary is fetchable — `github.com/MystenLabs/sui/...` and
  `api.github.com/repos/MystenLabs/sui/...` both return a **403 from this session's own GitHub access
  layer**, not a network failure: `{"message":"GitHub access to this repository is not enabled for
  this session. Use add_repo to request access..."}`. This session's GitHub scope is `alexandre-mrt/veil`
  only. `raw.githubusercontent.com` (not gated by that layer) answers fine, but release binaries are
  served from `github.com/.../releases/download/...`, which is gated. `crates.io`/`static.crates.io`
  are separately blocked at the network-policy layer (403 on direct HTTPS `CONNECT`, distinct from the
  GitHub layer), and no `circom`/`sui` binary crate is published there anyway (`cargo info circom` /
  `cargo info sui` — not found).
- Direct JSON-RPC to a public Sui fullnode (this baseline's suggested fallback): **every** fullnode
  host tried — `fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`, `sui-testnet-rpc.publicnode.com`,
  `sui-testnet.blockvision.org`, `rpc.ankr.com`, `explorer-rpc.testnet.sui.io` — gets an identical
  `connect_rejected` / `403` at `CONNECT`, from the network proxy itself, regardless of provider:

  ```
  $ curl -sS -m 12 -o /dev/null -w "%{http_code}\n" https://fullnode.testnet.sui.io
  curl: (56) CONNECT tunnel failed, response 403
  [agent-proxy] ... connect_rejected (organization policy) ...
  ```

  Six different hosts, same rejection, same wording ("organization policy") — this reads as a
  *category*-level block (blockchain RPC endpoints as a class), not a per-host or transient issue. For
  contrast, ordinary web hosts (`registry.npmjs.org`, `raw.githubusercontent.com`,
  `storage.googleapis.com`) are all reachable from this same session.

**Conclusion: item #1 is not a toolchain gap this loop can route around by trying harder or trying a
different provider.** It needs one of two things that only a human can grant: GitHub access to
`MystenLabs/sui` (for a source build or release binary) via `add_repo`, or a network-policy exception
for at least one Sui RPC host. Re-ranked in `EXPERIMENTS.md` below with this noted explicitly, so a
future run doesn't re-spend a night rediscovering the same wall. Per the loop's own fallback rule, I
did not attempt a design-only/UNMEASURED gas estimate — a static count of dynamic-field touches per
Move entry point would not be gas, and packaging a guess as an "estimate" is exactly what this loop
exists to avoid. Pivoted to item #2 instead, which turned out to have real, unblocked room to run.

## Threat / privacy model

No protocol circuit, Move module, or trust boundary changes here. This is a measurement of an
already-deployed circuit's constraint accounting, not a new construction — so there is no new
adversary capability to describe, and it maps to no STRIDE entry directly, same as the 2026-07-22
baseline.

**Who relies on this being honest:** the same audience as the baseline — this loop's own future
nights (a Poseidon2 KEEP/REJECT decision is a diff against tonight's ceiling number), and anyone
deciding whether a proof-system or hash-function change is worth the engineering cost at all. If
tonight's 93%/94%/78% figures were wrong, a future night could sink real effort into a Poseidon2 port
expecting a saving that was never available, or skip one that would have paid off.

**What this does not establish:** whether Poseidon2 (or any alternative) can actually close that gap
— that requires a *correct* Poseidon2 circom implementation, which this experiment deliberately does
not attempt (see Approach). It also says nothing about proving *time* per gadget (only constraint
*count* — the two correlate but aren't identical, since witness generation cost and R1CS-to-QAP
overhead differ per gadget shape). And it changes nothing about `docs/threat-model.md` — Groth16
soundness under BN254 discrete-log, and the dev-only trusted setup (RR2), are unchanged and unexamined
here.

## Approach

**What I built.** `scripts/bench/constraint-breakdown.mjs` — a reusable script that:

1. Generates a minimal standalone `.circom` file for each gadget actually used in the three circuits
   (`Poseidon(2/3/4/5)`, `Num2Bits(8/64)`, `GreaterThan(64)`, `GreaterEqThan(8/64)`, `LessEqThan(64)`,
   `MultiMux1(2)`, and the whole `MerkleProof(20)` template), using the exact same `circomlib`
   source already vendored in `circuits/node_modules` — not a reimplementation.
2. Compiles each with `circom2` (see below) and parses its own reported `non-linear constraints` /
   `linear constraints` line — the same numbers `snarkjs r1cs info` would report, read straight from
   the compiler.
3. Reconciles: for each real circuit, sums `(gadget instance count × measured per-instance cost)`
   against the circuit's actual total (from a fresh full compile), and reports the residual —
   constraints that live directly in the parent circuit (equality assertions, additions, booleanity
   checks on comparator outputs) rather than inside a named, reusable gadget.

**Toolchain finding, independent of tonight's hypothesis but worth recording:** the 2026-07-22 baseline
built `circom` from source via `cargo build --release` against a `git clone` of `iden3/circom` — a
path that no longer exists this session (see above, GitHub access is repo-scoped). `circom2`
(`npm install --save-dev circom2` in `circuits/`) is a WASM build of **circom compiler 2.2.3**
distributed on the npm registry, which *is* reachable. It reproduces the exact 2026-07-22 baseline
numbers bit-for-bit on a clean recompile of all three circuits (verified before touching anything —
see Results) and needs no GitHub or crates.io access at all. This is a strictly better reproduction
path for this environment specifically and I added it as a `devDependency` rather than relying on a
`/tmp`-built binary that doesn't survive a fresh session; `BASELINE.md`'s reproduction section is
updated accordingly.

**What I rejected.**

- **Actually porting a Poseidon2 gadget into the circuits and measuring the swap.** This is the
  version of item #2 the queue describes first, and it is what would actually move the number instead
  of just bounding it. I did not do it, for one reason: I have no way to obtain a *verified* Poseidon2
  circom implementation in this session. The reference implementations live on GitHub
  (`HorizenLabs/poseidon2`, `zkpassport`, etc.) — blocked by the same repo-scoped GitHub access as
  item #1. The npm packages that do exist for Poseidon2
  (`@zkpassport/poseidon2`, `@taceo/poseidon2`, `poseidon2`) are TypeScript/WASM *hash* libraries for
  computing digests off-chain — none of them ship a `.circom` gadget, so none are directly usable
  inside a circuit. Writing the permutation (round constants, external/internal round structure, the
  linear layer) from memory and calling it "Poseidon2" would be exactly the kind of unverified,
  self-certified crypto this loop should not ship — a subtly wrong constant or round count produces a
  circuit that compiles, "works" on valid witnesses, and is not the hash function anyone thinks it is.
  Measuring against it would produce a real number for the wrong primitive, which is worse than an
  honest gap. This is why tonight's experiment measures the *ceiling* instead: it's the true number
  that doesn't require trusting an unverified gadget.
- **Isolating each gadget with N=1 vs N=2 instances to check for fixed per-template overhead**,
  before trusting single-instance numbers as the per-instance marginal cost. Rejected as unnecessary
  once the reconciliation step (below) came back exact or near-exact for all three circuits — if there
  were a hidden fixed per-template cost, the predicted totals would systematically overshoot the
  actual ones, and they don't.

## Results

### Per-gadget non-linear constraint cost (real `circom2` compiles, `node scripts/bench/constraint-breakdown.mjs`)

| Gadget | Non-linear | Linear | Used in |
|---|---|---|---|
| `Poseidon(2)` | 243 | 243 | Merkle leaf hashing (per level) |
| `Poseidon(3)` | 264 | 264 | `transfer` txAmountHash; `compliance` nfHash, ctxHash |
| `Poseidon(4)` | 300 | 300 | `transfer` oldHash/newHash/nfHash; `withdraw` commHash/changeHash/nfHash |
| `Poseidon(5)` | 324 | 324 | `compliance` leafHash |
| `Num2Bits(8)` | 8 | 8 | `compliance` kycBits/reqKycBits |
| `Num2Bits(64)` | 64 | 64 | range checks, all three circuits |
| `GreaterThan(64)` | 65 | 65 | `transfer`/`withdraw` "amount > 0" |
| `GreaterEqThan(64)` | 65 | 65 | `compliance` expiry check |
| `GreaterEqThan(8)` | 9 | 9 | `compliance` kycLevel check |
| `LessEqThan(64)` | 65 | 65 | `transfer` threshold check; `withdraw` amount check |
| `MultiMux1(2)` | 2 | 2 | Merkle sibling-order selection (per level) |
| `MerkleProof(20)` (whole template) | 4,920 | 4,920 | `transfer` membershipProof; `compliance` merkleProof |

`MerkleProof(20)` reconciles internally to `20 × Poseidon(2)` (4,860) `+ 20 × MultiMux1(2)` (40)
`+ 20` residual (the per-level `pathIndices[i] * (1 - pathIndices[i]) === 0` booleanity check,
1 non-linear constraint × 20 levels) `= 4,920` — exact.

### Reconciliation against the real circuits (fresh `circom2` compile, matches 2026-07-22 baseline exactly)

| Circuit | Predicted (sum of gadgets) | Actual (fresh compile) | Residual | Poseidon share |
|---|---|---|---|---|
| `transfer.circom` | 6,470 | 6,470 | 0 | **93.1%** (6,024 / 6,470) |
| `compliance.circom` | 6,054 | 6,057 | 3 | **94.3%** (5,712 / 6,057) |
| `withdraw.circom` | 1,465 | 1,465 | 0 | **78.0%** (1,143 / 1,465) |

`compliance.circom`'s 3-constraint residual is fully explained by three assertions written directly in
the circuit body, not inside a named gadget: `computedValid <== expiryCheck.out * kycCheck.out` (1)
and the two defense-in-depth booleanity checks `expiryCheck.out * (1 - expiryCheck.out) === 0` /
`kycCheck.out * (1 - kycCheck.out) === 0` (2) — see `compliance.circom` lines 100–105.

Raw command output (`node scripts/bench/constraint-breakdown.mjs`, abbreviated — full output is
reproducible verbatim from the script):

```
=== Veil constraint breakdown (per-gadget, real circom2 compiles) ===

poseidon2            non-linear=  243  linear=  243  (Merkle leaf hashing (per level, both transfer.circom and compliance.circom))
poseidon3            non-linear=  264  linear=  264  (transfer.circom txAmountHash; compliance.circom nfHash + ctxHash)
poseidon4            non-linear=  300  linear=  300  (transfer.circom oldHash/newHash/nfHash; withdraw.circom commHash/changeHash/nfHash)
poseidon5            non-linear=  324  linear=  324  (compliance.circom leafHash)
num2bits8            non-linear=    8  linear=    8  (compliance.circom kycBits/reqKycBits)
num2bits64           non-linear=   64  linear=   64  (range checks in all three circuits)
greaterthan64        non-linear=   65  linear=   65  (transfer.circom / withdraw.circom "amount > 0" checks)
greaterequalthan64   non-linear=   65  linear=   65  (compliance.circom expiry check)
greaterequalthan8    non-linear=    9  linear=    9  (compliance.circom kycLevel check)
lessequalthan64      non-linear=   65  linear=   65  (transfer.circom threshold check; withdraw.circom amount check)
multimux1_2          non-linear=    2  linear=    2  (Merkle sibling-order selection (per level))
merkleproof20        non-linear= 4920  linear= 4920  (transfer.circom membershipProof; compliance.circom merkleProof (whole template, depth 20))

=== Reconciliation against real circuits ===

--- transfer.circom ---
  merkleproof20        x1 = 4920 (per-instance 4920)
  poseidon4            x3 = 900 (per-instance 300)
  poseidon3            x1 = 264 (per-instance 264)
  greaterthan64        x1 = 65 (per-instance 65)
  num2bits64           x4 = 256 (per-instance 64)
  lessequalthan64      x1 = 65 (per-instance 65)
  predicted total: 6470   actual (circom2, fresh compile): 6470   residual: 0 (0.0% unattributed)
  Poseidon share of predicted total: 6024 / 6470 = 93.1%

--- compliance.circom ---
  poseidon5            x1 = 324 (per-instance 324)
  merkleproof20        x1 = 4920 (per-instance 4920)
  poseidon3            x2 = 528 (per-instance 264)
  greaterequalthan64   x1 = 65 (per-instance 65)
  greaterequalthan8    x1 = 9 (per-instance 9)
  num2bits64           x3 = 192 (per-instance 64)
  num2bits8            x2 = 16 (per-instance 8)
  predicted total: 6054   actual (circom2, fresh compile): 6057   residual: 3 (0.0% unattributed)
  Poseidon share of predicted total: 5712 / 6054 = 94.4%  (94.3% of the actual measured total)

--- withdraw.circom ---
  poseidon4            x3 = 900 (per-instance 300)
  poseidon2            x1 = 243 (per-instance 243)
  num2bits64           x3 = 192 (per-instance 64)
  greaterthan64        x1 = 65 (per-instance 65)
  lessequalthan64      x1 = 65 (per-instance 65)
  predicted total: 1465   actual (circom2, fresh compile): 1465   residual: 0 (0.0% unattributed)
  Poseidon share of predicted total: 1143 / 1465 = 78.0%
```

Confirming `circom2` reproduces the 2026-07-22 baseline before any of the above (per-circuit fresh
compile, matches `BASELINE.md` exactly on non-linear/linear/wires for all three circuits):

```
$ npx circom2 transfer.circom --r1cs --wasm --sym -o build -l node_modules
non-linear constraints: 6470   linear constraints: 7141   wires: 13632
$ npx circom2 compliance.circom --r1cs --wasm --sym -o build-compliance -l node_modules
non-linear constraints: 6057   linear constraints: 6686   wires: 12762
$ npx circom2 withdraw.circom --r1cs --wasm --sym -o build-withdraw -l node_modules
non-linear constraints: 1465   linear constraints: 1593   wires: 3058
```

### What this bounds

No circuit changed, so there's no "before vs. after" proving-time table tonight — the number that
moved is **how precisely we can bound a future one**. `transfer.circom` and `compliance.circom` are
93–94% Poseidon; even a hypothetical zero-cost replacement hash could only ever remove that fraction of
their non-linear constraints, and Poseidon2's real published gains (round-count and linear-layer
changes relative to Poseidon) are almost certainly well short of 100% — so a realistic expectation for
a verified port is a meaningful fraction of that 93–94%, not the whole thing. `withdraw.circom` is
lower-leverage at 78% (it carries no Merkle proof), so it should be a lower priority for a future
Poseidon2 port than the other two.

### Test suite (full run — no circuit, Move, or frontend proving code changed)

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs, `circom2`-compiled) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` (individually — known `&&`-chain hang, queue item #12, unchanged) |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz | **6/6 properties, 500 cases each, all pass** | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Move contracts | **NOT RUN** (same blocker as 2026-07-22 — no `sui` CLI) | `cd contracts && sui move test` |

No test was loosened, skipped, or given new tolerance. Move remains the one gap, unchanged from the
last run and tracked by the same item #1 blocker above.

## Verdict: **KEEP**

`scripts/bench/constraint-breakdown.mjs` and its findings are merged. This gives every future
crypto-cost decision in this loop a real ceiling number instead of "Poseidon dominates the constraint
count" as a qualitative guess. `BASELINE.md` gets a new section with the per-gadget table and the
93.1% / 94.3% / 78.0% figures; the `circom2` reproduction path replaces the from-source `cargo build`
instructions there too, since the latter no longer works in this environment.

The Poseidon2 **port itself** is **PARK**ed, not attempted — blocked on obtaining a verified circom
gadget, which is a GitHub-access problem (same root cause as item #1's `sui` CLI gap), not a measurement
problem. It goes back into `EXPERIMENTS.md` re-ranked and re-scoped: "measure the swap" rather than
"measure the ceiling," since the ceiling is now known.

## Where this could be used

- **Any Circom/Groth16 circuit with a Merkle-membership component** (which is most private-set-membership
  protocols — mixers, private voting, credential systems): the `MerkleProof(depth)` cost dominates for
  any depth ≥ ~15–20, and this script's method (isolate the template, reconcile against the full
  circuit) is the right first move before optimizing anything about the tree itself — it tells you
  whether the leverage is in the hash function, the depth, or the tree structure (accumulator scheme).
- **A protocol deciding between Poseidon, Poseidon2, and Rescue for a new circuit** — this is the
  "what's the actual ceiling" step that should happen before benchmarking candidates, since it turns
  "which hash is fastest" into "which hash is fastest, multiplied by how much of my circuit it's
  actually responsible for."
- **A thesis chapter on ROI-driven circuit optimization**: the general method here — isolate every
  named gadget, reconcile the sum against the whole, report the residual honestly instead of hiding it
  — generalizes past Poseidon to any circuit optimization decision (which gadget to attack first is an
  empirical question, not an intuition call).

## Open questions (next queue)

1. **On-chain gas per entry point** (item #1) needs a human action this loop cannot take itself:
   GitHub access to `MystenLabs/sui` (via `add_repo`) for a `sui` CLI build, or a network-policy
   exception for at least one Sui RPC host. Until one of those changes, re-attempting this item will
   keep reproducing tonight's result, not new information.
2. **The actual Poseidon2 port** — now precisely scoped (93%/94%/78% ceiling known) but blocked on the
   same GitHub-access root cause as item #1: no verified `.circom` Poseidon2 gadget is reachable from
   this session. Worth flagging to whoever operates this loop: **GitHub being scoped to this one repo
   will keep blocking every research direction that depends on a third-party circom/Rust library**
   (Poseidon2, and items 9/10's PLONK/Halo2/Nova-folding are in the same position — those ecosystems
   are near-universally distributed as GitHub source, not npm packages). This is a structural ceiling
   on how much of the crypto half of this queue is reachable without a scope change.
3. Given `withdraw.circom` is Poseidon-light (78%) relative to the other two (93–94%), is its
   `Num2Bits(64)` usage (3 instances, 192 constraints, ~13% of its total) a better next target than
   Poseidon for that specific circuit — e.g., a single combined range check across `withdrawAmount`,
   `cumulativeOld`, and the derived `remainingBalance` instead of three independent ones? Worth a real
   look, and doesn't hit the GitHub-access wall since it only needs `circomlib`, already vendored.
4. Incidental finding, not investigated further tonight: `frontend/public/circuits/withdraw_vk.json`
   does not exist in git (unlike `transfer_vk.json` and `compliance_vk.json`, which are committed) —
   a fresh clone's frontend has no verifying key to check withdrawal proofs against until
   `compile-withdraw.sh` is run locally. Worth checking whether that's intentional; not touched here
   since committing a freshly-generated dev-ceremony key without a way to confirm it matches the
   deployed testnet contract's actual verifier would be worse than leaving the gap.
5. Mobile WASM proving latency (item #8, unchanged from last night) remains the best "cheap, unblocked"
   candidate for a lighter next run — same browser-latency harness, a device-emulation profile, no
   external dependency at all.
