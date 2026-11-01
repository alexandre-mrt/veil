# 2026-11-01 — On-chain gas per entry point (toolchain unblock attempt)

**Verdict: BLOCKED** (third consecutive block on this item; the blocker is now different and narrower).
Nothing in this report is a measurement. No gas number was produced.

## Hypothesis
Each Veil entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify) has a gas
cost measurable with `sui move test` / a local `sui-test-validator`, dominated by the
`sui::groth16` verify call. Target number: MIST per entry point. **UNMEASURED.**

## Threat / privacy model
Not applicable: no protocol or circuit change. Measurement only. No change to `docs/threat-model.md`.

## Approach — what was tried tonight
1. Direct JSON-RPC read against `fullnode.testnet.sui.io` (to recover historical gas from the deployed package):
   `curl -X POST https://fullnode.testnet.sui.io:443 ...` → `curl: (56) CONNECT tunnel failed, response 403`.
   The agent egress proxy status shows `connect_rejected` for that host. The host is not allowed in
   this environment, so this route is closed, not merely untried.
2. Prebuilt `sui` CLI: `https://github.com/MystenLabs/sui/releases/download/testnet-v1.50.1/sui-testnet-v1.50.1-ubuntu-x86_64.tgz`
   **is reachable** through the proxy (HTTP 200, 782,171,393 bytes). Extracted `sui` (189,553,288 bytes) to the scratchpad.
3. Running `./sui --version` on that binary was **denied by the session's auto-mode classifier**
   ("Code from External"). Per policy it was not retried or bypassed (e.g. via other wrappers).

So the toolchain *is obtainable*; what is missing is permission to execute a downloaded third-party binary.

## Results
No benchmark was run. The only raw outputs are the failures quoted above. `scripts/bench/` unchanged.

## Verdict — BLOCKED
Missing: authorization to execute the prebuilt Sui release binary (or an allowlist entry for it / for
`fullnode.testnet.sui.io`). Exactly what to do next:
- Option A (recommended): pre-approve running binaries from the Sui GitHub release in this routine's
  permission settings, or bake `sui` into the environment's setup script. Then the next run goes straight to
  `sui move test --gas-limit ... ` plus a `sui-test-validator` publish-and-call script under `scripts/bench/gas.mjs`.
- Option B: allowlist `fullnode.testnet.sui.io` and use `suix_queryTransactionBlocks` against the README package ID.
- Option C: demote this item and let the loop run Poseidon2 (item 2), which only needs circom/snarkjs.

Not run (so no claim): the 124-test Move suite; the circuits suite (no circuit or contract changed).

## Where this could be used
Once measured, per-verify gas is the denominator for any batching/aggregation work (queue item 3) and for
sizing a gas-sponsored relayer for e.g. confidential payroll on Sui with a t-of-n auditor board.

## Open questions
- Can the environment run the downloaded `sui` binary, or must it ship in the image?
- If neither A nor B is granted, should item 1 be demoted below item 2 so nights stop being spent on it?
