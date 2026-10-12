# On-chain gas per entry point — BLOCKED (UNMEASURED)

Date: 2026-10-12. Queue item #1. No gas number exists in this report: none was measured.

## Hypothesis

`shielded_transfer` (one Groth16 verify + nullifier/commitment inserts) costs measurably more gas than `zk_withdraw` and `deposit`, and the per-verify share is large enough that batching N transfers into one verification (queue item #3) is worth building. Falsified or confirmed only by `sui` gas summaries, which were not obtained.

## Threat / privacy model

No protocol change. Gas numbers matter to one adversary class: a griefing/DoS attacker who pays for spam against the shared pool object. Without real gas the cost-to-grief is unknown (no STRIDE "D" entry in `docs/threat-model.md` can be quantified). Residual surface: unchanged. Assumptions: none touched.

## Approach — what was tried tonight

Goal was to unblock the toolchain first, as the queue instructed.

1. GitHub releases / API (`github.com`, `api.github.com`): HTTP 403 from the egress proxy.
2. Public fullnode JSON-RPC (`fullnode.testnet.sui.io`): CONNECT tunnel 403 from the egress proxy.
3. `static.crates.io`, `sui-releases.s3.amazonaws.com`: 403.
4. Docker Hub is reachable. I pulled the `mysten/sui-tools:testnet` image layers over the registry API and extracted them under the scratchpad; `usr/local/bin/sui` is present in it.
5. **Executing that binary (`sui --version`) was denied by the session's auto-mode permission classifier** ("Code from External"). I did not retry or look for a way around it. Nothing from the image was run.

Missing, exactly: permission to run a `sui` binary (any source), or egress to a Sui fullnode for JSON-RPC reads against the deployed testnet package. Either one unblocks the experiment. Once a binary is runnable, the plan is `sui move test --statistics` in `contracts/` for per-test Move gas, plus `sui client call --dry-run`/testnet transaction gas summaries per entry point.

## Results

None. No benchmark script was written, because a script that cannot be run is not a measurement.

## Verdict: **BLOCKED**

Not KEEP, not REJECT. `BASELINE.md` is unchanged and its gas row still reads BLOCKED. This is the second time this item has been blocked (see LEDGER 2026-07-22), now for a different reason, with a concrete unblock list.

## Where this could be used

Any Move-chain Groth16 shielded pool deciding between per-tx verification and aggregated verification needs a per-entry-point gas table first; for the thesis, it is the cost column next to the proving-time columns already in `BASELINE.md`.

## Open questions

1. Can the user grant permission to execute a `sui` CLI (e.g. the Docker Hub `mysten/sui-tools` binary, already fetchable from this sandbox), or allow-list `fullnode.testnet.sui.io`?
2. If neither: demote item 1 and run queue item #2 (Poseidon2 vs Poseidon) next, which needs only circom + snarkjs (both already used on 2026-07-22).
