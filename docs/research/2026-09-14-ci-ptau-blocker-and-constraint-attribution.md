# 2026-09-14 — CI's Powers-of-Tau blocker (why the loop stalled) + Poseidon/Merkle constraint attribution

## Hypothesis

Two, in order of how the night actually went:

1. **The research loop's real bottleneck tonight is not "which experiment to run next," it's that nothing reaches `main`.** Specifically: the `circuit-tests` CI job's Powers-of-Tau download (`storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau`) returns `403` to GitHub Actions runners, failing that job on every PR unconditionally, regardless of the PR's actual content — and this is fixable by generating the ptau locally instead of downloading it, with no other change required.
2. (Original queue item #2, still worth answering on its own terms even though it's been asked before.) In `transfer.circom` and `compliance.circom`, the depth-20 Poseidon Merkle-membership path — not the four fixed-arity identity/nullifier/credential hashes — accounts for more than half of each circuit's non-linear R1CS constraints.

This report leads with (1) because it turned out to matter far more than (2), and touches an unrelated but critical finding along the way (see Threat/privacy model).

## How I got here

Queue order says start at `EXPERIMENTS.md` item #1 (on-chain gas — still genuinely network-blocked
tonight, re-confirmed: `fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`, and three public RPC
mirrors all return `403` at this session's egress proxy, `connect_rejected` / "organization policy").
Item #2 (Poseidon2 vs Poseidon) was next, and I built a from-scratch constraint-attribution
methodology for it (see Results, part 2) — cross-validated to an exact match against `BASELINE.md`'s
numbers.

Before writing this up, I went to open a PR and ran `git branch -a` / listed pull requests on GitHub
first (a habit, not something the prompt told me to do). That's when this stopped being a normal
night: **there are 30 open, unmerged `research:` PRs on this repo, #32 through #61, dated
2026-08-14 through yesterday (2026-09-13).** `main`'s `LEDGER.md` still has exactly one row — the
2026-07-22 baseline. Every night since has produced a real PR that never landed, so every subsequent
night re-read the same stale `main` and, unsurprisingly, re-ran overlapping experiments: at least
eight of those 30 PRs are titled some variant of "Poseidon2 vs Poseidon" or "Poseidon constraint
attribution/decomposition/breakdown" — including, apparently, mine, before I knew any of this.

I read PR #60 (2026-09-12, "fix CI, adopt circom --O2, consolidate 52-day PR backlog") and PR #61
(2026-09-13, "Poseidon2 vs Poseidon constraint-count bench (REJECT)") in full. #60 had already
diagnosed the CI/merge problem and proposed a fix; #61 had already settled the Poseidon2 question
with a well-measured REJECT. Neither merged. #60's own CI run still shows the `circuit-tests` job
failing — on the exact `curl` to `storage.googleapis.com` that #60's description says it fixed via a
`setup-bun` pin (a *different*, unrelated CI job's problem — #60 fixed the `oven-sh/setup-bun`
pin for `script-tests`/`frontend-tests`, but never touched the ptau download in `circuit-tests`,
which was and is the actual reason the flagship job goes red). That gap is what tonight's PR closes.

## Threat / privacy model

Two separate things here, deliberately not conflated:

**The CI/ptau fix (this report's main deliverable) changes no cryptography and no trust boundary.**
Generating the Powers of Tau locally (`snarkjs powersoftau new/contribute/prepare phase2`, one
CI-runner-local contribution) instead of downloading Hermez's public `pot15` is not a security
downgrade: both are single/few-contributor, dev-only setups, and `docs/threat-model.md` RR2 already
states neither is production-safe — only `ceremony.sh` run with independent contributors is. A CI
job's toxic waste is discarded the moment the runner exits either way. No STRIDE entry moves. What
*does* change: whether future PRs — including ones with real cryptographic changes — can ever reach
`main` at all, which is a prerequisite for every other threat-model entry ever getting fixed in
practice, not just written up.

**Unrelated finding, surfaced while reading PR #60, independently re-verified against current `main`
tonight (not taken on the prior PR's word):** `zk_withdraw`
(`contracts/sources/pool.move:571-632`) extracts `recipientHash` (bytes `[96..128)` of
`public_inputs_bytes`) but never uses it. The function has this comment directly above the gap:

```
// The circuit proves recipientHash = Poseidon(8, recipient), binding the withdrawal
// to a specific address. We enforce this by sending tokens ONLY to the `recipient`
// parameter — the caller must provide the address that matches their proof.
// Front-running is prevented: changing recipient invalidates the Groth16 proof.
// bytes 96-128 (recipientHash) are verified by the proof itself.
```

This is wrong, and I confirmed it by reading the function body directly (not just the comment):
`commitment_bytes`, `withdraw_amount`, `nullifier`, and `new_commitment` are each extracted from
`public_inputs_bytes` and used; `recipientHash` (bytes 96–128) is **never extracted at all**. The
Groth16 proof does correctly constrain `recipientHash == Poseidon(8, recipient)` *inside the
circuit's own witness* — but the circuit has no way to know what `recipient: address` value the
**on-chain caller** will later pass to `zk_withdraw`. Nothing ties the two together. A relayer, or
anyone who observes a pending `(proof_bytes, public_inputs_bytes)` pair in the mempool, can resubmit
the identical proof with a different `recipient` argument and redirect the payout — the proof still
verifies, because proof validity only depends on `public_inputs_bytes`, not on the separate
`recipient` parameter.

- **Adversary:** any party who can see a pending withdrawal transaction before it lands (a relayer,
  a validator, anyone watching the mempool) — no special privilege needed.
- **What they get:** the full `withdrawAmount` of someone else's withdrawal, redirected to an address
  of their choosing. The original sender's nullifier is still marked spent, so they cannot retry.
- **What this does NOT affect:** deposits, transfers, or compliance proofs — the gap is specific to
  `zk_withdraw`'s recipient binding. `README.md`'s own security posture section already says this
  code is unaudited and testnet-only with a valueless faucet token, so tonight's finding does not
  change the "don't put real money in it" bottom line — it sharpens why that line is there.
- **First found:** 2026-09-11 (unmerged PR #59). **Documented:** 2026-09-12, `docs/threat-model.md`
  RR10/Critical, in unmerged PR #60. **Still unfixed on `main` as of this run.** I did not attempt a
  fix tonight — the correct fix likely means either an on-chain Poseidon check (Move has no native
  BN254 Poseidon primitive to build that cheaply) or changing the circuit's public-input layout to
  expose `recipient` directly instead of a hash of it (a breaking circuit change: new VK, new trusted
  setup, proof-generation code updated in lockstep) — too large and too security-sensitive to rush
  through in the same PR as a CI fix, and it deserves dedicated review, not a drive-by patch from an
  unattended run. Flagged here again, pushed as a real-time notification, and kept at the top of
  `EXPERIMENTS.md`.

Assumptions unchanged from the existing threat model: Groth16/BN254 soundness, dev trusted setup
non-production-safety (RR2). This experiment's own PR touches no circuit and no VK.

## Approach

**What I built:**

1. **The CI fix** (`.github/workflows/ci.yml`): replaced the `curl` download of `pot15_final.ptau`
   with `snarkjs powersoftau new bn128 15` → `contribute` → `prepare phase2`, run entirely offline.
   Same change, with a try-download-then-fall-back-to-local-generation pattern (so a developer with
   working access to the Hermez file still gets the shared, more-widely-reused ptau by default),
   applied to `circuits/scripts/compile.sh` for local dev parity. Did **not** touch
   `compile-withdraw.sh` / `compile-compliance.sh`'s own copies of the same download — they reuse
   `build/pot15_final.ptau` from `compile.sh` and only hit the network themselves if that file is
   missing; leaving them as a thin duplicate wasn't worth the extra diff tonight, flagged as a queue
   item instead.
2. **Full validation, not just a diff that looks right:** actually ran the new local-ptau path in
   this session (same commands the CI YAML now runs), then re-ran `groth16 setup` +
   `zkey contribute` + `zkey export verificationkey` for all three circuits against the resulting
   ptau, then ran the full circuit test suite in **real full-proof mode** (not the JS fallback) —
   see Results.
3. **The constraint-attribution methodology** (queue item #2, `circuits/bench/components/` +
   `scripts/bench/component-constraints.sh` + `scripts/bench/component-witness-latency.mjs`):
   eleven single-gadget circom circuits (`Poseidon(2..5)` in isolation, `Num2Bits(64/8)`,
   `GreaterThan(64)`, `LessEqThan(64)`, `GreaterEqThan(64/8)`, and the full `MerkleProof(20)`
   template), each compiled alone so `circom`'s own constraint-count output attributes cost to
   exactly one gadget. Summed per production circuit and cross-checked against `BASELINE.md`'s
   already-measured totals as a correctness check on the methodology itself.

**What I rejected:**

- **Implementing a from-scratch Poseidon2 circom template to directly re-measure queue item #2.**
  PR #61 (yesterday) already did this properly — real KAT-validated correctness tests, both default-
  and `--O2`-optimized measurements, an honest note that 6 of Veil's 10 Poseidon call sites have no
  published Poseidon2 parameter set at any library checked — and reached REJECT. Redoing that work a
  ninth time would have been exactly the failure mode this report is about. My constraint-attribution
  angle is complementary (it explains *why* the swap barely moves the needle for the calls it does
  cover — the dominant cost is 20 calls to one arity, not spread evenly across four arities) rather
  than a re-litigation, so I kept it, but scoped down: no new hash primitive, no npm dependency, just
  isolating what's already in the repo.
- **Backfilling `LEDGER.md`/`EXPERIMENTS.md` with verdicts from all 30 unmerged PRs myself.** PR #60
  attempted a partial version of this. I read #60 and #61 directly and can vouch for their content,
  but several of the other ~28 PRs make *contradicting* claims about the same Poseidon2 question
  (PR #42: Merkle-hasher REJECT; PR #60's own kept-along report: a different template, small KEEP) —
  declaring winners across a backlog I haven't individually read isn't a call I should make
  unilaterally from an unattended run. Left as an explicit, named open question instead of a silent
  resolution either way.
- **Attempting the RR10 fix in this PR.** See Threat model above — real fund-safety code, two
  plausible fix shapes with different tradeoffs, needs a human decision, not folded into a CI-fix PR.

**Toolchain notes:**

- `circom` was not installed (fresh container); built `v2.2.2` from source
  (`cargo build --release`, ~1 minute) — same as every prior night, `circom` is not published to
  crates.io under that name and this sandbox does not persist a container image across sessions.
- `sui` CLI: still unavailable, still not on crates.io, still would mean compiling the full Sui
  workspace from source — not attempted, unchanged from every prior run.
- Sui JSON-RPC fallback for gas data: tested five different public endpoints
  (`fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`, `sui-testnet.public.blastapi.io`,
  `sui-testnet-rpc.publicnode.com`, `rpc.ankr.com`) — all five return `403` at this session's own
  egress proxy with `connect_rejected` (confirmed via the proxy's own status endpoint, not just a
  timeout), i.e. this is an organization-level network policy denial, not a per-tool approval prompt
  like the 2026-07-22 run hit. Genuinely BLOCKED, more conclusively than before.
- This sandbox's CPU is slow for FFT-heavy `snarkjs` work: generating the local `pot15` ptau
  (`new` + `contribute` + `prepare phase2`) took 1.6s + 19s + **5m47s** wall time respectively — slow
  enough that two different prior nights (per PR #60 and #61's own writeups) gave up on completing a
  local Groth16 setup at all. Completed it anyway tonight (it just needed patience, not a different
  approach) — see Results for the real end-to-end confirmation this unblocks CI, not just a
  theoretical fix.

## Results

### Part 1 — the CI fix, actually validated end-to-end

Raw command and timing (`circuits/`, this session, no network access to `storage.googleapis.com`
used or needed):

```
$ npx snarkjs powersoftau new bn128 15 build/pot15_0000.ptau -v
real  0m1.567s

$ echo "veil-ci-dev-entropy-<ts>" | npx snarkjs powersoftau contribute \
    build/pot15_0000.ptau build/pot15_0001.ptau --name="veil-dev-ci" -v
real  0m18.990s

$ npx snarkjs powersoftau prepare phase2 build/pot15_0001.ptau build/pot15_final.ptau -v
real  5m46.772s   (user 16m56.791s — this sandbox parallelizes across ~3 cores)
$ ls -la build/pot15_final.ptau
-rw-r--r-- 1 root root 37750189 Sep 14 07:26 build/pot15_final.ptau
```

Then, using that locally-generated ptau — no different from what the fixed CI job now does —
`groth16 setup` + `zkey contribute` + `zkey export verificationkey` for all three circuits, and the
full circuit test suite in real full-proof mode:

```
$ node --experimental-vm-modules test/transfer.test.mjs     # 43/43 pass, real Groth16
$ node --experimental-vm-modules test/compliance.test.mjs   # 30/30 pass, real Groth16
$ node --experimental-vm-modules test/withdraw.test.mjs     # 35/35 pass, real Groth16
```

(Full raw output for the zkey generation and the three test runs is in this PR's own description —
kept out of this file to avoid duplicating ~200 lines of `snarkjs` progress logging twice.)

This is the same sequence `.github/workflows/ci.yml`'s `circuit-tests` job now runs, minus GitHub's
own runner being a different (very likely faster) machine. It went from "fails in under a second on
a dead `curl`, before a single test runs" to "passes end-to-end with real Groth16 proofs, offline."

### Part 2 — Poseidon/Merkle constraint attribution

Per-gadget non-linear constraint count, compiled in isolation
(`bash scripts/bench/component-constraints.sh`, circom 2.2.2, default `-O1`):

| Gadget | Non-linear | Linear | Wires |
|---|---:|---:|---:|
| `Poseidon(2)` | 243 | 274 | 520 |
| `Poseidon(3)` | 264 | 341 | 609 |
| `Poseidon(4)` | 300 | 436 | 741 |
| `Poseidon(5)` | 324 | 511 | 841 |
| `Num2Bits(64)` | 64 | 1 | 66 |
| `Num2Bits(8)` | 8 | 1 | 10 |
| `GreaterThan(64)` | 65 | 3 | 70 |
| `LessEqThan(64)` | 65 | 4 | 71 |
| `GreaterEqThan(64)` | 65 | 4 | 71 |
| `GreaterEqThan(8)` | 9 | 4 | 15 |
| `MerkleProof(20)` (20× `Poseidon(2)` + 20× `MultiMux1(2)`) | 4,920 | 5,480 | 10,422 |

Summing each production circuit's actual gadget inventory against this table reproduces
`BASELINE.md`'s measured totals **exactly**:

| Circuit | Predicted from parts | Actual (`circom` compile, this session) | Match |
|---|---:|---:|---|
| `transfer.circom` (`Merkle20` + 3×`P(4)` + 1×`P(3)` + range checks) | 4920+900+264+386 = 6,470 | 6,470 | exact |
| `compliance.circom` (`P(5)` + `Merkle20` + 2×`P(3)` + range checks + 3 assertion constraints¹) | 324+4920+528+282+3 = 6,057 | 6,057 | exact |
| `withdraw.circom` (3×`P(4)` + 1×`Poseidon(2)` + range checks) | 900+243+322 = 1,465 | 1,465 | exact |

¹ `compliance.circom`'s `expiryCheck.out*(1-expiryCheck.out)===0`, `kycCheck.out*(1-kycCheck.out)===0`,
and `computedValid <== expiryCheck.out * kycCheck.out` are three additional non-linear constraints
outside any gadget — accounted for, not hand-waved.

**Attribution (share of each circuit's non-linear constraints):**

| Circuit | Merkle path (20× arity-2) | Other Poseidon (fixed arity) | Range/comparator | Other |
|---|---:|---:|---:|---:|
| `transfer.circom` | 76.0% | 18.0% | 6.0% | — |
| `compliance.circom` | 81.3% | 14.1% | 4.7% | 0.05% |
| `withdraw.circom` (no Merkle) | — | 78.0% | 22.0% | — |

Wire counts (a reasonable proxy for Groth16 prover cost — the prover does ~2×`#wires` G1 scalar
multiplications and ~1×`#wires` G2 multiplications, a textbook property of Groth16, not something
benchmarked tonight) track the same split almost exactly: Merkle-path wires are 76.5% of
`transfer.circom`'s total (10,422 / 13,632) and 81.7% of `compliance.circom`'s (10,422 / 12,762).

**Witness-generation timing** (`node scripts/bench/component-witness-latency.mjs --runs 20`,
`snarkjs.wtns.calculate`, includes WASM module load from disk each call — a real, if unflattering,
part of what `groth16.fullProve` also pays per invocation):

```
--- poseidon2 (1x arity-2 hash) ---
  mean: 15.932 ms   stddev: 1.787 ms   min: 13.503 ms   max: 20.943 ms
--- merkle20 (20x arity-2 hash + 20x mux) ---
  mean: 25.456 ms   stddev: 1.838 ms   min: 22.363 ms   max: 29.848 ms
```

20x the hash calls costs only 1.6x the wall time — witness generation for gadgets this small is
dominated by fixed per-call overhead (WASM instantiation), not by constraint count. This is *not*
in tension with "constraint count dominates prover time": it just locates where that dominance
actually shows up. `BASELINE.md`'s 751.9ms `transfer.circom` proving time includes both witness
generation and the Groth16 MSM/FFT step; the numbers above show witness generation itself is a small
slice of that (order of tens of ms out of ~750ms), consistent with the MSM/FFT step — which scales
with total wires, not call count — being the real bottleneck. That reinforces, rather than
undercuts, targeting the Merkle path specifically: it's ~76–82% of the wires the MSM has to process.

### Part 3 — incidental finding: client-side Merkle tree construction is O(2^depth), measured

While running the full test suite (`scripts/src/test-compliance-utils.ts`, unmodified — I only ran
the existing suite, didn't write this test), one section took over a minute for what should be a
cheap operation. Root cause, timed precisely:

```
$ bun run /tmp/time-merkle20.ts
buildMerkleTree(depth=20, 1 real leaf) wall time (ms): 64248.651709
```

`scripts/src/compliance-utils.ts`'s `buildMerkleTree` pads the leaf layer to full capacity
(`1 << depth` = 1,048,576 leaves at depth 20) and computes every level for real via `poseidon()` in
JS — no cached zero-subtree-hash optimization — so building a tree with a **single** real leaf at
depth 20 costs ~2^21 real Poseidon calls and **64 seconds**, every time, regardless of how sparse the
tree actually is. This is the reference implementation client code would use to reconstruct
Veil's on-chain commitment/credential accumulator (both `transfer.circom`'s membership proof and
`compliance.circom`'s credential tree share this depth-20 design). At today's near-empty testnet
pool this is merely slow; it does not scale to the 10^5–10^7-commitment anonymity sets
`EXPERIMENTS.md` item 4 already flags as the natural next step for RR5 (deposit-commitment
linkability) — a standard sparse-Merkle-tree optimization (precompute and cache the 21 "empty
subtree of depth d" hashes once, reuse them for every padding position) would turn this into
O(real leaves × depth) instead of O(2^depth), but that's a distinct, standalone fix, not something
to rush into tonight's PR. Filed as a new, precisely-scoped queue item below.

### Test suite

| Suite | Result | Command |
|---|---|---|
| Circuits, **real full-proof Groth16** (new tonight — CI fix enables this) | **108/108 pass** | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` (real zkeys from the locally-generated ptau) |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz | **6/6 properties** (500 cases each) | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Move contracts | **NOT RUN** | `sui` CLI unavailable, RPC fallback network-blocked (see Toolchain notes) — unchanged from every prior run; no Move code touched by this PR |

No test was loosened, skipped, or given new tolerance. Nothing in `circuits/bench/` is wired into
`component main` of any production circuit or referenced by `compile*.sh`/`ceremony.sh` — it cannot
affect the deployed verifying keys.

## Verdict: **KEEP**

The CI fix is the deliverable that matters: `.github/workflows/ci.yml`'s `circuit-tests` job no
longer depends on a host that returns `403` to GitHub Actions, validated end-to-end in this session
(local ptau generation → real zkeys → 108/108 real-Groth16 tests passing), with the same fallback
pattern applied to `circuits/scripts/compile.sh` for local dev parity. This is what every future
night's PR needs in order to ever actually merge.

The constraint-attribution result (queue item #2's underlying question) is also KEEP, as a
permanent, reusable addition: `scripts/bench/component-constraints.sh` and
`component-witness-latency.mjs` are checked in, and `BASELINE.md` gets a new attribution table below.
It doesn't overturn PR #61's REJECT on the Poseidon2 swap — it explains *why* that REJECT was the
right call (the swap only ever touched 18–24% of the relevant constraint budget; the other 76–82% is
one specific arity-2 call site, 20 times over).

The RR10 vulnerability is **not fixed** — correctly out of scope for this PR — but is re-confirmed,
still open, and flagged at the top of `EXPERIMENTS.md` again with today's date attached, plus a
direct notification sent tonight rather than left to be discovered by a human reading the 31st PR in
a backlog.

## Where this could be used

- **Any team running an unattended/scheduled agent loop against a real repo** — not just crypto
  research — should build in exactly the check this session did by habit and not by instruction:
  before starting new work, look at what's actually on the remote (open PRs, their CI status), not
  just the local ledger file the last "clean" run left behind. A ledger that only updates on merge is
  a single point of failure for the whole loop's institutional memory.
- **Any Circom/Groth16 protocol using a Merkle-membership circuit** (shielded pools, Semaphore-style
  anonymous credentials, zk-rollup account-inclusion proofs, cross-chain light-client proofs): profile
  hash *call count*, not hash *arity diversity*, before choosing a hash-optimization target. A 20-deep
  path of one hash outweighs four different hashes called once each by 4-5x here, and that ratio only
  gets more lopsided at greater Merkle depth.
- **A thesis chapter on unattended/agentic research-loop methodology**: this session is a small,
  concrete case study of a fully automated pipeline silently producing real, valid, wasted work for
  two months because its one feedback signal (a green CI check enabling a merge) was broken at the
  infrastructure layer, invisibly to every individual run that only looked at its own diff.
- **CI design for any project doing local Groth16 trusted setup in CI**: generating a small
  dev-only Powers of Tau locally (seconds to low-single-digit minutes for a `2^15`–`2^17` circuit) is
  a strictly more robust default than depending on a third-party file host staying reachable from
  every CI provider's IP ranges indefinitely — worth doing even where the download currently works.

## Open questions (next queue)

1. **RR10 fix (Critical, carried forward again).** Needs a human decision between two designs: (a)
   an on-chain Poseidon-over-BN254 implementation in Move (no existing native primitive — real
   implementation risk) to check `recipientHash == Poseidon(8, recipient)` directly, or (b) a
   breaking circuit change exposing `recipient` as a raw public input instead of a hash of it
   (simpler on-chain check, but needs a new VK/trusted setup and synchronized proof-generation code
   updates in `frontend/` and `scripts/`). Top of the queue, by a wide margin — it's the only
   Critical, confirmed-real, currently-exploitable finding in the backlog.
2. **The other ~28 unmerged research PRs.** Someone (the repo owner, most sensibly) needs to actually
   read and triage them — several contain real, non-duplicate findings (on-chain gas via a local Sui
   network per PR #59; a from-scratch Poseidon2 KAT cross-validation in PR #60's kept-along report
   that contradicts PR #42's earlier measurement of the same swap) that are currently invisible to
   `main`. This report deliberately does not adjudicate that backlog — see Approach, "What I
   rejected."
3. **`buildMerkleTree`'s O(2^depth) cost** (Part 3): a sparse-tree cached-zero-hash optimization
   would make client-side tree reconstruction usable at real anonymity-set sizes. Precisely
   scoped now — 64.2s at depth 20 for a near-empty tree, measured — a natural next night's fix +
   before/after benchmark, and directly feeds `EXPERIMENTS.md` item 4 (Merkle accumulator at scale).
4. **On-chain gas per entry point** — still BLOCKED tonight, more conclusively than before (five RPC
   endpoints tested, all denied at the network-policy level, not a one-off tool-approval hiccup). PR
   #59 reportedly unblocked this via a local Sui network rather than the public one — worth checking
   whether that approach is reproducible here before trying the public RPC path again.
5. Does adopting `circom --O2` (PR #60's other claim, -53% constraints, independently found three
   times across the backlog) hold up under an independent from-scratch re-measurement, now that CI
   can actually verify it? Good candidate for a lighter night, now that the CI blocker is gone.
