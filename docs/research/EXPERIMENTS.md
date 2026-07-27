# Experiment queue

Ranked, highest priority first. The nightly loop (`docs/research/NIGHTLY_PROMPT.md`) takes the
top item not already settled (KEEP/REJECT) in `LEDGER.md`. Re-ranked after every run.

## Queue

1. **On-chain gas per entry point (Sui Move)** — `shielded_transfer`, `zk_withdraw`,
   `deposit_and_register`, `compliant_transfer`, `create_pool` on `contracts/sources/pool.move`
   and `compliance.move`. Blocked in the 2026-07-27 baseline run: no `sui` CLI in the sandbox and
   `cargo install --git .../MystenLabs/sui` failed on a transient git-dependency fetch error
   (`zhiburt/tabled` pinned revision, HTTP 502 through the proxy). Retry the install (possibly with
   `CARGO_NET_GIT_FETCH_WITH_CLI=true`), or pursue a lighter path (prebuilt `sui` binary, Docker
   image with `sui` preinstalled, or a devnet faucet + `sui client publish` from a machine that
   already has the CLI). Once available: publish `pool.move`, drive each entry point through
   `sui client call` or a Move unit test with gas metering, record `computationCost` +
   `storageCost` per call from the transaction effects.
2. **Browser/WASM proving latency (mobile-representative)** — the baseline measured Node.js
   `snarkjs.groth16.fullProve` wall time only. Real users prove in-browser via WASM
   (`frontend/` already ships `circomlibjs` + `snarkjs` client-side). Build a minimal Playwright
   harness that loads `transfer.wasm` + `transfer_final.zkey` in a real Chromium page and times
   `fullProve`, then throttle CPU (Playwright's CDP `Emulation.setCPUThrottlingRate`) to
   approximate a mid-range phone. Compare against the Node baseline in this run.
3. **Poseidon2 vs Poseidon(t=5) swap in transfer.circom** — Poseidon2 claims ~2x fewer constraints
   per permutation. transfer.circom's 6384 constraints are dominated by 4 Poseidon(4) calls +
   MerkleProof(20) (20 more Poseidon(2) calls). If circomlib ships (or a vetted third-party
   circuit ships) a Poseidon2 template compatible with BN254/Groth16, re-measure constraint count
   and prove time with the same bench harness (`scripts/bench/prove-bench.mjs`). Needs a soundness
   note: Poseidon2's round structure differs from Poseidon — domain-tag collision analysis must be
   redone, not assumed to carry over.
4. **Merkle accumulator at scale (10^5–10^7 commitments)** — current depth is fixed at 20
   (anonymity set cap ~1.05M). Indexer/insertion throughput and batch-insert circuit cost are
   unmeasured. Depends on a scriptable way to grow `commitment_root` off-chain and re-derive
   Merkle paths at scale — needs the on-chain gas work (#1) or an off-chain simulation harness
   first, since `update_commitment_root` is the only on-chain hook.
5. **Batched/aggregated transfer proofs (N transfers → 1 verification)** — would move the
   dominant on-chain cost (Groth16 pairing check per transfer) if gas (#1) shows verification
   dominates. Ordered after #1 so the number it's supposed to move is actually known first.
6. **Groth16 → PLONK/Halo2 trusted-setup elimination** — worth investigating once a batching or
   scale experiment establishes whether trusted-setup risk or prover time is the bigger open
   problem; premature to rank above measurement work.
7. **Threshold auditing (t-of-n) vs single auditor key** — `compliance.move`'s
   `auditor_key` is currently a single key (see `propose_auditor_key_update`). A t-of-n scheme
   changes the trust model materially; worth a design-only pass once BASELINE's compliance-circuit
   numbers exist (they now do — 5979 constraints, dual-proof cost visible in this run's report).

## Settled (see LEDGER.md for the authoritative record)

- BASELINE.md — KEEP (partial), 2026-07-27. Circuit-side numbers (constraints, Groth16 setup,
  Node proving/verify time, artifact sizes) are real and merged into `BASELINE.md`. On-chain gas
  is explicitly BLOCKED and re-queued as item #1 above, not silently dropped.
