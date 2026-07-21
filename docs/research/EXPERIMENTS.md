# Research queue

Ranked list of candidate experiments for the nightly research loop. An item is removed from
"queued" once it has a verdict in `LEDGER.md` (KEEP/REJECT/PARK/BLOCKED). PARK items stay in the
queue at reduced rank with their blocker noted; BLOCKED items stay until the blocker is resolved.

This file did not exist before 2026-07-21 — the loop had been configured to consult it, but the
repository had never been bootstrapped. Ranking below is this bootstrap night's judgment call,
built from the "WHAT TO EXPLORE" list in `NIGHTLY_PROMPT.md`, scored by how directly each moves a
number Veil actually pays for (prover time, gas, anonymity-set size, or an unmitigated threat) and
by how cheaply it can be measured on this container (no GPU, no `sui` CLI available tonight, network
egress via a policy-scoped proxy).

## Queued

1. **Batched/aggregated proofs for `compliant_transfer`** — the highest-value scalability lever
   once a baseline exists: replacing 2 on-chain Groth16 verifications (transfer + compliance) per
   above-threshold transfer with 1 aggregated/recursive proof. Directly reduces the gas number this
   repo's own README already flags as unmeasured. Needs BASELINE.md's gas numbers to judge
   improvement against — currently blocked on the same missing `sui` CLI as BASELINE.md's gas
   column (see LEDGER 2026-07-21). Re-rank up once `sui` CLI is available in-session.
2. **Poseidon2 swap for the four Poseidon instances in `transfer.circom`** — non-linear constraints
   are 6,470 of transfer's 13,611 total (measured 2026-07-21); Poseidon2's reduced round count is
   the single biggest lever on prover time that doesn't change the trust model. Needs a same-PR
   soundness argument (round count vs security margin at this arity) and updated domain-tag
   collision analysis.
3. **Revocation-friendly accumulator vs. the depth-20 Merkle tree for the credential tree** —
   today revoking a KYC credential means walking the whole tree; an indexed/sparse accumulator
   with O(1) revocation is a real compliance-cost win. Needs a throughput measurement at
   10^5-10^7 commitments per NIGHTLY_PROMPT's scalability list.
4. **Threshold auditing (t-of-n) vs. the single auditor ECDH key** — `docs/auditor-guide.md`
   currently assumes one auditor keypair decrypts every `ComplianceVerifiedEvent` ciphertext; a
   single compromised auditor deanonymizes the whole pool's amounts. Threshold decryption
   (Shamir over the ECDH shared secret, or a multi-key hybrid scheme) bounds that blast radius.
   Design-heavy; likely UNMEASURED on the crypto side, but gas/latency of the extra ciphertext
   shares is measurable.
5. **Nullifier / proof-malleability audit pass over `transfer.circom` and `compliance.circom`**
   — a from-scratch review for under-constrained signals and alias checks beyond what
   `docs/zk-vulnerability-research.md` already lists, with new negative tests. Cheap to run (no new
   toolchain), high value if it finds something, but is a "sweep" by nature — needs a single
   falsifiable hypothesis per run, not a general audit, to fit the loop's one-hypothesis rule.
6. **PLONK/Halo2 migration feasibility for `transfer.circom`** — eliminates the trusted setup
   dependency the README already flags as a known blocker (single-contributor dev ceremony). High
   effort (different proving stack, new Sui-side verifier), best split into a design-only PARK
   experiment first (cost/benefit vs. the existing Groth16 + ceremony.sh path) before any code
   changes.
7. **Mobile WASM proving latency** — 2026-07-21 measured proving latency in headless desktop-class
   Chromium (1.1s median for `transfer.circom`, single-threaded). A real mobile-class CPU number
   (throttled/emulated) is a distinct, cheap follow-up once a device profile is chosen.
8. **Relayer throughput under load and what it leaks** — `scripts/src/relayer.ts` sponsors gas but
   the red-team report already shows sender privacy is not achieved; a load-test would quantify a
   secondary leak (timing correlation between relayer intake and on-chain landing) rather than
   fix the primary one. Lower priority until PRIV-002 has an active mitigation in flight.

## Notes

- Post-quantum exposure (BN254 pairing assumptions breaking under a CRQC) is a real residual risk
  worth a dedicated write-up, but it is a survey, not an experiment with a number to move — better
  suited to a `docs/` note than a ranked queue slot, unless framed as "cost of a lattice-based
  drop-in replacement for the pairing-based verifier," which would be a large, multi-night effort.
- Re-rank after every night: a KEEP that changes a baseline number should push whatever depends on
  that number back up the queue; a BLOCKED should stay parked until its blocker is gone, not silently
  dropped.
