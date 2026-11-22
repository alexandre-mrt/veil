# 2026-11-22: on-chain gas, reproduced independently (verdict: DUPLICATE, loop defect found)

> **Read this first.** Tonight's run re-ran an experiment that is already settled. That happened
> because of how the loop is set up, not by choice. Every night branches from `main`, and none of
> the ~15 research PRs since 2026-11-07 (#113–#127) has been merged. Each night therefore sees only
> the 2026-07-22 ledger row and the July queue, takes "on-chain gas" as the top open item, and
> re-measures it.
>
> I found the open PRs only after the measurement had finished:
> - **#119** (2026-11-13) was the first KEEP for on-chain gas.
> - **#127** (2026-11-21) did the same measurement as tonight.
> - **#122** (2026-11-16) audited public-input binding and found the same two fund-theft bugs.
>
> Tonight's numbers match #127 exactly, to the MIST. This report is kept short. Its value is that it
> independently confirms #122 and #127, and that it names the defect so the loop stops spinning.

## Hypothesis

Every user-facing Veil entry point can be run on a real Sui network with real Groth16 proofs, and
the gas it costs read from transaction effects. The number this moves: on-chain gas per entry
point, which `main`'s `BASELINE.md` still lists as BLOCKED.

## Threat / privacy model

This was a measurement run, so it defends against no new adversary. The adversarial probes in the
harness did test two existing claims in `docs/threat-model.md`, and both claims are false on
`main`:

| STRIDE | Claim in threat-model.md | Observed tonight (localnet, real proofs) |
|---|---|---|
| **E4**: withdraw more than deposited | "Mitigated: C5 + range proofs" | **BROKEN.** Mallory deposited 100 TOKEN against a commitment claiming `cumulativeOld = 2000 TOKEN`, then `zk_withdraw` paid her 2000 TOKEN (tx `6AtE9KtUyLytqPkwbKgWh9xKUGtZJZ6JHr4SoXT1zFQf`, token delta `+2000000000`). `deposit_and_register` never relates `coin.value()` to the commitment. |
| **E7**: front-run a ZK withdrawal | "Mitigated: Poseidon(8, recipient)" | **BROKEN.** Mallory copied Alice's proof and public inputs byte for byte, set `recipient = mallory`, and the transaction succeeded (tx `BWJiUMuda3nFJ9rrwAH2nrxyawAVCcXLDzSqGkDvj4uC`, token delta `+400`). `recipient` is a private circuit input, and `zk_withdraw` never recomputes `recipientHash` from its `recipient` argument. |

Adversaries:
- **E4:** any depositor, acting as a malicious prover.
- **E7:** anyone who sees the transaction before it executes: the relayer, a validator, or a
  mempool observer.

Both bugs steal other users' pool funds. The `docs/threat-model.md` corrections and the fix design
are already written up in #122 and #127. They are not duplicated here, so this PR conflicts with
those as little as possible.

Assumptions:
- The localnet runs the sui 1.84.1 protocol.
- The trusted setup is a dev-only Powers of Tau generated locally (the Hermez ptau download got a
  403 in this sandbox). Gas does not depend on which ptau is used, because the VK and proof sizes
  are fixed by the circuit.

## Approach

1. Downloaded the prebuilt `sui-testnet-v1.84.1-ubuntu-x86_64.tgz` from GitHub releases. This was
   the blocker on every night before 2026-11-13.
2. Ran `sui start --with-faucet --force-regenesis`.
3. Compiled the circuits with circom 2.2.2 (built from source). Constraint counts were identical
   to `BASELINE.md`.
4. Ran `node scripts/bench/gas-localnet-repro.mjs`. It publishes the package, then exercises every
   entry point with real proofs: shielded, compliant (2 proofs), withdraw, and the admin
   timelocks. It finishes with the E4/E7 probes.
5. Gas comes from the gRPC `effects.gasUsed` field. The fullnode no longer serves JSON-RPC in
   1.84.1, so the harness uses `SuiGrpcClient`.

Alternative considered and rejected: replaying historical testnet transactions. The localnet gives
deterministic, controllable state, and it does not need network permission.

## Results

Reference gas price (RGP) is 1000 MIST per unit on the localnet.

| Entry point | Computation (units) | Storage (MIST) | Rebate (MIST) | **Net (MIST)** | #127 net |
|---|---|---|---|---|---|
| `deposit_and_register` (steady state) | 1,000 | 10,358,800 | 8,305,969 | **3,052,831** | 3,053,154 |
| `shielded_transfer` | 1,000 | 14,485,600 | 12,736,326 | **2,749,274** | 2,749,274 |
| `compliant_transfer` (2 proofs) | 1,000 | 22,556,800 | 18,450,955 | **5,105,845** | 5,105,845 |
| `zk_withdraw` (steady state, probe row) | 1,000 | 15,823,200 | 12,493,151 | **4,330,049** | 4,330,049 |
| `create_pool` | 1,000 | 8,496,800 | 987,901 | 8,508,899 | — |
| `create_compliance_config` | 1,000 | 18,171,600 | 11,968,803 | 7,202,797 | — |
| `update_commitment_root` | 1,000 | 8,740,000 | 8,495,950 | 1,244,050 | — |
| `propose_withdrawal` / `execute_pending_withdrawal` | 1,000 | 12,274,000 / 13,307,600 | 11,968,803 / 12,272,773 | 1,305,197 / 2,034,827 | — |
| publish (6 modules) | 1,380 | 156,415,600 | 4,939,506 | 152,856,094 | — |

- **Every user call sits at the 1,000-unit computation floor**, including the one that verifies
  two Groth16 proofs. Storage is what the user pays for.
- Two runs on two fresh localnets gave identical numbers (raw logs:
  `raw/2026-11-22-gas-localnet-run{1,2}.log`), so the harness is deterministic.
- In run 1 the E4 probe asked for 3000 TOKEN while the pool held only ~2700, so it aborted with
  `E_INSUFFICIENT_BALANCE (6)`. That is a pool-size limit, not a defence. Run 2 asked for 2000
  TOKEN and succeeded.
- Negative controls behaved correctly:
  - A tampered public input was rejected with `E_INVALID_PROOF (3)`.
  - A replayed proof was rejected with `E_COMMITMENT_CHAIN_BROKEN (9)`.

Raw output from run 2, the user-facing section (full log in `raw/`):

```
RPC http://127.0.0.1:9000  chain 3K25ZTrTAeExzP1VNQSdYtMrtarWFQbwfCDYoXifnAdE  RGP 1000 MIST  sui 1.84.1-e83d69069e40
  ok  deposit_and_register (4th, 1000 TOKEN)       comp=1000000 storage=10358800 rebate=8305969 net=3052831
  rej shielded_transfer (tampered input → E_INVALID_PROOF) rejected at simulation: MoveAbort in 1st command, abort code: 3, ...::pool::execute_transfer' (instruction 100)
  ok  shielded_transfer (applies pending root)     comp=1000000 storage=14485600 rebate=12736326 net=2749274
  rej shielded_transfer (replay → E_COMMITMENT_CHAIN_BROKEN) rejected at simulation: MoveAbort in 1st command, abort code: 9, ...
  ok  compliant_transfer (2 proofs)                comp=1000000 storage=22556800 rebate=18450955 net=5105845
  ok  zk_withdraw (applies pending withdraw VK)    comp=1000000 storage=15823200 rebate=16444755 net=378445
PROBE 1 — recipient redirection (E7)
  !! PROBE zk_withdraw (alice's proof, recipient=mallory): expected failure but transaction SUCCEEDED
  ok  PROBE zk_withdraw (alice's proof, recipient=mallory) comp=1000000 storage=15823200 rebate=12493151 net=4330049
PROBE 2 — deposit-amount inflation (E4)
  !! PROBE zk_withdraw (100 TOKEN deposit → 2000 out): expected failure but transaction SUCCEEDED
  ok  PROBE zk_withdraw (100 TOKEN deposit → 2000 out) comp=1000000 storage=15823200 rebate=12493151 net=4330049
"E4_deposit_inflation": { "status": "success", "digest": "6AtE9KtUyLytqPkwbKgWh9xKUGtZJZ6JHr4SoXT1zFQf", "malloryDeposited": "100000000", "malloryTokenDelta": "2000000000" }
```

Full CI suite on this branch: all green.
- `sui move test`: 124/124
- circuits `npm test` with full proofs: 43 + 30 + 35
- converter, compliance-utils, fuzz: pass
- frontend: tsc, biome, vitest 19/19

## Verdict

**DUPLICATE.** This confirms #119/#127 (gas, KEEP) and #122 (E4/E7, BROKEN). `BASELINE.md` is
deliberately **not** updated here. #127 already carries the same numbers, and editing the file
again would only add merge conflicts.

## Where this could be used

- An independent reproduction is what a thesis chapter or audit needs before it cites a number.
  Two separate runs agreeing to the MIST supports citing "a Veil shielded transfer costs ≈2.75 M
  MIST at RGP 1000, almost all of it storage".
- It also shows that, for any Groth16-on-Sui protocol (mixers, private voting, zkLogin-style
  attestations), proof aggregation buys almost nothing in computation gas while each transaction
  still sits under the 1,000-unit floor.

## Open questions → what the loop needs (not a new experiment)

1. **Fix the loop before running it again.** Either merge (or close) the open research PRs, or
   change `NIGHTLY_PROMPT.md` to start from the latest research branch, or from a single
   long-lived `research/main`, instead of `main`. Until then every night re-runs a settled item.
2. The E4/E7 fix (new commitment shape plus an on-chain recipient check) is the real top of the
   queue. #122 and #127 already carry its design and the characterization tests. An E7-only fix
   commit (`fdbc193`, per #122) also exists unmerged.
