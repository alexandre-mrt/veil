# 2026-07-15 — `fix-stale-transfer-artifacts`

Queue item #1 (re-ranked to the top on 2026-07-14 by the `baseline` run, which found this bug but
did not fix it — see [`2026-07-14-baseline.md`](2026-07-14-baseline.md)). Explicitly **not a research
question**: this is a real, measured test-suite regression, fixed and verified with real commands.

## Hypothesis

`circuits/test/transfer.test.mjs`'s witness builder predates `transfer.circom`'s Merkle
anonymity-set membership proof (added: a `merkleRoot` public input plus `pathElements[20]` /
`pathIndices[20]` private inputs, C0 in the constraint list). Supplying those three signals to every
constructed witness makes the suite pass 40+/40+ **for real**, under an actual compiled circuit and a
real Groth16 setup — not the hash-only JS simulation that was silently absorbing the gap.

## Threat / privacy model

This is not a cryptographic change — `transfer.circom` itself is untouched. Nothing here moves what a
chain observer, relayer, or auditor can learn; the fix is confined to test tooling, one dev-only
frontend constant, and two doc files. Still, worth stating precisely what this gap could have caused
if it had reached a release build:

- **What it does NOT defend against, before the fix:** the test suite gave zero real signal on
  `transfer.circom`'s C0 (Merkle membership) constraint. A future refactor of `templates/merkle_proof.circom`
  or of the C0 wiring in `transfer.circom` could have broken anonymity-set membership checking (e.g.
  accepting a forged proof, or accepting `pathIndices` values that aren't binary) and **every existing
  test would still have reported green**, because `FULL_PROOF_AVAILABLE` mode — the only mode that
  actually invokes the compiled witness calculator and enforces R1CS constraints — threw a generic
  "Only 13 out of 54" input-count error before ever reaching the constraint logic, and the CI-facing
  `npm test` command silently fell back to a mode that doesn't compile the circuit at all when no
  `build/` directory is present.
- **What this fix does defend against, now:** two new tests (T41, T42) adversarially probe C0
  specifically — a tampered Merkle sibling, and a well-formed-but-never-deposited commitment reusing
  someone else's inclusion proof. Both are confirmed rejected by the actual compiled circuit (not the
  JS simulation), closing exactly the gap described above.
- **Assumptions unchanged:** same trusted setup (Groth16 + pot15 ptau, dev single-contributor for this
  run — production requires `ceremony.sh`), same BN254 hardness assumption, same VK-timelock key
  custody model. Nothing here touches those.
- **STRIDE mapping (`docs/threat-model.md`):** this closes a **Tampering** gap in the test harness
  itself — the test suite's job is to catch tampering with circuit logic, and it couldn't, for the
  Merkle-membership path specifically, since the artifacts needed to exercise it for real were absent.

## Approach

1. **Reproduced the finding independently**, from scratch, rather than trusting last night's report:
   compiled `transfer.circom` with `circom2` (native `circom` is still blocked by this environment's
   egress policy — reconfirmed below), ran a real Groth16 trusted setup against `pot15_final.ptau`,
   and re-ran `transfer.test.mjs` against the compiled artifacts. Got the exact same failure signature
   independently: **27 passed, 13 failed**, `"Not all inputs have been set. Only 13 out of 54"`.
2. **Found the root cause precisely**: `buildValidWitness()` (and three hand-rolled witness object
   literals used by T13, T14, T15/T16, T18, T24, T30, T35 that don't go through it) return exactly 13
   signals. The circuit now requires 54 (13 + `merkleRoot` + 20 `pathElements` + 20 `pathIndices`).
3. **Rejected** patching around it by only special-casing the happy-path tests — the 7 hand-rolled
   witness sites needed the same fix, and missing even one would have left a silent gap identical to
   the one being closed. Wrote one shared helper (`withMerkleProof`) instead of duplicating the fix 8
   times.
4. **Rejected** a fake/trivial Merkle proof that always succeeds (e.g. skip the check when `pathElements`
   is absent) — that would satisfy the test count without exercising C0 at all, reintroducing the exact
   vacuous-pass problem this fix exists to close. Used a real all-zero-sibling depth-20 proof, computed
   in JS by mirroring `templates/merkle_proof.circom`'s exact Poseidon(2)/mux logic, so C0 is genuinely
   evaluated by the compiled circuit on every witness.
5. **Added two negative tests for C0** (T41, T42) — the constraint had never been exercised by a real
   proof before tonight, positive or negative. This is the "negative test for a malicious witness"
   this kind of gap needs, even though the circuit itself didn't change.
6. **Extended `simulateTransfer`** (the hash-only fallback used when no `build/` exists) with the same
   C0 check, so the fallback mode isn't vacuous either — it now mirrors all 12 named constraints
   (C0–C11), not 11.
7. **Checked every other artifact the "stale" framing implied was broken**, rather than assuming last
   night's claim was fully accurate:
   - `frontend/public/circuits/transfer_vk.json` — confirmed genuinely stale (`nPublic: 6` vs. the
     circuit's actual 7). Regenerated from a fresh build and copied in, matching what `ceremony.sh`
     (the real production path for this file) would produce.
   - `frontend/src/hooks/useProofGeneration.ts`'s **real** proof-generation path
     (`generateRealProof`) already builds and submits `merkleRoot`/`pathElements`/`pathIndices`
     correctly — it was **not** broken, contrary to what a shallow reading of last night's PR
     description implied. The actual staleness there was narrower: a dev-only mock-proof constant,
     `MOCK_PUBLIC_INPUTS_COUNT = 6`, used only when `NODE_ENV !== "production"` and circuit artifacts
     are absent. Fixed to `7`. This distinction matters for anyone reading last night's report: the
     frontend was never one bad deploy away from submitting a rejected proof; only its dev/demo mode
     had a stale constant.
   - `CLAUDE.md` / `docs/SPEC.md` — confirmed the stale "11 constraints (transfer.circom)" / "6 public
     inputs" claims, and fixed them, adding the distinction the baseline report identified: 11 (now 12,
     with C0) is the count of *named* constraint blocks in the source comments, not the R1CS
     constraint count the prover actually pays for (13,611, unchanged, per `BASELINE.md`).
8. **Reconfirmed the `sui` CLI blocker** rather than reusing last night's claim unverified — see
   Results.

## Results

| | before | after |
|---|---|---|
| `circuits/test/transfer.test.mjs` (full Groth16 mode) | 27 passed, 13 failed | **42 passed, 0 failed** |
| `circuits/test/transfer.test.mjs` (hash-only fallback mode) | 40 passed, 0 failed (vacuous on C0 — no Merkle check simulated at all) | **42 passed, 0 failed** (C0 now checked in both modes) |
| `frontend/public/circuits/transfer_vk.json` `nPublic` | 6 (stale) | **7** (matches current `transfer.circom`) |
| `frontend/src/hooks/useProofGeneration.ts` `MOCK_PUBLIC_INPUTS_COUNT` | 6 | **7** |
| `CLAUDE.md` circuit line | "transfer.circom 11c" | 13,611 R1CS constraints / 7 public inputs, with the named-blocks-vs-R1CS distinction spelled out |
| `docs/SPEC.md` transfer.circom section | 6 public inputs, 11 constraints (no C0, no Merkle path) | 7 public inputs, 12 named constraints (C0–C11), Merkle path documented |
| `sui move test` / on-chain gas | `BLOCKED` (2026-07-14) | **still `BLOCKED`** (reconfirmed independently tonight, see below) |

### Raw output — reproducing the original failure (before the fix, this run)

```
$ node --experimental-vm-modules test/transfer.test.mjs
=== Veil Transfer Circuit Tests (v2 — audit fixes) ===
Mode: FULL PROOF (snarkjs Groth16)
...
  [FAIL] T1: Genesis transfer (cumOld=0, randOld=0, first-ever transfer)
         Not all inputs have been set. Only 13 out of 54
...
=== Results: 27 passed, 13 failed ===
```
(Full transcript matches [`2026-07-14-baseline.md`](2026-07-14-baseline.md) exactly — independent
reproduction, not copied.)

### Raw output — after the fix, full Groth16 mode (this is the mode that matters: real compiled
circuit, real trusted setup, real `snarkjs.groth16.fullProve`/`verify`)

```
$ node --experimental-vm-modules test/transfer.test.mjs
=== Veil Transfer Circuit Tests (v2 — audit fixes) ===
Mode: FULL PROOF (snarkjs Groth16)

--- Happy paths ---
  [PASS] T1: Genesis transfer (cumOld=0, randOld=0, first-ever transfer)
  [PASS] T2: Subsequent transfer (cumOld=100, txAmount=50)
  [PASS] T3: Chain of 3 transfers (state continuity)
  [PASS] T4: Transfer at exactly threshold (cumNew == threshold)
  [PASS] T5: Large values near 2^64 boundary (cumOld=2^64-200, txAmount=100)
  [PASS] T6: Different userSecrets produce isolated commitments
  [PASS] T7: Same epoch different randomness produces unique nullifiers
  [PASS] T8: Smallest valid transfer (txAmount=1)
--- Constraint violations (must be rejected) ---
  [PASS] T9..T23  (all pass — C1-C11 violations correctly rejected by the compiled circuit)
--- Edge cases ---
  [PASS] T24..T29
--- Security-specific ---
  [PASS] T30..T40
  [PASS] T41: C0 — tampered pathElement invalidates Merkle membership proof
  [PASS] T42: C0 — oldCommitment not in the tree is rejected (forged membership)

=== Results: 42 passed, 0 failed ===
```

T41/T42 fail closed at the exact expected constraint (confirmed via the wasm witness calculator's own
error, `Error in template Transfer_220 line: 61`, which is the `merkleRoot === membershipProof.root`
line in `transfer.circom` — i.e. C0, not some other constraint incidentally catching it).

### Raw output — hash-only fallback mode (no `build/` present), after the fix

```
$ mv build build_backup && node --experimental-vm-modules test/transfer.test.mjs && mv build_backup build
=== Veil Transfer Circuit Tests (v2 — audit fixes) ===
Mode: HASH-ONLY (constraint simulation)
  (Run 'npm run compile' to enable full Groth16 proof tests)
...
=== Results: 42 passed, 0 failed ===
```

### Raw output — other suites, unaffected by this change, run to confirm no regression

```
$ node --experimental-vm-modules test/compliance.test.mjs
=== Results: 30 passed, 0 failed ===

$ node --experimental-vm-modules test/withdraw.test.mjs
=== Results: 35 passed, 0 failed ===

$ cd scripts && bun run src/test-converter.ts
Results: 109 passed, 0 failed
All tests passed.

$ cd frontend && bun run test
 Test Files  3 passed (3)
      Tests  19 passed (19)
```

### Raw output — `sui` CLI, reconfirmed `BLOCKED` (not reused from last night unverified)

```
$ curl -sS -o /dev/null -w "%{http_code}\n" https://static.crates.io/crates/sui/ --max-time 10
403

$ timeout 40 cargo install --locked sui
    Updating crates.io index
 Downloading crates ...
  Downloaded sui v0.0.1
error: there is nothing to install in `sui v0.0.1`, because it has no binaries
(crates.io "sui" is an unrelated placeholder package with no binary — not Mysten's CLI)

$ timeout 120 cargo install --locked --git https://github.com/MystenLabs/sui.git --branch mainnet sui
Terminated (2 min timeout — full monorepo clone; even if unblocked, a from-source build of the
real Sui CLI is not a viable use of one night's budget)
```
`sui move test` and any on-chain gas number remain unmeasured. This is an environment limitation, not
a code issue in this PR — Move contracts were not touched.

## Verdict

**KEEP.** The fix is merged (this PR); `BASELINE.md` is updated (test-suite table + the "6 public
inputs / 11 constraints" note now point here instead of describing an open gap). All three of the
queue item's own success metrics are met:

1. `transfer.test.mjs` passes 42/42 for real, in the mode that actually compiles and proves the
   circuit — not vacuously.
2. The one git-tracked frontend circuit artifact (`transfer_vk.json`; `.wasm`/`.zkey` are gitignored
   by design and were never stale in git) now matches current `main`.
3. `CLAUDE.md` and `docs/SPEC.md` no longer claim 6 public inputs / 11 constraints for `transfer.circom`.

## Where this could be used

This specific fix is Veil-internal (test tooling), but the failure pattern it closes is general:
**any project that ships two witness-construction code paths — a "real" one that compiles/proves and
a fallback simulation for when the toolchain isn't available — will silently stop testing the real
path's newest constraints the moment CI stops compiling the circuit**, because the fallback absorbs
the drift without ever failing loudly. This is exactly the failure mode a **ZK circuit CI pipeline for
any Circom/Groth16 project** should guard against explicitly: assert `FULL_PROOF_AVAILABLE === true`
in CI (fail loudly if the compiled-circuit path silently degrades to simulation) rather than letting
both modes report a bare pass count with no indication of which one ran. Worth a follow-up: Veil's own
`circuits/package.json`'s `test` script doesn't compile the circuit first, so a fresh `git clone` +
`npm test` today silently runs hash-only mode — this PR doesn't change that (out of scope: it's a CI
config question, not a stale-artifact bug), but it is the same root cause and belongs in the queue.

## Open questions

- `circuits/package.json`'s `test` script should probably compile before testing (or CI should
  explicitly assert `FULL_PROOF_AVAILABLE`) so this exact silent-degradation pattern can't recur for
  `compliance.circom` or `withdraw.circom`, which have the same two-mode test structure and are not
  currently exercised in full-proof mode by any committed script. Candidate for the queue.
- `sui` CLI access remains the single blocker on `bulletproofs-vs-groth16` (#2, now #1) and
  `contra-hybrid-settlement` (#2) getting a real on-chain gas number for Veil's side. Needs a session
  with either a working `cargo install` path or a cached `sui` binary — re-attempting the identical
  blocked path nightly is not worth repeating without a change in environment.
