# 2026-10-26 — Toolchain unblock attempt (queue items #1 and #2): BLOCKED

## Hypothesis
Queue item #1 (on-chain gas per entry point) can be unblocked this run by obtaining a working
`sui` CLI or a public Sui RPC read; failing that, queue item #2 (Poseidon2 vs Poseidon constraint
count and proving time) can be measured with `circom` built from `iden3/circom` v2.2.2.

**No number was produced. Nothing below is a measurement.**

## What was tried (each result is from a command actually run)
| Attempt | Result |
|---|---|
| `curl` Sui testnet fullnode (`fullnode.testnet.sui.io:443`) | proxy `CONNECT` 403 — `connect_rejected`, host not allowed by egress policy |
| `curl` `fullnode.mainnet.sui.io`, `sui-rpc.publicnode.com` | proxy `CONNECT` 403 |
| `curl` GitHub releases API / `github.com/MystenLabs/sui/releases` | 403 (repo not attached to session) |
| `curl` `crates.io`, `sui-releases.s3.amazonaws.com` | 403 (`index.crates.io` returns 200) |
| Build `sui` from source | not attempted: 4 cores, ~31 GB free disk, full Sui workspace is infeasible |
| `npm ci` in `circuits/` | OK |
| `npm i @zkpassport/poseidon2` (TS Poseidon2 on BN254, constants source) | OK |
| `git clone --branch v2.2.2 iden3/circom` | OK |
| `cargo build --release` of that clone | **denied by the sandbox's tool-approval layer** ("Code from External"). Not retried or routed around (e.g. via the `circom2` npm WASM build), because that would sidestep the denial. |

Net: no `circom` binary this run, so no circuit can be compiled and no constraint or proving
number can be produced. Item #2 is therefore also unmeasured.

## Verdict
**BLOCKED.** Needed to proceed, any one of:
1. Network allowlist for a Sui fullnode (e.g. `fullnode.testnet.sui.io`) and/or `github.com/MystenLabs/sui` release assets → unblocks gas (#1).
2. Permission to `cargo build` the pinned `iden3/circom` v2.2.2 (this worked on 2026-07-22), or a pre-installed `circom` in the routine's environment setup script → unblocks #2, #5, #8, #9.

Recommended: put circom (and ideally `sui`) in the routine environment's setup script so
nightly runs don't depend on in-session build approval.

## Design notes for the unblocked run (UNMEASURED — design only)
- Poseidon2 is a different permutation, so Merkle hashing in Move (`sui::poseidon` is circomlib-compatible Poseidon) would have to change in lock-step; any claimed win must account for on-chain hashing cost, which depends on gas numbers (#1). Ordering #1 before a circuit swap remains sensible.
- Plan: write `Poseidon2` circom templates (t=3, t=4) with constants taken from `@zkpassport/poseidon2`, prove equality with the JS reference on random vectors, then recompile `transfer.circom` with the swap and report constraints/proving time vs `BASELINE.md` via `scripts/bench/`.
- Circuit change obligations (soundness, leakage, negative test) apply when this runs.

## Open questions
- Is the egress allowlist configurable for this routine, and for which hosts?
- Can circom be baked into the environment?
