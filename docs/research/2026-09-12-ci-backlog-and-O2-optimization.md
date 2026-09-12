# 2026-09-12 — Why nothing has merged since 2026-07-22, and a 53% constraint win found in the wreckage

Tonight's run started on the top of `EXPERIMENTS.md` as it stood on `main`: item #1 (on-chain
gas, still BLOCKED) and item #2 ("Poseidon2 vs current Poseidon"). Before opening a PR, a
`git fetch origin` (done here only because a push needed a clean remote state — not part of the
usual nightly routine, which is exactly the bug) turned up **45 open PRs** (#10–#59, minus a
handful closed early on), almost none of it reflected anywhere on `main`. This is not a
cryptography or scalability finding — it's the same process failure `docs/research/2026-09-06-ci-backlog-audit.md`
(PR #55) already diagnosed and partly fixed six nights ago, still unmerged. This report picks up
exactly where that one left off, verifies its diagnosis still holds, finishes landing its fix, and
adds one genuinely new, high-value finding found while auditing the backlog: **`circom`'s default
build has been using `--O1` instead of `--O2` this whole time, at a real, measured 53% constraint
cost.**

## What was found

`git fetch origin` + `list_pull_requests` (GitHub MCP) shows PRs #10 through #59 open against
`main`, dated 2026-07-21 through 2026-09-11 — essentially one per night since the loop started,
almost none merged (three early fixes did: #14/#15's baseline work is folded into main's single
2026-07-22 commit, and #16/#17 are small unrelated fixes). Of the rest, the overwhelming majority
are independent rediscoveries of two questions:

- **"Poseidon2 vs Poseidon"**, in every framing (`hash-swap`, `arity-gap`, `arity-benchmark`,
  `merkle-hasher`, `linear-layer`, `primitive-delta`, `constraint-delta`, `-vs-poseidon`,
  `compression-mode`, `benchmark` ×2, plus this session's own now-redundant contribution) —
  PRs #18, #19, #21(partial), #22(no), #23–#30, #32, #34, #36, #37, #39–#42, #44–#47, #50, #53, #57,
  and this session's own branch before this rewrite. At minimum **10+ independent nights**
  reached REJECT (a few reached PARK on a narrower Merkle-only angle). None of it visible to the
  next night, because none of it merged.
- **"Poseidon/R1CS constraint attribution or decomposition"** — PRs #20, #23, #26, #27, #33, #35,
  #38, #43, #48, #52, #54, #56, #58 — repeatedly re-deriving where each circuit's constraints come
  from (answer, settled independently many times: the 20-level Merkle path, not the four
  domain-tagged Poseidon calls, dominates — 76-81% in `transfer`/`compliance`).
- **On-chain gas** — PRs #11(partial), #22, #31, #51, #59 — independently re-BLOCKED, each time
  rediscovering the same `sui`-CLI/testnet-RPC network restriction from scratch.
- One CI/process audit (**PR #55**, 2026-09-06) that found and partly fixed the actual root cause
  six nights ago, and is itself still unmerged.

**Root cause, confirmed still live:** `.github/workflows/ci.yml`'s `oven-sh/setup-bun` action pin
(`735343b667d3e6f658f44e0a462d63b48e3324cb`) does not correspond to any real commit in that repo —
`script-tests` and `frontend-tests` fail at the action-resolution step, in 2-11 seconds, before any
test runs. Verified directly:

```
$ git ls-remote https://github.com/oven-sh/setup-bun.git | grep -E "4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5|735343b667d3e6f658f44e0a462d63b48e3324cb|refs/tags/v2.0.1"
4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5	refs/tags/v2.0.1
```

The broken SHA doesn't even appear in the remote's refs; `4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5`
(the fix PR #55 already found) is confirmed to be the real `v2.0.1` tag. Pulled PR #58's
(2026-09-10, most recent CI run before tonight) job logs directly to confirm the break is still
exactly this, unchanged since PR #55 diagnosed it:

```
$ get_job_logs(run_id=34449916528, failed_only=true)
[Frontend, Proof converter]: ##[error]Unable to resolve action `oven-sh/setup-bun@735343b667...`,
  unable to find version `735343b667d3e6f658f44e0a462d63b48e3324cb`
[Circom circuits]: curl: (22) The requested URL returned error: 403   (pot15.ptau download)
[Move contracts]: success   <- the sui CLI genuinely works fine in CI; it's this interactive
                                sandbox specifically where it's unreachable, a distinction worth
                                keeping straight before writing "sui CLI unavailable" for the 10th
                                time.
```

## Approach

**What I did:**

1. Re-applied PR #55's `oven-sh/setup-bun` pin fix to current `main` (it never landed — verified
   the broken SHA is still there, applied the same fix, re-verified the replacement SHA against
   the actual remote as shown above, rather than trusting the prior diagnosis blindly).
2. While auditing `circom` invocations repo-wide to check nothing else was quietly relying on the
   broken pin, noticed every `circom` call in `circuits/scripts/compile*.sh`, `ceremony.sh`, and
   `.github/workflows/ci.yml` passes no `-O` flag — meaning every one of them has been using
   circom's default, which is **`--O1`** ("only signal-to-signal and signal-to-constant
   simplification"), not `--O2` ("full constraint simplification"), confirmed via `circom --help`.
   PRs #24 and #40 (2026-08-04, 2026-08-22 — both still open) apparently found this independently
   and reported a ~53% constraint cut; re-derived and verified it directly rather than trusting
   that number secondhand (see Results).
3. Verified `--O2` doesn't change circuit behavior, not just circuit size: computed a valid witness
   and a deliberately malformed one (wrong `merkleRoot`) against both an `--O1`- and
   `--O2`-compiled `transfer.circom` wasm and confirmed identical accept/reject behavior (this is
   also what `--O2` is *supposed* to guarantee by construction — full constraint simplification is
   a provably solution-set-preserving rewrite, substituting out signals that are fully determined
   by others, not a heuristic approximation — but "supposed to" isn't "verified," so verified it).
4. Applied `--O2` to all three `compile*.sh` scripts, `ceremony.sh`'s WASM-only fallback path
   (important: it must match whatever optimization level produced the paired zkey, or the witness
   calculator and the proving key disagree about what a "signal" even is), and the CI workflow's
   inline `circom` call.
5. Updated `BASELINE.md`'s constraint-count table to the new `--O2` numbers, with proving
   time/zkey/vk explicitly marked pending re-measurement (this session's zkey setup was too slow to
   redo — see "What I didn't do").
6. Rewrote `LEDGER.md`/`EXPERIMENTS.md` to reflect the real state of the backlog: not a full
   line-by-line replay of all 40+ branches (out of scope for one night, and several are near-exact
   duplicates of each other), but an honest accounting of what's settled, by which PRs, and an
   explicit "check the backlog before re-running anything" step at the top of the queue — the fix
   PR #55 proposed for `NIGHTLY_PROMPT.md` but didn't apply. Applied it.
7. Kept my own independent Poseidon2 Merkle-hasher cross-validation as a secondary artifact (see
   `2026-09-09-poseidon2-merkle-hasher.md`) — its verdict (REJECT) isn't new, but its numbers
   directly *contradict* PR #42's (2026-08-24) on the same question — see that report's note and
   the ledger entry below for why, since resolving that contradiction is itself a real, unresolved
   finding worth keeping.

**What I didn't do:**

- **Did not merge or close any of the other 40+ PRs myself.** Closing a PR is a judgment call about
  whether it contains anything worth cherry-picking first (several do — see "Open questions"); a
  research-loop session deciding unilaterally to delete 40 branches of prior work is exactly the
  kind of hard-to-reverse, other-people-visible action that should go to whoever owns this repo,
  not be silently done by an autonomous PR. Flagged prominently instead (this report, the PR
  description, and a direct notification).
- **Did not re-run the Groth16 setup for `--O2`-compiled circuits.** This session already spent
  significant budget on a local Groth16 setup for an unrelated experiment tonight
  (`2026-09-09-poseidon2-merkle-hasher.md`) that didn't finish in reasonable time on this sandbox's
  CPU. `BASELINE.md`'s zkey/vk/proving-time rows are explicitly marked historical-`--O1`-only,
  not silently left looking current.
- **Did not touch the `sui`-CLI / `pot15.ptau` `403`s.** Confirmed CI's `move-tests` job (which
  needs neither of those two specific URLs) passes fine — `sui` itself works in the Actions
  environment. The `pot15.ptau` `403` (`circuit-tests` job) is a live, separate, unfixed blocker;
  scope discipline says leave it for its own night rather than let this PR sprawl further.

## Results

### CI fix (mechanical, verified)

```diff
- uses: oven-sh/setup-bun@735343b667d3e6f658f44e0a462d63b48e3324cb # v2.0.1
+ uses: oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5 # v2.0.1
```
(both `script-tests` and `frontend-tests` jobs in `.github/workflows/ci.yml`)

### `circom --O2` adoption (real, measured, functionally verified)

```
$ circom transfer.circom --r1cs -o /tmp/o1test -l node_modules   # current default (--O1)
non-linear constraints: 6470   linear constraints: 7141   wires: 13632
$ circom transfer.circom --O2 --r1cs -o /tmp/o2test -l node_modules
non-linear constraints: 6384   linear constraints: 0      wires: 6407

$ circom compliance.circom --r1cs -o /tmp/o1c -l node_modules
non-linear constraints: 6057   linear constraints: 6686
$ circom compliance.circom --O2 --r1cs -o /tmp/o2c -l node_modules
non-linear constraints: 5979   linear constraints: 0

$ circom withdraw.circom --r1cs -o /tmp/o1w -l node_modules
non-linear constraints: 1465   linear constraints: 1593
$ circom withdraw.circom --O2 --r1cs -o /tmp/o2w -l node_modules
non-linear constraints: 1439   linear constraints: 0
```

| Circuit | `--O1` (current default) | `--O2` | Δ constraints | Δ% |
|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,384 | -7,227 | **-53.1%** |
| `compliance.circom` | 12,743 | 5,979 | -6,764 | **-53.1%** |
| `withdraw.circom` | 3,058 | 1,439 | -1,619 | **-52.9%** |

Functional equivalence check (`snarkjs.wtns.calculate` against both `--O1`- and
`--O2`-compiled `transfer.circom` wasm, same valid witness and same deliberately-malformed one):

```
Valid witness against --O2 wasm:
  PASS: accepted
Malicious witness (wrong merkleRoot) against --O2 wasm:
ERROR:  4 Error in template Transfer_220 line: 61
  PASS: rejected — Error: Assert Failed. Error in template Transfer_220 line: 61
```

Same rejection point (`Transfer` template, line 61 — the `merkleRoot === membershipProof.root`
check) as `--O1`. `--O2` full constraint simplification is a solution-set-preserving rewrite by
construction (it eliminates signals that are an exact linear/constant function of others — it
doesn't relax or drop constraints), and this empirical check is consistent with that: same accept,
same reject, same failure point, far fewer rows.

Groth16 prover cost scales with total R1CS constraints (the multi-scalar-multiplication size) —
a 53% cut here is a 53% cut in the single largest cost this protocol pays on every proof, for
every one of the three circuits, for free (no protocol, soundness, or privacy change — see Threat
model). This is by a wide margin the most valuable number in the entire unmerged backlog, and it
was sitting there, independently found twice (PRs #24, #40), for over five weeks.

### Test suite

| Suite | Result | Command |
|---|---|---|
| CI workflow YAML | **Valid** | `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` |
| `--O2` functional equivalence (transfer, valid + malicious witness) | **PASS** (both, see above) | ad hoc `snarkjs.wtns.calculate`, see report |
| Circuits (production, unmodified logic) — HASH-ONLY mode | **108/108 pass** | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** (unchanged blocker in this sandbox; confirmed working in CI, see above) | `sui move test` |

No circuit *logic* changed (`transfer.circom`/`compliance.circom`/`withdraw.circom` are
byte-identical to `main`) — only the compiler flag used to build them, which is why the existing
hash-only test suite (which never touches `--O` at all) still passing is expected, not strong
evidence either way for this specific change; the direct `--O1`-vs-`--O2` wasm comparison above is
the actual evidence.

## Threat / privacy model

**`circom --O2` adoption:** no threat-model change. It is a compiler-level constraint-system
simplification, algebraically required to preserve the exact same solution set as the
unsimplified R1CS (that's the definition of a sound simplification pass, and per PR #24's original
finding and this session's own functional check, circom's implementation behaves accordingly). It
changes *how many rows* the R1CS has, never *what it proves*. No STRIDE entry changes. The one real
consequence is operational, not cryptographic: it changes the zkey/vk, so it composes with the
existing `RR2` (trusted setup) and `T3` (VK update timelock) controls exactly the way any circuit
recompilation does — a fresh ceremony and a `propose_vk_update` timelock are required before the
live pool accepts `--O2`-proved transactions, same process as any other circuit change, not a new
one.

**CI fix and backlog documentation:** no threat-model implications — process/tooling only.

## Verdict

- **`circom --O2` adoption: KEEP.** Real, measured, functionally verified, zero threat-model
  cost. `circuits/scripts/compile*.sh`, `ceremony.sh`, and CI updated. `BASELINE.md` updated with
  the new constraint counts; proving time/zkey/vk marked pending re-measurement.
- **CI bun-pin fix: KEEP.** Re-verified against the live `oven-sh/setup-bun` repo, not trusted
  secondhand from PR #55.
- **Backlog consolidation: KEEP** (the ledger/queue rewrite) **/ PARK** (the actual 40+-PR cleanup —
  a maintainer call, not this PR's to make unilaterally; see Open questions).

## Where this could be used

- **The `--O2` finding specifically**: any Circom project that hasn't audited its own compile
  flags. `--O1` is circom's default and looks like a reasonable, safe choice from the CLI help text
  alone ("simplification is applied") — nothing about the CLI surfaces that `--O2` is both safe
  *and* roughly half the constraint count for a circuit like this. Worth being the first thing
  checked, not the last, on any Groth16/R1CS circuit's first optimization pass — cheaper than any
  protocol-level change (Poseidon2, batching, anything) and this session's numbers suggest it can
  dwarf them.
- **The backlog-audit finding, generalized** (echoing PR #55's own framing, since it's still true
  and still unaddressed): any autonomous/scheduled agent loop whose only persistent memory is a
  markdown file on a trunk branch has *no* memory the moment merges stop landing — this is worth
  athesis section (or a production runbook line item) of its own: **a scheduled agent loop needs
  either write access straight to trunk, or an explicit "did last night's PR merge?" check before
  starting new work** — one or the other, or this exact failure mode recurs indefinitely, silently,
  looking productive (a new PR every night!) while accomplishing nothing net.

## Open questions (next queue)

1. **Someone needs to actually merge PRs, or the loop needs to push straight to a trunk it reads
   from.** This is the single highest-leverage open question — everything else is downstream of
   it. Flagging directly to the repo owner (see PR description / notification).
2. **Re-run the Groth16 ceremony + `propose_vk_update` flow for the `--O2` circuits** to get
   real zkey/vk/proving-time numbers and actually move the live pool onto the smaller circuits —
   the constraint-count win only pays off once a real ceremony and deployment happen.
3. **A human (or a future night with more budget) should triage the other ~40 open PRs** for
   anything else worth cherry-picking before they're closed. Skimming titles, at least two more
   look like real, distinct, non-duplicate findings: PR #49 ("merkle-zero-hash-pruning") and
   whatever #46/#18's actual measured numbers are (both claim a Merkle-hasher "win," which
   contradicts both PR #42's regression finding and my own session's marginal win — three
   independent measurements of nominally the same swap, three different magnitudes/signs, is
   itself worth reconciling before trusting any one of them).
4. **Reconcile the Poseidon2-Merkle-hasher sign discrepancy** between this session's
   `2026-09-09-poseidon2-merkle-hasher.md` (-0.3%, from a from-scratch circom template
   cross-validated against `HorizenLabs/poseidon2`'s own KAT) and PR #42's 2026-08-24 report
   (+9.3%/+9.9%, from a `@taceo/circom-lib`-based template). Same underlying math, opposite sign —
   almost certainly a circom-encoding-quality difference (named intermediate MDS-multiply signals
   defeating `--O1`'s limited simplification vs. inline expressions that fold away), which the
   `--O2` finding above makes newly testable: **re-run PR #42's exact template under `--O2`** and
   see whether the regression survives. If `--O2` erases the gap, that's a second, independent
   confirmation of tonight's headline finding.
