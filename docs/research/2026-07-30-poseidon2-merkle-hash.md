# Poseidon2 for the depth-20 Merkle-path hash

Queue item #2. Ranked above everything else not already settled in `LEDGER.md`, since queue
item #1 (on-chain gas) stayed blocked tonight for a third, different reason: the sandbox's
egress proxy returned a hard `403` (organization policy, not retryable) for both
`fullnode.testnet.sui.io` and `api.github.com`'s release-listing endpoint — see "What was
blocked" below.

## Hypothesis

Replacing circomlib's `Poseidon(2)` (t=3 sponge) with a Poseidon2 permutation of the same
width, in `templates/merkle_proof.circom`'s 20-level Merkle-path hasher — the single largest
Poseidon-call site in both `transfer.circom` and `compliance.circom` (20 invocations per
proof, vs. 3–4 non-Merkle Poseidon calls) — reduces R1CS constraint count and Node.js
proving time for both circuits, without changing any public interface.

**Falsified.** The vendored Poseidon2 implementation *increases* R1CS constraints by
9.3–9.9% for both circuits. Real proving time moved by only ~1.2–1.5%, and that delta is
within the noise band of the measurement — see "Why proving time barely moved" below.

## Threat / privacy model

**Adversary this defends against (unchanged from the existing design):** a malicious prover
who does not actually hold a commitment/credential in the tree, attempting to forge a
Merkle-membership proof. The relevant guarantee is exactly what `MerkleProof`/`MerkleProofV2`
already provide: given a claimed root, only a party who knows a full authentication path to
an actual leaf can produce a satisfying witness, because the path hash is (assumed)
collision-resistant — a forged root requires either a hash collision or breaking Groth16
soundness (BN254 discrete log). Poseidon2 does not change this threat model; it only changes
which permutation instantiates the 2-to-1 compression function inside that argument.

**What this does NOT defend against (residual surface, unchanged):**
- A chain observer or colluding relayer still learns *that* a valid membership proof was
  produced and *when* (I2/I4 in `docs/threat-model.md` — amounts and identity leakage
  unrelated to this change).
- A malicious auditor's decryption capability (I5) is untouched — this circuit never touches
  the ECDH/AES-GCM auditor path.
- A quantum adversary breaks BN254 discrete log regardless of which Poseidon variant is used
  underneath — Groth16-on-BN254 has no PQ story either way (queue item #10, still open,
  still unmeasured).
- Sybil (RR3/E6) and deposit-commitment linkability (RR5/I4) are structural properties of the
  protocol's identity model, not the hash function; unaffected.

**Assumptions this experiment adds or relies on:**
1. **Trusted setup**: unchanged mechanism (Groth16, dev-only single contribution, same RR2
   caveat). A production adoption of this swap would need its own MPC ceremony contribution
   for the new circuit hash (`transfer_v2`/`compliance_v2` have different circuit hashes than
   `transfer`/`compliance` — confirmed below), exactly like any other VK update.
2. **Hardness**: Poseidon2's security rests on the same family of assumptions as Poseidon
   (resistance to Gröbner-basis, interpolation, and statistical attacks on the round
   function) — see eprint 2023/323 §5. We did not run independent cryptanalysis; we relied
   on the published, peer-reviewed parameter derivation (the same HorizenLabs Sage-script
   lineage used by Polygon, Aztec, and Scroll's own BN254 Poseidon2 instances).
3. **Key custody**: unaffected — no keys are involved in this change.
4. **STRIDE mapping**: this touches S2 (proof forgery — the compression function's collision
   resistance is part of what makes membership non-forgeable) and, if ever deployed, T3/T4
   (VK/root-update timelock — a hash swap can only ship as a timelocked VK update, exactly
   like any other circuit change).

## Approach

**What we built:**
1. Vendored `@taceo/circom-lib`'s `poseidon2.circom` / `poseidon2_constants.circom` (MIT,
   npm, state widths t=2,3,4,8,12,16) into `circuits/lib/poseidon2/`, and wrote
   `Poseidon2Hash2` (`circuits/lib/poseidon2/poseidon2_hash2.circom`) — a 2-to-1 hash wrapper
   using **exactly** circomlib's own sponge convention (capacity=0, rate=2, squeeze
   `state[0]`, see `Poseidon(nInputs)`/`PoseidonEx` in `node_modules/circomlib`), so the only
   thing that changes between the old and new Merkle hasher is the permutation itself, not
   the hash construction around it.
2. **Independently verified the vendored permutation before it touched any circuit** (see
   "Correctness verification" below) — round constants and internal-matrix constants diffed
   byte-for-byte against the canonical HorizenLabs reference source, plus 8 end-to-end test
   vectors (including BN254 field-boundary edge cases) cross-checked against the independent
   `@taceo/poseidon2` TypeScript reference.
3. Built `templates/merkle_proof_v2.circom` (`MerkleProofV2`) — byte-identical to
   `templates/merkle_proof.circom` except the per-level hasher is `Poseidon2Hash2` instead of
   circomlib's `Poseidon(2)`.
4. Built `transfer_v2.circom` / `compliance_v2.circom` — copies of `transfer.circom` /
   `compliance.circom` with only the `include` and the Merkle-proof component swapped. Every
   other constraint, domain tag, and public/private signal is unchanged.
5. Wrote `scripts/bench/witnesses-v2.mjs` + `scripts/bench/prove-latency-v2.mjs` (mirrors the
   existing `witnesses.mjs`/`prove-latency.mjs`), and `circuits/test/poseidon2-merkle.test.mjs`
   (8 tests: 2 positive controls, 6 negative — see "Negative tests" below).

**Why the Merkle path and not the commitment/nullifier hashes** (the other candidate from
queue item #2's framing, "four Poseidon instances dominate..."): `@taceo/poseidon2` (and the
HorizenLabs reference it's built from) only publish parameters for t ∈ {2,3,4,8,12,16}.
Veil's commitment/nullifier hashes are `Poseidon(4)` (5 inputs after the domain tag → t=5),
which has **no published Poseidon2 parameter set** at all — swapping those would mean
generating our own round constants via the Sage script rather than reusing an
independently-published, already-scrutinized parameter set. That's a meaningfully bigger
soundness commitment for one research night, so this experiment scoped to the one hash
that's both (a) the dominant constraint contributor (20 calls vs. 3–4) and (b) has a
standard, publishable, already-cross-implemented parameter set (t=3). `withdraw.circom` was
out of scope entirely — it has no `MerkleProof` component (confirmed by reading the file).

**Rejected alternative**: hand-deriving Poseidon2 parameters for t=5 to also cover the
commitment/nullifier hashes. Rejected for tonight — no independently-published reference to
verify against means any bug in the derivation would be a real soundness hole, not a
performance regression, and that risk isn't worth taking to chase a constraint-count number
that (as this experiment shows) doesn't even move in the right direction for the
already-published t=3 case.

## Correctness verification (before this touched any circuit)

1. **Round-constant diff against the canonical source.** Fetched
   `HorizenLabs/poseidon2`'s `poseidon2_instance_bn256.rs` (the reference implementation the
   Poseidon2 paper and its Sage parameter generator are built around) and diffed all 64
   rounds' constants plus the internal-matrix diagonal against
   `circuits/lib/poseidon2/poseidon2_constants.circom`'s `t=3` branch, programmatically
   (Python, exact big-integer equality, not string comparison). **All 64 rounds matched
   exactly.** The `InternalMatMul3` template's hardcoded arithmetic
   (`out0=in0+sum, out1=in1+sum, out2=2·in2+sum` where `sum=in0+in1+in2`) was hand-verified
   to algebraically equal `MAT_INTERNAL3 = [[2,1,1],[1,2,1],[1,1,3]]` from the same reference.
2. **End-to-end witness vs. an independent implementation.** Compiled a standalone
   `Poseidon2Hash2` test circuit, computed its witness via `snarkjs wtns calculate` for 8
   inputs (`(0,0)`, `(1,2)`, `(p-1,p-1)`, `(0,p-1)`, and 4 random pairs), and compared every
   output against `@taceo/poseidon2`'s TypeScript `bn254.t3.permutation` (documented as
   parity-tested against the Rust `taceo-poseidon2` crate) — a different codebase and
   language than the circom template, reducing the chance of a correlated bug.
   **All 8 vectors matched exactly**, including the two field-boundary cases.

```
$ node -e "... bn254.t3.permutation([0n, 12345678901234567890n, 98765432109876543210n]) ..."
perm out[0] = 17317691606940634593078131700218317537631664947187174753349466189872311480209
circom witness out = 17317691606940634593078131700218317537631664947187174753349466189872311480209
MATCH: true

$ node -e "... 8 vectors incl. (0,0), (p-1,p-1), (0,p-1), 4 random ..."
vector 0 [0,0] MATCH=true
vector 1 [1,2] MATCH=true
vector 2 [p-1,p-1] MATCH=true
vector 3 [0,p-1] MATCH=true
vector 4 [random] MATCH=true
vector 5 [random] MATCH=true
vector 6 [random] MATCH=true
vector 7 [random] MATCH=true
ALL MATCH: true
```

This is not a substitute for a third-party audit (see Verdict) — it's the minimum bar for
"don't wire an unverified hand-copied permutation into a circuit that gates fund movement,"
which the repo's own security posture (`README.md`: "This code is unaudited... do not put
real money in it") already sets as the standard for everything else in the codebase.

## Results

Toolchain: circom 2.2.2 (prebuilt `linux-amd64` release binary, `iden3/circom` tag `v2.2.2` —
same version as the 2026-07-22 baseline, built from source there; a prebuilt binary of the
identical version was used here since `cargo install circom` failed — `circom` is not
published to crates.io), snarkjs 0.7.6, Node v22.22.2, pot15 Powers of Tau (same file,
reused for all four circuits). Single dev-only Groth16 contribution per circuit (not a
production ceremony). All numbers below are from this session, this machine (4 vCPU),
re-measured fresh rather than reused from the 2026-07-22 baseline — the baseline recompile
(`transfer`/`compliance`) reproduced BASELINE.md's constraint counts exactly, confirming
determinism across runs.

### Constraint counts

| Circuit | Non-linear | Linear | **Total R1CS** | Wires | zkey (bytes) |
|---|---|---|---|---|---|
| `transfer.circom` (baseline) | 6,470 | 7,141 | **13,611** | 13,632 | 6,001,431 |
| `transfer_v2.circom` (Poseidon2 Merkle) | 6,410 | 8,461 | **14,871** | 14,892 | 6,399,351 |
| **Δ** | −60 | **+1,320** | **+1,260 (+9.3%)** | +1,260 | +397,920 (+6.6%) |
| `compliance.circom` (baseline) | 6,057 | 6,686 | **12,743** | 12,762 | 5,682,155 |
| `compliance_v2.circom` (Poseidon2 Merkle) | 5,997 | 8,006 | **14,003** | 14,022 | 6,080,075 |
| **Δ** | −60 | **+1,320** | **+1,260 (+9.9%)** | +1,260 | +397,920 (+7.0%) |

The delta is identical (+1,260 constraints, +63/level over the 20-level path) for both
circuits, as expected — both use exactly one `MerkleProof(20)`/`MerkleProofV2(20)` component
and nothing else differs.

Raw output:
```
$ circom transfer.circom --r1cs --wasm --sym --output build -l node_modules
non-linear constraints: 6470
linear constraints: 7141
...
$ circom transfer_v2.circom --r1cs --wasm --sym --output build_v2 -l node_modules
non-linear constraints: 6410
linear constraints: 8461
...
$ circom compliance.circom --r1cs --wasm --sym --output build -l node_modules
non-linear constraints: 6057
linear constraints: 6686
...
$ circom compliance_v2.circom --r1cs --wasm --sym --output build_v2 -l node_modules
non-linear constraints: 5997
linear constraints: 8006
...
$ npx snarkjs r1cs info build/transfer.r1cs
# of Wires: 13632 / # of Constraints: 13611
$ npx snarkjs r1cs info build_v2/transfer_v2.r1cs
# of Wires: 14892 / # of Constraints: 14871
$ npx snarkjs r1cs info build/compliance.r1cs
# of Wires: 12762 / # of Constraints: 12743
$ npx snarkjs r1cs info build_v2/compliance_v2.r1cs
# of Wires: 14022 / # of Constraints: 14003
```

**Root cause of the regression**: the vendored `@taceo/circom-lib` template implements
`ExternalMatMul3`/`InternalMatMul3` (the t=3 linear layer) with named intermediate `signal`s
(`signal sum <== in[0]+in[1]+in[2]`, then `out[i] <== ... + sum`), and circom emits one R1CS
constraint per `<==` assignment regardless of whether it could be algebraically folded.
circomlib's own `Mix`/`MixS` templates for the *original* Poseidon instead accumulate the
same linear combination into a `var` (compile-time accumulator, not a signal) and only emit
one constraint for the final `<== `, producing far fewer constraints for the same linear
algebra. Poseidon2's algorithmic advantage (fewer *native* field operations when run outside
a circuit) does not automatically translate into fewer *R1CS rows* — that depends entirely on
how the specific circom template is written. This is an implementation property of the
vendored template, not a property of the Poseidon2 permutation itself — see "Open questions."

### Proving time (Node.js, mean of 10 runs, includes witness generation)

Measured with each circuit's benchmark run **alone** (a first attempt ran baseline and v2
concurrently and produced 15–35× higher stddev from CPU contention — discarded; see raw logs
below for both the contaminated and clean runs, kept for transparency).

| Circuit | Mean (clean, single-process) | σ | Δ vs. baseline |
|---|---|---|---|
| `transfer` (baseline) | 884.54 ms | 15.29 ms | — |
| `transfer_v2` | 895.51 ms | 40.27 ms | +10.97 ms (+1.2%) |
| `compliance` (baseline) | 854.34 ms | 15.69 ms | — |
| `compliance_v2` | 866.99 ms | 22.76 ms | +12.65 ms (+1.5%) |

**Why proving time barely moved despite a 9–10% constraint increase**: Groth16 setup/proving
cost in snarkjs is dominated by an FFT over a domain sized to the next power of two above the
constraint count. 13,611 → 16,384 and 14,871 → 16,384 are the **same power-of-two bucket**
(as are 12,743 and 14,003). The extra ~1,260 constraints were, in effect, free padding this
circuit was already paying for — a swap that pushed either circuit's count past 16,384 would
show a much larger real proving-time jump. The v2 stddev (23–40ms) is also large enough that
the ~11–13ms mean delta is not clearly distinguishable from noise on this 4-vCPU shared
machine; call the proving-time result **inconclusive**, not "confirmed small regression."

Raw output (clean runs):
```
$ node scripts/bench/prove-latency.mjs --runs 10          # baseline, run alone
--- transfer ---
  mean: 884.54 ms   stddev: 15.29 ms   min: 858.98 ms   max: 907.90 ms
--- compliance ---
  mean: 854.34 ms   stddev: 15.69 ms   min: 838.08 ms   max: 891.79 ms

$ node scripts/bench/prove-latency-v2.mjs --runs 10        # v2, run alone
--- transfer_v2 ---
  mean: 895.51 ms   stddev: 40.27 ms   min: 859.23 ms   max: 1005.42 ms
--- compliance_v2 ---
  mean: 866.99 ms   stddev: 22.76 ms   min: 824.07 ms   max: 898.66 ms
```

Reproduce: `cd circuits && circom {transfer,compliance}_v2.circom --r1cs --wasm --sym
--output build_v2 -l node_modules`, then Groth16 setup against `build_v2/pot15_final.ptau`
(copy of the baseline ptau), then `node scripts/bench/prove-latency-v2.mjs --runs 10` — run
it alone, not concurrently with `prove-latency.mjs`, or CPU contention inflates variance
2–35×.

### Proof/VK size

Unchanged in on-chain terms: Groth16 proofs remain 3 fixed group elements (128 bytes
compressed) regardless of the internal hash primitive — confirmed via the proof JSON byte
sizes above (722–725 bytes snarkjs-JSON-encoded across all four circuits, same order of
magnitude as the existing baseline's 721–726 bytes, difference is just field-element decimal
string length noise). VK size grows by 1–2 bytes (still 6/7 public inputs), zkey grows
6.6–7.0% (proportional to the extra wires).

### What was blocked

Queue item #1 (on-chain gas) attempted again before starting this experiment, per its own
recommendation to "spend an early part of the next run purely on unblocking the toolchain."
Both prongs failed this time for a **new, third reason** — not the same as either of the two
prior nights:
```
$ curl -X POST https://fullnode.testnet.sui.io:443 -d '{"jsonrpc":"2.0",...}'
curl: (56) CONNECT tunnel failed, response 403
$ curl https://api.github.com/repos/iden3/circom/releases/tags/v2.2.2
403
```
Both are the sandbox's egress proxy returning a hard, non-retryable `403` (org policy
denial, confirmed via `/root/.ccr/README.md`: "do not retry or route around it — report the
blocked host"). `registry.npmjs.org` and `raw.githubusercontent.com`/
`release-assets.githubusercontent.com` *were* reachable (used throughout this experiment),
so this is a specific-host policy, not a blanket network block. Still top of the queue for
whoever runs this loop with a different network policy.

## Test suite

All circuits changed tonight are net-new files (`transfer_v2.circom`, `compliance_v2.circom`,
`templates/merkle_proof_v2.circom`, `circuits/lib/poseidon2/*`) — `transfer.circom`,
`compliance.circom`, and `withdraw.circom` are byte-for-byte unchanged. Ran the full suite
from `README.md` (no `CLAUDE.md` exists in this repo; used the README's documented commands):

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (unchanged) | **43/43 pass** | `node circuits/test/transfer.test.mjs` |
| `compliance.circom` (unchanged) | **30/30 pass** | `node circuits/test/compliance.test.mjs` |
| `withdraw.circom` (unchanged) | **35/35 pass** | `node circuits/test/withdraw.test.mjs` |
| Poseidon2 correctness + negative tests (new) | **8/8 pass** | `node circuits/test/poseidon2-merkle.test.mjs` |
| Proof converter | **109/109 pass** | `bun run scripts/src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `bunx vitest run` (in `frontend/`) |
| Compliance utils (unrelated to this change) | **67/67 pass** | `bun run scripts/src/test-compliance-utils.ts` |
| Property-based fuzz (unrelated to this change) | **6/6 properties pass** (500 cases each) | `bun run scripts/src/fuzz-tests.ts` |
| Move contract (`sui move test`) | **NOT RUN** — same blocker as 2026-07-22 (no `sui` CLI, no contract code touched tonight) | — |

### Negative tests (the "malicious witness" requirement)

`circuits/test/poseidon2-merkle.test.mjs`, 8 tests:
- **P1/P2** — positive controls: a real Poseidon2-computed Merkle proof is accepted by
  `transfer_v2`/`compliance_v2`.
- **N1/N5** — `merkleRoot` off by one is rejected.
- **N2** — a tampered path sibling is rejected.
- **N4** — a non-boolean `pathIndices` entry fails witness generation (mirrors the existing
  `T43` test for the original circuit).
- **N3/N6 — the load-bearing test for this specific change**: a Merkle proof whose root was
  computed with the *old* circomlib `Poseidon(2)` hash (i.e., what the previously-deployed VK
  would have accepted) is submitted against the new Poseidon2 VK. This directly tests that
  the swap is actually enforced by the constraint system — if a wiring bug had left the old
  hasher live somewhere, or the new VK still accidentally validated old-style roots, this is
  the test that would catch it. **It correctly rejects in both circuits.**

```
$ node circuits/test/poseidon2-merkle.test.mjs
  [PASS] P1: valid transfer_v2 witness (real Poseidon2 Merkle proof) is accepted
  [PASS] N1: transfer_v2 — merkleRoot off by one is rejected
  [PASS] N2: transfer_v2 — tampered Merkle sibling is rejected
  [PASS] N3: transfer_v2 — a Merkle root computed with the OLD Poseidon hash (not Poseidon2) is rejected
  [PASS] N4: transfer_v2 — non-boolean pathIndices rejected (witness generation must fail)
  [PASS] P2: valid compliance_v2 witness (real Poseidon2 Merkle proof) is accepted
  [PASS] N5: compliance_v2 — merkleRoot off by one is rejected
  [PASS] N6: compliance_v2 — a credential root computed with the OLD Poseidon hash is rejected
=== Results: 8 passed, 0 failed ===
```

**Suite is green.** Normal (non-draft) PR.

### A tooling papercut found and fixed along the way

`scripts/bench/prove-latency.mjs` (and the `-v2` sibling written tonight) left the Node
process alive after printing results — the same `snarkjs`-keeps-worker-handles-open issue
that PR #17 already fixed for the `circuits/test/*.mjs` runners, just not for the bench
scripts. Added the same `process.exit(0)` fix to both. Confirmed by killing three separately
hung `prove-latency` processes during tonight's benchmarking before isolating clean,
uncontended runs.

## Verdict: REJECT

The hypothesis named R1CS constraint count as the number this should move, and it moved in
the wrong direction (+9.3% to +9.9%) — a clean, deterministic, fully-reproducible result, not
noise. The real proving-time impact is small and statistically inconclusive on this machine,
which somewhat softens the practical cost, but doesn't rescue the hypothesis: the whole point
of the experiment was to *reduce* prover cost, and instead this specific implementation adds
constraints for a benefit that doesn't clearly show up in wall-clock time either.

This is a REJECT of *the vendored `@taceo/circom-lib` t=3 template as a drop-in Merkle-hash
replacement*, not a rejection of "Poseidon2 could ever help here" — see Open Questions. No
change to `BASELINE.md` (nothing here beats what's already recorded), no change to
`docs/threat-model.md` or `docs/SPEC.md` (no security property changed — the experimental
circuits were never wired into anything deployed). The branch and this report are the
record; `transfer_v2.circom`/`compliance_v2.circom`/`merkle_proof_v2.circom`/
`circuits/lib/poseidon2/*` stay in the repo as a working, verified, benchmarked reference for
whoever picks up the re-ranked follow-up below — deleting them would throw away the
correctness-verification work along with the negative result.

## Where this could be used

Even though tonight's specific implementation lost, the verification methodology generalizes
directly:
- **Any circom project vendoring a third-party gadget library** (Poseidon2, EdDSA, Merkle
  helpers) should run the same two-step check before wiring it into a proving circuit that
  gates value transfer: diff constants against the canonical/reference source
  byte-for-byte, then cross-check end-to-end outputs against a second, independently-written
  implementation. This is cheap (a few hours) relative to the cost of a hash-function bug in
  a deployed Groth16 circuit, and is a reusable pattern for Veil's own future gadget
  vendoring (queue item #6's threshold-auditing scheme, item #7's revocation accumulator —
  both will likely pull in third-party circom code).
- **Confidential payroll on Sui with a t-of-n auditor board** (the use case named in the
  2026-07-22 report) would inherit this exact Merkle-accumulator structure for its employee
  commitment tree — the same "measure the actual R1CS delta before trusting a library's
  marketing claim" lesson applies directly, especially since payroll-scale deployments would
  push toward larger anonymity sets (queue item #4) where constraint-count regressions
  compound across every prover, not just Veil's own users.
- **Any BN254 Groth16 protocol currently on circomlib Poseidon evaluating a Poseidon2
  migration for its own Merkle accumulator** (rollup nullifier trees, other Tornado-style
  privacy pools) should not assume Poseidon2's native-execution speedup transfers to
  circuit-constraint count without checking the specific circom template's linear-layer
  implementation style — the gap identified here (named-signal vs. `var`-accumulator linear
  combinations) is a generic circom-authoring pitfall, not specific to this one library.

## Open questions (next queue)

1. **Would a hand-optimized Poseidon2 t=3 linear layer (using `var`-accumulator folding like
   circomlib's `Mix`, instead of the vendored template's named-signal intermediates) actually
   reduce constraints below circomlib's original Poseidon?** This is the natural, scoped
   follow-up: same verified round constants (already confirmed correct tonight), rewritten
   `ExternalMatMul3`/`InternalMatMul3` only. If it doesn't beat circomlib's Poseidon even
   with an optimal linear layer, that's a much stronger and more final REJECT for this
   specific hash swap. **Re-ranked to the top of the queue below** — it's now well-scoped,
   builds directly on tonight's verification work, and answers the question this experiment
   left open.
2. Does the same +1,260-constraint-per-tree regression (or an optimized-linear-layer
   improvement) hold at other Merkle depths, or is the fixed 20-level depth masking a
   crossover point where Poseidon2 wins for deeper trees (relevant to queue item #4, Merkle
   accumulator at 10^5–10^7 commitments, which needs deeper trees than 20 levels for a wallet
   waiting the same block time)?
3. Is there a published, audited Poseidon2 t=5 parameter set anywhere (not found in tonight's
   search) that would let the commitment/nullifier hashes — the ones actually named in queue
   item #2's original framing — be swapped without hand-deriving constants? Worth a
   dedicated, shorter search-only night before ruling it out entirely.
4. `scripts/bench/prove-latency.mjs`/`-v2.mjs` hanging after printing results (now fixed,
   see above) suggests the underlying "PR #17 fixed it for `circuits/test/*.mjs`, missed
   `scripts/bench/*.mjs`" gap might exist in *other* scripts too (`scripts/src/*.ts` that
   call `snarkjs.groth16.*`) — worth a grep-and-fix pass, folded into queue item #12.
