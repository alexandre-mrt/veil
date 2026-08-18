# 2026-08-18 — Poseidon2 (compression mode) vs Poseidon for Merkle hashing (queue item #2)

## Hypothesis

Swapping the Merkle-membership node hash used 20 times per proof in `transfer.circom` and
`compliance.circom` — circomlib's `Poseidon(2)` (sponge, internal state width 3) — for
`Poseidon2(2)` in **compression mode** (state width 2, Miyaguchi–Preneel feed-forward) reduces
each circuit's total R1CS constraint count by a measurable amount, and that reduction is visible
(if smaller and noisier) in real Groth16 proving time on the same machine. This is the "next
highest-leverage number" flagged by the 2026-07-22 baseline's own open question: the ~13k-constraint
circuits (`transfer`, `compliance`) are dominated by their 20-level Merkle path relative to the
~3k-constraint `withdraw` circuit, which has none.

Before tonight's on-chain-gas attempt (see below) was re-confirmed blocked, this was queue item #2.

## Threat / privacy model

**Adversary considered:** anyone who can construct a Groth16 proof and submit it on-chain —
i.e. a **malicious prover** trying to forge Merkle membership of a commitment or credential that
was never actually inserted into the accumulator, or to pass off a tampered authentication path.
Secondarily, a **chain observer** watching public inputs/events for anything this change might
newly reveal.

**What this experiment changes:** exactly one thing — how the 20-level Merkle-membership check
(`C0` in `transfer.circom`, `C2` in `compliance.circom`) recomputes each tree node from a leaf and
its sibling. The leaf hashes themselves (`Poseidon(4)` commitments, `Poseidon(5)` credential
leaves), nullifier derivation, `txAmountHash`, context binding, and every other constraint are
byte-for-byte identical to the deployed circuits.

**What a malicious prover could try, and why it still fails:**
- *Forge membership of a commitment/credential that was never inserted*, by fabricating a path and
  claiming a root that isn't the on-chain root for that leaf — rejected because `merkleRoot` is a
  **public** input the verifier checks against the on-chain accumulator root; the circuit only
  proves "this leaf, hashed forward through this path, reproduces the stated root", not that any
  root is acceptable. See test `N1` below.
- *Tamper with one sibling or one path-index bit after computing an honest root* — rejected because
  every level's output feeds the next; changing any element anywhere in the path changes the final
  root, which the circuit checks equals the public `merkleRoot`. See tests `N2`/`N3`.
- *Supply a non-binary path index* (e.g. `2` instead of `0`/`1`) to try to exploit `MultiMux1`'s
  linear-interpolation selection — rejected by the same
  `pathIndices[i] * (1 - pathIndices[i]) === 0` constraint the original `merkle_proof.circom`
  already has; `merkle_proof_poseidon2.circom` keeps it unchanged. See test `N4`.

**Soundness argument for the swapped primitive itself.** Poseidon2's permutation follows the same
HADES-style design as the original Poseidon (alternating full and partial rounds, degree-5 S-box
over the BN254 scalar field), with round constants and the internal/external linear layers coming
from `@taceo/circom-lib`/`@taceo/poseidon2` — published npm packages from TACEO (an MPC/ZK
engineering firm), whose README states compatibility with the HorizenLabs Poseidon2 parameter
script and a Rust reference crate, i.e. the same parameter-generation methodology used elsewhere in
the ecosystem to size round counts against known algebraic attacks (Gröbner-basis, interpolation,
statistical/differential) at a 128-bit security target. I did not trust that claim blindly: I
independently verified the concrete circom implementation against the package's own JS reference
with a chain of known-answer tests (see Approach) — including a full 20-level chained application,
which is what actually caught a real bug (below).

The **construction change** is more consequential than the round constants: the original
`merkle_proof.circom` hashes with circomlib's `Poseidon(2)`, which is a **sponge** internally
using state width 3 (rate 2 + a fixed, zero-initialized capacity element). The Poseidon2 variant
uses **compression mode**, state width 2, no separate capacity: `H(L, R) = permute(L, R)[0] + L`.
This is the standard "compression function built from a permutation" pattern (the Miyaguchi–Preneel
construction from block-cipher-based hash function theory — Preneel/Govaerts/Vandewalle's PGV
classification identifies it as one of the schemes provably collision-resistant and one-way in the
ideal-cipher/ideal-permutation model). It is also exactly the construction the Poseidon2 paper
(Grassi, Khovratovich, Schofnegger, 2023) and the `zk-kit` binary-Merkle-root Poseidon2 port (which
`@taceo/circom-lib`'s `binary_merkle_root.circom` is explicitly adapted from — see that file's own
header comment) recommend for fixed-arity 2-to-1 Merkle hashing specifically because the sponge's
spare capacity element is unneeded overhead when the arity is fixed and known in advance. Under the
same "permutation behaves as an ideal/pseudorandom permutation" heuristic the *original* Poseidon
sponge construction's security already assumes for this codebase (nothing new is being assumed),
Miyaguchi–Preneel feed-forward gives collision resistance and one-wayness for the 2-to-1 node hash.

**What is explicitly unchanged, not newly introduced:** neither the original sponge construction
nor the Poseidon2 compression construction domain-separates different **tree layers** from each
other — `@taceo/circom-lib`'s own header comment flags this for `BinaryMerkleRoot` (their upstream
adaptation), and it is equally true of the pre-existing `merkle_proof.circom`. This experiment does
not change that property in either direction; it's listed here for completeness, not as a new
finding. Layer domain separation only matters as a defense if leaf values and internal-node values
could plausibly collide across the specific arities in use, and here they can't: commitments and
credential leaves are computed via `Poseidon(4)`/`Poseidon(5)` (a structurally different template,
different arity, different circuit component) — not via the 2-ary node hash — so a node-hash output
cannot be produced by the leaf-hash circuit or vice versa, before or after this change.

**What this does NOT defend against (residual surface, unchanged by this experiment):** sender
identity is still linked to the wallet that signs the transaction (`PRIV-002`, unmitigated);
deposit-to-commitment timing/amount correlation is still an accepted risk
(`docs/threat-model.md` I4/RR5) — this experiment doesn't touch anonymity-set *size* (that's queue
item #4, unattempted tonight), only the *cost* of proving membership in the existing depth-20 set.
It says nothing about post-quantum exposure (queue item #10). And if this circuit were ever promoted
to production, its own verifying key would need its own trusted setup — tonight's zkeys are the
same **single-dev-contributor** ceremony as every other circuit in this repo
(`docs/threat-model.md` RR2, still open), explicitly not production-safe.

**Chain-observer leakage.** Zero change. The set of public inputs is identical to the deployed
circuits (`merkleRoot`, `oldCommitment`, `newCommitment`, `nullifier`, `txAmountHash`, `threshold`,
`epochId` for transfer; the analogous six for compliance) — this swap is entirely internal to how
`C0`/`C2` are *computed*, not what's exposed. Groth16 proofs stay a fixed 3-group-element,
128-byte-compressed structure regardless of the internal circuit; verification carries no timing
information about how the prover generated the witness. No new side channel is opened.

**Assumptions carried over unchanged:** Groth16 soundness under BN254 discrete log; Poseidon2's
permutation modeled as ideal/pseudorandom (same assumption class the deployed Poseidon already
relies on); single-contributor dev trusted setup (RR2, unproduction-safe, applies to tonight's new
zkeys the same as every existing one).

## Approach

**What I built:**

- `circuits/templates/merkle_proof_poseidon2.circom` — a `MerkleProofPoseidon2(depth)` template,
  structurally identical to the existing `merkle_proof.circom` (same `MultiMux1`-based left/right
  selection, same binary-index constraint, same depth-first path fold) — the *only* change is the
  per-level hash, isolating the one variable this experiment is about.
- `circuits/transfer_poseidon2.circom` and `circuits/compliance_poseidon2.circom` — full copies of
  the deployed circuits with `MerkleProof` swapped for `MerkleProofPoseidon2` at the one call site
  each (`C0`, `C2` respectively). Every other constraint, domain tag, and signal is untouched.
  **These are experimental circuits, not deployed** — see Verdict.
- `circuits/scripts/compile-transfer-poseidon2.sh` / `compile-compliance-poseidon2.sh` — same shape
  as the existing per-circuit compile scripts, own `build-*-poseidon2/` output directories, own
  dev-only Groth16 setup.
- Extended `scripts/bench/witnesses.mjs` and `scripts/bench/prove-latency.mjs` (both from the
  2026-07-22 baseline) with Poseidon2-compression-mode witness builders and the two new circuits, so
  the same reusable benchmark now covers all five circuits.
- `circuits/test/transfer_poseidon2.test.mjs` (6 cases) and `circuits/test/compliance_poseidon2.test.mjs`
  (3 cases) — real-Groth16-proof happy paths plus malicious-witness rejection tests for the changed
  construction specifically (forged membership, tampered sibling, flipped path-index bit, non-binary
  path index). They deliberately do **not** re-test `C1`/`C3`–`C11`, already covered by
  `transfer.test.mjs`/`compliance.test.mjs` and unchanged here.

**Dependency used:** `@taceo/circom-lib@0.6.0` (circom `Poseidon2`/`BinaryMerkleRoot` templates) and
`@taceo/poseidon2@0.2.0` (JS/TS reference permutation, "compatible with the HorizenLabs parameter
script and the Rust `taceo-poseidon2` crate" per its own docs) — both real, versioned npm packages
from TACEO, added as real dependencies (`circuits/package.json`, `scripts/bench/package.json`).

**What I rejected:**

- *Deriving Poseidon2 round constants/matrices from scratch.* Too risky for a security primitive
  without an independently-checkable reference — used the published package instead, and did not
  stop at "it's a known company's package, trust it": independently verified the concrete circom
  template against the JS reference with known-answer tests at increasing Merkle depth (1, 2, 3, 5,
  10, 15, 20), not just a single isolated hash call.
- *Swapping the leaf hashes too* (`Poseidon(4)` commitments, `Poseidon(5)` credential leaves). Out
  of scope for one hypothesis — the 20×-repeated Merkle node hash is what the 2026-07-22 baseline's
  own open question #4 identified as the dominant, highest-leverage cost, and it's the only place
  arity is fixed at 2 regardless of protocol changes elsewhere.
- *Touching `withdraw.circom`.* It has no Merkle proof — nothing to swap.
- *Sponge-mode Poseidon2* (state width 3, matching the original) instead of compression mode. Would
  have kept an unnecessary capacity element for a fixed 2-input hash, throwing away the main
  advantage the paper's own recommended construction gives for this exact use case.
- *Replacing the deployed `transfer.circom`/`compliance.circom` in place.* Doing so would obsolete
  the already-deployed testnet pool's verifying keys and require a fresh, production-grade (not
  single-dev-contributor) trusted setup ceremony plus a contract redeploy — far beyond one night,
  and would leave the live pool needing a migration path that doesn't exist yet. Built parallel
  `*_poseidon2.circom` circuits instead, with their own dev-only setup, so every number below is
  real and reproducible without touching anything live.

**A bug this methodology caught, worth recording as a finding in its own right.** My first pass at
a JS-side reference for the Poseidon2 compression hash (used by the benchmark witness builder and
the test files, to compute `merkleRoot` independently of the circuit) hardcoded the wrong BN254
scalar-field modulus — a plausible-looking but incorrect 77-digit constant, apparently misremembered
rather than sourced. Small-depth known-answer tests (a single hash call, and a 1–2 level chain) all
matched the circuit's real output anyway, because the erroneous reduction only diverges from the
correct one once an intermediate sum actually exceeds the modulus — which doesn't happen at shallow
depth with small test values, but reliably does happen inside a real 20-level Merkle chain. It
surfaced as every `transfer_poseidon2` witness in the benchmark failing circuit constraint `C0`
(`ERROR: Error in template TransferPoseidon2 line: 70`). I bisected it by depth (1, 2, 3, 5, 10,
15, 20 — see the shell history), confirmed the *circuit itself* was self-consistent at every depth
(a standalone single-hash-call circuit reproduced the exact same output as the corresponding step of
the 20-level chain, with and without circom's `--O0`, ruling out a compiler optimization bug), and
only then found the actual discrepancy was in my own modulus constant, not the library or the
circuit — confirmed against `ffjavascript`'s own `bn128.js` (`node_modules/ffjavascript/src/bn128.js`),
the library `snarkjs` itself depends on. Fixed to the verified value
(`21888242871839275222246405745257275088548364400416034343698204186575808495617`), documented
inline in both `witnesses.mjs` and the test files. This is the concrete reason this report's negative
tests exercise realistic-depth paths rather than only a single hash call — a shallow KAT alone would
not have caught it.

## Results

### Constraint counts (fresh `circom`/`snarkjs r1cs info` on this machine, both variants)

| Circuit | R1CS constraints | Non-linear | Linear | Δ constraints | Δ % |
|---|---|---|---|---|---|
| `transfer.circom` (deployed) | 13,611 | 6,470 | 7,141 | — | — |
| `transfer_poseidon2.circom` | **12,951** | 5,930 | 7,021 | **−660** | **−4.85%** |
| `compliance.circom` (deployed) | 12,743 | 6,057 | 6,686 | — | — |
| `compliance_poseidon2.circom` | **12,083** | 5,517 | 6,566 | **−660** | **−5.18%** |

The transfer and compliance deltas are numerically identical (−660 total, −540 non-linear, −120
linear) because both circuits call the same `MerkleProof(20)` template once — the entire saving is
attributable to the one changed component, with zero cross-effects on the rest of either circuit. An
isolated known-answer test of the two hash primitives alone confirms this exactly: a standalone
circomlib `Poseidon(2)` costs 243 non-linear / 274 linear constraints; a standalone `Poseidon2(2)`
compression hash costs 216 non-linear / 268 linear — a per-call delta of −27 non-linear / −6 linear,
times the Merkle depth of 20 = **−540 non-linear / −120 linear**, matching the full-circuit
measurement to the constraint.

Raw command and output:

```
$ circom transfer_poseidon2.circom --r1cs --wasm --sym --output build-transfer-poseidon2 -l node_modules
non-linear constraints: 5930
linear constraints: 7021
public inputs: 7
private inputs: 47
wires: 12972
$ npx snarkjs r1cs info build-transfer-poseidon2/transfer_poseidon2.r1cs
[INFO]  snarkJS: # of Wires: 12972
[INFO]  snarkJS: # of Constraints: 12951

$ circom compliance_poseidon2.circom --r1cs --wasm --sym --output build-compliance-poseidon2 -l node_modules
non-linear constraints: 5517
linear constraints: 6566
public inputs: 6
private inputs: 45
wires: 12102
$ npx snarkjs r1cs info build-compliance-poseidon2/compliance_poseidon2.r1cs
[INFO]  snarkJS: # of Wires: 12102
[INFO]  snarkJS: # of Constraints: 12083

# Isolated hash-primitive KAT (single call each, no Merkle chain):
$ circom poseidon1_t2.circom --r1cs   # component main = Poseidon(2)
non-linear constraints: 243
linear constraints: 274
$ circom compress_t2.circom --r1cs    # Poseidon2(2) compression: out <== r[0] + left
non-linear constraints: 216
linear constraints: 268
```

The deployed-circuit numbers above (13,611 / 6,470 / 7,141 for transfer; 12,743 / 6,057 / 6,686 for
compliance) were reproduced fresh on this machine before comparing, and match the 2026-07-22
baseline and `README.md` exactly — a useful cross-session sanity check that both reports' toolchains
agree.

### Artifact sizes

| Circuit | zkey (bytes) | vk (bytes) | Δ zkey | Δ % |
|---|---|---|---|---|
| `transfer` (deployed) | 6,001,436 | 4,022 | — | — |
| `transfer_poseidon2` | **5,742,717** | 4,019 | **−258,719** | **−4.31%** |
| `compliance` (deployed) | 5,682,160 | 3,840 | — | — |
| `compliance_poseidon2` | **5,423,441** | 3,839 | **−258,719** | **−4.55%** |

(Same dev-only single-contribution Groth16 setup as every other circuit in this repo, `pot15`
Powers of Tau — non-production, see `docs/threat-model.md` RR2. vk size is essentially unchanged, as
expected: it scales with public-input count, which didn't change.)

```
$ stat -c %s build/transfer_final.zkey build/transfer_vk.json
6001436
4022
$ stat -c %s build-transfer-poseidon2/transfer_poseidon2_final.zkey build-transfer-poseidon2/transfer_poseidon2_vk.json
5742717
4019
$ stat -c %s build-compliance/compliance_final.zkey build-compliance/compliance_vk.json
5682160
3840
$ stat -c %s build-compliance-poseidon2/compliance_poseidon2_final.zkey build-compliance-poseidon2/compliance_poseidon2_vk.json
5423441
3839
```

### Proving time — Node.js (`node scripts/bench/prove-latency.mjs --runs 20`)

| Circuit | Mean (ms) | σ (ms) | Δ mean | Δ % |
|---|---|---|---|---|
| `transfer` | 901.95 | 27.53 | — | — |
| `transfer_poseidon2` | **860.10** | 25.91 | **−41.84** | **−4.64%** |
| `compliance` | 877.45 | 23.94 | — | — |
| `compliance_poseidon2` | **828.17** | 20.18 | **−49.27** | **−5.62%** |

Raw output (JSON summary block; full per-circuit console output also printed by the same run):

```
$ node scripts/bench/prove-latency.mjs --runs 20
=== Summary (JSON) ===
[
  { "circuit": "transfer", "runs": 20, "meanMs": 901.9462852, "stddevMs": 27.527176431183197,
    "minMs": 862.428155, "maxMs": 956.161193, "proofBytesJson": 723, "publicSignalsCount": 7 },
  { "circuit": "compliance", "runs": 20, "meanMs": 877.4454360499998, "stddevMs": 23.943258327640475,
    "minMs": 839.418164, "maxMs": 922.691796, "proofBytesJson": 722, "publicSignalsCount": 6 },
  { "circuit": "transfer_poseidon2", "runs": 20, "meanMs": 860.1028317, "stddevMs": 25.913065468405517,
    "minMs": 830.089068, "maxMs": 942.214491, "proofBytesJson": 724, "publicSignalsCount": 7 },
  { "circuit": "compliance_poseidon2", "runs": 20, "meanMs": 828.1716315500001, "stddevMs": 20.184678139307522,
    "minMs": 797.335384, "maxMs": 880.793223, "proofBytesJson": 722, "publicSignalsCount": 6 }
]
```

An earlier, independent 10-run pass on the same machine agreed in direction and rough magnitude
(transfer 901.21ms → transfer_poseidon2 884.75ms, −1.8%; compliance 854.75ms → compliance_poseidon2
830.03ms, −2.9%), though noisier — the 20-run numbers above are the ones this report treats as
primary. Honest read: the ~4.6–5.6% proving-time reduction is real (consistent in direction across
two independent runs, and roughly tracks the ~4.85–5.18% constraint-count reduction) but is close
enough to the per-run standard deviation (roughly 1.5–2σ) that it should be read as "a modest,
probably-real effect," not "proving time scales linearly with constraint count." Groth16 proving
time is dominated by fixed costs (WASM instantiation — excluded via warm-up, per the existing
harness — witness-vector construction, and the multi-scalar multiplication over the full ~13k-row
constraint system) that don't shrink proportionally with a ~5% reduction in one sub-component.

### Circuit-level tests (all real Groth16 proofs, no hash-only fallback used)

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (deployed, unmodified) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (deployed, unmodified) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (deployed, unmodified) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| `transfer_poseidon2.circom` (new) | **6/6 pass** | `node --experimental-vm-modules test/transfer_poseidon2.test.mjs` |
| `compliance_poseidon2.circom` (new) | **3/3 pass** | `node --experimental-vm-modules test/compliance_poseidon2.test.mjs` |

The three deployed-circuit suites (108/108 total) confirm this experiment touched nothing they
exercise — expected, since `transfer_poseidon2.circom`/`compliance_poseidon2.circom` are separate
files, not edits to the deployed ones. The two new suites are the negative-test requirement for this
circuit change:

```
=== Veil Transfer-Poseidon2 (experimental) Circuit Tests ===
--- Happy paths ---
  [PASS] P1: Genesis transfer, real Groth16 proof verifies
  [PASS] P2: Non-trivial Merkle path (leaf not at index 0, mixed left/right siblings)
--- Malicious witnesses (must be rejected) ---
  [PASS] N1: Forged membership — commitment never inserted, path fabricated to match a stale root
  [PASS] N2: Tampered sibling — attacker flips one pathElement after computing the honest root
  [PASS] N3: Flipped path index — attacker swaps left/right at one level
  [PASS] N4: Non-binary path index (malicious prover sets pathIndices[i] = 2)
=== Results: 6 passed, 0 failed ===

=== Veil Compliance-Poseidon2 (experimental) Circuit Tests ===
--- Happy paths ---
  [PASS] P1: Valid KYC credential, real Groth16 proof verifies
--- Malicious witnesses (must be rejected) ---
  [PASS] N1: Forged credential membership — leaf never issued, root borrowed from a different credential
  [PASS] N2: Tampered sibling in the credential path
=== Results: 3 passed, 0 failed ===
```

### Rest of the suite (unmodified code paths, run to confirm nothing else broke)

| Suite | Result | Command |
|---|---|---|
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Compliance utils / fuzz | see note below | `cd scripts && bun run src/test-compliance-utils.ts && bun run src/fuzz-tests.ts` |
| Move contracts | **NOT RUN — BLOCKED** (see below) | `cd contracts && sui move test` |

### On-chain gas (queue item #1) — re-attempted, still BLOCKED, new specific cause

Before starting the Poseidon2 experiment, I spent the first part of the run re-attempting queue item
#1 per its own note ("worth spending an early part of the next run purely on unblocking the toolchain").
Tried, in order, all through the session's outbound proxy:

- `github.com/MystenLabs/sui/releases/...` (prebuilt CLI binary) — **403** (organization egress
  policy denies the host; confirmed via the proxy's own status endpoint, not a transient error).
- `api.github.com/repos/MystenLabs/sui/releases` — reachable, but returns "GitHub access to this
  repository is not enabled for this session" — this session's GitHub MCP access is scoped to
  `alexandre-mrt/veil` only, so even the API route can't reach a different repo's releases.
- `static.crates.io` (a `sui` crate, for `cargo install`) — **403**.
- Direct JSON-RPC to `fullnode.testnet.sui.io` and `fullnode.devnet.sui.io` (`suix_queryTransactionBlocks`
  against the deployed package, no CLI needed) — both **403** (CONNECT tunnel denied).
- Building `sui` from source (as `circom` was, successfully, for this same session) was not
  attempted: the 2026-07-22 report already judged a full Sui workspace build (validator, Move VM,
  RocksDB, etc.) impractical to verify honestly within one night's budget, and tonight's blockers are
  explicit organization policy denials rather than a missing binary — building from source wouldn't
  route around a network policy that also blocks the crate registry needed to fetch its dependencies.

This is a genuinely different blocker shape than either previous night (2026-07-22: no binary
reachable, RPC call denied by tool-approval, not retried per policy) — tonight it's an explicit,
confirmed organization egress/repo-scope policy, not a missing tool or an un-retried denial. Still
**BLOCKED**, not estimated. Left at the top of `EXPERIMENTS.md` with this session's specific finding
noted, in case the network/repo-scope policy changes on a future run.

## Verdict: **KEEP** (experimental — not deployed)

The Poseidon2 compression-mode Merkle hash is a real, measured, reproducible win: −4.85% to −5.18%
total R1CS constraints, −4.3% to −4.6% zkey size, and a −4.6% to −5.6% Node proving-time reduction on
`transfer` and `compliance` — the two circuits that matter most, since they dominate the protocol's
total proving cost. Both new circuits pass their full real-Groth16 test suite including
malicious-witness rejection, and every existing test for the deployed circuits still passes
unchanged. `docs/research/BASELINE.md` is updated with a clearly-labeled **"Poseidon2 candidate
(measured, not yet deployed)"** section — the deployed-circuit rows are left untouched, since the
live testnet pool still runs the original Poseidon-only circuits and their existing verifying keys.

**Why this is KEEP-as-recommendation rather than KEEP-as-deployed:** adopting this for real would
mean a new circuit version, a new (production-grade, multi-party) trusted setup ceremony for
`transfer`/`compliance`, new on-chain verifying keys, and a pool migration — a protocol version bump,
not a parameter tweak, and out of scope for what one night can respectably ship and verify. What
*is* shipped tonight: the experimental circuits, the benchmark and test harness extensions (reusable
for that future migration), and honest, reproducible numbers backing the recommendation.

## Where this could be used

- **Any Circom/Groth16 (or PLONKish, since Poseidon2 is proof-system-agnostic) protocol with a
  fixed-arity 2-to-1 Merkle accumulator** — nullifier sets, commitment trees, credential trees — gets
  the same class of saving essentially for free by switching the node hash from sponge to
  compression mode; this is not specific to Veil's protocol logic at all.
- **Confidential payroll or compliance-gated DeFi on Sui** (the use case named in the 2026-07-22
  report) — a t-of-n auditor board's credential tree is exactly `compliance.circom`'s shape, and a
  ~5% proving-time cut compounds directly into UX if proving happens client-side.
- **A thesis chapter on circuit-level micro-optimizations for ZK compliance protocols** — this report
  is a template for "isolate one primitive, verify it independently before trusting a library,
  measure the delta on both axes (constraints and wall-clock), and don't conflate them" — the finding
  that a ~5% constraint cut produced a smaller, noisier wall-clock effect is itself a useful,
  generalizable data point for anyone predicting proving-time savings from constraint-count savings
  alone.
- **Anyone using a third-party circom crypto library for a security-relevant primitive** — the
  field-modulus bug section above is a concrete argument for why "shallow known-answer test passes"
  is not sufficient assurance; test at the real depth/arity the protocol actually uses.

## Open questions (next queue)

1. **On-chain gas per entry point** — still queue item #1, still BLOCKED, now for a confirmed
   organization-policy reason rather than a missing toolchain. Worth re-attempting if the session's
   network policy or GitHub repo scope ever changes; otherwise this queue item may need to wait for
   direct user-provided gas data (e.g. a `sui client` session run outside this sandbox).
2. **Would the same Poseidon2 compression swap, applied to the leaf hashes too** (`Poseidon(4)`
   commitments, `Poseidon(5)` credential leaves), compound with tonight's saving? Deliberately out of
   scope tonight (one hypothesis at a time) but a natural, cheap follow-up using the same harness.
3. **Batched/aggregated proof verification** (queue item #3) still depends on a real on-chain gas
   number to quantify savings — still blocked transitively on item #1.
4. **Merkle accumulator at scale** (queue item #4) is unaffected in kind by tonight's result — a
   deeper tree still costs proportionally more Merkle-hash constraints, just with a ~5% lower
   per-level cost than before after this swap, if ever adopted.
5. If this circuit is ever promoted from experimental to deployed, it needs its own real trusted
   setup ceremony (`ceremony.sh`), not the dev-only single contribution used to produce tonight's
   numbers — flagged here so it isn't forgotten when that migration happens.
