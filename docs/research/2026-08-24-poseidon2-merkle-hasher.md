# 2026-08-24 — Poseidon2 as a drop-in Merkle node hash (queue item #2)

## Hypothesis

Replacing circomlib's `Poseidon(2)` with a Poseidon2(t=3) permutation as the Merkle-tree node
hash in `templates/merkle_proof.circom` — the highest-multiplicity hash call in the protocol (20
invocations per proof, once per tree level, in both `transfer.circom` and `compliance.circom`) —
measurably reduces R1CS constraint count and Groth16 proving time for those two circuits, without
changing any public interface or security property.

`EXPERIMENTS.md` queue item #2 named this the "highest-leverage next number" after the 2026-07-22
baseline, on the theory that Poseidon2's improved linear layer needs fewer S-boxes than Poseidon's
Hades-style round structure for the same field and security margin.

## Threat / privacy model

**Adversary considered:** a chain observer (reads the 128-byte compressed Groth16 proof and the
public signals Sui stores/emits) and an off-chain observer with the *full* commitment/credential
Merkle tree (the indexer, a relayer, or anyone replaying `TransferEvent`/`ComplianceVerifiedEvent`
history to reconstruct it client-side, per `frontend/src/lib/merkle-tree.ts`'s design).

**What they can do / what they observe, before and after this change:**

- The on-chain Move contract (`contracts/sources/pool.move`) never computes or verifies Poseidon
  on-chain — `commitment_root` is stored and compared as opaque `vector<u8>`, and every hash
  relation is proven entirely inside the Groth16 circuit. So a chain observer's view — proof bytes,
  public signal count and order (`oldCommitment, newCommitment, threshold, epochId, nullifier,
  txAmountHash, merkleRoot` for transfer; the analogous 6 for compliance) — is byte-for-byte
  unchanged by swapping the *internal* hash function the circuit uses to prove tree membership.
- An off-chain observer with the full tree now sees Merkle node values that are Poseidon2(t=3)
  outputs instead of Poseidon(t=3) outputs. Both are believed-secure permutations of the same BN254
  scalar field at the same ~128-bit security target (Poseidon2: eprint 2023/323, using TACEO's
  published parameters, cross-checked below); neither leaks leaf position, leaf identity, or
  anything beyond the standard authentication-path relation a depth-20 Merkle proof already reveals.

**What this does NOT defend against (residual surface, unchanged):**

- Still a single dev-only Groth16 trusted-setup ceremony per circuit (`docs/threat-model.md` RR2) —
  this experiment reruns that same non-production ceremony for the modified circuits; it does not
  touch the ceremony process itself.
- Still BN254 / no post-quantum story.
- Still a single auditor key (no threshold auditing).
- `withdraw.circom` still deliberately reveals the consumed commitment on exit (comment at the top
  of that file) — unrelated to, and unchanged by, the Merkle-hasher swap (withdraw has no Merkle
  proof; only its unrelated `recipientHash` call happens to share the same arity-2 primitive).
- Deposit-to-commitment linkability (`docs/threat-model.md` I4) is unchanged — same tree, same
  depth, same anonymity-set size.

**Assumptions:** Groth16 soundness under the BN254 discrete-log assumption (unchanged); Poseidon2
security at the parameter set published by TACEO (`@taceo/circom-lib` / `@taceo/poseidon2`,
independently maintained, MIT-licensed, "parameters compatible with the HorizenLabs parameter
script") — a new cryptographic assumption this experiment introduces, alongside the existing
Poseidon assumption (both hash functions are now live in the codebase: Poseidon2 for arity-2 node
hashing, circomlib's original Poseidon everywhere else).

**STRIDE mapping:** this is an Information Disclosure question (`docs/threat-model.md` I2/I4/I6 —
does anything new leak?) — answered no, per above. It also touches Tampering only insofar as the
hash primitive itself must remain collision-resistant for nullifier/commitment binding to hold;
verified functionally below (all soundness-relevant tests still pass, including a new negative
test). No Spoofing/Repudiation/DoS/Elevation-relevant behavior changed.

## Approach

**What I built:**

- `circuits/templates/poseidon2_hash2.circom` — a `Poseidon2Hash2` template wrapping TACEO's
  `Poseidon2(t)` permutation (`@taceo/circom-lib`) in circomlib's exact `Poseidon(2)` sponge
  convention: `state = [0, in0, in1]`, one `t=3` permutation, digest = `state[0]`. Matching that
  convention (zero capacity element, rate = the two inputs, digest position) is what makes it a
  true drop-in for every `Poseidon(2)` call site — same input order, same output.
- Rewired `templates/merkle_proof.circom` (the node hash for both `transfer.circom`'s commitment
  tree and `compliance.circom`'s credential tree — both depth 20) and `withdraw.circom`'s
  `recipHash` (the one other arity-2 Poseidon call in the protocol) to use it.
- Updated `scripts/bench/witnesses.mjs` and all three `circuits/test/*.test.mjs` files' arity-2
  hash call sites to compute with the same Poseidon2 sponge, so benchmark and test witnesses match
  what the new circuits actually enforce. Left every arity-≥3, domain-tagged call (commitments,
  nullifiers, `txAmountHash`, credential leaves, context binding) on the original circomlib
  Poseidon — those call sites were not touched in-circuit, so their JS mirrors shouldn't be either.
- Added T44 to `transfer.test.mjs`: builds a valid witness, then recomputes the Merkle root with
  the *old* `Poseidon(2)` instead of `Poseidon2Hash2` and asserts the circuit rejects it — proof
  the swap is actually enforced by R1CS constraints, not a JS-side convention nobody checks.
- Fixed a real bug hit while running this: `scripts/bench/prove-latency.mjs` never called
  `process.exit(0)`, so it hung indefinitely after finishing every benchmark (same
  `snarkjs`/`ffjavascript` open-handle issue `EXPERIMENTS.md` item #12 already named for
  `circuits/test/*.mjs`, which do have the fix). One-line fix, folded in here since it blocked
  getting clean benchmark output.

**Verifying the primitive before trusting it in a circuit.** Before wiring anything into the real
circuits, I compiled a two-line standalone `Poseidon2(3)` circuit, generated a witness for input
`[0, 1, 2]`, and compared it byte-for-byte against `@taceo/poseidon2`'s JS `bn254.t3.permutation`
for the same input — both produced the identical three field elements (see raw output below). This
is the load-bearing check for the whole experiment: TACEO ships the circom template and the JS
reference implementation as separate packages, and without this cross-check a test suite built
against a mismatched JS reference would either false-fail everything or, worse, silently pass by
computing the "expected" value the same wrong way the circuit does.

**What I rejected:**

- **A full arity-preserving swap** (also replacing the arity-4/5/6 domain-tagged Poseidon calls for
  commitments, nullifiers, and credential leaves). TACEO's `Poseidon2(t)` template — and every
  Poseidon2 reference implementation checked — only supports "round-optimized" state widths
  `t ∈ {2, 3, 4, 8, 12, 16}`. `transfer.circom`'s and `withdraw.circom`'s commitment/nullifier
  hashes need `t=5` (4 inputs + capacity); `compliance.circom`'s credential leaf needs `t=6`. Both
  are unsupported without padding into `t=8` (wasting 2–3 field elements of unused rate per call)
  or a from-scratch round-constant derivation, either of which is a bigger, riskier lift than one
  night justifies. Scoping to the `t=3` Merkle hasher — genuinely supported, genuinely the highest
  multiplicity call site (20 of the ~24 Poseidon invocations in `transfer.circom` are Merkle-node
  hashes) — was the deliberate trade-off.
- **Vendoring/hand-deriving Poseidon2 round constants** instead of depending on
  `@taceo/circom-lib` + `@taceo/poseidon2`. Hand-rolling MDS/round-constant generation for a
  security primitive in one night, with no independent way to verify the constants against a
  second source, is exactly the kind of soundness risk not worth taking; using a published,
  cross-checked (circom ⟷ JS parity verified above), MIT-licensed implementation from a team that
  also publishes a Rust crate with declared "parity" is the safer choice even though it adds a
  supply-chain dependency.

## Results

### Constraints and artifact sizes — baseline (2026-07-22) vs after

| Circuit | R1CS (before → after) | Non-linear (before → after) | Linear (before → after) | zkey bytes (before → after) | vk bytes (before → after) |
|---|---|---|---|---|---|
| `transfer.circom` | 13,611 → **14,871** (+1,260, +9.3%) | 6,470 → 6,410 (−60, −0.9%) | 7,141 → 8,461 (+1,320, +18.5%) | 6,001,431 → 6,399,342 (+397,911, +6.6%) | 4,025 → 4,024 (≈0) |
| `compliance.circom` | 12,743 → **14,003** (+1,260, +9.9%) | 6,057 → 5,997 (−60, −1.0%) | 6,686 → 8,006 (+1,320, +19.7%) | 5,682,155 → 6,080,077 (+397,922, +7.0%) | 3,841 → 3,837 (≈0) |
| `withdraw.circom` | 3,058 → **3,121** (+63, +2.1%) | 1,465 → 1,462 (−3, −0.2%) | 1,593 → 1,659 (+66, +4.1%) | 1,385,335 → 1,405,231 (+19,896, +1.4%) | 3,656 → 3,659 (≈0) |

The per-call delta is exactly consistent: `transfer.circom` and `compliance.circom` each replace 20
`Poseidon(2)` calls (one depth-20 `MerkleProof`) and both gain exactly **+1,260 constraints = +63
per call**; `withdraw.circom` replaces exactly one call (`recipHash`, no Merkle proof) and gains
exactly **+63**. Non-linear (S-box) constraints drop slightly, as the hypothesis predicted — but
linear constraints grow far more, for a net loss. This traces to how TACEO's `ExternalMatMulT` /
`InternalMatMulT` linear-layer templates are written: each 4-wide MDS block
(`ExternalMatMul4`/`InternalMatMul3` etc.) computes its dot-products through several named
intermediate signals (`t_0`, `quad_t_0`, `sum`, …) rather than one fused linear expression, and
circom emits one R1CS linear constraint per named signal rather than folding the chain. circomlib's
own `Mix`/`MixLast` templates for Poseidon's linear layer write the equivalent dot-product as a
single accumulating expression per output wire, producing far fewer constraints for the same
algebra.

Raw command output:

```
$ circom transfer.circom --r1cs --wasm --sym --output build
template instances: 161
non-linear constraints: 6410
linear constraints: 8461
public inputs: 7
private inputs: 47
wires: 14892
$ snarkjs r1cs info build/transfer.r1cs
[INFO]  snarkJS: # of Constraints: 14871

$ circom compliance.circom --r1cs --wasm --sym --output build-compliance
non-linear constraints: 5997
linear constraints: 8006
$ snarkjs r1cs info build-compliance/compliance.r1cs
[INFO]  snarkJS: # of Constraints: 14003

$ circom withdraw.circom --r1cs --wasm --sym --output build-withdraw
non-linear constraints: 1462
linear constraints: 1659
$ snarkjs r1cs info build-withdraw/withdraw.r1cs
[INFO]  snarkJS: # of Constraints: 3121

$ stat -c %s build/transfer_final.zkey build/transfer_vk.json
6399342
4024
$ stat -c %s build-compliance/compliance_final.zkey build-compliance/compliance_vk.json
6080077
3837
$ stat -c %s build-withdraw/withdraw_final.zkey build-withdraw/withdraw_vk.json
1405231
3659
```

Cross-implementation verification (standalone `Poseidon2(3)` circuit vs `@taceo/poseidon2` JS,
both for input `[0, 1, 2]`):

```
# circom witness (state[0..2] after one Poseidon2(t=3) permutation)
5297208644449048816064511434384511824916970985131888684874823260532015509555
21816030159894113985964609355246484851575571273661473159848781012394295965040
13940986381491601233448981668101586453321811870310341844570924906201623195336

# node -e "import('@taceo/poseidon2').then(({bn254}) => console.log(bn254.t3.permutation([0n,1n,2n])))"
5297208644449048816064511434384511824916970985131888684874823260532015509555
21816030159894113985964609355246484851575571273661473159848781012394295965040
13940986381491601233448981668101586453321811870310341844570924906201623195336
```

### Proving time — Node.js (`node scripts/bench/prove-latency.mjs --runs 10`), baseline vs after

| Circuit | Before (mean, σ) | After (mean, σ) | Δ |
|---|---|---|---|
| `transfer.circom` | 751.9 ms (σ 17.3) | **883.98 ms** (σ 25.9) | **+132.1 ms, +17.6%** |
| `compliance.circom` | 738.1 ms (σ 20.9) | **842.24 ms** (σ 15.4) | **+104.1 ms, +14.1%** |
| `withdraw.circom` | 244.3 ms (σ 7.9) | **290.49 ms** (σ 15.6) | **+46.2 ms, +18.9%** |

```
=== Veil Groth16 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- transfer ---
  runs: 10
  mean: 883.98 ms   stddev: 25.88 ms   min: 852.74 ms   max: 947.00 ms
  proof JSON size: 724 bytes, public signals: 7

--- withdraw ---
  runs: 10
  mean: 290.49 ms   stddev: 15.55 ms   min: 265.91 ms   max: 320.00 ms
  proof JSON size: 721 bytes, public signals: 5

--- compliance ---
  runs: 10
  mean: 842.24 ms   stddev: 15.36 ms   min: 807.42 ms   max: 863.51 ms
  proof JSON size: 723 bytes, public signals: 6
```

### Proving time — Chromium (`node scripts/bench/browser-latency.mjs --runs 8`), baseline vs after

| Circuit | Before (mean, σ) | After (mean, σ) | Δ |
|---|---|---|---|
| `transfer.circom` | 1213.3 ms (σ 32.6) | **1344.22 ms** (σ 139.0) | **+130.9 ms, +10.8%** |
| `compliance.circom` | 1163.4 ms (σ 58.6) | **1270.01 ms** (σ 40.2) | **+106.6 ms, +9.2%** |
| `withdraw.circom` | 382.9 ms (σ 9.9) | **405.98 ms** (σ 13.6) | **+23.1 ms, +6.0%** |

```
=== Veil browser (Chromium) proving-time benchmark (8 runs per circuit) ===
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36

--- transfer ---
  runs: 8
  mean: 1344.22 ms   stddev: 139.04 ms   min: 1237.10 ms   max: 1679.30 ms

--- withdraw ---
  runs: 8
  mean: 405.98 ms   stddev: 13.59 ms   min: 380.80 ms   max: 420.90 ms

--- compliance ---
  runs: 8
  mean: 1270.01 ms   stddev: 40.21 ms   min: 1217.10 ms   max: 1330.10 ms
```

Every circuit is slower after the swap, in both environments, by a consistent double-digit
percentage in Node and a smaller (but still consistently positive) percentage in the browser — the
browser numbers include fixed WASM-instantiation/fetch overhead that dilutes the relative delta but
doesn't erase it.

### Test suite

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs, incl. new T44 negative test) | **109/109 pass** (44 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Proof converter | **109/109 pass** (unaffected — no byte-layout change) | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** — `sui` CLI still unavailable this session (see below); no contract code touched | `sui move test` |

No test was loosened, skipped, or given new tolerance to reach these numbers. The circuit suite
result is FULL PROOF mode throughout (real `snarkjs.groth16.fullProve` + `verify` against the
freshly compiled artifacts above), not the hash-only fallback.

**Toolchain note (queue item #1, revisited):** before starting this experiment I spent the first
part of the session on the standing on-chain-gas blocker, per `EXPERIMENTS.md`'s instruction to
"unblock the toolchain before attempting the measurement" again. Result: still blocked, for a third
distinct reason this time. `fullnode.testnet.sui.io` is now rejected at the network-proxy level
(`403` on the HTTPS `CONNECT`, confirmed via the proxy's own status endpoint — a policy denial, not
a transient failure) rather than by the tool-approval layer as on 2026-07-22. Crates.io does list a
package literally named `sui`, but it's an unrelated placeholder library with no binary
(`cargo install sui` fails with "there is nothing to install... it has no binaries"). Building the
real CLI from source remains out of budget for one night, as noted last time. This is now blocked
for three different reasons across two nights — worth downgrading in the queue re-rank below rather
than retrying a fourth time without a new angle.

## Verdict: **REJECT**

The hypothesis — that Poseidon2 reduces constraint count and proving time for Veil's Merkle hasher
— is disproven by direct measurement, not merely unconfirmed. Non-linear (S-box) constraints do
drop slightly, exactly as the Poseidon2 literature would predict, but TACEO's linear-layer
implementation costs far more in linear R1CS constraints than it saves in non-linear ones, and that
shows up as a real, consistent proving-time regression (+14–19% Node, +6–11% browser) across all
three circuits, plus a 1.4–7.0% larger zkey. The branch (`research/2026-08-24-poseidon2-merkle-hasher`)
is kept for the record; `main`, `BASELINE.md`, and `docs/threat-model.md` are unchanged.

This is not a verdict on Poseidon2 as a primitive — it's a verdict on *this specific, literal
translation* of TACEO's reference circom implementation, which prioritizes readability (named
intermediate signals per matrix multiply) over R1CS-constraint minimality. A hand-fused linear
layer (single expression per output wire, circomlib-`Mix`-style) could plausibly recover the
non-linear-constraint win without the linear-constraint cost — that's exactly the open question
queued below, not attempted tonight to keep this experiment to one measured hypothesis.

## Where this could be used

- **The negative result generalizes to any Circom/Groth16 project evaluating an off-the-shelf
  Poseidon2 circom library as a literal drop-in**: "fewer S-boxes" from a paper or a Rust
  benchmark does not imply fewer R1CS constraints once a specific circom encoding of the linear
  layer is compiled — the encoding matters as much as the algorithm. Worth checking before
  adopting Poseidon2 in, e.g., a Tornado-Cash-style mixer, a Semaphore-based anonymous-voting
  circuit, or any other depth-N Merkle-membership circuit currently on plain Poseidon.
- **The cross-implementation verification step** (compile a tiny circuit, diff its witness against
  the JS/Rust reference for a fixed input) is a reusable pattern for any project pulling in a
  circom package and a JS package from the same "family" that aren't literally the same artifact —
  worth two minutes before trusting either.
- **A thesis chapter on Poseidon2 adoption trade-offs** now has a concrete, measured
  counter-example to cite alongside the usual "Poseidon2 is faster" claims — with the specific
  mechanism (linear-layer constraint bloat from named-signal MDS multiplication) identified, not
  just an unexplained negative number.

## Open questions (next queue)

1. **Would a hand-fused Poseidon2 linear layer (one expression per output wire, no named
   intermediates) recover the non-linear-constraint win without the linear-constraint cost?** This
   is the natural re-attempt — same permutation, same round constants (already verified correct),
   different circom encoding of `ExternalMatMulT`/`InternalMatMulT`. Should be re-ranked above
   other queue items only if someone is willing to hand-write and re-verify a custom linear layer,
   which is real cryptographic-engineering risk for a maybe-win; parking rather than promoting for
   now.
2. **On-chain gas per entry point** — blocked a third time, for a third reason (network-proxy
   policy denial this time, not a tool-approval or CLI-availability gap). Re-ranked *below* item 2
   below unless a future session brings a materially different angle (e.g. explicit user-granted
   network exception, or a prebuilt `sui` binary reachable through an allowed host) — three blocked
   attempts on the same approach is a signal to stop repeating it.
3. Does the same linear-layer-bloat pattern show up in TACEO's wider state sizes (`t=8,12,16`), or
   is it specific to the small `t=3`/`t=4` matrices this experiment used? Relevant if a future
   batched/aggregated-proof experiment (queue item 3) considers Poseidon2 for a wider hash.
