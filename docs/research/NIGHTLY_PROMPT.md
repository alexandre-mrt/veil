# Veil — Nightly Research Loop (prompt for scheduled cloud agent)

Paste everything below the line into the Claude Code app as the recurring prompt.
Recommended: 1 run/night, effort `xhigh`, repo `alexandre-mrt/veil`, base branch `main`.

---

You are running one iteration of Veil's **nightly cryptography & scalability research loop**.
Veil is a ZK privacy payment protocol on Sui (Circom/Groth16 + Move + Next.js). Read `CLAUDE.md`
first — it holds the architecture, build and test commands.

Your job tonight is **one measured experiment**, merged as a PR, and permanently documented.
Not a refactor. Not a sweep of small fixes. One hypothesis, tested, with numbers.

## 0. State of the loop

The substrate already exists — read it, don't recreate it:
- `docs/research/LEDGER.md` — append-only, one row per night, with the verdicts so far.
- `docs/research/EXPERIMENTS.md` — the ranked queue.
- `docs/research/2026-07-14-contra-confidential-transfers.md` — a worked example of the expected
  report shape (hypothesis → threat model → measured results → verdict → use cases).

**`BASELINE.md` does not exist yet, and it is queue item #1.** Veil's own numbers — per-circuit
constraints, proving time, proof/VK size, on-chain gas per entry point, browser proving latency —
have never been measured in one run on one machine. Until they exist, every comparison is half-blind.
If tonight is the first run, build it: every number from a command you actually ran, raw output
pasted, plus a reusable `scripts/bench/`.

## 1. Pick tonight's experiment

Read `docs/research/LEDGER.md` and `docs/research/EXPERIMENTS.md`.
Take the **highest-ranked queue item not already `KEEP`/`REJECT`**. Never redo a settled experiment —
if you think a `REJECT` deserves a rematch, say why explicitly in the report and re-rank it, don't silently
re-run it. Re-rank the queue at the end of the night based on what you learned.

Two experiments max per night, and only if the first came back `BLOCKED` on a missing toolchain.

## 2. Experiment axes

**Cryptography**
- Proof system: Groth16 → PLONK / Halo2 / Nova-Folding; trusted-setup elimination; recursion for batching.
- Hash & commitments: Poseidon2 vs Poseidon, arity tuning, domain-tag audit, Pedersen/Sinsemilla comparison.
- Circuit soundness: under-constrained signals, alias checks on field elements, nullifier collision surface,
  malleability of the (proof, publicSignals) pair, VK-swap and epoch-boundary attacks.
- Compliance: dual-proof composition cost, credential nullifier context binding, revocation-friendly
  accumulators (RSA / KZG / Verkle) vs the current depth-20 Merkle tree.
- Auditor path: ECDH P-256 + AES-GCM padding analysis, forward secrecy, threshold auditing (t-of-n) vs
  the current single auditor key.
- Post-quantum exposure: which primitives break, what a migration would cost.

**Scalability**
- Constraint reduction per circuit (the number that dominates prover time).
- Batch / aggregated proofs: N transfers → 1 on-chain verification; recursion vs proof aggregation.
- Merkle accumulator: batch insertion, incremental roots, sparse trees, depth vs anonymity-set trade-off,
  off-chain indexer throughput at 10⁵–10⁷ commitments.
- On-chain gas: `sui::groth16` call cost, PTB packing, shared-object contention on the pool
  (`ExecutionCancelledDueToSharedObjectCongestion` under concurrent transfers — measure it).
- Client: WASM proving latency on mobile, parallel witness generation, precomputed VK caching.
- Relayer: throughput, rate-limit behaviour, sender-privacy leakage under load.

Prefer experiments that move a number Veil actually pays for: prover time, gas, anonymity-set size,
or a threat currently unmitigated.

## 3. Execute — evidence or it didn't happen

- Work on a fresh branch: `research/YYYY-MM-DD-<slug>`. **Never push to `main`.**
- Install what you need (circom, snarkjs, sui CLI, bun). If a toolchain genuinely cannot be installed in
  this environment, mark the experiment `BLOCKED`, write down exactly what was missing, and fall back to a
  **design-only** experiment — which must be labelled `UNMEASURED` everywhere it appears. Never estimate a
  benchmark and present it as a measurement.
- Every number in the report comes from a command whose raw output you paste. No extrapolation without
  saying it is one.
- Benchmarks must be reproducible: add or extend a script under `scripts/bench/` and cite the exact command.
- Any circuit change requires, in the same PR: (a) a soundness argument, (b) a leakage analysis — what a
  chain observer learns that they didn't before, (c) at least one **negative test** proving a malicious
  witness is rejected.
- Before opening the PR, run the full suite from `CLAUDE.md` (Move + circuits + converter + frontend + E2E).
  Green → normal PR. Red → open it as a **draft** with the failure and its root cause documented.
  Never loosen, skip, or fudge a test to get green. A broken invariant is a finding, not an obstacle.

## 4. Document — the real deliverable

Write `docs/research/YYYY-MM-DD-<slug>.md`:

```markdown
# <Experiment title>
Date · Branch · Verdict: KEEP | REJECT | PARK | BLOCKED

## Hypothesis
One sentence, falsifiable, with the number it should move.

## Threat / privacy model
- **What this defends against** — the concrete adversary: chain observer, colluding relayer, malicious
  auditor, honest-but-curious validator, statistical deanonymiser, quantum adversary, malicious prover.
  Name their capabilities and what they observe.
- **What it does NOT defend against** — the residual attack surface after this change. Be blunt.
- **Assumptions** — trusted setup, hardness assumption, honest-majority, key custody.
- **Where it maps in `docs/threat-model.md`** — cite the STRIDE entries covered or newly exposed.

## Approach
What was built, and the alternatives considered and rejected before building it (and why).

## Results
Baseline vs after, in a table. Raw command output below it. Deltas in % and absolute.

## Verdict & rationale
KEEP → merged, `BASELINE.md` updated with the new numbers.
REJECT → why it lost; keep the branch, do not delete the knowledge.
PARK → promising but blocked on X; add X to the queue.

## Where this could be used
Beyond Veil: which protocol classes, which real deployments, which thesis chapter. Be specific —
"confidential payroll on Sui with a t-of-n auditor board", not "privacy applications".

## Open questions
Feeds tomorrow night's queue.
```

Then, in the same PR:
- Append one row to `docs/research/LEDGER.md`.
- Re-rank `docs/research/EXPERIMENTS.md`, adding what tonight's open questions surfaced.
- If `KEEP`: update `BASELINE.md`, and update `docs/threat-model.md` / `docs/SPEC.md` if the security
  properties changed.

## 5. Close out

Open the PR: title `research: <slug>`, body = hypothesis, headline number, verdict, and the list of files
changed. Then reply with a ≤10-line summary: what was tested, the number, the verdict, what's next.

**Stop criteria** — end the night when the experiment reaches a verdict, or when you have spent the run
without a measurable result. In that case commit the partial work, mark it `PARK` with an honest account of
where you got stuck, and stop. A documented dead end is a successful night. Silently inventing a plausible
benchmark is a failed one.
