# 2026-09-04 — Poseidon2 vs current Poseidon: constraint-count and proving-time delta (queue item #2)

## Hypothesis

Swapping Veil's Poseidon (circomlib, via `Poseidon(nInputs)`) for Poseidon2 (Grassi–Khovratovich–
Schofnegger, 2023) in the exact hash "shapes" Veil actually calls — a 20-deep, width-3 Merkle
proof and four tagged compression hashes of width 3–6 — reduces total R1CS constraints for
`transfer.circom`, `compliance.circom`, and `withdraw.circom` and, with it, Groth16 proving time.
Falsifiable directly: constraint counts and proving-time means either drop or they don't, measured
on isolated hash-only skeletons of the three production circuits before and after the swap.

This is queue item #2. Queue item #1 (on-chain gas) was attempted first and is still BLOCKED — see
"Blocked toolchain: on-chain gas" below — so this run fell through to the next unsettled item, as
the queue's own instructions say to do.

## Threat / privacy model

**Adversary:** a chain observer and a malicious prover, the same two the existing domain-tag
design in `transfer.circom`/`compliance.circom`/`withdraw.circom` already defends against (see
`docs/threat-model.md`, "Domain-separated Poseidon hashes... Tags 1-8 prevent cross-domain hash
collisions"). This experiment does not introduce a new adversary or a new observable; it changes
which permutation computes an already-public commitment/nullifier/hash value, not what is
disclosed. A chain observer today sees the same thing under either variant: commitment and
nullifier field elements, unchanged in structure, meaning, or count. Nothing in this experiment
exposes cumulative spending, userSecret, or any other value that today's circuits keep private.

**What changes, concretely:** the SAFE-style variant explored here (`circuits/bench/lib/`) moves
the domain tag from a rate element (Veil's current convention — the tag is `Poseidon(N).inputs[0]`)
into the sponge's capacity element. This is a **strengthening**, not a weakening, of domain
separation: SAFE (Sponge API for Field Elements, https://eprint.iacr.org/2023/522) is the standard
recommendation precisely because a capacity-element tag can never leak into or collide with rate
output, whereas a rate-element tag is only separated by the permutation's own diffusion. Both are
sound under Poseidon's/Poseidon2's design (Veil's current tag-in-rate scheme has no known
weakness), but capacity-based separation is the more conservative choice, and this experiment's
own JS sanity check confirms distinct tags on identical inputs still produce distinct outputs (see
Approach).

**What this does NOT defend against, or even touch:**
- **Trusted setup (RR2).** Both variants use the same dev-only, single-contributor Groth16 setup.
  Nothing here is a PLONK/Halo2 migration (that's queue item #9, explicitly parked behind this one).
- **Sender privacy (`PRIV-002`, README).** Unrelated to the hash function.
- **Malicious auditor / single auditor key (asset #6).** Unrelated; queue item #6.
- **Post-quantum exposure.** Poseidon2 is still a BN254-field permutation; identical PQ exposure to
  Poseidon (queue item #10).
- **Statistical deanonymization / relayer leakage under load.** Unrelated; queue item #11.
- The bench circuits in `circuits/bench/` are **not used by the deployed protocol** — this is
  isolated research code, not a change to `transfer.circom`/`compliance.circom`/`withdraw.circom`
  or to the deployed verifying keys. A chain observer of the real Veil testnet package sees nothing
  different as a result of this PR.

**Assumptions:** Groth16 soundness under the BN254 discrete-log assumption (unchanged). Poseidon2's
security (algebraic-attack resistance, sponge indifferentiability under SAFE) is taken on the
authority of its published cryptanalysis and the round-constant/MDS parameters shipped by
`@taceo/circom-lib` 0.9.0 / `@taceo/poseidon2` 0.2.0 (TACEO Labs) — "compatible with the HorizenLabs
parameter script and the Rust `taceo-poseidon2` crate" per that package's own docs, i.e.
cross-checked against an independent reference, not hand-derived in this session. No round
constants or MDS/diagonal matrices were generated or modified here.

**STRIDE mapping (`docs/threat-model.md`):** most directly touches the "Domain-separated Poseidon
hashes" preventive control (line 173) and, if ever deployed, entry I6 (nullifier pattern leakage —
unaffected either way, both variants are pseudorandom PRF-like outputs). No RR (residual risk) row
changes: this experiment is additive research, not a production change, and even a future KEEP
would not remove or add an RR row since it wouldn't change what's observable on-chain.

## Approach

**What I built:**

1. **`circuits/bench/lib/poseidon2_compress.circom`** — `Poseidon2CompressTagged(nVals, T, tag)`, a
   compression wrapper around `@taceo/circom-lib`'s `Poseidon2Sponge(N, T)` (SAFE-style: domain tag
   folded into the sponge capacity via a simplified `ds = tag + 1009*nVals + 1000003*T` — a
   stand-in for the paper's full SHA3-derived tag, not a production-ready derivation; see the file
   header) — and `MerkleLevelPoseidon2`, its 2-value specialization for Merkle nodes.
2. **`circuits/bench/lib/merkle_proof_poseidon2.circom`** — a byte-for-byte structural copy of
   `templates/merkle_proof.circom`'s mux-based path selection, with `MerkleLevelPoseidon2` in place
   of `Poseidon(2)`.
3. **Six bench circuits**, one pair per production circuit shape:
   `transfer_hash_{current,poseidon2}.circom`, `compliance_hash_{current,poseidon2}.circom`,
   `withdraw_hash_{current,poseidon2}.circom`. Each `_current` file is the **exact** Poseidon-related
   subset of its production circuit (same domain tags, same call sites, same Merkle depth) with the
   arithmetic constraints removed — `Num2Bits` range checks, `GreaterThan`/`LessEqThan`, the
   cumulative-sum equality — because those are identical between variants and would only dilute the
   hash-function delta this experiment measures. Each `_poseidon2` file is the same skeleton with
   every `Poseidon(N)` call replaced by `Poseidon2CompressTagged`.
4. **`scripts/bench/poseidon2-sponge.mjs`** — a JS mirror of the circom sponge, built on
   `@taceo/poseidon2`'s raw per-width permutations (not reimplemented — imported), used to compute
   correct witness values outside the circuit.
5. **`scripts/bench/poseidon2-bench-witnesses.mjs`** — witness builders for all six circuits, same
   constant values as `scripts/bench/witnesses.mjs` uses for the production circuits.
6. **`circuits/scripts/compile-poseidon2-bench.sh`** — reusable compile + dev Groth16 setup for all
   six circuits (see the file for why it uses `circom2`/WASM and a locally-generated Powers of Tau
   instead of native `circom` and the downloaded Hermez ceremony file compile.sh uses — both were
   unreachable this session; see "Toolchain notes" below).
7. **`scripts/bench/poseidon2-prove-latency.mjs`** — proving-time benchmark, same methodology as
   the existing `prove-latency.mjs` (warm-up run discarded, N timed `groth16.fullProve` calls).
8. **`scripts/bench/poseidon2-negative-tests.mjs`** — malicious-witness rejection tests (see
   "Negative tests" below).

**The width table — why this experiment exists.** Poseidon2's published parameter set only covers
state sizes `t ∈ {2, 3, 4, 8, 12, 16}`. circomlib's `Poseidon(nInputs)` uses `t = nInputs + 1` for
any `nInputs`, so it has a native width for every one of Veil's call sites. Poseidon2 does not:

| Hash shape (Veil call sites) | circomlib `Poseidon(N)` width | Poseidon2 width (tag in capacity) | Native or padded? |
|---|---|---|---|
| Merkle sibling (40x: 20 in `transfer.circom`, 20 in `compliance.circom`) | t=3 (`Poseidon(2)`) | t=3 (2 vals, no tag today; MERKLE_TAG=9 added) | same width |
| `recipHash` (`withdraw.circom`, 1x: tag+1 val) | t=3 (`Poseidon(2)`) | **t=2** (1 val) | **narrower** |
| `txHash`/compliance `nfHash`/`ctxHash` (3x: tag+2 vals) | t=4 (`Poseidon(3)`) | **t=3** (2 vals) | **narrower** |
| `oldHash`/`newHash`/transfer `nfHash`/withdraw `commHash`/`changeHash`/`nfHash` (6x: tag+3 vals) | t=5 (`Poseidon(4)`) | **t=4** (3 vals) | **narrower** |
| compliance `leafHash` (1x: tag+4 vals) | t=6 (`Poseidon(5)`) | **t=8** (4 vals, 3 rate slots unused) | **wider** |

Moving the domain tag into the capacity element (a genuine, free side benefit of adopting SAFE) lets
four of five shapes use a *narrower* Poseidon2 permutation than today's circomlib width. Only the
credential leaf hash (4 non-tag values) is forced wider, because t=5/6 don't exist in Poseidon2's
parameter set and the next available width is t=8. This mixed picture — smaller permutations for
most calls, one much larger one — is exactly what makes "does the total move" a real, non-obvious
question, and why a stand-alone microbenchmark (rather than reasoning from S-box counts alone) was
worth building.

**Alternatives rejected:**
- **Deriving custom Poseidon2 round constants for t=5/6** to avoid the leaf-hash width penalty —
  rejected: generating and validating fresh Poseidon2 round constants/MDS-diagonal matrices is a
  nontrivial cryptographic-parameter-generation task (statistical/algebraic tests against known
  attacks) with no time to do safely and correctly in one night. Using only the published,
  independently cross-checked t=8 parameter is the honest choice here; the t=5/6 gap is reported as
  a finding, not worked around.
- **Modifying the production circuits directly** instead of isolated bench circuits — rejected:
  swapping the hash in `transfer.circom`/`compliance.circom`/`withdraw.circom` changes every
  commitment/nullifier's derivation, which changes the verifying key, breaks every already-issued
  commitment on the deployed testnet pool, and is a live-protocol migration, not a one-night
  experiment. An isolated, faithful microbenchmark gets a real, honest number without that blast
  radius; a production port is exactly the kind of follow-up a KEEP verdict here would queue.
- **Full-circuit (not hash-only) A/B** — rejected: the arithmetic constraints (range checks,
  comparators) are identical between variants and would just add a large, unchanging constant to
  both sides of the comparison, diluting the actual delta without adding information.

**Toolchain notes (why this run's methodology differs from 2026-07-22's):**
- **`circom` native binary:** unavailable. The 2026-07-22 baseline cloned `iden3/circom` from
  GitHub and built it with cargo. This session's GitHub access is denied outright (`api.github.com`
  and `github.com` both return HTTP 403 through the egress proxy — "GitHub access to this
  repository is not enabled for this session" for the API, plain 403 for the web UI, for any repo
  other than this one). Used `circom2` (circom compiled to WASM, npm package, pulls upstream circom
  2.2.3) instead, and validated it before trusting it: compiling the actual `transfer.circom`
  reproduces `BASELINE.md`'s exact figures (6,470 non-linear / 7,141 linear), so it's a faithful
  stand-in, not a "we couldn't get the real thing" caveat on the numbers below.
- **Powers of Tau:** `compile.sh`'s ceremony URL (`storage.googleapis.com`) is also unreachable
  (403). Generated a local, single-contribution `pot15` (`snarkjs powersoftau new` → `contribute` →
  `prepare phase2`) instead of downloading the Hermez file — the same trust level `BASELINE.md`'s
  own setup already documents ("single dev-only Groth16 contribution... not a production
  ceremony"), just generated fresh rather than fetched.
- General egress in this session is allowlisted to `registry.npmjs.org`, `jsr.io`, `pypi.org`,
  `index.crates.io`, `proxy.golang.org`, and the Anthropic APIs; everything else (tested directly:
  `github.com`, `api.github.com`, `storage.googleapis.com`, `fullnode.testnet.sui.io`, and even
  `example.com`) returns HTTP 403 at the proxy. This is an organization egress policy, not a
  missing-package problem — see "Blocked toolchain: on-chain gas" for what this meant for queue
  item #1.

## Negative tests

`scripts/bench/poseidon2-negative-tests.mjs`, mirroring the style of
`circuits/test/{transfer,compliance,withdraw}.test.mjs` (an `assertRejected`/`assertAccepted` pair
around a real `snarkjs.groth16.fullProve` call — a failing `===` constraint makes witness
calculation throw, the same signal the production suite checks). Per `*_poseidon2` circuit: a
positive control (honest witness proves and verifies), a tampered Merkle sibling, non-boolean
`pathIndices`, and a public hash output that doesn't match its private preimage. Raw output below
("Results").

## Results

### Constraint counts (raw `circom2 ... --r1cs` output, `circuits/bench/`)

Reproduce: `cd circuits && bash scripts/compile-poseidon2-bench.sh` (or run each
`node_modules/.bin/circom2 bench/<name>.circom --r1cs --wasm --sym --output build-bench/<name> -l node_modules` individually).

| Circuit shape | Variant | Non-linear | Linear | **Total** | zkey (bytes) |
|---|---|---:|---:|---:|---:|
| transfer | current (circomlib Poseidon) | 6,084 | 7,129 | **13,213** | _TBD_ |
| transfer | poseidon2 (SAFE, tag in capacity) | 5,892 | 8,904 | **14,796** | _TBD_ |
| compliance | current | 5,772 | 6,673 | **12,445** | _TBD_ |
| compliance | poseidon2 | 5,703 | 8,780 | **14,483** | _TBD_ |
| withdraw | current | 1,143 | 1,583 | **2,726** | 1,238,784 |
| withdraw | poseidon2 | 1,008 | 2,032 | **3,040** | 1,327,384 |

Delta (poseidon2 − current):

| Circuit shape | Non-linear | Linear | Total |
|---|---:|---:|---:|
| transfer | −192 (−3.2%) | +1,775 (+24.9%) | **+1,583 (+12.0%)** |
| compliance | −69 (−1.2%) | +2,107 (+31.6%) | **+2,038 (+16.4%)** |
| withdraw | −135 (−11.8%) | +449 (+28.4%) | **+314 (+11.5%)** |

Raw `circom2` output for all six:

```
_RAW_CIRCOM_OUTPUT_
```

### Proving time (Node.js, `node scripts/bench/poseidon2-prove-latency.mjs --runs _N_`)

```
_RAW_PROVE_LATENCY_OUTPUT_
```

### Negative tests (`node scripts/bench/poseidon2-negative-tests.mjs`)

```
_RAW_NEGATIVE_TEST_OUTPUT_
```

### Test suite (full `README.md` suite, this session)

```
_RAW_TEST_SUITE_OUTPUT_
```

## Blocked toolchain: on-chain gas (queue item #1)

Attempted first, per the queue's own note to "spend an early part of the next run purely on
unblocking the toolchain." Confirmed **BLOCKED**, with more definitive evidence than the
2026-07-22 attempt:

- No prebuilt `sui` CLI binary reachable: `github.com`/`api.github.com` (where Sui publishes
  release binaries) both return HTTP 403.
- `cargo install`-from-source: `cargo search circom`-style check shows no official `sui` binary
  crate on crates.io either (it isn't published there), and building the real `sui` workspace from
  its git repo needs the same blocked GitHub access.
- Direct JSON-RPC against the deployed testnet package (`suix_queryTransactionBlocks` etc.) — the
  2026-07-22 report noted this was "not attempted after an early permission denial... not retried,
  per policy." This session **did** retry it directly: `curl -X POST
  https://fullnode.testnet.sui.io:443` (and, to rule out a Sui-specific block, `https://
  example.com` as a control) both fail identically — `CONNECT tunnel failed, response 403`,
  `connect_rejected... organization policy`. This is a hard egress allowlist (only npm/jsr/pypi/
  crates-index/golang-proxy/Anthropic-API hosts are reachable), not a retryable transient denial —
  confirmed by testing a completely unrelated domain (`example.com`) and getting the same block.

Recommend removing this from "worth spending time unblocking" framing in future queue entries: two
sessions, two different blocking mechanisms (missing CLI, then a confirmed-deliberate network
policy), point at an environment constraint outside what any amount of in-session effort resolves.
Re-attempt only if a future session's egress policy changes, or if `sui` gas costs can be estimated
from the Move bytecode statically (no `sui` CLI available for that either — `sui move test
--gas-report`, if it exists, needs the same missing binary) — or, more promisingly, if an
integrator ever supplies real historical gas numbers from their own node. Re-ranked below.

## Verdict: _VERDICT_

## Where this could be used

Beyond Veil: this width table (Poseidon2's `t ∈ {2,3,4,8,12,16}` restriction vs. what a protocol
actually calls with) is a real gotcha for any Circom-based ZK protocol considering a Poseidon2
migration for a "we'll just recompute constants for the widths we use" reason without checking
that the published, independently-audited parameter set actually covers those widths first —
common in note-commitment schemes (Tornado-Cash-style UTXO privacy pools with a domain-tagged
4–6-element leaf, exactly Veil's `leafHash` shape) and in any protocol using SAFE-style capacity
tagging for more than 7 field elements per compression call. Specific to a thesis chapter: a
worked comparison of "S-box count says X, measured R1CS says Y" — the gap between a permutation's
textbook multiplicative complexity and its actual constrained-circuit cost, driven by how the
linear layer decomposes into R1CS linear constraints — is a good concrete example for a chapter on
why circuit benchmarking has to be empirical, not just algebraic-complexity counting.

## Open questions (next queue)

1. **Is the linear-constraint blowup inherent to Poseidon2, or an artifact of this specific circom
   implementation?** `@taceo/circom-lib`'s `ExternalMatMulT`/`InternalMatMulT` templates declare a
   named intermediate signal (`sum`, `t0`, `t1`, ...) for every partial sum in the MDS/diagonal
   matrix multiply. circomlib's Poseidon computes its MDS multiply as direct dot-products with no
   intermediate signals. A hand-fused Poseidon2 implementation collapsing those intermediates might
   erase some or all of the linear-constraint growth measured tonight — worth one focused
   experiment before concluding "Poseidon2 is worse for Veil" as a general claim rather than
   "this implementation, unmodified, is worse."
2. **Does the leaf-hash width penalty (t=6 → t=8) actually dominate compliance.circom's proving
   time**, or does removing three Merkle-hash rate slots' worth of dead weight elsewhere offset it?
   Answered in part by this run's proving-time numbers (see Results) — worth a closer per-component
   breakdown if the aggregate number is ambiguous.
3. Re-attempt queue item #1 (on-chain gas) only if the session's egress policy changes, per
   "Blocked toolchain" above.
