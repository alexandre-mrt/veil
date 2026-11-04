# 2026-11-04 — On-chain gas per entry point (queue item #1) — BLOCKED

## Hypothesis

Gas per Veil entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops)
can be measured by running the existing Move suite and a real proof round-trip on a local Sui network
with a `sui` CLI, and the Groth16 verify share of `shielded_transfer` gas is the number that sizes the
payoff of batched verification (queue item #3). **No gas number was produced tonight.**

## Threat / privacy model

None changed — measurement-only, no protocol change. Residual surface, assumptions and STRIDE mapping
are unchanged from `docs/threat-model.md`.

## Approach — what was tried (all real, in order)

1. `which sui` → absent. `sui` is not in the image.
2. JSON-RPC to the public fullnodes (`fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`) → proxy
   `CONNECT tunnel failed, response 403`. So `suix_queryTransactionBlocks` against the README's deployed
   package is **not reachable from this environment's network policy**. (Rules out queue-item-1 option B.)
3. GitHub release API (`api.github.com`) → denied, but the **release asset download URL works**:
   `https://github.com/MystenLabs/sui/releases/download/testnet-v1.60.0/sui-testnet-v1.60.0-ubuntu-x86_64.tgz`
   (302 → `release-assets.githubusercontent.com`, 200). Downloaded 837,340,044 bytes, extracted fine
   (`sui`, `sui-test-validator`, `sui-faucet`, `move-analyzer`, … present).
   `sha256 c61b762d7a24aee05f6d864ca83c7ba4be3fd0b60b625472a0d64a0580836f8e` (not compared against a
   published checksum — none was fetched).
4. First execution (`sui --version; sui move test`) was **denied by the session's auto-mode permission
   classifier** ("Code from External": an unverified binary downloaded from the internet). I did not
   try to route around the denial.

## Results

| Metric | Baseline | After |
|---|---|---|
| Gas per entry point | not measured | **not measured** (BLOCKED) |
| Move tests (124) | not run | **not run** |

Raw output: the only measurements are the connectivity facts above (403 on both fullnodes; 200 on the
release asset; sha256 above). No gas figure exists, and none is estimated here.

## Verdict — BLOCKED (unblock path found)

Missing: permission to execute the downloaded Sui CLI. Everything else is in place. To unblock, either
(a) approve running the binary in this routine's environment (pin the checksum below after verifying it
against the release page), or (b) bake `sui` into the environment's setup script. Then measure with:
`sui move test --statistics` for per-test gas, plus a localnet (`sui start --force-regenesis`),
publish `contracts/`, and drive real proofs via `scripts/` to read `gasUsed` per entry point, saved as
`scripts/bench/gas.mjs` (not written tonight — can't be validated without a runnable CLI, and an
unrunnable script would be an invented benchmark by another name).

## Where this could be used

Per-verify Groth16 gas is the input for any "N transfers → 1 verify" design: e.g. a batched confidential
payroll run on Sui (one pay-run proof for a whole payroll table) is only worth building if verify
dominates `shielded_transfer` gas. That is the thesis-chapter question this number answers.

## Open questions

- What fraction of `shielded_transfer` gas is `sui::groth16` verification vs. object/dynamic-field writes
  (Merkle insert, nullifier set)?
- Is the pool shared object the contention bottleneck rather than gas? (needs the same localnet.)
