# 2026-09-24 — Fix the unmitigated recipient-binding vulnerability (E7 / RR10)

## Hypothesis

`pool::zk_withdraw` can be made to reject any `(proof_bytes, public_inputs_bytes, recipient)`
triple where `recipient` does not match the proof's committed `recipientHash`, by recomputing
`Poseidon(8, recipient)` on-chain with Sui's native `sui::poseidon` precompile and asserting
equality — closing a fund-theft vulnerability — **without** a circuit change, a VK rotation, or
any loosening of an existing test. The number this moves isn't a performance metric: it's the
count of unauthenticated public inputs in `zk_withdraw` that actually get checked against the
value the caller supplies, from 0 to 1.

## Why this jumped the queue

Tonight's queue (`EXPERIMENTS.md`, as merged on `main`) still lists on-chain gas as item #1 — but
that ranking predates a finding that was never merged. Before starting anything, I checked the
open-PR backlog (10 open PRs, `#64`–`#73`, since 2026-07-28) because so many nightly runs had
clearly been re-deriving the same two experiments. `#71` (2026-09-21, "audit stuck PR backlog,
correct false E7 mitigation claim") had already found and documented a critical, unpatched
recipient-substitution bug in `pool::zk_withdraw`, and proposed `docs/threat-model.md`'s new RR10
as the real queue item #1 — but `#71` itself is still open, so none of that ever landed on `main`,
and the false "Mitigated" claim was still live. I re-read `contracts/sources/pool.move:571-630`
against current `main` independently before trusting that PR's claim, confirmed it, and decided
fixing it outranks any further Poseidon2/gas rerun: "closes a threat currently unmitigated" is
this queue's own stated top value, and this is the only entry that qualifies as a live one.

## The vulnerability, confirmed

`withdraw.circom`'s public inputs are `[commitment, withdrawAmount, nullifier, recipientHash,
newCommitment]`. `recipientHash = Poseidon(8, recipient)` is a real circuit constraint (C9) — the
*proof* is genuinely bound to a specific recipient. But a Groth16 public input only constrains
what the **verifier** checks it against. Before this fix, `pool::zk_withdraw` extracted
`recipientHash` from the public inputs, verified the proof, and then never looked at
`recipientHash` again — it just sent the withdrawn balance to whatever `recipient: address` the
*caller* passed as a separate, unconstrained function argument:

```move
// bytes 96-128 (recipientHash) are verified by the proof itself.
...
transfer::public_transfer(withdrawn, recipient);
```

"Verified by the proof itself" was the bug: the proof verifies that `recipientHash` *equals*
`Poseidon(8, someRecipient)` for whatever `someRecipient` the prover used — it says nothing about
whether the `recipient` argument on this particular call matches that value. Anyone who observed
a valid `(proof_bytes, public_inputs_bytes)` pair — front-run from the mempool, copied from a
relayer log, or simply resubmitted before the legitimate transaction landed — could call
`zk_withdraw` themselves with their own address as `recipient`. The proof still verifies
(`recipientHash` is unchanged), the nullifier still gets consumed (permanently blocking the real
owner from ever withdrawing that commitment again), and the funds go to the attacker.

## Threat / privacy model

- **Adversary**: any on-chain observer or mempool watcher — no privileged position needed. This
  is a passive, permissionless attack: watch for a `zk_withdraw` transaction (or its sponsored
  equivalent from the relayer), extract `proof_bytes`/`public_inputs_bytes` from the transaction
  data, and resubmit with a substituted `recipient` and higher gas, before or instead of the
  original.
- **What they could do (before this fix)**: steal the full withdrawn amount from any pending
  withdrawal, and permanently block the legitimate owner (the nullifier is now spent).
- **What they still cannot do (after this fix)**: forge a proof for a commitment they don't own
  (Groth16 soundness, S2, unaffected), replay an already-consumed nullifier (S3, unaffected), or
  redirect funds without ever seeing a valid proof for that commitment in the first place. The fix
  only closes the recipient-substitution path; it does not add sender privacy, and withdrawals
  remain visible on-chain by design (`withdraw.circom`'s own header comment: "the exit path is
  identifiable").
- **Residual surface**: none new. The fix adds exactly one equality check; it introduces no new
  trust assumption beyond what `sui::poseidon::poseidon_bn254` already is (a native precompile in
  the same trust boundary as `sui::groth16`, which every proof-verification path in this protocol
  already depends on).
- **Assumptions**: Groth16 soundness (unchanged), BN254 discrete log hardness (unchanged), and now
  additionally that `sui::poseidon::poseidon_bn254` implements the same Poseidon permutation as
  `circomlib`'s `Poseidon` template — **not assumed, verified below**.
- **STRIDE mapping**: `docs/threat-model.md` E7 (Elevation of Privilege — front-run ZK withdrawal
  to steal funds), previously mismarked "Mitigated" on a circuit-only argument that never covered
  the on-chain half.

## Approach

**Rejected: change the circuit.** Exposing `recipient` as a raw public input (dropping the
Poseidon hash entirely, since withdrawals aren't anonymous anyway) would also work and is simpler
in the circuit, but it requires a new verifying key, a VK-rotation ceremony
(`propose_withdraw_vk` + 1-epoch timelock), and re-deriving every in-flight proof against the new
VK. The bug is entirely on the Move side — the circuit's binding was always sound — so touching
the circuit would be strictly more risk for no additional soundness.

**Chosen: recompute the hash on-chain.** Sui ships a native BN254 Poseidon precompile
(`sui::poseidon::poseidon_bn254`, added for zkLogin) in the exact framework revision this repo
already pins (`Move.toml`'s `rev = "94ad8ccd0ed6..."`). If it implements the same permutation
`circomlib`'s `Poseidon` template does, `pool::zk_withdraw` can recompute `Poseidon(8, recipient)`
itself and assert it against the claimed `recipientHash` — zero circuit changes, zero VK rotation.

That assumption needed checking, not trusting — Sui addresses are 32 bytes (256 bits) but the
BN254 scalar field is quite a bit smaller (~2^253.97), so `sui::address::to_u256(recipient)`
(which treats the address as a big-endian 256-bit integer) is **not always a canonical field
element**: roughly 3 out of every 4 raw addresses exceed the field size. `verifier::recipient_to_field`
reduces mod the field, matching what the circuit's `recipient` signal must already be (a
`circom` signal *is* a field element; a witness generator that never reduced would already have
been broken for most real addresses). This reduction is 4-to-1, not 1-to-1 — but every other
32-byte value that reduces to the same residue is a uniformly random point in a ~2^256 space that
nobody can select a keypair for (Sui addresses are hash-derived; you cannot choose your own).
Finding a second valid address in the same residue class costs the same ~2^256 work as breaking
the address hash's preimage resistance, so the reduction does not weaken the binding.

**Verified, not assumed: does `sui::poseidon::poseidon_bn254` match `circomlib`?** Fetched a
prebuilt `sui` 1.72.1 CLI binary matching `Move.toml`'s pinned commit *exactly*
(`sui 1.72.1-94ad8ccd0ed6`, confirmed via `sui --version`) and wrote
`contracts/tests/poseidon_compat_tests.move`, asserting `poseidon_bn254` against four reference
vectors computed independently with `circomlibjs 0.1.7`'s `buildPoseidon()` — the same
permutation `withdraw.circom`'s `Poseidon(2)` template compiles to. All four matched exactly (raw
output below). This is the actual crux of the fix's soundness: if it hadn't matched, the whole
approach would have been wrong and the circuit-change path would have been the only option.

**Negative test, with a real proof, not a simulated one.** Built `withdraw.circom` with `circom`
2.2.2, ran a fresh local Groth16 trusted setup (`pot13`, since `storage.googleapis.com`'s
published ptau is 403-blocked here, same as every prior night — generated locally instead,
following `#70`'s approach), generated a real witness and a real proof for a withdrawal bound to
`@0xD`, and independently verified it with `snarkjs.groth16.verify` before embedding it in
`contracts/tests/pool_withdraw_recipient_binding_tests.move`. That file reproduces the exact
attack: submits the *same* real, valid `(proof_bytes, public_inputs_bytes)` with `recipient =
@0xC` (attacker) instead of `@0xD` (the address the proof actually commits to). Before the fix
this succeeded and stole the funds; after the fix it aborts with `E_INVALID_RECIPIENT`. A second
test confirms the fix doesn't collaterally reject the legitimate withdrawal to `@0xD`.

The fixture-generation script is reusable: `scripts/bench/recipient-binding-fixture.mjs` (it
regenerates a fresh, differently-randomized but equally valid proof over the same witness on
every run — Groth16 proofs aren't deterministic — so the embedded fixture is a frozen, pre-verified
snapshot rather than something CI regenerates from scratch).

## Results

| Check | Before | After | Command |
|---|---|---|---|
| Recipient substitution with a real, valid proof | **succeeds** (funds stolen, nullifier burned) | **aborts**, `E_INVALID_RECIPIENT` (30) | `sui move test` (see raw output) |
| Legitimate withdrawal (correct recipient) | succeeds | still succeeds | `sui move test` |
| `sui::poseidon::poseidon_bn254` vs. `circomlibjs` Poseidon | unverified assumption | **verified identical**, 4/4 vectors | `sui move test poseidon_compat` |
| Full Move suite | 124 pass | **127 pass** (+3: poseidon compat, 2 recipient-binding e2e) | `cd contracts && sui move test` |

Raw output — Poseidon compatibility check (the crux verification):

```
$ /tmp/suibin/sui move test poseidon_compat
sui 1.72.1-94ad8ccd0ed6   # matches Move.toml's pinned framework rev exactly
Running Move unit tests
[ PASS    ] veil::poseidon_compat_tests::test_poseidon_bn254_matches_circomlibjs_reference_vectors
Test result: OK. Total tests: 1; passed: 1; failed: 0
```

Reference vectors (computed independently, `node` + `circomlibjs 0.1.7`, before the Move test was
written):

```
poseidon([8,12345])   = 7163575327242158666077169141605442609494059320358707772268333069888638990040
poseidon([8,0])       = 3389212708216144879186174190097808449254289024066134177507956630700586741844
poseidon([8,1])       = 365457035153223777471802539189832243157897367080642673562402074993874281703
poseidon([8,<addr%R>]) = 334127709492056454786748719113802606371996487778193307372369739479136801427
```

Raw output — full Move suite, including the two real-proof recipient-binding tests:

```
$ cd contracts && sui move test
Running Move unit tests
...
[ PASS    ] veil::pool_withdraw_recipient_binding_tests::test_zk_withdraw_rejects_recipient_substitution
[ PASS    ] veil::poseidon_compat_tests::test_poseidon_bn254_matches_circomlibjs_reference_vectors
[ PASS    ] veil::pool_withdraw_recipient_binding_tests::test_zk_withdraw_succeeds_for_bound_recipient
Test result: OK. Total tests: 127; passed: 127; failed: 0
```

Raw output — real Groth16 proof generation and independent verification (before it was embedded
as a Move test fixture):

```
$ circom withdraw.circom --r1cs --wasm --sym --output build-withdraw
non-linear constraints: 1465
linear constraints: 1593
# matches README.md's documented 3,058 total constraints exactly (1465 non-linear + 1593 linear)

$ node scripts/bench/recipient-binding-fixture.mjs
snarkjs.groth16.verify: true
```

Full downstream suite, confirming nothing else regressed:

```
withdraw.circom (real Groth16)         35 pass   node test/withdraw.test.mjs
Proof converter                        109 pass  bun run src/test-converter.ts
Property-based fuzz                    6 properties x 500 cases   bun run src/fuzz-tests.ts
Frontend (vitest)                      19 pass   bunx vitest run
Compliance utils                       still running at report time — pre-existing slow suite
                                        (queue item #13, unaffected by this diff; not touched)
```

## Verdict: KEEP — merged, `docs/threat-model.md` updated

E7 corrected from a false "Mitigated" to an accurate description of what's now actually checked
and why the old claim was wrong. No `BASELINE.md` change (this isn't a performance number). No VK
rotation, no circuit change — this ships immediately, unlike a Poseidon2 swap or any other
circuit-touching queue item, which all require a timelocked VK update before they can land.

## Where this could be used

- **Any protocol that treats a Groth16 public input as self-enforcing.** This is a generic ZK
  integration mistake, not Veil-specific: a public input only constrains what the *verifier
  contract* explicitly checks it against. Any Solidity/Move/Cairo verifier that extracts a public
  input and uses it for control flow (a recipient, an amount, an authorization flag) without
  asserting it against caller-supplied data has the same class of bug. Worth a dedicated pass
  over `docs/zk-vulnerability-research.md`'s bug-class list to check whether it's already named
  there (it should be — "public input is not automatically re-derived by the contract" is at
  least as common as under-constrained signals).
- **Sui's native `poseidon_bn254` precompile as a general circom-interop tool.** Any Sui protocol
  with a `circom`+Groth16 circuit that needs to bind a public input to on-chain state (an address,
  an amount, a timestamp) via a hash — not just recipient binding — can recompute that hash
  natively instead of exposing the raw value as an extra public input, avoiding both an extra
  public input and a VK change. Useful anywhere a circuit was designed to hide a value behind a
  hash but the contract still needs to authenticate it.
- **Confidential payroll / t-of-n auditor board thesis chapter** (per the 2026-07-22 baseline
  report's use-case framing): any withdrawal-style exit path in that design needs exactly this
  binding — an employee proving entitlement to a payroll disbursement, with the payout address
  bound the same way, is the identical pattern.

## Open questions

1. **The PR backlog itself is now the top queue item.** 10 open, unmerged, duplicate PRs since
   2026-07-28 (`#64`-`#73`) — mostly re-deriving Poseidon2-vs-Poseidon and on-chain gas because
   two CI infra bugs (`oven-sh/setup-bun` SHA pin, `storage.googleapis.com` ptau 403) kept the
   suite red for ~2 months and were independently fixed 5+ times without ever merging. This
   session flagged it to the repo owner directly (a scheduled research run shouldn't merge to
   `main` or bulk-close PRs unilaterally) rather than acting on it. Until a human triages that
   backlog, every subsequent night risks re-deriving the same results again.
2. **`docs/zk-vulnerability-research.md` doesn't yet name "unchecked public input" as its own bug
   class** — worth adding explicitly, since this exact mistake is what E7 was.
3. **On-chain gas per entry point** (old queue item #1) — several unmerged PRs (`#66`, `#68`)
   already have real localnet measurements; once the backlog is triaged, re-verify and merge
   whichever is best rather than re-measuring from scratch.
4. **Frontend `useWithdraw.ts` calls `pool::emergency_withdraw` (admin-only), not
   `pool::zk_withdraw`.** The real ZK withdrawal path this fix protects has no wired frontend
   caller yet — worth confirming before shipping a user-facing withdraw button that the
   `recipient` field-element convention documented here (BE address mod BN254 field) is what the
   proving code actually uses once that wiring exists.
