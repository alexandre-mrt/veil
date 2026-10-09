# 2026-10-09 — On-chain gas per entry point (toolchain unblock attempt)

**Verdict: BLOCKED. Nothing about Veil was measured tonight. No gas number exists in this report.**

## Hypothesis
Each Veil entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify) has a gas
cost measurable with `sui move test` / a local `sui` dry-run, and the Groth16 verify dominates
`shielded_transfer`. (Not tested.)

## Threat / privacy model
Not applicable — this night was toolchain access only; no protocol or circuit change was made.
No new residual surface. STRIDE mapping: none.

## What was attempted (all commands actually run)
Queue item 1 asked to spend the early part of the run on unblocking a `sui` CLI.

| Route | Result |
|---|---|
| `api.github.com/repos/MystenLabs/sui/releases/latest` | HTTP 403 — repo not enabled for this session (only `alexandre-mrt/veil` is in scope; I did not call `add_repo` for an unrelated repo) |
| `github.com/MystenLabs/sui/releases/latest`, S3 release bucket, `crates.io` | HTTP 403 via egress proxy |
| JSON-RPC to `fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`, blockvision, publicnode | CONNECT rejected by egress proxy (organization policy) |
| `pip download sui` | unrelated package, no Sui CLI |
| `docker pull mysten/sui-tools:testnet` | no Docker daemon in the container |
| Pull the image layers directly from Docker Hub's registry HTTP API (reachable) | **worked**: manifest `sha256:dd98def2…81f7dd` config, 13 layers, 292 MB, image created 2026-10-06, amd64; extracted `usr/local/bin/sui` (209,360,072 bytes, sha256 `94871a4e7aa9ff4538db5457d9b67a745b2cb7178e8867d20b0551d2e58f509b`) |
| Execute that `sui` binary (`sui --version`) | **Denied** by the session's auto-mode permission classifier ("Code from External"). Not retried or circumvented. |

So the only thing standing between this repo and a gas baseline is permission to run an
externally-downloaded binary. The extracted tree lived in the session scratchpad only and is not in
the repo.

## Approach / alternatives rejected
- Rebuilding Sui from source: GitHub and crates.io are blocked here, so it is not possible, not just slow.
- Estimating gas from the Move source or from published Sui gas schedules: rejected by the loop's
  one rule — that would be an estimate presented as a number.
- Switching tonight to queue item 2 (Poseidon2) or 8 (mobile latency): both need the `circom`
  compiler, which is not installed (`which circom` empty) and whose source (`iden3/circom`) is on
  the blocked GitHub. Not attempted; whether an `npm` WASM circom (`registry.npmjs.org` is reachable)
  is acceptable for a like-for-like baseline is an open question, since 2026-07-22 used 2.2.2 built from source.

## Results
None. No baseline row changed. `BASELINE.md` is untouched.

## Verdict
**BLOCKED.** Missing: permission to execute a `sui` binary. Unblock options for the owner, cheapest first:
1. Allow running the digest-pinned `mysten/sui-tools` image's `sui` (steps above are reproducible
   with `curl` against `registry-1.docker.io`; verify the manifest digest first), or
2. Add a pinned `sui` binary to the environment's setup script, or
3. Allow direct JSON-RPC reads of the deployed testnet package (`suix_queryTransactionBlocks`) to
   recover historical gas without a CLI.

## Where this could be used
A per-entry-point gas table is the input to any "batch N transfers into one verify" argument
(queue item 3) and to comparing Veil's cost against other Sui privacy pools. Thesis chapter:
evaluation/cost.

## Open questions
- Which of the three unblock options does the owner accept? (Blocks queue items 1 and 3.)
- Should the loop's environment ship `sui` and `circom` preinstalled so nights stop spending their budget on this?
