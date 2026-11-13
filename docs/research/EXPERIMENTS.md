# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Re-ranked 2026-11-13** after [`2026-11-13-onchain-gas-per-entry.md`](2026-11-13-onchain-gas-per-entry.md):
(a) two *open, reproduced* soundness gaps go straight to the top, since an unmitigated threat
outranks any optimization; (b) on-chain gas turned out to be storage-dominated, with Groth16
verification at Sui's 1,000-unit minimum bucket. So batched verification (formerly #3) drops near
the bottom, and a storage-layout experiment (VKs out of the hot Pool object) enters at #4.
Formerly #1 (on-chain gas) is settled KEEP. Formerly #12 (chained `npm test` hang) is resolved by
#17: `npm test` completed all three files in 31 s on 2026-11-13.

**Tooling, fold into the next night that touches circuits:** the Hermez pot15 URL in
`circuits/scripts/compile*.sh` and `.github/workflows/ci.yml` returns 403 (as does the old S3
mirror). Pin a working source with a sha256 check, or document local generation. Fresh clones
currently cannot produce zkeys without a manual workaround.

1. **Fix E7: bind `recipient` on-chain in `zk_withdraw`.** Reproduced on 2026-11-13: a valid withdraw
   proof submitted with an arbitrary `recipient` pays that address. The circuit's `recipientHash`
   is never recomputed by the contract. Fix: compute `Poseidon(8, addr_to_field(recipient))` with
   `sui::poseidon::poseidon_bn254` and compare it with public-input bytes 96..128. Pin down the
   address→field reduction, since a 32-byte address can exceed the BN254 scalar field, and match it
   in the client. Deliverables: a negative Move test (valid proof, wrong recipient → abort), the
   `withdraw-redirect` probe in `scripts/bench/gas-per-entry.mjs` flipping to `aborted`, and the
   gas delta from the same harness.

2. **Fix compliance-proof binding in `compliant_transfer`.** Reproduced on 2026-11-13: a spender with
   no credential completed a compliant transfer using a compliance proof built from another user's
   credential. The two proofs share no on-chain-checked value. Candidate fix: make
   `transferNullifier` a *public* input of `compliance.circom` and assert bytes equality with
   transfer inputs 128..160. That leaks nothing new, because the nullifier is already public. This
   alone still allows a credential holder to certify a stranger's transfer, so it must be combined
   with a shared owner binding, e.g. both circuits expose `Poseidon(DOMAIN, userSecret)`, or the
   compliance proof re-derives the transfer nullifier from the same `userSecret`. This is a circuit
   change, so it needs a soundness argument, a leakage analysis, and a negative test. The
   `credential-lending` probe should flip to `aborted`.

3. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Unchanged rationale: four
   Poseidon instances dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints
   (6,470 and 6,057). Prover time is now clearly the biggest *user-facing* cost: ~750 ms Node /
   ~1.2 s browser, versus a verify that costs at most 1,000 gas units on-chain.

4. **Move VKs out of the hot Pool object; take `&ComplianceConfig` when nothing is pending.** New,
   from the 2026-11-13 numbers. Every transaction rewrites the whole Pool object, VKs included.
   Storage is charged in full, ~99% is rebated, and the non-refundable 1% recurs. Compliant
   transfers also rewrite ComplianceConfig (a third VK), which adds a second shared-object write
   per transfer. The harness can measure the saving directly. The same change also reduces
   shared-object contention surface.

5. **Independent circuit soundness audit (cross-boundary).** Promoted in spirit: on 2026-11-13 the
   full test suite was green while two binding failures were live. The suites check each circuit
   against itself and each contract against itself, but not the circuit↔contract boundary. Audit
   every public input of every circuit: is it (a) checked on-chain, (b) derived on-chain, or
   (c) intentionally free? Also cover alias checks, nullifier collisions across the eight domain
   tags, and proof malleability. Build on the probes in `gas-per-entry.mjs`.

6. **Shared-object contention under concurrent transfers.** New. Every `shielded_transfer`,
   `zk_withdraw` and `deposit_and_register` takes `&mut Pool`, so all of them serialize. Measure
   sustained TPS on the localnet with N concurrent senders, and what sharding commitments across
   sub-pools would cost in anonymity-set size.

7. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs deeper
   (anonymity set vs proving time), indexer throughput. Relevant to RR5. With real per-deposit
   storage now known (net 1,797,468 MIST at RGP 1,000), the storage side of 10^7 commitments can
   now be computed instead of guessed.

8. **Threshold auditing (t-of-n) vs the single auditor key.** Unchanged (asset #6, auditor-guide).

9. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Unchanged.

10. **Mobile WASM proving latency.** Cheap extension of `scripts/bench/browser-latency.mjs` with a
    mobile device-emulation profile. Good lighter-night candidate.

11. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Unchanged (RR2). Note that
    `sui::groth16` is a native verifier. Any non-Groth16 system would verify in Move bytecode and
    leave the 1,000-unit bucket, so measure that cost before committing to a port.

12. **Batched/aggregated proof verification (N transfers → 1 verify).** *Demoted from #3.* The
    2026-11-13 measurement shows verification is at most the 1,000-unit minimum computation bucket,
    32% of a transfer's net cost, and every transaction pays that floor regardless. Aggregation can
    only save part of that 32%, and the dominant storage cost (one nullifier field per transfer)
    doesn't shrink with batching. Revisit only if RGP economics change or verification moves off
    the native verifier (see #11).

13. **Post-quantum exposure.** Unchanged. Likely design-only, UNMEASURED.

14. **Relayer throughput and leakage under load.** Unchanged, but now linked to #1. Until E7 is
    fixed, a relayer that sees proof bytes can redirect withdrawals, so the relayer is in the
    custody path, not just the privacy path.
