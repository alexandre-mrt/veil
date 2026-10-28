# 2026-10-28 — On-chain gas per entry point: toolchain unblock attempt (queue item #1)

## Hypothesis

A prebuilt `sui` CLI can be obtained in this sandbox and used to run the Move suite and measure gas
per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify), moving "entry
points with a measured gas number" from 0 to 4+.

## Threat / privacy model

No protocol change; no adversary model touched. The only security-relevant point is the sandbox's
own: an 837 MB executable fetched from the internet was **not run**, because the execution
layer's auto-mode classifier denied it (reason: "Code from External"). That is a legitimate control
and was not circumvented. Residual: gas-based DoS/griefing analysis (docs/threat-model.md) stays
impossible without real gas numbers.

## Approach

Tried, in order (all commands actually run this session):

1. `curl https://api.github.com/repos/MystenLabs/sui/releases/latest` → "GitHub access to this
   repository is not enabled for this session" (repo scope is `alexandre-mrt/veil` only).
2. `curl -X POST https://fullnode.testnet.sui.io:443 ... sui_getLatestCheckpointSequenceNumber`
   → `curl: (56) CONNECT tunnel failed, response 403`. Other public RPC hosts
   (`fullnode.mainnet.sui.io`, `sui-testnet.nodeinfra.com`, `sui-rpc.publicnode.com`) return no
   response (HTTP 000). So the JSON-RPC fallback (historical gas via `suix_queryTransactionBlocks`)
   is blocked by network policy, not just by tool approval as on 2026-07-22.
3. `curl -L https://github.com/MystenLabs/sui/releases/download/testnet-v1.60.0/sui-testnet-v1.60.0-ubuntu-x86_64.tgz`
   → HTTP 200, 837,340,044-byte gzip tarball, containing `./sui`. **This path works for download.**
   Extracted `./sui` into the scratchpad area.
4. Running `sui --version` / `sui move test` on the extracted binary → **denied** by the auto-mode
   classifier. Not retried or worked around.

Not attempted: building Sui from source (Move.toml pins a Sui git rev; full workspace build
judged out of budget, and it would also execute fetched code).

## Results

No gas number was measured. No Move test result exists. Nothing here is estimated.

| Metric | Baseline | After |
|---|---|---|
| Entry points with measured gas | 0 | 0 |
| Move tests run (of 124) | 0 | 0 |

## Verdict

**BLOCKED** (third time, new and more specific cause).

What unblocks it, concretely — any one of:
- Allow executing the downloaded release binary (URL above is confirmed reachable and is the
  official MystenLabs release asset), e.g. via a permission rule for the extracted `sui`, or a
  setup script in the environment that installs it; or
- Allow network egress to `fullnode.testnet.sui.io` so historical gas can be read from the
  deployed package in README.md without the CLI.

## Where this could be used

Per-entry-point gas is the input to: batched-proof savings (queue #3), relayer fee setting for a
shielded-payments relayer on Sui, and gas-griefing analysis of a shared-object pool under
concurrent transfers (a thesis chapter on throughput of shielded pools on object-centric chains).

## Open questions

- Which unblock option is the owner willing to grant?
- Given the block, should the queue run item #2 (Poseidon2 vs Poseidon constraint count; needs only
  circom + snarkjs) tomorrow? Recommendation: yes — item #1 is now demoted below it.
