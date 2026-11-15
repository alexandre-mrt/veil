# 2026-11-15 — compliance-transfer-binding

**Verdict: KEEP** (circuit + contract change, full suite green; needs a timelocked compliance-VK
rotation to take effect on a live pool).

## Why this experiment, and not the top of the queue

`main`'s `EXPERIMENTS.md` still lists on-chain gas (#1) and Poseidon2 (#2) at the top, and
`main`'s `LEDGER.md` has one row. That is not the real state of the loop. `git branch -r` shows
~110 nightly branches since 2026-07-22 whose PRs were never merged, so every night forks from the
same stale ledger and re-runs the same two items. Collected across all remote branches tonight
(command in "Raw output" §0):

- **Poseidon2 swap**: settled **REJECT** at least 15 times (e.g. 2026-08-05, 08-15, 09-30,
  11-08, 11-11, 11-12, 11-14). Not re-run tonight.
- **On-chain gas per entry point**: settled **KEEP** at least 20 times (e.g. 2026-11-13: localnet,
  real proofs, `shielded_transfer` 3,116,144 MIST net). Not re-run tonight.
- Mobile WASM latency (KEEP 09-28), Merkle zero-hash pruning (KEEP 08-31) also already done.

The 2026-11-13 gas run reproduced two **security bugs on-chain**, both still present on `main`:

1. `zk_withdraw` never checks `recipient` against `recipientHash`. A fix exists, unmerged, on
   commit `fdbc193` (2026-09-24). Tonight I re-checked `main`'s `pool.move` (`zk_withdraw`): still
   no check. Out of scope tonight because a fix is already written. `threat-model.md` E7 is
   corrected from "Mitigated" to "Not mitigated on `main`" so the doc stops claiming otherwise.
2. `compliant_transfer` accepted a compliance proof built from **another user's credential**. No
   branch has fixed it. **That is tonight's experiment.** It is queue item "independent circuit
   soundness audit" narrowed to one concrete, already-reproduced, unmitigated threat.

## Hypothesis

Binding the compliance proof to the paired transfer proof (circuit:
`contextId := Poseidon(2, userSecret, transferEpochId, transferRandomnessOld)`, i.e. the transfer
nullifier; contract: `contextId == transfer nullifier`) blocks cross-user credential reuse (attack
success 1 → 0 on real Groth16 proofs) and costs **≤ 2% compliance constraints and ≤ 5%
compliance proving time**.

## Threat / privacy model

**Adversary: credential lender / non-KYC'd spender (malicious prover).** Alice holds one valid KYC
credential in the issuer tree. Bob has no credential but wants to move more than the Tier-2
threshold through a compliance-required pool.

*Before*, on `main`:
- `compliance.circom` proved `contextId = Poseidon(6, transferNullifier, userSecret)` with
  `transferNullifier` a **private** input that nothing tied to anything.
- `compliance.move::compliant_transfer` never read `contextId` (bytes 64..96) at all. It checks
  root, epoch, KYC level, credential nullifier freshness, `validCredential == 1`, and the proof.
- So Alice can make a fresh valid compliance proof for every transfer Bob makes: any
  `transferNullifier` gives a fresh `contextId`, which gives a fresh credential nullifier
  `Poseidon(5, userSecret, contextId)`, so the "spent" check never fires. **One KYC'd identity can
  vouch for any number of other people's transfers, without limit and without anyone seeing it.**
  This voids the main promise of Tier 3 compliance: that above-threshold volume belongs to a
  KYC'd person. (Reproduced on localnet on 2026-11-13. Reproduced tonight with real proofs at the
  circuit/byte level, §Results Part 1.)

*After*:
- The circuit derives `contextId` from the **same** `userSecret` that opens the credential leaf
  (C1/C2), using the transfer circuit's own nullifier formula (tag 2).
- The contract asserts `compliance_inputs[64..96] == transfer_inputs[128..160]` (new abort
  `E_COMPLIANCE_TRANSFER_MISMATCH = 116`), before any proof verification.

What an observer sees: nothing new. `contextId` is now byte-equal to the transfer nullifier. That
nullifier is already public in the same transaction (`TransferEvent.nullifier`), and the two proofs
were always submitted together in one `compliant_transfer` call. Before the change, `contextId` was
a fresh-looking hash, but linking the compliance proof to the transfer took zero effort anyway (same
tx). The credential nullifier `Poseidon(5, userSecret, contextId)` still changes on every transfer
(the transfer nullifier is unique per spend), so two compliant transfers by the same person still
cannot be linked to each other through the compliance proof. **Leakage delta: none.**

**What this does NOT defend against (residual surface):**
- **Secret sharing.** If Alice gives Bob her `userSecret`, Bob can spend under Alice's credential.
  But then Bob's commitments are opened by Alice's secret, so Alice can spend Bob's funds too. This
  is the same trust as handing over a private key, and no ZK scheme can stop it. A credential
  issuer who wants to prevent it needs hardware-bound keys, which is out of scope.
- **Sybil on the threshold (RR3/E6).** Unchanged. One person with many `userSecret`s still gets
  many per-secret counters. Each compliant transfer now needs a credential *for that secret*, which
  makes Sybil above-threshold transfers cost one KYC each. That is a strict improvement, not a fix.
- **The recipient-binding bug (E7)** is separate and still open on `main` (fix on `fdbc193`).
- **Auditor ciphertext binding.** `encrypted_amount` is still not bound inside any proof. It is
  only length-checked on-chain. Out of scope, recorded as an open question.
- **Live pools.** The fix only applies once the new compliance VK replaces the old one via the
  existing 1-epoch timelock (`propose_compliance_vk_update`). Until then the old VK accepts
  old-shape proofs, and their `contextId` ≠ transfer nullifier, so **the new contract check rejects
  every compliant transfer until the VK rotates.** Deploy order: propose VK → wait one epoch →
  upgrade package (or ship both together while compliance is off).

**Assumptions:** Poseidon (circomlib, BN254, t=5) collision resistance, which the transfer
nullifier already relies on. Groth16 knowledge soundness under the existing (dev,
single-contributor, RR2) setup. The issuer issues credentials over the user's master
`userSecret`. That is already what the frontend does: `useCompliantTransfer.ts` passes
`privateState.userSecret` to both proofs.

**STRIDE mapping (`docs/threat-model.md`):** new **E8** (Elevation of Privilege, borrow someone's
KYC credential): Mitigated. **S3** (replay): unchanged, still holds. **E5** (bypass compliance):
strengthened, because before this the compliance proof was not tied to the spender at all. **E7**
corrected to "Not mitigated on `main`".

## Soundness argument

Assume the contract accepted `(π_T, x_T, π_C, x_C)`, with transfer nullifier `x_T.nf` and
compliance `x_C.contextId`, and `x_T.nf = x_C.contextId` (checked on-chain). By knowledge
soundness:

- from π_T, an extractor gets `(s_T, e_T, r_T)` with `x_T.nf = P(2, s_T, e_T, r_T)` (transfer C10).
  The same `s_T` opens `oldCommitment = P(1, cum, r_T, s_T)` (C1);
- from π_C, it gets `(s_C, e_C, r_C, kyc, exp, iss, path)` with
  `x_C.contextId = P(2, s_C, e_C, r_C)` (C_BIND) and `P(4, s_C, kyc, exp, iss)` in the credential
  tree under the on-chain root (C1, C2).

Equality gives `P(2, s_T, e_T, r_T) = P(2, s_C, e_C, r_C)`. Unless the prover found a Poseidon
collision, `s_C = s_T`. So the credential in the issuer tree was issued to the same secret that owns
the commitment being spent. ∎

Domain separation: tag 2 is reused **on purpose**, and only for the identical 4-input formula, so
there is no cross-domain confusion: both sides compute "the transfer nullifier". Tag 6 is retired.
It must not be reused for a different 3-input hash, because old proofs carry `P(6, ·, ·)` values,
which the contract now rejects anyway. The credential nullifier (tag 5) still has a different tag
and arity from everything else.

Grace-period epochs: `transferEpochId` is private and need not equal `currentEpoch`. It only has to
reproduce the transfer nullifier, and the transfer proof already pins its own epoch on-chain. CC34
shows that a wrong epoch cannot reproduce it.

## Approach

Built:
- `circuits/compliance.circom`: C_BIND is now `Poseidon(4)` over
  `(2, userSecret, transferEpochId, transferRandomnessOld)`. The private input `transferNullifier`
  is replaced by `transferEpochId` and `transferRandomnessOld`. Public-input layout is unchanged
  (6 signals, `contextId` at bytes 64..96), so the Move byte parsing does not change.
- `contracts/sources/compliance.move`: a transfer-inputs length check plus a `contextId ==
  nullifier` assert, placed before any Groth16 verification (cheap abort). New code 116.
- Clients: `frontend/src/hooks/useComplianceProof.ts` / `useCompliantTransfer.ts` capture the
  epoch and `randomnessOld` used for the transfer proof and pass them to the compliance proof, with
  a client-side check that the recomputed `contextId` equals the transfer nullifier.
  `scripts/src/e2e-compliance-test.ts` and `scripts/bench/witnesses.mjs` follow the new witness
  shape.
- Tests: `circuits/test/compliance.test.mjs` CC31–CC34 (owner binding, real Groth16) and existing
  tests ported to the new inputs. `contracts/tests/compliance_tests.move` tests 18–20.
- Bench: `scripts/bench/build-circuit.sh` (compile + dev setup for any circuit) and
  `scripts/bench/compliance-binding.mjs` (attack demo + interleaved A/B proving time).

Rejected before building:
- **Expose `transferNullifier` as a 7th compliance public input** and compare on-chain. It is
  equivalent in leakage, but it only proves "the prover knows the transfer nullifier", which is
  public. It does not prove "same secret". It would leave the attack fully open. The binding has to
  go through `userSecret`.
- **Keep `contextId = P(6, nf, s)` and recompute it on-chain.** That needs `userSecret` on-chain,
  so it is impossible.
- **Merge the two circuits into one proof** (transfer + compliance). That gives the strongest
  binding and saves one on-chain Groth16 verify, but it means a new transfer VK, a new tx shape,
  and a re-audit of both circuits. It is the right long-term direction (recorded as an open
  question), but too big for one night.
- **Bind via `oldCommitment`** (`contextId = oldCommitment`). The transfer nullifier is better: it
  is unique per spend, while `oldCommitment` is not unique if a user ever re-derives one. The
  nullifier is also already what the old code tried to bind to.

## Results

| Metric | Baseline (`main`) | After | Δ |
|---|---|---|---|
| Alice's credential accepted for Bob's transfer (real proofs) | **yes**: proof verifies, contract never compares `contextId` | **no**: witness unsatisfiable (C_BIND, line 96). An honest-shape proof gives `contextId ≠ nf` → abort 116 | attack closed |
| Move: mismatched `contextId` / transfer nullifier | passes binding (aborts later at 102, root) | aborts **116** | — |
| compliance R1CS constraints | 12,743 | 12,874 | +131 (+1.03%) |
| non-linear / linear | 6,057 / 6,686 | 6,093 / 6,781 | +36 / +95 |
| wires / private inputs | 12,762 / 45 | 12,894 / 46 | +132 / +1 |
| zkey bytes (dev setup) | 5,682,141 | 5,727,549 | +45,408 (+0.8%) |
| vk bytes / public inputs | 3,842 / 6 | 3,842 / 6 | 0 |
| Node proving time, interleaved, 20 runs (run 2) | 800.8 ms (sd 33.0) | 820.9 ms (sd 36.6) | +20.1 ms (+2.5%, 1.8 SE) |
| Node proving time, interleaved, 20 runs (run 1) | 772.8 ms (sd 31.5) | 789.0 ms (sd 30.1) | +16.2 ms (+2.1%, 1.7 SE) |
| On-chain gas of `compliant_transfer` | 5,288,528 MIST (2026-11-13, unmerged branch) | **UNMEASURED** | two 32-byte extracts + compare, before verification |
| Full suite | — | Move 127/127; circuits 43 + 34 + 35; scripts 3/3; frontend tsc ✓ biome ✓ vitest 19/19 | — |

Both proving-time deltas fall under 2 SE. Honest reading: about +2% (one more Poseidon width step,
t=4 → t=5), within the ≤5% budget. The gas row is UNMEASURED tonight: a localnet deploy with
real-proof compliant transfers was the 2026-11-13 night's whole budget. The added Move work is O(1)
byte comparisons, but that is a claim, not a measurement.

Hypothesis **confirmed**: attack success 1 → 0, constraints +1.03% (≤2%), proving +2.1–2.5% (≤5%).

### Raw output

§0 — loop state across branches (abridged, full list in the session):
```
$ for b in $(git branch -r | grep -E 'origin/(research|claude)/'); do git show $b:docs/research/LEDGER.md 2>/dev/null | grep -E '^\| 20'; done | sort -u | awk -F'|' '{print $2 "|" $3 "|" substr($5,1,60)}' | sort -u
 2026-08-05 | `poseidon2-arity-mismatch` | **REJECT**
 2026-09-21 | `backlog-audit-and-recipient-binding-vuln` | **KEEP**
 2026-09-24 | `recipient-binding-fix` | **KEEP**
 2026-11-08 | `poseidon2-r1cs` | **REJECT**
 2026-11-11 | `poseidon2-r1cs-cost` | **REJECT**
 2026-11-12 | `poseidon2-folded-linear-layers` | **REJECT** (rematch, disclosed)
 2026-11-13 | `onchain-gas-per-entry` | **KEEP**
 2026-11-14 | `poseidon2-merkle-arity` | **REJECT** (Poseidon2) / **PARK** (4-ary tree)
 ... (~110 rows total; none on compliance/transfer binding)
```

Toolchain unblocked tonight (both were "BLOCKED" on many nights):
```
$ ~/bin/circom --version            # github.com release asset, HTTP 200
circom compiler 2.2.2
$ ~/bin/sui --version                # sui-testnet-v1.72.1-ubuntu-x86_64.tgz from github.com releases
sui 1.72.1-94ad8ccd0ed6
$ curl ... https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
403        # → local dev pot15: snarkjs powersoftau new/contribute/prepare phase2 (6m54s)
```

Baseline build (`git show main:circuits/compliance.circom`):
```
$ bash scripts/bench/build-circuit.sh compliance.circom circuits/build-compliance-baseline
circom: circom compiler 2.2.2
template instances: 224
non-linear constraints: 6057
linear constraints: 6686
public inputs: 6
private inputs: 45
public outputs: 0
wires: 12762
labels: 19117
[INFO]  snarkJS: # of Constraints: 12743
-rw-r--r-- 1 root root 5682141 Nov 15 07:12 .../build-compliance-baseline/compliance_final.zkey
-rw-r--r-- 1 root root    3842 Nov 15 07:12 .../build-compliance-baseline/compliance_vk.json
```

After build:
```
$ bash scripts/bench/build-circuit.sh compliance.circom circuits/build-compliance
circom: circom compiler 2.2.2
template instances: 297
non-linear constraints: 6093
linear constraints: 6781
public inputs: 6
private inputs: 46
public outputs: 0
wires: 12894
labels: 19351
[INFO]  snarkJS: # of Constraints: 12874
-rw-r--r-- 1 root root 5727549 Nov 15 07:13 .../build-compliance/compliance_final.zkey
-rw-r--r-- 1 root root    3842 Nov 15 07:13 .../build-compliance/compliance_vk.json
```

Attack + A/B (witness-generator error lines filtered):
```
$ node scripts/bench/compliance-binding.mjs --runs 20
=== compliance-binding (node v22.23.4, linux/x64) ===
Bob's public transfer nullifier: 10821658901894512401628061431649099762636789657589423138406199972229135425455
--- Part 0: cross-circuit — real transfer proof vs real bound compliance proof ---
transfer proof verifies: true; compliance proof verifies: true
transfer publicSignals[4] (nullifier, bytes 128..160) == compliance publicSignals[2] (contextId, bytes 64..96): true
--- Part 1: Alice's credential vouching for Bob's transfer ---
[baseline] Alice proof verifies: true
[baseline] contextId == Bob's transfer nullifier: false (main's compliance.move never compares them -> ACCEPTED on-chain)
[bound]    Alice witness with contextId := Bob's nullifier rejected: true (Error: Assert Failed. Error in template Compliance_296 line: 96)
[bound]    Alice's honest-shape proof verifies: true, contextId == Bob's nullifier: false -> compliance.move aborts 116
[bound]    (control) owner-bound proof verifies: true, contextId == transfer nullifier: true
--- Part 2: proving time, interleaved, 20 runs each (+2 warm-up) ---
baseline  mean 800.8 ms  sd 33.0  median 797.7  min 741.9
bound     mean 820.9 ms  sd 36.6  median 817.5  min 777.2
delta     +20.1 ms (2.5%), 1.8 SE
```
(First run, before Part 0 was added: baseline 772.8 / sd 31.5, bound 789.0 / sd 30.1, +16.2 ms,
+2.1%, 1.7 SE.) Line 96 of `compliance.circom` is `contextId === ctxHash.out;` (C_BIND).

Negative tests, circuit (real Groth16, full-proof mode):
```
$ node --experimental-vm-modules test/compliance.test.mjs
--- Owner binding (credential holder == transfer owner) ---
ERROR:  4 Error in template Compliance_296 line: 96
  [PASS] CC31: credential holder cannot bind to someone else's transfer nullifier (C_BIND)
ERROR:  4 Error in template Compliance_296 line: 73
  [PASS] CC32: switching to the transfer owner's secret breaks credential membership (C2)
  [PASS] CC33: owner's compliance proof exposes contextId == transfer nullifier
ERROR:  4 Error in template Compliance_296 line: 96
  [PASS] CC34: wrong transferEpochId cannot reproduce the transfer nullifier
=== Results: 34 passed, 0 failed ===
```

Negative test, Move: the new attack test **fails against `main`'s `compliance.move`** (so it
really tests the fix) and passes with it:
```
$ git show main:contracts/sources/compliance.move > contracts/sources/compliance.move && sui move test other_transfer
[ FAIL    ] veil::compliance_tests::test_compliance_proof_for_other_transfer_rejected
... Expected test to abort with code 116 originating in the module veil::compliance but instead it aborted with code 102 ...
Test result: FAILED. Total tests: 1; passed: 0; failed: 1

$ (patched) sui move test
[ PASS    ] veil::compliance_tests::test_compliance_binding_rejects_short_transfer_inputs
[ PASS    ] veil::compliance_tests::test_compliance_proof_bound_to_transfer_passes_binding
[ PASS    ] veil::compliance_tests::test_compliance_proof_for_other_transfer_rejected
Test result: OK. Total tests: 127; passed: 127; failed: 0
```

Full suite (CI's commands, `.github/workflows/ci.yml`; there is no CLAUDE.md in the repo):
```
cd contracts && sui move test          → Test result: OK. Total tests: 127; passed: 127; failed: 0
cd circuits && npm test                → transfer 43/0, compliance 34/0, withdraw 35/0 (FULL PROOF mode)
cd scripts && bun run src/test-converter.ts       → All tests passed.
cd scripts && bun run src/test-compliance-utils.ts → All tests passed.
cd scripts && bun run src/fuzz-tests.ts           → ALL 6 PROPERTIES PASSED
cd frontend && bunx tsc --noEmit       → exit 0
cd frontend && bunx biome check .      → exit 0
cd frontend && bunx vitest run         → Test Files 3 passed (3), Tests 19 passed (19)
```

## Verdict — KEEP

It closes a reproduced, unmitigated privilege-escalation threat (E8). The cost is +1.0% constraints
and about +2% proving time, with no leakage delta, a soundness argument, and real-proof negative
tests on both layers. `BASELINE.md`, `docs/threat-model.md` and `docs/SPEC.md` are updated.
**Deployment note:** the contract change and the compliance VK must go live together (see the
residual-surface bullet about live pools).

## Where this could be used

- **Any two-proof "spend + attestation" design** where the attestation is a separate SNARK:
  Zcash-style shielded pools with a compliance sidecar proof, Railgun-style "Private Proofs of
  Innocence", and Privacy Pools association-set proofs submitted next to a withdrawal. The generic
  lesson: an attestation proof must recompute a value the spend proof makes public *from the same
  secret*. Hiding a link value (the old `P(6, nf, s)`) without checking it binds nothing.
- **Confidential payroll on Sui with KYC'd employees:** each above-threshold salary payout proves
  that the payee's own credential covers it, so an HR operator holding one credential cannot
  launder payouts for unverified contractors.
- **Thesis chapter on composition soundness of multi-proof transactions:** a worked example of a
  binding that existed in the circuit but not in the verifier. It is the same bug class as E7
  (recipient). Both public inputs were "verified by the proof" but never compared on-chain with the
  value they were meant to bind.

## Open questions → queue

1. **Public-input binding audit across every entry point.** E7 and E8 are the same bug class: a
   public input is proven but never compared on-chain. Do a mechanical table of every public input
   of all three circuits against what the Move code compares it to, plus a negative Move test per
   row. Cheap, and the two bugs found so far were both in this class.
2. **Merge recipient-binding fix `fdbc193` (E7)** and the backlog in general. This is for the
   owner, not the loop.
3. **Single combined transfer+compliance circuit.** It saves one `sui::groth16` verify per
   compliant transfer and makes the binding structural. Measure constraints, proving time and gas
   against two separate proofs.
4. **Bind `encrypted_amount` (auditor ciphertext) inside a proof.** Today it is only
   length-checked, so a prover can attach garbage and the auditor learns nothing.
5. **Measure `compliant_transfer` gas with the binding** on localnet (the 2026-11-13 harness).
   Expected to stay in the same computation bucket, but unmeasured.
