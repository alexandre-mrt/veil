# 2026-10-31 — On-chain gas per entry point: toolchain unblock (queue item #1)

**Verdict: PARK.** No gas number was produced. Two blockers were removed and one remains.
Nothing here is a benchmark; every figure below comes from a command that was run.

## Hypothesis

A prebuilt `sui` CLI can be obtained inside the sandbox, which unlocks real per-entry-point gas
measurement on a local network (`shielded_transfer`, `zk_withdraw`, `compliance::compliant_transfer`,
`deposit_and_register`, admin ops). Number it should move: on-chain gas rows in `BASELINE.md`
(0 of N measured before tonight).

## Threat / privacy model

No protocol change, so no adversary model change. Gas numbers matter to a *griefing / DoS*
adversary (what does it cost to make the pool's shared object expensive to use) and to the
batching experiment (queue #3), which needs a per-verify gas figure. Not defended / not established:
anything about gas. Assumptions unchanged. Maps to no STRIDE entry yet; it is a prerequisite for a
future gas-DoS entry.

## Approach

1. Public fullnode RPC (`fullnode.testnet.sui.io:443`): **denied** by the environment's network
   policy (proxy status shows `connect_rejected`, 403 on CONNECT). So the "read historical gas from
   the deployed testnet package" route is closed in this environment.
2. Prebuilt CLI from GitHub Releases: **works**. Latest testnet tag found via `git ls-remote` was
   `testnet-v1.83.0`; the `ubuntu-x86_64` tarball downloaded (1,191,250,401 bytes) and runs.
3. Real proofs require compiled circuits (wasm + zkey), which require `circom`. Building `circom`
   v2.2.2 from source (as the 2026-07-22 run did) was **blocked by the run's permission layer**
   ("Code from External") when I tried to clone and `cargo build` it. I did not try to route around
   that (e.g. an npm WASM circom port). The repo ships only `*_vk.json`, no wasm/zkey, so no valid
   proof can be produced here.

Rejected alternative: measuring gas with an *invalid* proof. Verification would likely cost the
same until abort, but "likely" is an estimate, and the entry point's post-verify work (nullifier
insert, leaf insert, balance move) would be missing. Not reported as a measurement.

## Results

| Item | Before | After | Source |
|---|---|---|---|
| `sui` CLI available | no | yes (1.83.0) | below |
| Move suite (`sui move test`) | NOT RUN | 124 / 124 pass | below |
| Gas per entry point | BLOCKED | **still BLOCKED** (needs circom) | — |

```
$ sui --version
sui 1.83.0-16d2dc1e05ed

$ cd contracts && sui move test | tail
[ PASS    ] veil::pool_withdraw_tests::test_zk_withdraw_no_vk
[ PASS    ] veil::pool_withdraw_tests::test_zk_withdraw_short_inputs
Test result: OK. Total tests: 124; passed: 124; failed: 0
```

`sui move build` also succeeds (about 7 s warm; only linter warnings).
Reproduce: download `sui-testnet-v1.83.0-ubuntu-x86_64.tgz` from
`github.com/MystenLabs/sui/releases`, extract `./sui`, run the two commands above.

## Verdict

**PARK** — blocked on a `circom` binary. Once available the plan is: `sui start --force-regenesis
--with-faucet`, publish `contracts/`, drive the flow in `scripts/src/e2e-test.ts` against localnet
(it hardcodes `NETWORK = "testnet"`; needs a localnet switch), and read `effects.gasUsed`
(computation + storage − rebate) per call. Put it in `scripts/bench/gas-localnet.mjs`.

## Where this could be used

A per-verify gas number is the input for any "N confidential transfers, one verification"
design on Sui, e.g. confidential payroll with a t-of-n auditor board settling a whole pay run in
one transaction (thesis scalability chapter).

## Open questions (tomorrow's queue)

- Can a `circom` binary be provided to the sandbox (pre-installed, or a permitted build)? This
  gates items 1, 2 and 5 of the queue.
- Localnet gas uses the local reference gas price and protocol config; confirm it matches testnet's
  `groth16` native cost table before quoting numbers as "mainnet cost".
