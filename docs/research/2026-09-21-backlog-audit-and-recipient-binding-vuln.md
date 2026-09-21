# 2026-09-21 — PR-backlog audit + reconfirmation of an unpatched fund-theft bug

## Hypothesis

None of the usual form ("swapping X moves number Y") — tonight's session started by taking
`EXPERIMENTS.md`'s queue as given (item #1: on-chain gas, item #2: Poseidon2 vs Poseidon) and
building a fresh, isolated Poseidon-vs-Poseidon2 R1CS constraint-count benchmark
(`circuits/research/poseidon-bench/`, `scripts/bench/poseidon-arity.mjs`). Partway through, a check
of open PRs (`list_pull_requests`, `state=open`) turned up **27 open PRs** (#41–#70), the great
majority independently re-deriving the *same* two experiments (Poseidon2: at least 16 PRs; on-chain
gas: at least 6), none merged, going back to **2026-07-22** — the date of the one row in
`LEDGER.md` and the one commit (`ab6fbc8`) actually on `main`. That reframed tonight's real,
falsifiable question: **is the research loop's queue state on `main` an accurate reflection of what
has actually been tried, and is every "Mitigated" claim in `docs/threat-model.md` still true?**
Both turned out to be no. This is a process-audit + security-reconfirmation night, not a
performance-number night — see "Verdict" for why that's still a legitimate, falsifiable, measured
result and not a punt.

## What was actually found

### 1. The loop has been re-running settled experiments for two months because nothing merges

`LEDGER.md` and `EXPERIMENTS.md` on `main` are frozen at the 2026-07-22 baseline night. Every night
since has correctly read them, correctly picked the top unsettled item, done real work — and then
opened a PR that never got merged, so the *next* night saw the exact same frozen queue and repeated
the same experiment. Concretely, as of tonight (`list_pull_requests`, `state=open`, `alexandre-mrt/veil`):

| Experiment | Open PRs (this session's count) |
|---|---|
| Poseidon2 vs Poseidon (constraint count / proving time) | **16**: #41, #42, #44, #45, #46, #47, #48, #50, #52, #53, #54, #56, #57, #58, #61, #64, #65, #67 (18 actually, several titled identically) |
| On-chain gas per entry point | **6**: #51, #59, #63, #66, #68 (+ earlier attempts) |
| CI infra fixes (bun-pin SHA, ptau 403) | **4**: #55, #60, #62, #69, #70 (several nights independently found and re-fixed the *same two* bugs) |

Root cause, confirmed by reading the actual CI runs (`actions_list` → `list_workflow_runs`): the
repo's CI (`.github/workflows/ci.yml`) has been red on nearly every PR since some point in August
because of **two unrelated infrastructure bugs**, neither caused by any research PR's own diff:

1. `oven-sh/setup-bun@v2.0.1` pinned to a SHA (`735343b6...`) that does not resolve to any real
   commit in that repo — every `script-tests`/`frontend-tests` job fails at action-resolution,
   before any test runs.
2. `circuits`' CI step downloads `pot15_final.ptau` from `storage.googleapis.com`, which now
   returns `403` to GitHub-hosted runners (the same host this session's own sandbox found blocked
   independently tonight — see below).

At least five separate nights (PRs #55, #60, #62, #63, #70) independently rediscovered one or both
of these and shipped a fix — correctly diagnosed, correctly fixed, every time — and every single fix
sat unmerged. **PR #68** ("research: on-chain gas per entry point, measured on a local network") is
the current best candidate: its own CI run (`run 35534616455`) is **green** (`conclusion: success`)
and `mergeable_state: "clean"`. It contains both infra fixes plus a real, validated closing of
queue item #1 (on-chain gas via a local Sui network, 124/124 Move tests passing for the first time
this loop). This session did **not** merge it — merging into `main` is a shared-state, hard-to-reverse
action outside a scheduled run's authority without the repo owner's sign-off — but it is the single
highest-leverage action available: merging it retires ~6 duplicate gas PRs and both CI bugs in one
step, and every night after would finally see an accurate, advancing ledger.

**This session's own recommendation, not yet acted on:** merge #68, then close #41–#67, #69, #70 as
superseded (their content is preserved in `LEDGER.md`/this report either way).

### 2. `docs/threat-model.md` E7 currently makes a false safety claim about a real, unpatched bug

While auditing the backlog, several unmerged PR descriptions (#59, #60, #62, #63) independently
flagged the same critical finding in `contracts/sources/pool.move`. Rather than take that on trust,
this session re-derived it directly against **current `main`** (not an unmerged branch):

`pool::zk_withdraw` (`contracts/sources/pool.move:571-630`) documents its 160-byte public-input
layout as `[0..32) commitment, [32..64) withdrawAmount, [64..96) nullifier, [96..128) recipientHash,
[128..160) newCommitment`, and its own comment (line 595-599) claims:

> "The circuit proves recipientHash = Poseidon(8, recipient), binding the withdrawal to a specific
> address. We enforce this by sending tokens ONLY to the recipient parameter... Front-running is
> prevented: changing recipient invalidates the Groth16 proof."

Reading the actual function body: it extracts `commitment_bytes` (0-32), `withdraw_amount` (32-64),
`nullifier` (64-96) — then jumps straight to `new_commitment` (128-160). **Bytes 96-128
(`recipientHash`) are never extracted, never hashed from `recipient`, never compared to anything.**
`recipient` is a plain, separate function argument with no cryptographic link to the proof at all.
Groth16 verification (`verifier::verify_withdraw_proof`) checks `proof_bytes` against
`public_inputs_bytes` only — it has no way to know what `recipient` argument the caller passed.

The comment's claim ("changing recipient invalidates the Groth16 proof") is simply false: the proof
and its public inputs are fixed at proof-generation time and are entirely independent of the
`recipient` argument supplied at call time.

**Impact:** anyone who observes a pending withdrawal's `(proof_bytes, public_inputs_bytes)` —
visible in the mempool, or leaked by a relayer — can call `zk_withdraw` themselves with their own
address as `recipient`. The proof still verifies, the nullifier is consumed (so the legitimate
owner's withdrawal is now permanently blocked, not just redirected once), and the funds go to the
attacker. Checked `contracts/tests/pool_withdraw_tests.move`: the 3 existing `zk_withdraw` tests
cover missing-VK, frozen-pool, and wrong-input-length — **none** exercise a recipient/proof
mismatch, so nothing in the green 124/124 Move suite would catch this.

`docs/threat-model.md` E7 ("Front-run ZK withdrawal to steal funds") is corrected in this PR from
**Mitigated** to **Not mitigated**, and a new **RR10 (Critical)** row is added. The fix itself —
either computing `Poseidon(8, recipient)` on-chain and asserting equality, or (simpler, since
`recipient` is already not anonymous per `README.md`'s own "Recipient anonymity: No") changing
`withdraw.circom` to expose `recipient` as a raw public input instead of a hash of it — needs a
circuit change, a new soundness argument, a negative test, and a VK rotation either way. That is
real engineering, not a same-night patch, and is **not attempted in this PR** — rushing a
security-critical circuit change in an unattended run risks introducing a second bug while fixing
the first. It is filed as `EXPERIMENTS.md` item #1, ahead of every performance item.

**Testnet-only impact note, for calibration, not as an excuse:** the deployed package
(`README.md`, "Deployed (Sui testnet)") uses a valueless faucet token, so no real funds are at risk
today. The bug is still real, still unpatched, and still worth an owner's immediate attention before
any mainnet consideration — that's why this goes out as a priority notification, not just a queue
re-rank.

### 3. Tonight's original experiment (Poseidon2 vs Poseidon), for the record

Before finding the above, this session built its own from-scratch, isolated benchmark
(`circuits/research/poseidon-bench/`, reusable script `scripts/bench/poseidon-arity.mjs`) rather
than trusting the unmerged PRs' numbers:

| Circuit | Non-linear | Total constraints |
|---|---|---|
| `Poseidon(2)` (circomlib, t=3) — the Merkle-path hasher, 20x/proof | 243 | 517 |
| `Poseidon2T3` (this session's own permutation, same round schedule) | 243 | 522 |
| `MerkleProof(20)` (production template, Poseidon) | 4,920 | 10,400 |
| `MerkleProof(20)` rebuilt with `Poseidon2T3` | 4,920 | 10,500 |

Full depth-20 Merkle proof: **0.00% non-linear delta, +0.96% total constraints** (the extra "free"
linear constraints of Poseidon2's initial linear layer). This independently corroborates every one
of the ≥16 unmerged Poseidon2 PRs' REJECT/PARK verdicts: Poseidon2's efficiency claim is about
*native* (non-arithmetized) multiplication count, not R1CS constraint count — inside Groth16, the
S-box count (identical here) is the only thing that costs constraints, and the linear layer (where
Poseidon2 differs from Poseidon) is free in R1CS regardless of its structure. One genuinely new,
reusable artifact from this: `poseidon-arity.mjs` isolates each Poseidon instance
(`Poseidon(2)`/`Poseidon(3)`/`Poseidon(4)`, plus the full `MerkleProof(20)`) so the exact per-instance
constraint contribution is measured, not derived by subtraction — confirming the depth-20 Merkle
path (10,400 of `transfer.circom`'s 13,611 total, ~76%) dominates, not the four domain-tagged
commitment/nullifier hashes `EXPERIMENTS.md` previously assumed. Given the existing, more thoroughly
validated PRs (#67 in particular uses the actual published Horizen Labs Poseidon2 reference
parameters and measures real proving time, not just constraint counts — this session's own
permutation used repurposed placeholder constants, sufficient for a constraint-count-only argument
but explicitly not a validated hash), **this session is not opening an 19th duplicate PR for this
finding.** The benchmark script is kept locally as corroborating evidence in this report; see
`circuits/research/poseidon-bench/` in this PR's diff for the actual circuits and negative test
(malicious-witness rejection, confirmed: a tampered expected-output is rejected at witness
generation).

## Threat / privacy model

Nothing in this PR changes any circuit, contract, or proof — it is a documentation correction
(threat-model.md) plus a benchmark-only addition (isolated Poseidon2 circuits, unreachable from any
production circuit) plus this report. The one substantive change to a security claim is E7/RR10,
and it makes the documented threat model *more* conservative (a claimed mitigation is retracted),
never less. No new adversary capability is introduced; an adversary who could already exploit RR10
loses nothing and gains nothing from this PR — they gain from the bug being fixed, which is not yet
done. Maps to STRIDE: E7 (Elevation of Privilege — an unprivileged caller can redirect funds
without holding the necessary knowledge, i.e. the honest recipient's private witness), corrected in
place; new row RR10 in the risk register.

## Approach

- Read `docs/research/{LEDGER,EXPERIMENTS,BASELINE}.md` on the current branch first, as instructed.
- Confirmed queue item #1 (on-chain gas) is genuinely still `BLOCKED` *in this sandbox* tonight
  (`fullnode.testnet.sui.io` → proxy `403 connect_rejected`; `github.com/MystenLabs/sui` releases
  unreachable — GitHub access this session is scoped to `alexandre-mrt/veil` only; no `sui` crate on
  crates.io) — before finding PR #68, which solved it differently (local network, not testnet RPC;
  a `sui` CLI release asset, not crates.io) in an environment where GitHub Releases for
  `MystenLabs/sui` apparently *were* reachable. Environments evidently differ run-to-run in what's
  network-reachable; worth remembering before declaring anything "impossible," only "blocked here."
- Built and measured the Poseidon2 isolated benchmark (see above) before checking the PR backlog —
  the backlog check happened when preparing to open this session's own PR and sanity-checking
  against `EXPERIMENTS.md`'s framing ("four Poseidon instances dominate"), which didn't match the
  measured per-instance breakdown and prompted a check of what else might be stale on `main`.
- Used `list_pull_requests`/`actions_list`/`pull_request_read` (GitHub MCP tools) to enumerate the
  open backlog and its CI history, rather than guess from commit-message claims alone.
- Independently re-read `contracts/sources/pool.move` and `contracts/tests/pool_withdraw_tests.move`
  line-by-line before accepting any unmerged PR's vulnerability claim — confirmed firsthand, not
  taken on trust.
- **Rejected:** attempting the `zk_withdraw` fix itself tonight (circuit change + VK rotation +
  soundness argument in one unattended run is too much surface for a security-critical change);
  merging PR #68 or closing the duplicate PRs myself (both are shared-state actions on someone
  else's repository that deserve an explicit human decision, even though the technical case for
  both is strong).

## Results

See sections 1-3 above for the full tables and reasoning. Summary:

| Question | Answer | Evidence |
|---|---|---|
| Is `main`'s queue state accurate? | **No** — 2 months stale | 27 open PRs enumerated via `list_pull_requests` |
| Why doesn't anything merge? | 2 recurring CI infra bugs (bun-pin SHA, ptau 403), independently fixed ≥5x, never merged | `actions_list` workflow-run history across #55/#60/#62/#63/#68/#70 |
| Is there a ready-to-merge fix for queue item #1? | **Yes** — PR #68, CI green, `mergeable_state: clean` | `pull_request_read` on #68 |
| Is E7 ("Mitigated") still true? | **No** | Direct read of `pool.move:571-630`; no test covers it |
| Does Poseidon2 reduce Groth16 constraints? | **No** (0.00% non-linear delta) | `scripts/bench/poseidon-arity.mjs` output, this PR |

## Verdict: KEEP

The deliverable is the `docs/threat-model.md` correction (a real, previously-false "Mitigated"
claim retracted) and this report, both of which should merge regardless of what happens to the
Poseidon2/gas backlog. `BASELINE.md` is unchanged (no production circuit or measured number
changed). `EXPERIMENTS.md` is re-ranked below with the RR10 fix at #1.

## Where this could be used

- **Any project running an unattended nightly agent loop against a git remote**: the actual bug
  here isn't cryptographic, it's operational — a loop that always branches from `main` and never
  checks whether its own prior output landed will silently repeat itself forever if merges don't
  happen. Any such loop needs either merge authority, a stronger nudge to a human reviewer, or a
  loop-visible signal (e.g. failing CI badge count, open-PR count) that's checked *before* picking
  the next queue item, not just after.
- **Any ZK protocol binding an on-chain action to an off-proof argument** (a recipient address, a
  destination chain ID, a fee parameter): the exact failure mode here — a public input the circuit
  computes but the verifying contract never reads — is a generic pattern worth a specific
  code-reviewer checklist item: for every public input the circuit derives from something the
  *caller* also supplies as a plain argument, confirm the contract actually compares the two.
- **A thesis chapter on "trusted setup and verification aren't the whole soundness story"**: this is
  a clean, concrete example of a completely sound circuit (the Poseidon(8, recipient) constraint is
  correctly enforced *inside* the circuit) wired to a completely unsound contract (the binding is
  never checked *outside* it) — soundness of the SNARK says nothing about correctness of its
  integration.

## Open questions (next queue)

1. **RR10 fix** — the actual circuit + contract change, with a soundness argument and negative test.
   Top of the queue now.
2. Should the next research session have narrower authority to merge its own fully-green,
   `mergeable_state: clean` CI-infra/process PRs (like #68), given the demonstrated cost of not
   doing so? Worth the repo owner's explicit decision, not this session's.
3. Once #68 merges: does its "Groth16 verification cost is flat/bucketed, storage-dominated"
   finding change the batching/aggregation experiment's expected payoff? (Re-read #68's own report
   once merged rather than re-deriving.)
4. Mobile WASM proving latency, relayer throughput/leakage, threshold auditing, revocation
   accumulators, post-quantum exposure — all still open, unchanged from before (see `EXPERIMENTS.md`).
