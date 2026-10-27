# 2026-10-27 — On-chain gas per entry point

**Status: BLOCKED. No gas numbers were produced. Nothing below is a measurement.** (UNMEASURED)

## Hypothesis
`shielded_transfer` costs measurably more gas than `zk_withdraw` and `deposit`, with the delta
dominated by `sui::groth16` verification (7 vs 5 public inputs). Falsifiable only with real gas
summaries from a local network or the deployed testnet package.

## What was attempted (every step actually run)
| Step | Command | Result |
|---|---|---|
| Fullnode JSON-RPC read | `curl -X POST https://fullnode.testnet.sui.io:443` (also mainnet, ankr, publicnode) | `CONNECT tunnel failed, response 403` — egress proxy refuses these hosts |
| Prebuilt `sui` binary | `curl https://github.com/MystenLabs/sui/releases/latest`, `sui-releases.s3.amazonaws.com` | HTTP 403 both |
| Source clone | `git clone --depth 1 MystenLabs/sui` (via the session's anonymous git proxy) | **Succeeded** (commit `30e8865e`) |
| Toolchain | `rustup toolchain install 1.98.1` | **Succeeded** (repo pins 1.98.1) |
| Build | `cargo build --release -p sui` | **Denied by the session's permission classifier** ("Code from External"). Not retried or worked around. |

Also absent this session: `circom` (needed for queue item 2), so no fallback circuit experiment
could be measured either; building it from source would be the same class of action as the denied one.

## Unblock options (needs a human decision)
1. Allow `cargo build --release -p sui` in the routine environment (~4 cores, ~30 GB free disk is tight; expect 1–3 h), or
2. Add `fullnode.testnet.sui.io` (and release hosts) to the environment's network allowlist, or
3. Bake `sui` and `circom` into the environment's setup script so nightly runs start with them.

Option 3 pays off every night. Once any of these exists: run a local network, publish `contracts/`,
call each entry point, record `gasUsed` from the transaction effects in a script under `scripts/bench/`.

## Verdict
**BLOCKED.** Contracts and circuits untouched; no tests were run, so nothing is claimed green.

## Where this could be used
Per-verify gas is the input to queue item 3 (batched verification) and to any cost model for
confidential payroll on Sui with a t-of-n auditor board.

## Open questions
- Does the environment allow a long (hours) source build, or must the toolchain be preinstalled?
