# 2026-08-03 — Poseidon2 vs. current Poseidon: constraint attribution (queue item #2)

## Hypothesis

Swapping Veil's circomlib `Poseidon` instances for a Poseidon2-style permutation reduces the
R1CS non-linear constraint count of `transfer.circom` (6,470) and `compliance.circom` (6,057) —
and therefore Groth16 proving time — for the same security level. This is falsifiable by
precisely attributing every non-linear constraint in the three circuits to a specific gadget
(each Poseidon instance, each range check, each comparator), and inspecting how a Poseidon2-style
linear-layer change would move each of those numbers.

Before tonight, the 2026-07-22 baseline said only "four Poseidon instances dominate the
non-linear constraints." Nobody had actually measured the per-instance breakdown or checked
whether Poseidon2's specific design change (a cheaper linear/MDS layer) has any R1CS analogue at
all.

## Threat / privacy model

No protocol code changed tonight — no circuit, Move module, or frontend file in the shipped
paths was touched. So there is no new adversary this defends against and no new attack surface.
The relevant framing, as with the 2026-07-22 baseline, is narrower: **who relies on this number
being honest, and what happens if it's wrong.**

- **This research loop, on future nights.** The next Poseidon2-adjacent decision (whether to
  actually port the hash function, whether to look at PLONK/Halo2 instead) is a direct
  consequence of tonight's numbers. A wrong attribution here sends a future night down a
  multi-day circuit-port effort for zero payoff.
- **A protocol integrator or thesis reader** citing "Poseidon2 would cut Veil's prover time" needs
  the actual mechanism-level reason it wouldn't (for Groth16/R1CS specifically), not a vague
  "hashing is faster" claim.
- **A future auditor of this decision** should be able to re-run one script
  (`scripts/bench/poseidon-constraint-attribution.sh`) and get the identical reconciliation.

What this does **not** establish: whether Poseidon2 would help in a different proof system
(it plausibly would — see "Where this could be used"), whether a reduced-round Poseidon/Poseidon2
variant with a re-derived security margin could still shrink real constraint count (a live,
unverified cryptanalysis question, explicitly not attempted tonight — see Open questions), or
anything about gas cost (queue item #1, attempted separately tonight, see below).

Assumptions unchanged from the existing threat model: Groth16 soundness under the BN254
discrete-log assumption, single-dev-contributor trusted setup (`docs/threat-model.md` RR2), all
circomlib gadget implementations trusted as-is. Maps to no STRIDE entry directly (no protocol
behavior changed), but the merkle-path constraint share measured below (76–81% of the two
dominant circuits) is a real, load-bearing number for any future work on **RR5 — deposit-commitment
linkability** (`docs/threat-model.md`): it's the first real cost-per-Merkle-level figure for the
anonymity-set-size/proving-time trade-off that RR5's mitigation section gestures at.

## Approach

**What I built:**

- `scripts/bench/poseidon-constraint-attribution.sh` — compiles eleven isolated single-gadget
  probe circuits (one `component main` each: `Poseidon(2..5)`, `Num2Bits(64)`, `Num2Bits(8)`,
  `GreaterThan(64)`, `LessEqThan(64)`, `GreaterEqThan(64)`, `GreaterEqThan(8)`, `MultiMux1(2)`,
  plus the repo's own `MerkleProof(20)` template as a twelfth, composite probe) with real `circom
  --r1cs` compiles, reads each one's non-linear constraint count from circom's own stdout, then
  **reconciles** the sum of the relevant gadget instances against a *fresh* full-circuit compile
  of `transfer.circom` / `compliance.circom` / `withdraw.circom`. The reconciliation is the actual
  test: if the parts don't sum to the whole, the attribution model is wrong, and the script says
  so instead of printing a plausible-looking number.
- No files under `circuits/` were modified. All probe circuits live in a `mktemp -d` scratch
  directory, removed on exit.

**What I rejected:**

- *Actually porting circomlib's `Poseidon` template to a Poseidon2 permutation and measuring the
  delta directly*, which is what the queue item's primary framing asked for. Rejected for
  tonight because doing this correctly requires trustworthy Poseidon2 round constants and MDS/
  internal-matrix parameters for BN254 at the specific `t` values Veil uses (3, 4, 5, 6). I could
  not verify a canonical source for those parameters in this sandbox — `eprint.iacr.org` and
  `arxiv.org` are both blocked by the same egress policy that blocks the Sui RPC hosts (see
  below; confirmed with real `curl` attempts, not assumed), and I was not willing to hand-derive
  or guess round constants for a hash function and ship a circuit-change PR on top of them. A
  circuit change built on unverifiable constants is a worse outcome than a rigorous no-go
  analysis. This is recorded as an open question, not silently dropped.
- *Reading published Poseidon2 round-count tables from memory and presenting them as fact.* I know
  the shape of the Poseidon2 paper's claims from training, but the one-rule-that-matters is "every
  number comes from a command actually run" — so the argument below is built entirely from what
  circomlib's actual, in-repo constraint-generation code does, not from an unfetched paper.
- *A hypothetical reduced-round Poseidon2 variant* (Poseidon2 claims improved cryptanalysis
  resistance that could in principle justify fewer partial rounds for the same security level).
  This is the one lever that actually could move R1CS constraint count — deliberately not
  attempted tonight; it is a security-parameter re-derivation, not a "swap versions" change, and
  needs an independent audit, not a nightly research loop run. Queued.

## Results

### Per-gadget non-linear constraint cost (measured, isolated single-gadget compiles)

| Gadget | `circom` template | Non-linear | Linear |
|---|---|---|---|
| `Poseidon(2)` (t=3 permutation) | `poseidon.circom` | 243 | 274 |
| `Poseidon(3)` (t=4) | `poseidon.circom` | 264 | 341 |
| `Poseidon(4)` (t=5) | `poseidon.circom` | 300 | 436 |
| `Poseidon(5)` (t=6) | `poseidon.circom` | 324 | 511 |
| `Num2Bits(64)` | `bitify.circom` | 64 | 1 |
| `Num2Bits(8)` | `bitify.circom` | 8 | 1 |
| `GreaterThan(64)` | `comparators.circom` | 65 | 3 |
| `LessEqThan(64)` | `comparators.circom` | 65 | 4 |
| `GreaterEqThan(64)` | `comparators.circom` | 65 | 4 |
| `GreaterEqThan(8)` | `comparators.circom` | 9 | 4 |
| `MultiMux1(2)` | `mux1.circom` | 2 | 0 |
| `MerkleProof(20)` (full template) | `templates/merkle_proof.circom` | **4,920** | 5,480 |

`MerkleProof(20)` = 20×`Poseidon(2)` (4,860) + 20×`MultiMux1(2)` selection (40) + 20×boolean
`pathIndices[i]*(1-pathIndices[i])===0` check (20) = 4,920 — itself an exact reconciliation.

### Reconciliation against fresh full-circuit compiles

| Circuit | Predicted (Σ gadget instances) | Actual (`circom --r1cs`, fresh compile) | Match |
|---|---|---|---|
| `transfer.circom` | 6,470 | 6,470 | **exact** |
| `compliance.circom` | 6,057 | 6,057 | **exact** |
| `withdraw.circom` | 1,465 | 1,465 | **exact** |

All three circuits' published baseline totals (2026-07-22, unchanged today) reconcile exactly,
constraint-for-constraint, from eleven independently-compiled single-gadget probes plus the shared
`MerkleProof(20)` template. Nothing was tuned to hit these numbers — the script computes the
predicted sum first and compares.

### Poseidon share of each circuit

| Circuit | Pure-Poseidon-permutation non-linear constraints | Total non-linear | Share |
|---|---|---|---|
| `transfer.circom` | 6,024 (20×`Poseidon(2)` + 3×`Poseidon(4)` + `Poseidon(3)`) | 6,470 | 93.1% |
| `compliance.circom` | 5,712 (20×`Poseidon(2)` + `Poseidon(5)` + 2×`Poseidon(3)`) | 6,057 | 94.3% |
| `withdraw.circom` | 1,143 (3×`Poseidon(4)` + `Poseidon(2)`) | 1,465 | 78.0% |

And, the number this experiment actually surfaces that the baseline didn't have:

| | Non-linear constraints | Share of `transfer.circom` | Share of `compliance.circom` |
|---|---|---|---|
| **`MerkleProof(20)` alone** | 4,920 | **76.0%** | **81.2%** |
| — of which pure Poseidon S-boxes | 4,860 | 75.1% | 80.2% |
| — of which mux/boolean scaffolding | 60 | 0.9% | 1.0% |

**The depth-20 Merkle authentication path, not any individual commitment/nullifier hash, is the
dominant cost in both of Veil's two big circuits.** Each additional tree level costs exactly one
more `Poseidon(2)` permutation plus one `MultiMux1(2)` plus one boolean check = 245 non-linear
constraints (measured above), a real, reusable number for a future Merkle-depth-vs-anonymity-set
experiment (queue item #4).

### Raw command output

```
$ export PATH="/tmp/circom-src/target/release:/tmp/bin:$PATH"   # circom 2.2.2, built from
                                                                  # iden3/circom tag v2.2.2
$ bash scripts/bench/poseidon-constraint-attribution.sh

=== Isolated single-gadget probe compiles (circom 2.2.2) ===
  poseidon_t3 (Poseidon(2)) non-linear=243    linear=274
  poseidon_t4 (Poseidon(3)) non-linear=264    linear=341
  poseidon_t5 (Poseidon(4)) non-linear=300    linear=436
  poseidon_t6 (Poseidon(5)) non-linear=324    linear=511
  num2bits_64 (Num2Bits(64)) non-linear=64     linear=1
  num2bits_8 (Num2Bits(8)) non-linear=8      linear=1
  greaterthan_64 (GreaterThan(64)) non-linear=65     linear=3
  lesseqthan_64 (LessEqThan(64)) non-linear=65     linear=4
  greatereqthan_64 (GreaterEqThan(64)) non-linear=65     linear=4
  greatereqthan_8 (GreaterEqThan(8)) non-linear=9      linear=4
  multimux1_2 (MultiMux1(2)) non-linear=2      linear=0
  merkle20 (depth 20)  non-linear=4920   (= 20x poseidon_t3 [4860] + 20x2 mux-mul [40] + 20x boolean-check [20])

=== Reconciliation against fresh full-circuit compiles ===
--- transfer.circom ---
  merkle20 + oldHash(t5) + newHash(t5) + nfHash(t5) + txHash(t4) + 4xNum2Bits64 + GreaterThan64 + LessEqThan64
  predicted non-linear total: 6470
  actual non-linear total (transfer.circom, fresh compile): 6470
  MATCH

--- compliance.circom ---
  merkle20 + leafHash(t6) + nfHash(t4) + ctxHash(t4) + GreaterEqThan64 + GreaterEqThan8 + 3xboolean-mul + 2xNum2Bits64 + 2xNum2Bits8 + Num2Bits64(issuer)
  predicted non-linear total: 6057
  actual non-linear total (compliance.circom, fresh compile): 6057
  MATCH

--- withdraw.circom (no Merkle proof) ---
  commHash(t5) + changeHash(t5) + nfHash(t5) + recipHash(t3) + 3xNum2Bits64 + GreaterThan64 + LessEqThan64
  predicted non-linear total: 1465
  actual non-linear total (withdraw.circom, fresh compile): 1465
  MATCH

=== Poseidon S-box share of each circuit's non-linear constraints ===
(pure Poseidon-permutation cost only — excludes the Merkle path's non-Poseidon
 scaffolding: 20x MultiMux1 selection [40] + 20x pathIndices boolean check [20])
  transfer.circom:    6024 / 6470  (93.1%) pure-Poseidon non-linear constraints
  compliance.circom:  5712 / 6057  (94.3%) pure-Poseidon non-linear constraints
  withdraw.circom:    1143 / 1465  (78.0%) pure-Poseidon non-linear constraints

  merkle20 total:      4920 non-linear constraints, of which:
    - pure Poseidon (20x t=3 permutations): 4860
    - mux + boolean scaffolding (not Poseidon, unaffected by any hash swap): 60
  merkle20 is 76.0% of transfer.circom and 81.2% of compliance.circom's non-linear constraints —
  the single largest lever in both circuits is Merkle depth, not any individual hash instance.
```

### Why Poseidon2 doesn't move this number (architecture-level analysis, not a benchmark)

This is grounded entirely in reading `circuits/node_modules/circomlib/circuits/poseidon.circom`
(the actual code the constraint counts above come from), not in an unfetched paper:

- Every Poseidon non-linear constraint comes from `Sigma()` (the x⁵ S-box): `in2 <== in*in`,
  `in4 <== in2*in2`, `out <== in4*in` — **exactly 3 non-linear constraints per S-box
  application**, independent of `t`.
- Total S-box applications per permutation = `nRoundsF * t + nRoundsP(t)` (8 full rounds × t
  elements, plus `nRoundsP` partial rounds × 1 element). This fully explains the measured 243 /
  264 / 300 / 324 numbers (3× that S-box count for t=3/4/5/6).
- The round's **linear layer** — `Mix`, `MixLast`, `MixS` in the same file — is implemented purely
  as `lc += M[j][i]*in[j]; out[i] <== lc;`: a linear combination of existing signals by *known
  constants*. There is not one `signal * signal` multiplication anywhere in those three templates.
  In R1CS, a linear combination is free — it costs nothing beyond whatever non-linear constraint
  consumes it next; the *number of terms* or the *specific matrix* used doesn't add constraints.
- **Poseidon2's core design change, per its stated goal (a faster/cheaper linear layer — a
  cheaper external-round matrix and a restructured internal-round matrix, while targeting the same
  round schedule for equivalent security), is a change to exactly the part of the permutation that
  R1CS already prices at zero.** Its real speedups are for native-field execution and AIR/STARK
  trace width, where linear-layer multiplications are not free. For a circom/Groth16 circuit,
  there is no mechanism by which changing the matrix — Poseidon2's or any other — reduces
  non-linear constraint count. Only changing the S-box count (`nRoundsF`/`nRoundsP`) would, and
  that is a round-schedule / security-margin question, not a "Poseidon vs Poseidon2" one.
- I attempted to fetch the actual Poseidon2 paper to cite its round-schedule table directly rather
  than rely on memory of it; both `eprint.iacr.org` and `arxiv.org` returned the same `403 CONNECT
  tunnel failed` as the blocked Sui RPC hosts below — a real, run command, not an assumption (see
  raw output in the gas-measurement section). The argument above does not depend on that table: it
  holds for *any* alternative linear layer, which is what makes it strong enough to act on without
  the citation.

### Full test suite (per README.md — no `CLAUDE.md` exists in this checkout to defer to)

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (incl. depth-20 Merkle tree) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz | **6/6 properties × 500 cases pass** | `cd scripts && bun run src/fuzz-tests.ts` |
| Move contracts (124 tests) | **NOT RUN** | `sui` CLI unavailable — see below, same blocker as 2026-07-22 |

No test was loosened, skipped, or given new tolerance. No circuit, Move, or frontend source file
changed — this was a measurement-only night, so an all-green suite (modulo the still-unavailable
Move suite) is expected, not a claim of new correctness.

## Verdict: **REJECT** (the Poseidon2-reduces-constraints hypothesis) — attribution data folded into `BASELINE.md`

The falsifiable hypothesis — "swapping to Poseidon2 measurably reduces non-linear constraint
count for the same security level" — is **rejected** on architectural grounds specific to
R1CS/Groth16: Poseidon2's efficiency gain lives entirely in the linear layer, which circom's R1CS
compilation already treats as free. There is no plausible constraint-count win here without
independently re-deriving a reduced round schedule, which is a different and much bigger claim
this experiment does not attempt.

What tonight *does* keep: the exact per-gadget attribution (reconciled to the constraint, three
times) is new, real information that closes the queue item's "OR" alternative framing
("re-deriving the exact non-linear-constraint contribution per Poseidon instance"). `BASELINE.md`
is updated with the attribution tables above — this doesn't change any previously-published number,
it explains them. The Merkle-path finding (76–81% of the two dominant circuits) is now the
highest-leverage number for queue item #4 (Merkle accumulator at scale), re-ranked below.

## Where this could be used

- **Any Circom/Groth16 circuit dominated by a fixed-depth Merkle-membership proof** (nullifier
  sets, credential trees, UTXO accumulators) — the finding generalizes directly: for R1CS-based
  SNARKs, a hash-function "v2" swap that only changes the linear/MDS layer is very unlikely to be
  worth the engineering and audit risk; the actual lever is tree depth vs. anonymity-set size, or
  the S-box/round count itself (a security-margin decision, treated separately from a version
  bump).
- **A thesis chapter on Groth16 circuit optimization methodology** — the isolated single-gadget
  probe + reconciliation technique in `scripts/bench/poseidon-constraint-attribution.sh` is a
  reusable pattern for "where do my constraints actually go" on any circom circuit, not just
  Poseidon-heavy ones.
- **A future proof-system migration decision** (queue item #9, PLONK/Halo2/Nova) — this is exactly
  where Poseidon2 (or any linear-layer-optimized hash) *would* pay off, since AIR/STARK-style
  arithmetizations do charge for linear-layer width. If Veil ever pursues that migration, Poseidon2
  becomes a real candidate again — this REJECT is scoped to "under Groth16/R1CS today," not
  "Poseidon2 is bad."
- **Confidential payroll or compliance-gated DeFi on Sui** (the same use case named in the
  2026-07-22 baseline) — the Merkle-path-dominance finding directly informs the anonymity-set
  design decision: a t-of-n auditor board's credential tree pays ~245 non-linear constraints per
  additional depth level, a concrete number product/protocol design can now budget against.

## Open questions (next queue)

1. **Merkle depth vs. anonymity-set size (queue item #4)** — now has a real per-level cost (245
   non-linear constraints/level, ~4% of `transfer.circom`'s total per level) to trade off against
   accumulator size (2^depth). Re-ranked to the top of the queue below — this experiment is the
   direct prerequisite it was missing.
2. **Reduced-round Poseidon/Poseidon2 with an independently re-derived security margin** — the one
   lever that actually could cut constraint count, deliberately not attempted tonight (see
   Approach). Needs either a verified round-constant source (currently unreachable — `eprint.iacr.
   org`/`arxiv.org` both blocked in this sandbox) or an independent cryptographic audit; too risky
   for a nightly loop to attempt alone.
3. **On-chain gas per entry point (queue item #1)** — attempted again tonight with two genuinely
   new approaches (see below); still blocked, for new, more specific reasons than 2026-07-22.
4. Does the mux/boolean scaffolding in `MerkleProof` (60 non-linear constraints, 1.2% of the
   template) have any cheaper formulation (e.g. collapsing the boolean check into the mux itself)?
   Trivial in isolation, not worth a dedicated night, but cheap to fold into a future Merkle-depth
   experiment.

---

## Appendix: on-chain gas per entry point (queue item #1) — attempted first, BLOCKED again

Per this run's instructions, item #1 was tried first, time-boxed, with genuinely different
approaches from the two prior attempts (2026-07-22: no `sui` CLI reachable, and a JSON-RPC read
denied by the sandbox's tool-approval layer, not retried).

**Attempt A — direct JSON-RPC to a public Sui fullnode.** Tried three different hosts this time
(not a repeat of the single host from last time), to distinguish "this one host is blocked" from
"the whole RPC category is blocked":

```
$ curl -sS -X POST https://fullnode.testnet.sui.io:443 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"sui_getLatestCheckpointSequenceNumber","params":[]}'
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS -o /dev/null -w "%{http_code}\n" https://sui-testnet-rpc.publicnode.com
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS -o /dev/null -w "%{http_code}\n" https://rpc-testnet.suiscan.xyz
curl: (56) CONNECT tunnel failed, response 403
```

All three fail identically at the network layer (`CONNECT tunnel failed, response 403`), which
per `/root/.ccr/README.md` is an organization egress-policy denial, not a per-tool approval
prompt: *"403 / 407 from the proxy: The destination host is not allowed by your organization's
egress policy for this session. Do not retry or route around it — report the blocked host."* This
is a materially different, more conclusive finding than 2026-07-22's "denied by the sandbox's
tool-approval layer mid-session, not retried per policy" — this time it's a confirmed, categorical
network policy block on blockchain-RPC-class hosts, tested (not assumed), and I stopped after
three hosts per that same README's explicit instruction not to keep retrying a policy denial.

**Attempt B — build the `sui` CLI from source.** This is the genuinely new thing tried tonight.
Two things changed since 2026-07-22 that made this worth another shot:

1. Plain `git clone https://github.com/MystenLabs/sui.git` **works** in this sandbox — this
   session's global gitconfig rewrites any `https://github.com/` URL to a local git-specific proxy
   (`url."http://local_proxy@127.0.0.1:.../git/".insteadOf = https://github.com/`), which is a
   different code path from the generic `HTTPS_PROXY` that blocks `curl` to `github.com` (403,
   confirmed). This wasn't verified last time — worth checking explicitly rather than assuming
   "no GitHub access" from the earlier `403` on `github.com/.../releases`.
2. Given that, the from-source build was retried, and hit a **new, specific, fixable failure**:
   `cargo`'s own git fetcher (libgit2-based) does not honor the gitconfig `insteadOf` rewrite the
   plain `git` CLI benefits from, so the very first pinned git dependency
   (`zhiburt/tabled` at a specific commit) failed:
   ```
   Caused by:
     failed to receive HTTP 200 response: got 502; class=Net (12)
   ```
   Setting `net.git-fetch-with-cli = true` in `.cargo/config.toml` (forces cargo to shell out to
   the system `git`, which does have the rewrite) fixed dependency resolution — a real, specific,
   different fix from anything tried in the 2026-07-22 session. The build then genuinely started
   compiling (not just resolving): by the time this report was written it had compiled well over
   1,600 crates from a 20,952-line `Cargo.lock`, past the Move execution/adapter layer
   (`sui-adapter-{v0,v1,latest}`) and into Sui's own transaction-processing crates
   (`sui-transaction-checks`, `sui-transaction-builder`), reaching **4.8 GB** in `target/` after
   ~17 minutes of real compile time, on 4 vCPUs / 15 GB RAM / a 30 GB session disk budget. It had
   not finished linking the `sui` binary by the time this experiment's time-box closed (it was
   left running in the background; it may finish after this report is written, in which case a
   future night can pick up `sui move test` and a local-network gas measurement directly rather
   than repeating this build).

   ```
   $ cd /tmp/sui-test && cat .cargo/config.toml
   [net]
   git-fetch-with-cli = true
   $ cargo build --release --bin sui > build.log 2>&1 &
   $ tail -6 build.log   # ~17 minutes into the build
      Compiling postgres-types v0.2.14
      Compiling jsonrpsee-http-client v0.24.9
      Compiling sui-transaction-checks v0.1.0 (/tmp/sui-test/crates/sui-transaction-checks)
      Compiling sui-transaction-builder v0.0.0 (/tmp/sui-test/crates/sui-transaction-builder)
      Compiling cexpr v0.6.0
      Compiling tonic-web v0.14.6
   $ du -sh target
   4.8G    target
   ```

   Even a completed `sui` CLI binary would still need Attempt A's network path (a fullnode
   JSON-RPC endpoint) to read real historical gas from the deployed testnet package — which is
   confirmed blocked. The one thing a completed local build *would* unlock is `sui move test`
   (Move's test runner is fully local, no network) and a **local** `sui start`/`sui client
   publish`+`sui client call` gas measurement against the actual compiled bytecode — not the real
   deployed testnet history, but real, locally-measured gas against the identical package, which
   is a legitimate (if slightly different) answer to queue item #1. That's specifically why this
   is PARKed rather than re-marked fully BLOCKED-and-abandoned.

**Verdict for this sub-item: PARK.** Re-queued at the top with the concrete next step: resume
the from-source build (the `net.git-fetch-with-cli = true` fix is the one part of this that's
worth preserving verbatim for the next attempt) across a session with a multi-hour budget and more
disk headroom, specifically to unlock `sui move test` (124 tests, currently un-run for the second
session running) and a local-network gas measurement — not to keep chasing the now-confirmed-dead
JSON-RPC route.
