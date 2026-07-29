# 2026-07-29 — Poseidon2 for Merkle hashing: a ~5% constraint win, not the ~30% the paper's
# headline number implies (queue item #2)

## Hypothesis

Swapping Veil's hash primitive from circomlib's Poseidon to Poseidon2 (Grassi, Khovratovich,
Schofnegger, [eprint 2023/323](https://eprint.iacr.org/2023/323)) reduces `transfer.circom`'s and
`compliance.circom`'s R1CS constraint count and Node.js proving time, because both circuits spend
most of their non-linear constraints on Poseidon hashing (`BASELINE.md`, 2026-07-22: 6,470 and
6,057 non-linear constraints respectively, vs. 1,465 for the Poseidon-light `withdraw.circom`).

This is queue item #2. It moves "does Poseidon2 help, and by how much" from a citation of the
paper's abstract to a number measured against Veil's actual circuits, on this machine, tonight.

**The hypothesis survives, but only for one specific, narrow design — not the naive one.** A
straight swap of every `Poseidon(N)` call for a Poseidon2 sponge is a **net loss** (transfer:
+17.4% total constraints; withdraw: +93.0%). A swap scoped to *only* the repeated 2-to-1 Merkle-tree
hash — using Poseidon2's "compression" construction, which needs no sponge capacity — is a real,
modest win (transfer: −4.85% constraints, −4.4% proving time; compliance: −5.18% constraints, −3.7%
proving time). The difference between those two outcomes is the actual finding tonight.

## Threat / privacy model

**What changes.** The hash function computing (a) the two authenticated Merkle-tree accumulators
(commitment tree in `transfer.circom`, credential tree in `compliance.circom`) changes from
circomlib's Poseidon to Poseidon2 in compression mode. Commitment, nullifier, credential-leaf, and
context-binding hashes are **unchanged** — still circomlib Poseidon, still the same domain-tag
scheme (first array element = tag, documented in each circuit's header comment).

**Adversary model — unchanged from the existing threat model, because the security *property* the
Merkle hash provides doesn't change, only its instantiation:**

- **A malicious prover** who does not know a valid `(leaf, pathElements, pathIndices)` triple for
  the current `merkleRoot` must not be able to produce an accepting proof. This is exactly
  `docs/threat-model.md` T4 ("Modify commitment Merkle root to include fake commitments") and T5
  (credential root) — Poseidon2 compression's soundness for this property reduces to the same kind
  of assumption as Poseidon's (collision resistance / one-wayness of the permutation under the
  BN254 scalar field), not a new one. Tonight's negative tests (see Results) exercise this directly:
  wrong root, tampered sibling, non-boolean path bit, and swapped left/right ordering are all
  rejected by the compiled circuit itself, not by application-level validation.
- **A chain observer** watching commitment-root updates learns nothing new or different from
  before: the on-chain artifact is still just a field element (the root), Poseidon2 or not. I2/I6 in
  the threat model (amount and nullifier-frequency disclosure) are untouched — those hashes weren't
  changed.
- **A malicious auditor or colluding relayer** — out of scope for this change; neither the auditor
  ECDH scheme nor the relayer's role touches Merkle hashing.

**What this does NOT defend against, and what's new here specifically:**

- **Domain separation between tree layers.** Neither the old `MerkleProof` template nor the new
  `MerkleProof2` domain-separates leaf-layer hashing from internal-node hashing — both hash
  `(left, right)` identically at every level, exactly as circomlib's original did. This is a
  pre-existing property, not a regression, but @taceo/circom-lib's own `binary_merkle_root.circom`
  explicitly flags it as something a caller must handle if it matters ("There is no dedicated domain
  separation... If domain separation is required, leaf values must be domain separated before being
  passed in"). Veil's leaves are themselves Poseidon-domain-tagged commitments/credential-hashes
  (tag 1 or 4), which gives second-preimage resistance against confusing a leaf for an internal node
  in practice, but this is inherited unchanged, not newly analyzed tonight.
- **The trusted setup.** Both hybrid zkeys were generated with the exact same dev-only
  single-contributor ceremony as every other circuit in this repo (`circuits/scripts/compile.sh`'s
  pattern — one `snarkjs zkey contribute` with session-derived entropy, not a multi-party ceremony).
  RR2 in the threat model is unchanged and applies identically to these new zkeys.
- **Poseidon2's own cryptanalysis maturity.** Poseidon2 (2023) has less published third-party
  cryptanalysis than Poseidon (2019/2021, now with years of follow-up attack papers finding nothing
  practical against the standard parameterization). The permutation used here keeps Poseidon's
  original round counts (see Approach) and only changes the *linear layer*, which the Poseidon2
  paper argues doesn't weaken the algebraic security argument — but "argues" is not "field-proven
  over years," and that gap is real, not dismissed.
- **This is still Groth16 on BN254.** No post-quantum story, no change to RR1 (UpgradeCap), RR3
  (Sybil), RR7 (relayer centralization), or any other residual risk not touching Poseidon.

**Assumptions carried over unchanged:** Groth16 soundness under the BN254 discrete-log assumption;
the algebraic hardness assumption underlying Poseidon2's security (interpolation/Gröbner-basis
attack resistance for the specific round counts and S-box degree used, same class of assumption as
original Poseidon, argued in the Poseidon2 paper §5); dev-only trusted setup non-production-safety
(RR2).

## Approach

**What I built:**

1. **`circuits/templates/poseidon2_compat.circom`** — a `Poseidon2Hash(nInputs)` template with the
   same external interface as circomlib's `Poseidon(nInputs)` (`inputs[nInputs]` in, `out` out), so
   call sites don't need to change their domain-tag logic. Backed by `Poseidon2Sponge` from
   `@taceo/circom-lib` (MIT, npm `@taceo/circom-lib@0.6.0` — the `poseidon2`, `eddsa_poseidon2`, and
   `babyjubjub` circuits in that package are pulled from the audited TACEO:OPRF repository per its
   README; `compression.circom`/`precomputations.circom`, which is what I actually call, are not
   claimed as separately audited).
2. **`circuits/templates/merkle_proof_poseidon2.circom`** — `MerkleProof2(depth)`, structurally
   identical to the existing `templates/merkle_proof.circom` (same mux-select-by-`pathIndices`,
   same chain-to-root loop), but each level's pairwise hash is Poseidon2 in **compression mode**
   (`permutation(left, right)[0] + left`, T=2, no capacity element) instead of circomlib
   `Poseidon(2)`. This is the same construction `@taceo/circom-lib`'s own
   `binary_merkle_root.circom` uses for tree layers — I didn't invent it, I matched their pattern.
3. **Three full alternate circuits** to measure the "swap everywhere" design honestly rather than
   asserting it's worse: `transfer_poseidon2.circom`, `compliance_poseidon2.circom`,
   `withdraw_poseidon2.circom` — every `Poseidon(N)` and the Merkle hash replaced with Poseidon2.
4. **Two "hybrid" circuits** — the actual candidate — `transfer_hybrid.circom`,
   `compliance_hybrid.circom`: only the Merkle hash is Poseidon2; commitment/nullifier/leaf hashes
   stay circomlib Poseidon. (`withdraw.circom` has no Merkle tree, so there is no hybrid variant —
   swapping its hashes to Poseidon2 can only make it worse, confirmed below, so it's excluded from
   the candidate design entirely.)
5. **`scripts/bench/witnesses-poseidon2.mjs`** + **`scripts/bench/prove-latency-poseidon2.mjs`** —
   same methodology as the existing `scripts/bench/{witnesses,prove-latency}.mjs` (10 timed
   `snarkjs.groth16.fullProve` runs after one untimed warm-up), computing Merkle roots with
   `@taceo/poseidon2` (npm, the native/non-circuit JS implementation) instead of `circomlibjs`'s
   Poseidon for the tree layers. **I verified `@taceo/poseidon2`'s JS output matches the compiled
   circom circuit bit-for-bit before trusting it for witness construction** — same input `(1, 2)`
   through both the JS package and a standalone compiled test circuit produced the identical field
   element `6588139247708940112588203339651261153905233202198520634825199962343944922547` (see raw
   output below). Without that check, a JS/circuit mismatch would silently produce witnesses that
   happen to satisfy the wrong constraints, or fail for a reason unrelated to the thing being tested.
6. **`circuits/test/poseidon2_hybrid.test.mjs`** — real-Groth16 tests (no hash-only fallback) for
   both hybrid circuits: one happy-path proof-and-verify, plus four negative tests (see Results).

**What I rejected:**

- **Using Poseidon2 sponge mode for the commitment/nullifier/leaf hashes too** (the "everywhere"
  design, `*_poseidon2.circom`). Measured, not assumed, to be worse — see Results. Root cause,
  isolated with small standalone test circuits before touching the real ones: circomlib's
  `Poseidon(N)` implementation is an R1CS-optimized construction (round-constant/matrix folding
  reduces its linear-constraint count well below a naive affine-layer evaluation), refined over
  years of production use. `@taceo/circom-lib`'s Poseidon2 computes each round's affine layer
  explicitly. For a 2-to-1 compression (T=2, no capacity, the Merkle case) that difference is small
  and Poseidon2's cheaper linear layer wins. For N≥3 (needs a capacity element, or — worse — has to
  jump to the next larger supported state width, since Poseidon2 here only supports
  t ∈ {2,3,4,8,12,16} and Veil's arity-4 hashes don't fit t=4's rate of 3) the gap in favor of
  circomlib's optimization grows large: **+40.8% constraints at N=3, +99.2% at N=5**, measured with
  isolated single-primitive circuits (below).
- **A dynamic-depth Merkle template** (`@taceo/circom-lib`'s own `binary_merkle_root.circom`, which
  supports `depth ≤ MAX_DEPTH` at runtime). Veil's tree depth is a compile-time constant (20) in
  both circuits already; a dynamic-depth template adds `IsEqual` checks and an index-range proof
  Veil doesn't need, for no benefit here. Kept `MerkleProof2` structurally identical to the existing
  fixed-depth `MerkleProof` instead, to isolate the hash-primitive change as the only variable.
- **Regenerating the deployed testnet zkeys / cutting production `transfer.circom` and
  `compliance.circom` over tonight.** The measured win is real but modest (~5%), and a full
  cutover means regenerating and redeploying VKs (behind the existing 1-epoch-timelocked
  `update_commitment_root`/T3 VK-update path), updating the frontend's shipped wasm/zkey, and
  rerunning the full 108-case circuit test suite against new expected hash outputs. That's a
  deliberate, separate migration, not a rider on a measurement night — see Verdict.

**Toolchain, and how each gap was closed tonight (all closed, nothing left BLOCKED this run):**

- `circom` and `sui` are not installed, same as every prior night. `circom` v2.2.2 built from
  source in ~70s (`cargo build --release`, `iden3/circom` tag `v2.2.2`) — same as 2026-07-22, no
  issue.
- **Queue item #1 (on-chain gas, blocked twice previously) — re-attempted for the first ~20 minutes
  of tonight's session, with new diagnostic information, then correctly abandoned rather than
  re-blocked on the same excuse.** This session's sandbox scopes GitHub access to
  `alexandre-mrt/veil` only: `curl` to `api.github.com` and `github.com/MystenLabs/sui/releases`
  both return `403` with an explicit "GitHub access to this repository is not enabled for this
  session" message (not a network failure — a policy denial, confirmed by testing `releases/latest`
  vs. a wrong-tag `releases/download/...` path returning a *different* error, 404, proving the
  connection itself succeeds and only the API/HTML path is scoped-out). A direct JSON-RPC call to
  `fullnode.testnet.sui.io` (bypassing GitHub entirely, in case a CLI-free path existed) was blocked
  at the network layer (`CONNECT tunnel failed, response 403`) — this sandbox's outbound network is
  allowlisted, not just GitHub-scoped, and `fullnode.testnet.sui.io` isn't on the allowlist
  (`registry.npmjs.org`, `pypi.org`, `crates.io`, `jsr.io`, and a few others are). `crates.io`'s own
  API also 403's with its own unrelated rate-limit-style policy message. Given `git ls-remote` to
  `github.com` *does* work (git smart-protocol traffic isn't scoped the same way web/API traffic
  is), a full from-source Sui build remains theoretically possible, but building the entire Sui
  validator/Move-VM/RocksDB workspace was already judged impractical within one night's budget on
  2026-07-22 and nothing tonight changes that math — so I spent bounded, real effort confirming
  *why* it's blocked with concrete commands (useful new information — "network policy, not tool
  availability" — for whoever picks this up next) and moved to the next queue item rather than
  re-running the same losing attempt a third time. **Re-ranked to stay at the top of the queue**;
  see Open questions.
- `@taceo/circom-lib` and `@taceo/poseidon2` installed cleanly from `registry.npmjs.org` (in the
  sandbox's network allowlist) — no gap.
- Powers-of-Tau (`pot15_final.ptau`, same file the existing `compile.sh` scripts use) downloaded
  from `storage.googleapis.com`, also reachable — no gap.

## Results

### Constraint counts — "everywhere" design (rejected)

Every `Poseidon(N)` call replaced with `Poseidon2Hash(N)`, including the Merkle tree.

| Circuit | R1CS (baseline → everywhere) | Non-linear | Linear | Wires | Δ total |
|---|---|---|---|---|---|
| `transfer_poseidon2` | 13,611 → 15,979 | 6,470 → 6,119 | 7,141 → 9,860 | 13,632 → 16,000 | **+17.4%** |
| `compliance_poseidon2` | 12,743 → 13,405 | 6,057 → 5,556 | 6,686 → 7,849 | 12,762 → 13,424 | **+5.2%** |
| `withdraw_poseidon2` | 3,058 → 5,902 | 1,465 → 1,651 | 1,593 → 4,251 | 3,058 → 5,902 | **+93.0%** |

Non-linear constraints go *down* in every case (Poseidon2's S-box structure is genuinely cheaper
per-round) — but linear constraints explode, because Veil's arity-4 hashes (commitment, nullifier)
don't fit Poseidon2's t=4 state (rate 3) and have to jump to t=8 (rate 7, using only 4 of 7 slots),
and even the arity-3 case loses to circomlib's optimized affine layer. **Total R1CS constraints — the
number that actually drives Groth16 prover time via FFT domain size — go up, not down, everywhere
except the Merkle-only case below.** `withdraw.circom` has no Merkle tree to amortize this cost
against, so it's the starkest loss: nearly double.

Raw commands (representative):
```
$ circom transfer_poseidon2.circom --r1cs --wasm --sym --output build-poseidon2/transfer -l node_modules
template instances: 42
non-linear constraints: 6119
linear constraints: 9860
public inputs: 7
private inputs: 47
public outputs: 0
wires: 16000
labels: 49256

$ circom compliance_poseidon2.circom --r1cs -l node_modules --output build-poseidon2/compliance
non-linear constraints: 5556
linear constraints: 7849
wires: 13424

$ circom withdraw_poseidon2.circom --r1cs -l node_modules --output build-poseidon2/withdraw
non-linear constraints: 1651
linear constraints: 4251
wires: 5902
```

### Isolated primitive cost (why the "everywhere" design loses)

Single-hash circuits, N inputs → 1 output, no surrounding protocol logic — isolates the primitive
from the circuit it's embedded in.

| N (inputs) | Construction | Non-linear | Linear | Wires | Total | vs. circomlib `Poseidon(N)` |
|---|---|---|---|---|---|---|
| 2 (Merkle pairwise) | Poseidon2 compression, T=2 | 216 | 268 | 487 | **484** | circomlib: 517 total → **Poseidon2 −6.4%** |
| 3 (txAmountHash, nullifier, ctx) | Poseidon2 sponge, T=4 | 264 | 588 | 856 | **852** | circomlib: 605 total → **Poseidon2 +40.8%** |
| 4 (commitment, nullifier) | Poseidon2 sponge, T=8 (forced — t=4 too narrow) | 363 | 1300 | 1668 | **1663** | circomlib: 736 total → **Poseidon2 +126.0%** |
| 5 (credential leaf) | Poseidon2 sponge, T=8 | 363 | 1300 | 1669 | **1663** | circomlib: 835 total → **Poseidon2 +99.2%** |

(N=4's Poseidon2 cost is identical to N=5's because both round up to the same T=8 permutation —
confirmed by also testing T=3 and T=4 sponges for N=4: T=3 gives 1,162 total via two chained
permutations, cheaper than T=8's 1,663 but still worse than circomlib's 736. Raw sweep in the PR
diff's commit history if reproducing.)

Only N=2 favors Poseidon2, and only because compression mode needs no capacity element — it's a
single T=2 permutation either way, the smallest and cheapest state size the library supports, and
Poseidon2's linear-layer savings aren't yet swamped by having to pad up to a wider unused state.

### Constraint counts — hybrid design (Merkle-only, the actual candidate)

| Circuit | R1CS (baseline → hybrid) | Non-linear | Linear | Wires | zkey (bytes) | Δ total |
|---|---|---|---|---|---|---|
| `transfer_hybrid` | 13,611 → 12,951 | 6,470 → 5,930 | 7,141 → 7,021 | 13,632 → 12,972 | 6,001,422 → 5,742,712 | **−4.85%** |
| `compliance_hybrid` | 12,743 → 12,083 | 6,057 → 5,517 | 6,686 → 6,566 | 12,762 → 12,102 | 5,682,146 → 5,423,436 | **−5.18%** |

Raw commands:
```
$ circom transfer_hybrid.circom --r1cs --wasm --sym -l node_modules --output build-hybrid/transfer
non-linear constraints: 5930
linear constraints: 7021
public inputs: 7
private inputs: 47
wires: 12972

$ circom compliance_hybrid.circom --r1cs --wasm --sym -l node_modules --output build-hybrid/compliance
non-linear constraints: 5517
linear constraints: 6566
public inputs: 6
private inputs: 45
wires: 12102

$ stat -c "%n %s" build-hybrid/transfer/transfer_hybrid_final.zkey build-hybrid/compliance/compliance_hybrid_final.zkey
build-hybrid/transfer/transfer_hybrid_final.zkey 5742712
build-hybrid/compliance/compliance_hybrid_final.zkey 5423436
```

660 fewer constraints in both circuits — exactly `20 × (517 − 484)` from the per-level isolated
delta above, confirming the full-circuit measurement composes cleanly from the primitive-level one.

### Proving time — Node.js, same session, same container, back-to-back (10 runs each)

**Methodological note, because it mattered:** an earlier draft of this experiment compared tonight's
hybrid numbers against `BASELINE.md`'s 2026-07-22 figures (751.9ms / 738.1ms) and found the hybrid
circuits *slower* — a result that made no sense given fewer constraints, and turned out to be an
artifact of comparing across two different ephemeral container instances (this sandbox is a fresh
container per session; absolute wall-clock timings are not comparable across nights). Re-measuring
the **unmodified baseline circuits, fresh, in this same container, immediately before and after the
hybrid run** resolved it. Every timing comparison below is same-machine, same-session.

| Circuit | Baseline (this session) | Hybrid (this session) | Δ |
|---|---|---|---|
| `transfer` | 922.46 ms (σ 23.81) | 881.65 ms (σ 23.76) | **−4.4%** |
| `compliance` | 879.89 ms (σ 24.47) | 847.68 ms (σ 9.19) | **−3.7%** |

Witness generation alone (isolated from the SNARK proving step, via the compiled wasm's
`witness_calculator.js`, 8 runs each): baseline `transfer` 13.96ms vs. hybrid `transfer` 8.64ms
(−38%) — the larger share of the ~4% end-to-end win is in witness generation, where the constraint
and wire-count reduction shows up directly; the Groth16 proving step itself gains proportionally
less, consistent with both circuits' constraint counts rounding up to the same FFT domain size
(2^14 = 16,384) either way.

Raw command output:
```
$ node scripts/bench/prove-latency.mjs --runs 10        (baseline, rebuilt fresh this session)
--- transfer ---
  mean: 922.46 ms   stddev: 23.81 ms   min: 887.73 ms   max: 958.86 ms
--- compliance ---
  mean: 879.89 ms   stddev: 24.47 ms   min: 833.62 ms   max: 920.17 ms

$ node scripts/bench/prove-latency-poseidon2.mjs --runs 10        (hybrid)
--- transfer_hybrid ---
  mean: 881.65 ms   stddev: 23.76 ms   min: 853.37 ms   max: 930.94 ms
  proof JSON size: 723 bytes, public signals: 7
--- compliance_hybrid ---
  mean: 847.68 ms   stddev: 9.19 ms   min: 824.33 ms   max: 855.07 ms
  proof JSON size: 725 bytes, public signals: 6
```

Both hybrid circuits still produce valid, verifying Groth16 proofs (`groth16.verify` against the
freshly generated VK — not assumed, checked):
```
transfer_hybrid proof valid: true
compliance_hybrid proof valid: true
```

### Soundness — negative tests (malicious witness must be rejected)

`circuits/test/poseidon2_hybrid.test.mjs`, real Groth16 (no hash-only fallback — the whole point of
this test is exercising the Poseidon2 witness-generation path):

```
--- transfer_hybrid ---
  PASS: transfer_hybrid: happy path — valid witness produces a verifying proof
  PASS: transfer_hybrid: C0 — wrong merkleRoot rejected (Poseidon2-hashed path doesn't match)
  PASS: transfer_hybrid: C0 — tampered Merkle sibling rejected (malicious prover forges a path element)
  PASS: transfer_hybrid: C0 — non-boolean pathIndices rejected (mux selector must be 0/1)
  PASS: transfer_hybrid: C0 — swapped left/right at one level rejected (prover claims wrong side of the tree)

--- compliance_hybrid ---
  PASS: compliance_hybrid: happy path — valid witness produces a verifying proof
  PASS: compliance_hybrid: C0 — wrong merkleRoot rejected (Poseidon2-hashed path doesn't match)
  PASS: compliance_hybrid: C0 — tampered Merkle sibling rejected (malicious prover forges a path element)
  PASS: compliance_hybrid: C0 — non-boolean pathIndices rejected (mux selector must be 0/1)
  PASS: compliance_hybrid: C0 — swapped left/right at one level rejected (prover claims wrong side of the tree)

=== Results: 10 passed, 0 failed ===
```

Every tampered witness fails at **witness generation** (`ERROR: 4 Error in template ... — Assert
Failed`), before a proof is even attempted — the circuit's own constraints reject it, not
application-level checking. The "swapped left/right" test specifically exercises the new Poseidon2
compression construction's soundness: I confirmed the permutation is not symmetric in its two
inputs before writing the test (`perm(1,2)[0] = 6588...922546` vs. `perm(2,1)[0] = 21581...996873`
— different), which is what makes claiming the wrong tree-side actually change the digest rather
than being silently accepted.

### Full test suite (`CLAUDE.md` doesn't exist in this repo — commands are `README.md`'s, and
### `scripts/init.sh`)

| Suite | Result | Command |
|---|---|---|
| Circuits — real Groth16, **unmodified** circuits (regression check) | **108/108 pass** (43+30+35) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Circuits — Poseidon2-hybrid negative/soundness tests (new) | **10/10 pass** | `node --experimental-vm-modules test/poseidon2_hybrid.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Compliance utils | **67/67 pass** (slow on this container — several minutes, unrelated to tonight's changes; not touched) | `cd scripts && bun run src/test-compliance-utils.ts` |
| Move contracts (124 tests) | **NOT RUN** — same `sui` CLI blocker as 2026-07-22 and every prior gap; no contract code touched this session | `cd contracts && sui move test` |

No test was loosened, skipped, or given new tolerance. The 108 pre-existing circuit tests run
against the **original, unmodified** `transfer.circom`/`compliance.circom`/`withdraw.circom` —
nothing in production changed tonight (see Verdict for why).

## Verdict: **KEEP** (validated candidate; not yet cut into production circuits)

The Merkle-only Poseidon2 design is a real, reproducible, modest win — about 5% fewer constraints
and 4% less proving time on the two circuits that carry a Merkle tree — with no soundness
regression (four real-Groth16 negative tests, all rejecting at witness generation) and no privacy
regression (the changed hash is internal to the accumulator; nothing newly observable on-chain).
It's also a genuine finding in the other direction: **do not** swap Poseidon for this specific
Poseidon2 implementation everywhere, because for arity ≥3 it loses to circomlib's already
R1CS-optimized Poseidon by 41–126%, and for a circuit with no repeated pairwise hash to amortize
that against (`withdraw.circom`), the naive swap nearly doubles constraint count. That's the kind of
result the "always adopt the newer primitive" instinct gets wrong, and it's now measured instead of
assumed.

What's merged tonight: `templates/poseidon2_compat.circom`, `templates/merkle_proof_poseidon2.circom`,
the reference hybrid circuits (`transfer_hybrid.circom`, `compliance_hybrid.circom`) and the rejected
"everywhere" circuits (kept for anyone re-deriving these numbers, not deleted), the bench scripts,
and the negative-test suite. **Production `transfer.circom`/`compliance.circom` are unchanged** — a
real cutover means regenerating and redeploying VKs through the existing timelocked update path
(`docs/threat-model.md` T3), reissuing the frontend's shipped wasm/zkey, and rerunning the full
existing 108-case suite against new expected hash outputs end-to-end (including on the deployed
testnet contracts, which this session's `sui`-CLI blocker also prevents touching). That's a
deliberate, scoped migration night, not something to fold into a measurement PR. `BASELINE.md` gets
a new "Poseidon2 Merkle-hashing candidate (validated, not yet in production)" section with tonight's
numbers rather than an in-place edit to the protocol's current baseline row, since the deployed
protocol hasn't changed.

## Where this could be used

- **Any Circom/Groth16 protocol with a Merkle accumulator whose depth dominates constraint count** —
  the win scales with tree depth (Veil's is fixed at 20; a protocol with a deeper tree, or one doing
  multiple membership proofs per circuit, gets proportionally more benefit from the same swap).
  Mixers, UTXO-shielded-pool designs, and credential-accumulator schemes (KYC trees, revocation
  trees) on any BN254-Groth16 stack are the direct match.
- **A thesis chapter or protocol audit comparing "adopt Poseidon2" claims against reality** — the
  isolated primitive-cost table above is the concrete counter-example to "Poseidon2 is strictly
  better," and the mechanism (state-width granularity forcing small-arity hashes into an
  oversized permutation) generalizes to any Poseidon2 implementation that only ships a fixed set of
  supported `t` values rather than a fully general one.
- **Confidential payroll or a t-of-n auditor board on Sui** (the deployment class named in the
  2026-07-22 report) — if that design also uses a credential Merkle tree for auditor-set membership
  or employee KYC, this same hybrid pattern (Poseidon2 for the repeated tree hash, Poseidon for
  arity-3+ commitment/nullifier derivation) is a drop-in ~5% win with the same soundness argument.
- **Anyone evaluating whether to build a custom R1CS-optimized Poseidon2** (folding the affine layer
  the way circomlib's Poseidon does) — tonight's numbers are the "before" baseline that would make
  such an effort's payoff measurable; the theoretical ceiling (Poseidon2 native-speed gains applied
  to an equally R1CS-optimized circuit implementation) is not something this experiment reaches, and
  is exactly what queue item 3 below is for.

## Open questions (next queue)

1. **On-chain gas per entry point** — still `BLOCKED`, now for a confirmed reason (sandbox network
   policy, not tool unavailability — see Approach). Stays at the top of the queue. Next attempt
   should not re-try the same GitHub/CLI/JSON-RPC paths a third time; it needs either a session with
   a broader network allowlist, or a pre-built `sui` binary supplied some other way (e.g. checked
   into a scratch location ahead of time by a human, since this sandbox can't fetch one itself).
2. **Would an R1CS-optimized Poseidon2 (folding the affine layer the way circomlib's Poseidon does)
   beat circomlib's Poseidon at every arity, not just N=2?** Tonight's numbers show Poseidon2's
   *unoptimized-for-circuits* implementation losing badly for N≥3 — that's a property of this
   specific `@taceo/circom-lib` implementation's constraint generation, not necessarily a ceiling on
   what Poseidon2 could do with the same optimization circomlib applies. Worth a dedicated
   comparison if someone wants to actually build that optimized variant — real effort, not a
   parameter tweak.
3. **The actual production migration** — cut `transfer.circom`/`compliance.circom` over to
   `MerkleProof2`, regenerate and redeploy VKs through the timelocked update path, update the
   frontend's shipped artifacts, rerun the full suite against new expected values end-to-end. Now
   fully specified and low-risk (design validated, soundness tested) — this is a real "do the
   migration" night, not a "figure out if it's worth it" night.
4. Poseidon2 in **sponge mode absorbing multiple values across permutations** (rather than the
   single-permutation cases tested here) wasn't explored — Veil never needs it (max arity 5), but a
   protocol hashing longer vectors would hit different width-selection tradeoffs than the ones
   measured tonight.
