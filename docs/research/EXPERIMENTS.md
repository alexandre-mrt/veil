# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Fix E7: bind `zk_withdraw`'s `recipient` argument to the proof's `recipientHash`.**
   Confirmed exploitable on localnet 2026-11-20: 3/3 redirected withdrawals accepted (see that
   report §4). Compute `poseidon_bn254([8, addr_to_field(recipient)])` on-chain and assert it
   equals public-input bytes 96..128. That needs a canonical address→field encoding shared by
   circuit, contract and client (a Sui address can exceed the BN254 scalar field). Deliverables:
   a negative Move test, a localnet reproducer flipping from VIOLATED to holds
   (`scripts/bench/gas.ts` already prints it), and the added gas measured with the same harness.
   Top because it is an unmitigated fund-loss threat, not an optimisation.

2. **Independent circuit/contract-interface soundness audit, starting with compliance binding.**
   (Was #5, promoted.) E7 shows the circuits can be correct while the contract fails to enforce
   what they bind. First concrete lead: `compliance.circom` derives
   `contextId = H(6, transferNullifier, userSecret)` from a *private* `transferNullifier`, and
   `compliant_transfer` checks `contextId` against nothing in the transfer proof. Hypothesis:
   a KYC'd user can produce compliance proofs that accompany another user's transfer (credential
   lending). Build a localnet reproducer first, then sweep every public input of all three
   circuits for "proved but never compared on-chain". Also cover the original scope: alias checks,
   nullifier collisions across the 8 domain tags, malleability.

3. **Pool object layout vs per-transfer storage cost.** (New, from the gas baseline.) Storage,
   not computation, is what users pay: `shielded_transfer` net 2.88–3.12 M MIST against a 1 M MIST
   computation floor. `Pool` is rewritten on every transfer and carries both VKs (488 + 424 B)
   and pending-VK buffers inline. Hypothesis: moving them into separate objects or dynamic fields
   cuts net per-transfer storage by a measurable amount. Measure with `node bench/gas.ts`.

4. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Unchanged rationale: four
   Poseidon instances dominate `transfer.circom`'s and `compliance.circom`'s non-linear
   constraints (6,470 and 6,057 vs 1,465 for `withdraw.circom`). This moves prover time (~750 ms
   Node / ~1.2 s browser), the user-facing latency, which gas does not.

5. **Shared-object contention on `Pool` under concurrent transfers.** (New.) Every entry point
   takes `&mut Pool`, so all transfers serialize through consensus on one object. Extend
   `gas.ts` to N concurrent senders on localnet and measure end-to-end latency and throughput vs N.

6. **Mobile WASM proving latency.** Cheap extension of `scripts/bench/browser-latency.mjs`
   (device-emulation profile). Good lighter-night candidate.

7. **Threshold auditing (t-of-n) vs the single auditor key.** Unchanged.

8. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Unchanged.

9. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** (Was #3,
   demoted.) The 2026-11-20 sweep shows one Groth16 prepare + verify ≈ 267 computation units,
   under the 1,000-unit per-tx floor. Batching saves no computation below ~4 proofs per
   transaction. Its remaining value is amortising the per-tx floor and object rewrites, which
   item 3 attacks more directly. Revisit if transaction shapes grow.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Unchanged (large lift; RR2).
    Note for sizing: a non-Groth16 verifier on Sui would need a Move implementation or a new
    native, and the cheap native Groth16 path is a large part of why per-tx computation sits at
    the floor today.

11. **Post-quantum exposure.** Unchanged (likely design-only / UNMEASURED).

12. **Relayer throughput and leakage under load.** Unchanged.

13. **Gas on public networks.** Re-run `gas.ts` against testnet once fullnode RPC is reachable from
    the run environment (refused by the egress proxy on 2026-11-20). It checks that protocol v124
    numbers still hold.

Settled / removed this re-rank: *on-chain gas per entry point* (KEEP 2026-11-20) and *fix
circuits' chained `npm test` hang* (fixed in #17; `npm test` ran all three files end-to-end on
2026-11-20).
