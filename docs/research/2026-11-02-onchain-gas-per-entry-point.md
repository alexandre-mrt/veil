# On-chain gas per entry point — BLOCKED (third attempt)

Date: 2026-11-02. Queue item #1. **Verdict: BLOCKED. Nothing measured; no numbers in this file.**

## Hypothesis
`shielded_transfer` costs measurably more gas than `zk_withdraw` and `deposit`, and `sui::groth16`
verification dominates it; a real per-entry-point gas table in `BASELINE.md` would show by how much.
(Not tested.)

## What was attempted tonight (all commands actually run)
| Route | Result |
|---|---|
| `which sui` | not installed |
| JSON-RPC to `fullnode.testnet.sui.io:443` (read-only `sui_getLatestCheckpointSequenceNumber`) | `curl: (56) CONNECT tunnel failed, response 403` — host not on the session's egress allow-list |
| `fullnode.mainnet.sui.io`, `sui-testnet-endpoint.blockvision.org` | same 403 from the egress proxy |
| Prebuilt binary from GitHub releases (`github.com/MystenLabs/sui/releases/latest`, `api.github.com/.../releases/latest`) | 403 / "GitHub access to this repository is not enabled" — release assets are not served, only anonymous git reads |
| `suiup` via pip | no matching distribution |
| Shallow clone of `MystenLabs/sui` (works, 238 MB) + `cargo build -p sui --bin sui` in the background (4 cores, 15 GB RAM, ~31 GB free disk; crates.io reachable) | **Denied by the session's auto-mode permission classifier** ("Code from External"). Not retried or worked around, per policy. Clone was deleted. |

Also absent this session: `circom` and `circuits/build/` artifacts, so the cheap fallback (queue #8,
mobile WASM latency) would first need a circom toolchain, which has the same external-build problem.

## What is needed to unblock (any one of)
1. Allow `fullnode.testnet.sui.io` on the egress proxy → recover real historical gas via
   `suix_queryTransactionBlocks` / `sui_getTransactionBlock` against the package IDs in `README.md`.
   Cheapest, and gives real on-chain numbers.
2. Allow a prebuilt `sui` binary download (GitHub release asset or `suiup`) → `sui move test` (124
   tests) plus a localnet `sui client call --gas-budget` dry-run per entry point.
3. Explicitly approve a from-source `cargo build -p sui` (est. hours and 15–25 GB; not measured —
   labelled UNMEASURED) in a session with a longer budget.

## Threat / privacy model
N/A — no design or code change. Residual: gas cost of verification is unknown, so the DoS/cost-based
entries in `docs/threat-model.md` cannot yet be quantified.

## Where this could be used
A measured per-verify Groth16 gas figure on Sui is the input for any batching/aggregation argument
(queue #3) and for fee-model design of relayer-subsidised confidential payroll on Sui.

## Open questions
- Can the operator allow-list one Sui fullnode host? (Highest leverage; changes the plan.)
- Is the circom toolchain installable via the `circom2` npm WASM package, to unblock queue #8?
