# 2026-10-07 — On-chain gas per entry point (queue item #1)

**Verdict: BLOCKED.** No gas number was measured tonight. Everything below the "Results" heading
that is not raw command output is labelled **UNMEASURED**.

## Hypothesis

`pool::shielded_transfer`, `pool::compliant_transfer` and `pool::zk_withdraw` each spend most of
their gas on Groth16 verification, and hoisting `prepare_verifying_key` out of the per-call path
(storing a `PreparedVerifyingKey` in `Pool`/`ComplianceConfig`) cuts per-transfer gas by the ~82K
that a comment in `contracts/sources/verifier.move` claims. Number it should move: gas units per
`shielded_transfer`. Falsifiable by measuring `shielded_transfer` before/after on one network.

## Threat / privacy model

Pure measurement; no protocol change, so no new adversary and no STRIDE entry changes. The one
relevant adversary is a **gas-griefing / DoS attacker** (STRIDE "D"): the cost of a verify bounds
what it costs an honest relayer to submit and what an attacker pays to spam invalid proofs.
Without real gas numbers that cost is unquantified. This experiment does **not** defend against
anything and does not touch RR2 (dev-only trusted setup).

## Approach

Plan: unblock the toolchain first, then measure. Both routes were tried and both are closed by the
session's egress policy (not by missing tools):

1. JSON-RPC read of the deployed testnet package (`suix_queryTransactionBlocks` /
   `sui_getTransactionBlock` for real historical gas) — would need `fullnode.testnet.sui.io`.
2. Prebuilt `sui` CLI from GitHub releases, then `sui move test` + `sui client dry-run` on a local
   or testnet publish.

Alternatives rejected: building the Sui workspace from source (would also need github.com egress,
which is denied, and is not a one-night budget); routing around the proxy (the proxy README says
403 policy denials must be reported, not bypassed); estimating gas from Sui's published cost
tables from memory (that is exactly the invented-number failure this loop forbids).

## Results

Nothing measured. Raw evidence of the block:

```
$ curl -sS -m 20 -X POST https://fullnode.testnet.sui.io:443 -d '{"jsonrpc":"2.0","id":1,"method":"sui_getLatestCheckpointSequenceNumber","params":[]}'
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS -m 20 -o /dev/null -w "%{http_code}\n" -I https://github.com/MystenLabs/sui/releases/latest
403
$ curl -sS -m 20 -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/MystenLabs/sui/releases/latest
403
$ which sui
(not found)

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"   # recentRelayFailures
  "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "fullnode.testnet.sui.io:443"
```

Other public Sui RPC hosts tried once each (blockvision, ankr, nodeinfra, mainnet fullnode)
returned curl exit `000` (no connection); not retried.

### Structural inventory (read from source — **gas UNMEASURED**)

This is what a measurement would have to decompose. Counts are from `contracts/sources/*.move`,
not from execution.

| Entry point | Groth16 verifies | `prepare_verifying_key` calls | Dynamic-field ops | Public-input bytes |
|---|---|---|---|---|
| `shielded_transfer` | 1 (transfer) | 1 | 3 `exists`, 1 `remove`, 2 `add` | 224 (7×32) |
| `compliant_transfer` | 2 (transfer + compliance) | 2 | same as above + credential-nullifier ops | 224 + compliance inputs |
| `zk_withdraw` | 1 (withdraw) | 1 | nullifier `add`, new-commitment `add` | 5×32 |
| `deposit_and_register` | 0 | 0 | 1 `add` | — |

Finding worth keeping: `verifier.move` carries the comment *"Saves ~82K gas per verification"* for
storing the prepared VK. **No evidence for that figure exists in this repo or in the ledger.** It
is an unverified number sitting in production code and should not be cited until measured.

## Verdict

**BLOCKED.** Missing: (a) egress to a Sui fullnode (`fullnode.testnet.sui.io:443`), or (b) a `sui`
CLI binary (egress to GitHub releases or a vendored binary). Either one unblocks the whole item.
The blocker is policy, so it needs a human decision on the environment's network allowlist, not
more effort from the loop. Third consecutive night this item is blocked (second for egress).

## Where this could be used

A measured per-verify gas figure is the input for: relayer fee schedules on Sui privacy pools
(what a relayer must charge to break even per shielded transfer), the batching decision
(queue #3: N proofs → 1 verify only pays if verify dominates gas), and the thesis chapter on
on-chain verification cost of Groth16 on Move (BN254 native vs. aggregated verification).

## Open questions

- Allow `fullnode.testnet.sui.io` (read-only RPC) or `github.com/MystenLabs/sui/releases`?
  Either closes this item in one run.
- Is the ~82K prepared-VK saving real? Needs `dry-run` of `shielded_transfer` with and without
  `prepare_verifying_key` in the path.
- Queue item #2 (Poseidon2 constraint count) needs only circom/snarkjs, which work offline —
  it is the next runnable experiment while this one stays blocked.
