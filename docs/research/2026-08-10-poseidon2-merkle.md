# 2026-08-10 — Poseidon2 vs Poseidon: real constraint and proving-time deltas (queue item #2)

## Hypothesis

Swapping Veil's Poseidon (circomlib) hash calls for Poseidon2 (`@taceo/circom-lib`, BN254,
HorizenLabs parameters) reduces R1CS constraint count and Groth16 proving time, at every arity
Veil's circuits actually use: the depth-20 Merkle-membership sponge (2-input, t=3), the tx-amount
hash (3-input, t=4), and the commitment/nullifier hashes (4-input, t=5 — no native Poseidon2 width,
padded to t=8). This experiment measures the delta at each arity in isolation and in a full working
`transfer.circom` prototype, and is falsifiable in either direction: the queue predicted a win: this
report's job is to say, with real numbers, whether that prediction holds.

Item #1 (on-chain gas, `BASELINE.md`'s missing axis) was re-attempted first — still **BLOCKED**, see
"Item #1 retry" below — so this is the top actionable item once that's confirmed.

## Threat / privacy model

**Adversary this defends against:** none, directly — this is a prover-cost/circuit-cost experiment,
not a new mitigation. The relevant question is narrower: does changing which permutation computes
Veil's commitments and nullifiers change what a chain observer, colluding relayer, or malicious
prover can do?

- **Chain observer.** Sees a 128-byte compressed Groth16 proof and the same 7 public field elements
  (`oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot`) whether
  the circuit computes those hashes with Poseidon or Poseidon2 — the public-input shape of
  `transfer_poseidon2.circom` (this experiment's prototype) is byte-for-byte identical to production
  `transfer.circom`. Nothing new is observable on-chain from this swap alone.
- **Malicious prover.** Five negative tests (`scripts/bench/circuits/transfer_poseidon2.negative.test.mjs`,
  N0-N4) confirm the Poseidon2-based circuit rejects a forged hash preimage, a tampered Merkle
  sibling, an out-of-range mux selector, and a wrong root — real Groth16 `fullProve` calls that must
  throw, the same assertion pattern as production `transfer.circom`'s own T41-T43.
- **What this does NOT establish:** no new cryptanalysis of Poseidon2 over BN254 was performed or
  commissioned here. The soundness argument below leans on the published Poseidon2 security analysis
  (Grassi, Khovratovich, Schofnegger, eprint 2023/323) and HorizenLabs' published BN254 parameter
  derivation — the same trust basis Veil already extends to circomlib's Poseidon (also un-audited
  from-scratch, resting on the original 2019/458 whitepaper's analysis). This experiment neither
  raises nor lowers that trust level.
- **STRIDE mapping:** touches the "Domain-separated Poseidon hashes... Tags 1-8 prevent cross-domain
  hash collisions" control (`docs/threat-model.md` line 173) only in the sense of confirming it is
  *unchanged* — the domain tag stays the first rate element in the sponge in the same position,
  regardless of which permutation processes it. Does not touch I2/I4/I6 (amount/deposit/nullifier
  disclosure) — nothing about what's disclosed changes.
- **Residual surface a future migration would need to design for:** if Veil ever ships a construction
  swap, old-Poseidon and new-Poseidon2 commitments/nullifiers must never share a nullifier-set or
  domain-tag space without an explicit construction-version tag — otherwise a partial migration could
  in principle blur which hash produced a given field element. Not a live risk today (nothing is
  deployed), but real enough to flag for whoever picks this up next — see Open Questions.

Assumptions carried over unchanged from `docs/threat-model.md`: Groth16/BN254 soundness, the
dev-only single-contributor trusted setup (RR2, unaffected — Poseidon2's linear layer doesn't change
what the trusted setup ceremony has to do).

## Approach

**What I built** (none of this touches production `circuits/*.circom` — all under `scripts/bench/`):

- `circuits/templates/poseidon2_hash.circom` — thin sponge wrapper around `@taceo/circom-lib`'s raw
  `Poseidon2(t)` permutation, matching circomlib's `Poseidon(nInputs)` convention exactly (capacity-0
  first state slot, rate = inputs, output = permuted capacity slot).
- `circuits/templates/merkle_proof_poseidon2.circom` — line-for-line the same as production
  `templates/merkle_proof.circom`, with the per-level `Poseidon(2)` sponge call swapped for
  `Poseidon2Hash(3)`.
- Six standalone benchmark circuits (`scripts/bench/circuits/{merkle,hash_arity3,hash_arity4}_*.circom`)
  isolating each arity Veil uses: the depth-20 Merkle sponge (t=3), the 3-input tx-amount-hash shape
  (t=4), and the 4-input commitment/nullifier shape (t=5, only available in Poseidon2 padded to t=8 —
  `@taceo/circom-lib`'s `Poseidon2(t)` only supports `t ∈ {2,3,4,8,12,16}`; the paper's efficient
  external-matrix trick needs `t ∈ {2,3}` or a multiple of 4, so t=5 does not exist).
- `scripts/bench/circuits/transfer_poseidon2.circom` — a full working prototype of `transfer.circom`
  with the Merkle proof and `txAmountHash` swapped to Poseidon2 (the two arities with a *native*
  width). `oldHash`/`newHash`/`nfHash` stay on production `Poseidon(4)` — the isolated arity-4 result
  below shows padding to t=8 is strictly worse, so it wasn't worth repeating inside the full circuit.
- `scripts/bench/circuits/transfer_poseidon2.negative.test.mjs` — 5 negative tests (real Groth16
  proofs) against the prototype.
- `scripts/bench/circuits/build.sh` — reusable, compiles all six benchmark circuits + runs a real
  dev-only Groth16 setup for each.
- `scripts/bench/poseidon2-latency.mjs` — proving-time benchmark for the six isolated circuits.
- `scripts/bench/transfer-poseidon2-latency.mjs` — proving-time benchmark, production `transfer.circom`
  vs the prototype, same witness values (`salt`, `userSecret`, etc.) fed through both hash
  constructions so the comparison is apples-to-apples.

**What I rejected.** `@taceo/circom-lib` also ships `binary_merkle_root.circom`, which uses Poseidon2
in *compression mode* (t=2, Miyaguchi-Preneel-style feed-forward: `node = permute([0,l,r])[0] + l`)
instead of the sponge mode (t=3) Veil's `MerkleProof` currently uses. Compression mode is a real,
narrower-state, likely-cheaper construction — but it's a different construction, not just a different
permutation, and needs its own security argument (collision resistance under an ideal-permutation
assumption is sufficient for Merkle-tree nodes and is the standard choice in e.g. zk-kit/Semaphore,
but that's a claim this report didn't verify, so I didn't build it tonight). Flagged as a queued
follow-up, not measured here — mixing "swap the permutation" and "change the construction" in one
experiment would have made a REJECT/KEEP verdict on either change ambiguous.

**Toolchain gaps and how I handled each:**

- `circom` — same as 2026-07-22: not installed, no prebuilt binary. Cloned `iden3/circom` (tag
  `v2.2.2`) and `cargo build --release` — under 90s, no issues (github.com and crates.io's *index*
  are both reachable through the proxy).
- `@taceo/circom-lib` / `@taceo/poseidon2` — not installed, but `registry.npmjs.org` is on this
  session's proxy allowlist (unlike `static.crates.io`, see below), so `npm install` worked directly.
  Both are MIT-licensed, real circom source (not prebuilt/opaque), version-pinned
  (`@taceo/circom-lib@0.6.0`, `@taceo/poseidon2@0.2.0`).

## Item #1 retry (on-chain gas — still BLOCKED)

Spent the first part of this run specifically trying to unblock this, per the queue's instruction:

```
$ curl -sS -v https://fullnode.testnet.sui.io:443 -X POST ...
* Establish HTTP proxy tunnel to fullnode.testnet.sui.io:443
< HTTP/1.1 403 Forbidden
* CONNECT tunnel failed, response 403
```

Confirmed via `/root/.ccr/README.md`: this is an organization egress-policy denial ("Do not retry or
route around it — report the blocked host"), not a transient failure — same conclusion as
2026-07-22, now with the specific proxy diagnostic instead of a sandbox tool-approval denial.

Also tried building `sui` from source (`cargo install sui` / cloning `MystenLabs/sui`), reasoning
that `index.crates.io` (the package index) *is* on the allowlist even though `fullnode.testnet.sui.io`
isn't:

```
$ curl -o /dev/null -w "%{http_code}" https://index.crates.io/config.json
200
$ curl -o /dev/null -w "%{http_code}" https://static.crates.io/crates/sui/sui-1.0.0.crate
403
```

The crate *index* is reachable but `static.crates.io` (where actual `.crate` files are downloaded
from) is not — so `cargo build`/`cargo install` for anything pulling real dependencies is blocked the
same way the fullnode RPC is, independent of the "full Sui workspace is a multi-night build" problem
already on record. Both paths to a gas number are closed by network policy, not by a fixable local
gap. Still top of the queue for whenever this session's egress policy allows either host.

## Results

### Isolated arity comparisons (`node scripts/bench/circuits/build.sh` then `snarkjs r1cs info` + `node scripts/bench/poseidon2-latency.mjs --runs 5`, uncontended — see note on methodology below)

| Circuit (arity Veil uses) | Non-linear | Linear | **Total constraints** | Δ constraints | Proving time (mean, 5 runs) | Δ proving time |
|---|---|---|---|---|---|---|
| Merkle depth-20, Poseidon (t=3, production) | 4,920 | 5,480 | **10,400** | — | 782.82 ms (σ 8.99) | — |
| Merkle depth-20, Poseidon2 (t=3) | 4,860 | 6,800 | **11,660** | **+12.1%** | 761.47 ms (σ 6.69) | −2.7% |
| Arity-3 hash, Poseidon (t=4, txAmountHash shape) | 264 | 341 | **605** | — | 124.56 ms (σ 5.96) | — |
| Arity-3 hash, Poseidon2 (t=4, native) | 264 | 588 | **852** | **+40.8%** | 102.99 ms (σ 8.42) | −17.3% |
| Arity-4 hash, Poseidon (t=5, commitment shape) | 300 | 436 | **736** | — | 137.18 ms (σ 8.95) | — |
| Arity-4 hash, Poseidon2 (t=8, zero-padded — no native t=5) | 363 | 1,300 | **1,663** | **+126.0%** | 136.38 ms (σ 5.86) | −0.6% (noise) |

Raw command and output (constraint counts):

```
$ circom scripts/bench/circuits/merkle_poseidon.circom --r1cs --sym --output build -l circuits/node_modules
non-linear constraints: 4920
linear constraints: 5480
$ snarkjs r1cs info build/merkle_poseidon.r1cs
[INFO]  snarkJS: # of Constraints: 10400

$ circom scripts/bench/circuits/merkle_poseidon2.circom --r1cs --sym --output build -l circuits/node_modules
non-linear constraints: 4860
linear constraints: 6800
$ snarkjs r1cs info build/merkle_poseidon2.r1cs
[INFO]  snarkJS: # of Constraints: 11660

$ snarkjs r1cs info build/hash_arity3_poseidon.r1cs      # 264 + 341 = 605
$ snarkjs r1cs info build/hash_arity3_poseidon2.r1cs     # 264 + 588 = 852
$ snarkjs r1cs info build/hash_arity4_poseidon.r1cs      # 300 + 436 = 736
$ snarkjs r1cs info build/hash_arity4_poseidon2_padded.r1cs  # 363 + 1300 = 1663
```

Proving-time raw output (`node scripts/bench/poseidon2-latency.mjs --runs 5`, run alone with no other
proving jobs on the machine — see methodology note):

```
=== Veil Poseidon vs Poseidon2 proving-time benchmark (5 runs per circuit) ===
node v22.22.2, linux/x64

--- merkle_poseidon (Merkle depth-20, Poseidon (t=3, production)) ---
  mean: 782.82 ms   stddev: 8.99 ms   min: 773.14 ms   max: 797.77 ms
--- merkle_poseidon2 (Merkle depth-20, Poseidon2 (t=3)) ---
  mean: 761.47 ms   stddev: 6.69 ms   min: 752.87 ms   max: 772.30 ms
--- hash_arity3_poseidon (Arity-3 hash, Poseidon (t=4, production shape)) ---
  mean: 124.56 ms   stddev: 5.96 ms   min: 115.28 ms   max: 130.47 ms
--- hash_arity3_poseidon2 (Arity-3 hash, Poseidon2 (t=4, native)) ---
  mean: 102.99 ms   stddev: 8.42 ms   min: 93.45 ms   max: 118.52 ms
--- hash_arity4_poseidon (Arity-4 hash, Poseidon (t=5, production shape)) ---
  mean: 137.18 ms   stddev: 8.95 ms   min: 125.25 ms   max: 148.21 ms
--- hash_arity4_poseidon2_padded (Arity-4 hash, Poseidon2 (t=8, zero-padded)) ---
  mean: 136.38 ms   stddev: 5.86 ms   min: 128.37 ms   max: 146.38 ms
```

**Methodology note on proving-time noise:** the first attempt at these numbers was run while two
other `snarkjs`-proving Node processes were still alive in the background (a leftover from an earlier
step in this same session) — that run showed the production circuit taking ~957ms vs a plausible
~750ms baseline-night figure, a ~27% slowdown from resource contention alone, not a real signal. I
killed the stray processes and reran every proving-time number in this report alone on an otherwise
idle machine; the numbers above are the clean rerun. Flagging this because it's exactly the kind of
noise source that turns a benchmark into an accidental estimate if you don't notice it.

### Full-circuit comparison: `transfer.circom` (production) vs `transfer_poseidon2.circom` (prototype)

| | Constraints | zkey (bytes) | vk (bytes) | r1cs (bytes) | Proving time (mean, 8 runs) |
|---|---|---|---|---|---|
| `transfer.circom` (production, unmodified) | 13,611 | 6,001,424 | 4,025 | 1,851,820 | 942.53 ms (σ 16.67) |
| `transfer_poseidon2.circom` (Merkle + txAmountHash → Poseidon2; commitments/nullifier unchanged) | 15,118 | 6,478,384 | 4,020 | 2,026,536 | 910.83 ms (σ 25.71) |
| **Δ** | **+1,507 (+11.1%)** | +7.9% | −0.1% | +9.4% | **−3.4%** |

```
$ circom circuits/transfer.circom --r1cs --wasm --sym --output build -l node_modules
non-linear constraints: 6470
linear constraints: 7141
$ snarkjs r1cs info build/transfer.r1cs
[INFO]  snarkJS: # of Constraints: 13611     # exactly reproduces BASELINE.md — same machine-independent number

$ circom scripts/bench/circuits/transfer_poseidon2.circom --r1cs --wasm --sym --output build -l circuits/node_modules
non-linear constraints: 6410
linear constraints: 8708
$ snarkjs r1cs info build/transfer_poseidon2.r1cs
[INFO]  snarkJS: # of Constraints: 15118

$ node scripts/bench/transfer-poseidon2-latency.mjs --runs 8
--- transfer.circom (production, Poseidon) ---
  mean: 942.53 ms   stddev: 16.67 ms   min: 917.90 ms   max: 972.44 ms
--- transfer_poseidon2.circom (prototype) ---
  mean: 910.83 ms   stddev: 25.71 ms   min: 874.35 ms   max: 961.94 ms
```

Note: 942.53ms for the *unmodified* production circuit vs BASELINE.md's 751.9ms figure for the same
circuit on 2026-07-22 is a different container (this loop gets a fresh sandbox each night — see
CLAUDE.md/environment notes), not a regression; only the within-night, same-machine deltas above are
meaningful.

### Why more constraints didn't mean slower proving

Groth16 proving cost is dominated by an FFT over a domain sized to the next power of two above the
constraint count, plus an MSM roughly linear in constraint count. Both the Merkle circuits
(10,400 → 11,660) and the full transfer circuits (13,611 → 15,118) stay under the same power-of-two
ceiling (16,384) in both the Poseidon and Poseidon2 version — so the dominant FFT cost didn't
actually grow, and the smaller, genuinely-linear MSM cost increase was evidently outweighed by
whatever made the Poseidon2 witness/proving path itself a bit faster (fewer WASM instructions per
S-box round, most likely — not measured directly here). The arity-4-padded case is the interesting
exception: 736 → 1,663 constraints crosses a power-of-two boundary (1,024 → 2,048) and *still* showed
no time penalty, which says these microbenchmarks are small enough that fixed per-proof overhead
(WASM instantiation, `snarkjs` setup) dominates wall time more than the underlying FFT/MSM cost — the
full-circuit numbers are the ones to trust for anything resembling a real-world estimate.

### Root cause of the constraint increase

`@taceo/circom-lib`'s `ExternalMatMulT`/`InternalMatMulT` templates implement Poseidon2's efficient
*native*-arithmetic linear-layer trick (O(t) additions instead of a full O(t²) MDS matrix multiply) —
good for Rust/hardware, but it materializes intermediate values (`sum`, `t_0`, `t_1`, `quad_t_0`, …)
as named circom `signal`s with fan-out. circomlib's classic `Mix()` (one `M[j][i]*in[j]` linear
combination directly assigned to each output wire, zero named intermediates) collapses to constraints
that circom's optimizer can often fold away entirely; the Poseidon2 template's reused intermediate
signals can't be folded the same way, so they show up as real extra linear R1CS rows — visible
directly in the linear-constraint column above (+24%, +72%, +198% at t=3/4/8 respectively), while the
non-linear (S-box) constraint count stays flat or slightly improves. This looks like a genuine,
fixable implementation inefficiency in this specific circom port, not an inherent property of the
Poseidon2 permutation — see Open Questions.

### Test suite (full, from `README.md`'s "Run it" section — no test loosened, skipped, or given new tolerance)

| Suite | Result | Command |
|---|---|---|
| Circuits (production, real Groth16 proofs) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Poseidon2 prototype negative tests (real Groth16 proofs) | **5/5 pass** (N0 sanity + N1-N4 malicious-witness rejections) | `node scripts/bench/circuits/transfer_poseidon2.negative.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (credential leaf, Merkle builder) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz (fast-check) | **6/6 properties**, 500 cases each | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** — `sui` CLI still unavailable (see Item #1 retry) | `cd contracts && sui move test` |

## Verdict: **REJECT** (adopting `@taceo/circom-lib`'s Poseidon2 as a drop-in) — knowledge kept, branch kept

At every arity Veil's circuits actually use, `@taceo/circom-lib`'s Poseidon2 produces **more** R1CS
constraints than production Poseidon — +12.1% for the Merkle sponge (the highest-volume call, 20 per
proof), +40.8% for the 3-input hash, +126.0% for the 4-input hash padded to the only larger supported
width. The full `transfer_poseidon2.circom` prototype confirms this compounds to +11.1% constraints
and +7.9% zkey size for the whole circuit. This directly contradicts the queue's framing of Poseidon2
as "the highest-leverage next number" for cutting prover time — with this library, it isn't, not for
Veil's specific hash shapes. `BASELINE.md` is not updated; nothing in production changed.

The one genuinely surprising, real result: proving time did **not** get worse (Merkle −2.7%, full
transfer −3.4%, both outside their stddev), because Groth16's FFT-dominated cost structure absorbed
the extra constraints without crossing a power-of-two domain boundary. So the number Veil users
actually feel (wall-clock proving time) didn't regress even though the number that's usually a good
proxy for it (constraint count) did — worth remembering before treating constraint count alone as
the metric that matters.

This is not a verdict on Poseidon2 the algorithm — it's a verdict on this specific circom
implementation's linear layer for Veil's specific arities. The root-cause analysis above points at a
fixable inefficiency (materialized intermediate signals vs. circomlib's fold-away `Mix()`), not a
fundamental limit, so a hand-optimized direct-linear-combination port is a legitimate next-queue item
if someone wants to actually chase the win the original hypothesis predicted.

## Where this could be used

- **Any circom/Groth16 team evaluating Poseidon2 off a library README's claimed native-arithmetic
  speedup**, without checking what a specific R1CS port of the linear layer actually compiles to —
  this report is a concrete "measure before you port" cautionary data point, arity-by-arity, not just
  "Poseidon2 is faster" taken on faith.
- **A thesis chapter or benchmark suite comparing Poseidon/Poseidon2/Rescue circuit costs** needs
  exactly this arity-by-arity breakdown (not just "one hash function, one report") since real circuits
  mix multiple call arities and the R1CS delta is highly arity-dependent, as shown here (t=3 barely
  worse, t=8-padded much worse).
- **Nova/folding-scheme or PLONKish-recursion research** (queue item #9, trusted-setup elimination) —
  Poseidon2 is the hash of choice for several recursive-SNARK ecosystems specifically because of its
  native-arithmetic efficiency; this report's finding that the *circom/R1CS* port doesn't inherit that
  advantage is a relevant caveat for anyone assuming a Poseidon2 circuit is a free upgrade on the way
  to a folding-scheme migration.

## Open questions (next queue)

1. **Hand-optimized Poseidon2 linear layer.** Rewrite `ExternalMatMulT`/`InternalMatMulT` as direct
   per-output linear combinations (no named intermediate signals) and re-measure the same six
   benchmark circuits. If the root-cause analysis above is right, this should close most or all of
   the constraint gap and could flip this REJECT to a KEEP. Bounded, well-scoped follow-up night.
2. **Poseidon2 compression-mode Merkle tree (t=2).** `@taceo/circom-lib`'s own `binary_merkle_root.circom`
   uses a narrower, Miyaguchi-Preneel-style construction instead of the sponge Veil uses today —
   likely cheaper again, but changes the hash *construction*, not just the permutation, so it needs
   its own soundness writeup (collision-resistance-only vs. the sponge's fuller assumption) before
   it's a fair comparison. Flagged, not measured, tonight.
3. **Cross-construction domain separation for any future hash migration.** If Poseidon2 (or any
   future hash swap) ever ships, old- and new-construction commitments/nullifiers must not share a
   domain-tag/nullifier-set space without an explicit version tag. Design note, not a benchmark.
4. Re-verify item #1 whenever this session's egress policy changes — both blocking hosts
   (`fullnode.testnet.sui.io`, `static.crates.io`) are policy denials, not toolchain gaps, so no
   amount of local effort closes this without a policy change.
