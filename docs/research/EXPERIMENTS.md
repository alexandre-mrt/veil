# Veil research queue

Ranked list of candidate experiments for the nightly research loop. Highest-ranked unsettled
item is what the next run takes. An item is "settled" once `LEDGER.md` records a KEEP or REJECT
verdict for it; PARK and BLOCKED stay in the queue (re-ranked, with the blocker noted) until they
either get unblocked or someone decides to drop them.

Ranking heuristic: prefer experiments that move a number Veil actually pays for — prover time,
gas, anonymity-set size, or a threat currently unmitigated — over speculative cryptography with no
attached cost model.

## Queue

1. **~~BASELINE.md~~ — measure everything once, on one machine.** (SETTLED 2026-07-17, see
   `2026-07-17-groth16-baseline.md`) Per-circuit R1CS constraints, Groth16 setup/prove/verify time,
   proof and VK size, ptau size. On-chain gas and browser WASM proving latency could not be measured
   this run (toolchain gaps — see report) and remain open sub-items, tracked as queue items 2 and 3
   below rather than re-blocking the whole baseline.

2. **On-chain gas per entry point** (`shielded_transfer`, `compliant_transfer`, `deposit`,
   `withdraw`, `zk_withdraw`) under the Sui CLI's gas profiler. Blocked tonight: no `sui` binary in
   the sandbox, GitHub release-asset downloads are denied by the egress proxy (403, policy — not a
   transient failure), and building the full Sui monorepo from source is not a one-night job. Needs
   either a sandbox image with `sui` preinstalled, an allowed download mirror, or a pre-built binary
   supplied out-of-band. High priority once unblocked — gas is a number Veil directly pays on every
   transfer, and `shielded_transfer` touches a shared object (contention risk under concurrent load,
   see item 8).

3. **Browser WASM proving latency** (real device, real network) for `transfer.circom` via
   `frontend/`'s snarkjs Web Worker path, vs. the Node.js `snarkjs` figure measured in the baseline.
   Blocked tonight: no `bun run dev` + Playwright pass was attempted (time budget went to the
   baseline itself); Node-process proving time is a directional floor, not the same number. Medium
   priority — mobile proving latency is the actual UX bottleneck for a payments app, and the gap
   between "Node process on a build server" and "phone browser on a cold cache" is exactly where
   marketing numbers usually lie.

4. **Poseidon2 vs Poseidon for the four hash instances in `transfer.circom`.** Poseidon2 claims
   ~2x fewer constraints per permutation than Poseidon1 at the same security level (Grassi et al.
   2023). Four Poseidon(4)/Poseidon(3) calls plus the 20-level Merkle path account for a large
   fraction of `transfer.circom`'s 13,611 constraints (6,470 non-linear) — this is the single
   highest-leverage constraint-count lever available without changing the proof system. Needs a
   `circomlib`-equivalent Poseidon2 gadget (none ships in `circomlib` today; would need porting or
   vendoring) and a domain-tag collision re-check against the existing tags 1–8, since Poseidon2's
   different internal round structure changes what "domain separation" costs in constraints.

5. **Depth-20 Merkle accumulator at scale (10^5–10^7 commitments): batch insertion cost, indexer
   throughput, and the depth-vs-anonymity-set trade-off.** Depth 20 caps the anonymity set at
   2^20 ≈ 1.05M leaves; Veil is nowhere near that today but the accumulator design decision is
   cheap to revisit now and expensive later (VK regeneration + migration once live). Needs a
   synthetic-load script (`scripts/bench/`) that inserts N commitments into the Move Pool's dynamic
   fields and measures wall-clock + (blocked, see item 2) gas per insertion, plus an off-chain
   indexer throughput number for root recomputation.

6. **Batched/aggregated transfer proofs: N transfers → 1 on-chain Groth16 verification.** Would
   move on-chain gas (item 2, currently unmeasured) and shared-object contention (item 8) at once,
   but the honest cost is prover-side: naive batching means one prover holds N witnesses, which
   breaks the "each user proves their own transfer" trust boundary unless done via recursion
   (Nova-style folding) or a SNARK-friendly aggregation layer neither of which circom/snarkjs
   supports out of the box. Rank this below Poseidon2 until a concrete aggregation scheme is picked;
   right now it's a direction, not an experiment.

7. **Groth16 → PLONK/Halo2: eliminate the per-circuit trusted setup.** `RR2` in
   `docs/threat-model.md` — the current ceremony is single-contributor, dev-only, and is a listed
   pre-mainnet blocker. A universal-setup proof system removes the recurring per-circuit ceremony
   requirement entirely. Real cost: circom compiles to R1CS, which PLONK backends (or a rewrite in a
   Halo2-native DSL) don't consume identically — this is a rewrite of three circuits, not a flag
   flip. High value, high effort; queued below cheaper wins.

8. **On-chain gas and shared-object contention on `Pool` under concurrent transfers.** `Pool` is a
   single shared object (`pool.move`); every `shielded_transfer` mutates it. Sui's object-versioning
   model serializes writes to the same shared object across a checkpoint — worth knowing the actual
   throughput ceiling before anyone quotes a TPS number. Depends on item 2 (needs a live `sui`
   client) plus a local Sui test validator or testnet access under load; rank below the baseline gas
   number itself since you need the single-transfer cost before the concurrent one means anything.

9. **Revocation-friendly accumulators vs. the depth-20 Merkle tree for the KYC credential set**
   (`compliance.circom`). Today, revoking a credential requires an admin-gated `credential_root`
   update (timelocked) that rebuilds the whole tree off-chain. A cryptographic accumulator with
   native revocation (RSA accumulator, or a sparse-Merkle-tree-with-nullifier scheme) could remove
   the "rebuild everything" step. Needs a concrete accumulator construction chosen and its
   constraint cost estimated in-circuit before it's worth prototyping.

10. **Threshold auditing (t-of-n auditor board) vs. the single auditor key.** Today
    `ComplianceConfig.auditor_key` is one P-256 key — compromise or coercion of that one key
    decrypts every compliance ciphertext ever emitted. Threshold ElGamal or a t-of-n
    Shamir-split symmetric key would bound that blast radius. Directly relevant to "confidential
    payroll with a t-of-n auditor board" (see open questions in the baseline report). No circuit
    change required — this is a key-management and `AuditorEncryption` protocol change, cheaper
    to prototype than the circuit-level items above it, but ranked here because it doesn't move a
    number Veil currently measures (no live incident it fixes yet).

11. **Nullifier collision / proof-malleability audit** across the three circuits' domain tags
    (1, 2, 3, 5, 6, 7, 8). `docs/zk-vulnerability-research.md` already covers the checked bug
    classes; this item is a fresh adversarial pass specifically hunting for a tag-boundary
    collision (e.g. can a `Poseidon(2, a, b)` nullifier ever equal a `Poseidon(3, a, b, c)`
    amount hash for attacker-chosen inputs under BN254's field size). Cheap to run, low expected
    yield given the existing review, but cheap enough to slot in on a night nothing else is ready.

12. **Post-quantum exposure.** BN254 pairing-based Groth16 is broken by a sufficiently large
    quantum computer (breaks the discrete-log assumption the whole trust boundary rests on, per
    `docs/threat-model.md` boundary 5). Nothing actionable short-term — there is no drop-in
    post-quantum SNARK with comparable proof size and on-chain verification cost today — so this
    stays a watch item, not an experiment, until a PQ-STARK or lattice-SNARK option matures enough
    to prototype.

## Notes for future nights

- Items 2 and 3 exist because the baseline run could only measure what the sandbox's toolchain
  allowed. Re-attempt them opportunistically (e.g. if a future session's sandbox ships `sui`) rather
  than waiting for them to reach the top of the ranking by attrition.
- Any item that gets promoted to "in progress" should be moved here with today's date and a link to
  its report, not silently dropped from the list.
