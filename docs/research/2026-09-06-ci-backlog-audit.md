# 2026-09-06 — Why nothing merges: a CI/process audit, not a crypto experiment

Tonight's run started by taking the top of `EXPERIMENTS.md` (item #1, on-chain gas per entry
point) as usual. Before touching the toolchain, a look at the loop's own history — every research
PR ever opened, and whether it landed — turned up a problem bigger than any single measurement:
**the loop has not merged a single research finding since 2026-07-22.** Fixing that is tonight's
deliverable instead. This isn't a cryptography or scalability finding, so the usual
threat-model/leakage-analysis sections don't apply; the report shape below is adapted for a
process finding.

## Hypothesis

(Not a falsifiable performance hypothesis — a diagnostic question.) *Why does `EXPERIMENTS.md`
still show items #1 and #2 as the top-ranked, unsettled queue entries after ~40 nights of runs
that repeatedly claim to have executed exactly those two experiments?*

## What was found

`git fetch --prune` plus `gh`-equivalent PR listing shows **35 open research PRs** (#18 through
#54), dated 2026-07-29 through 2026-09-05, none merged. `main` is still at the commit the
2026-07-22 baseline landed on (plus two unrelated small fixes, #16/#17). `docs/research/LEDGER.md`
and `EXPERIMENTS.md` **on `main`** still only have the one 2026-07-22 row — every subsequent
night's ledger/queue edits live only on that night's own unmerged branch, invisible to the next
night's fresh checkout of `main`.

Consequence: at least **6 separate nights** (PRs #21, #23, #26, #27, #33, #35, #38, #43, #48, #52
and more — the exact count is higher, this is a lower bound from titles alone) independently
re-ran "Poseidon2 vs Poseidon" and reached the same REJECT verdict, and at least 3 nights
(#22, #31, #51) independently re-ran "on-chain gas per entry point" and hit the same BLOCKED
result, because none of them could see that a prior night had already done so. Yesterday's PR
(#54, `poseidon-constraint-decomposition`) is a genuinely good, non-duplicate KEEP-verdict
measurement night — and it's sitting unmerged like all the rest.

### Root cause: CI is red on every single one of these PRs

Checked `pull_request_read(get_check_runs)` on PR #54 (2026-09-05, still open): all 4 CI jobs
fail, each within 2–11 seconds — too fast to be real test failures. Pulled the job logs
(`get_job_logs`, `failed_only: true`, run 33952535623):

- **`script-tests` and `frontend-tests`** (both use `oven-sh/setup-bun`): fail at the
  action-resolution step, before checkout even finishes:
  `Unable to resolve action oven-sh/setup-bun@735343b667d3e6f658f44e0a462d63b48e3324cb, unable to
  find version 735343b667d3e6f658f44e0a462d63b48e3324cb`. That SHA does not exist in
  `oven-sh/setup-bun` — it's a corrupted pin (a near-miss for v2.0.2's real SHA, off by a few
  trailing hex characters, per the commit that already diagnosed this, below).
- **`move-tests`**: `curl -fsSL https://api.github.com/repos/MystenLabs/sui/releases` /
  the release-asset download both return `curl: (22) ... error: 403`.
- **`circuit-tests`**: `curl -fsSL -o build/pot15_final.ptau
  https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau` also returns `403`.

The bun-pin bug already has a fix — sitting unmerged. `git log --all -- .github/workflows/` turns
up commit `4dc78ea` ("ci: fix corrupted oven-sh/setup-bun action SHA pin", 2026-08-31), on some
prior night's branch, never merged into `main`. Its own commit message says this pin "has been
breaking both the 'Proof converter + compliance utils' and 'Frontend' CI jobs since the commit
that introduced them (`e37ecd6`) — every CI run on main since then has failed." That's every CI
run on `main` for over a month, diagnosed correctly once already, and still broken tonight because
the fix never landed.

The `sui` CLI and `pot15.ptau` downloads are a different failure mode: `github.com` itself is
reachable (checkout, and the `oven-sh/setup-bun` action-metadata fetch, both succeed) but a
release-asset download from `github.com/MystenLabs/sui/releases/download/...` and a
`storage.googleapis.com` object both come back `403`. That reads like a runner-level network
allowlist that permits `github.com` API/git traffic but not release-asset or GCS object fetches —
i.e., an infrastructure/policy setting, not a bug in this repo's code. (This matches what three
separate nights already reported as "on-chain gas BLOCKED, no `sui` CLI" — they were hitting the
same wall and, lacking visibility into `main`'s CI logs, treated it as a local-sandbox limitation
each time rather than a shared, fixable-or-not-fixable-by-us CI setting.)

## Approach

- Applied `4dc78ea`'s fix (verified against the currently-broken pin on `main`, not re-derived):
  `oven-sh/setup-bun@735343b667d3e6f658f44e0a462d63b48e3324cb` →
  `oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5` (still labelled `v2.0.1`), in both
  jobs that use it (`script-tests`, `frontend-tests`).
- Did **not** attempt to route around the `sui`-release / `storage.googleapis.com` `403`s from
  inside the workflow (e.g., a mirror, a vendored binary committed to the repo, a different CDN).
  That network boundary may well be an intentional guardrail on what this repo's Actions runners
  can reach, not an oversight — changing it is a call for whoever administers the repo's Actions
  settings, not something to quietly work around from a research PR. Flagged for the maintainer
  instead (see Open questions).
- Did not touch `EXPERIMENTS.md` items #1/#2 themselves tonight — re-running either without first
  fixing the reason 9+ prior attempts never landed would just add a 36th duplicate PR.

## Results

| | Before | After (this PR) |
|---|---|---|
| `script-tests` / `frontend-tests` CI jobs | Fail at action-resolution (0 tests run) | Bun resolves; jobs run their actual test steps |
| `move-tests` / `circuit-tests` CI jobs | Fail on external download (`403`) | **Unchanged** — this is a network-policy boundary, not a code bug in this PR's scope |
| Open unmerged research PRs | 35 (#18–#54) | Unchanged by this PR — a merge/backlog decision for the repo owner, not something this PR does unilaterally |

Raw log excerpts backing the "before" column are pasted above, from `get_job_logs` on run
`33952535623` (PR #54, commit `d1e575c`). This PR's own CI run against the fixed pin is the "after"
evidence — check its `script-tests`/`frontend-tests` job logs on this PR to confirm they now run
past action-resolution.

## Verdict

**KEEP** (the bun-pin fix — small, mechanical, verified-broken, verified-fixed-in-diagnosis by a
prior night). The rest of the finding is **PARK**, pending a decision from whoever administers
this repo:

1. **Merge the backlog.** At minimum PR #54 (2026-09-05, KEEP, no duplicate) and this one. The
   other 34 are mostly duplicate or superseded Poseidon2/gas nights (see the list above) — worth a
   human pass to pick any distinct findings out of them (e.g. #49's Merkle zero-hash pruning, #40's
   `circom --O2` adoption) before closing the rest, rather than this PR closing 30+ others
   unilaterally.
2. **Decide on the `sui`-release / GCS network block.** Either widen whatever Actions network
   policy is blocking `github.com/*/releases/download/*` and `storage.googleapis.com`, or accept
   the block and vendor `pot15_final.ptau` (checked into the repo or an internal artifact store —
   it's ~85 MB, git-LFS territory) and a pinned `sui` binary (or build it via `cargo install`
   the way `circom` already is, from source, since raw git clones over `github.com` do appear to
   work). Either fix unblocks `move-tests`, `circuit-tests`, and the recurring "on-chain gas
   BLOCKED" queue item in one shot.

## Where this could be used

Not protocol-specific — this is a process failure mode for *any* autonomous/scheduled research or
maintenance loop that (a) opens PRs instead of pushing to a trunk, and (b) relies on that trunk's
state (a ledger, a queue, a baseline file) to avoid repeating itself. The generalizable lesson:
an autonomous loop whose memory lives in unmerged branches has no memory at all — it will
silently re-derive the same conclusions indefinitely unless something (a human, or the loop
itself) periodically checks "did last night's finding actually land where the next night can see
it?" A recurring-task/agent-ops thesis chapter on multi-session agent loops, or any CI-gated
auto-PR bot (dependency-update bots, nightly-fuzzing bots), hits exactly this failure mode if
merges stall for any reason (red CI, missing review capacity, low-priority backlog).

## Open questions

- Should the nightly prompt (`NIGHTLY_PROMPT.md`) add an explicit early step — "check whether the
  previous N nights' PRs merged; if not, say so and stop before starting new research" — so this
  doesn't silently recur? Proposed addition, not yet made (didn't want to change the loop's own
  contract unilaterally in the same PR that reports the bug).
- Who reviews/merges these PRs, and on what cadence? If the answer is "nobody, currently," that's
  the actual root cause, and the CI fix in this PR only helps once someone is merging again.
- Is the `github.com` release-asset / `storage.googleapis.com` block in the Actions runner network
  policy intentional (a deliberate egress allowlist) or incidental? This determines whether the
  right fix is "widen the allowlist" or "vendor the two blocked downloads."
- Of the 34 other open PRs, which (if any) besides #54 contain a distinct, non-duplicate finding
  worth cherry-picking before the branches are cleaned up?
