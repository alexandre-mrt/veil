# 2026-10-01 — On-chain gas per entry point (queue item #1)

## Hypothesis

Every Veil entry point can be executed end-to-end with a real Groth16 proof on a local Sui network and
its gas read from `effects.gasUsed`, and Groth16 verification is **not** what makes a Veil
transaction expensive. This moves "entry points with a measured on-chain gas number" from 0 to 11
(`publish`, `create_pool`, `create_compliance_config`, `deposit_and_register`, `shielded_transfer`,
`compliant_transfer`, `zk_withdraw`, and four admin ops), and gives the first measured answer to
"how much of a transfer's cost could proof aggregation remove" (queue item #3's premise).

This is a measurement night. No circuit, Move module, or frontend code changed.

## Threat / privacy model

No protocol property changes. Who relies on these numbers:

- **A griefing adversary** (threat-model D3, "spam pool with fake commitments"): the cost of one
  `deposit_and_register` is now measured (net 1,799,900 MIST ≈ 0.0018 SUI in gas, on top of the 100–1000
  TOKEN standard denomination). The *gas* alone is a trivial deterrent; D3's mitigation is the
  denomination, not gas.
- **A chain observer**: gas is public, and tonight's table shows entry points are
  distinguishable by gas alone (compliant transfer nets 5.29M MIST vs 3.12M for a plain transfer). That
  leaks nothing new — the called function is already in the transaction — but it means gas padding
  cannot hide the compliant/non-compliant distinction, and the gas payer address is the real
  linkability surface (this is what the relayer exists for; unchanged, unmeasured tonight).

What this does **not** establish: mainnet/testnet fee levels (this is a local network at RGP 1000 —
see Caveats), shared-object contention on the single `Pool` under concurrent transfers (every transfer
mutates the same shared object; not measured), or any security property. No STRIDE entry changes.
Assumptions carried over unchanged: Groth16/BN254 soundness, and the dev-only trusted setup (RR2) —
note the proving keys used here came from a **locally generated, single-party powers-of-tau**
(see Tooling findings), which is fine for gas (gas does not depend on the ceremony) and
useless for anything else.

## Approach

`scripts/bench/gas-localnet.ts` (new, reusable): starts from nothing but a funded throwaway key on a
local Sui network, publishes `contracts/`, creates a pool and compliance config, deposits real
commitments, proposes the commitment root + withdraw VK (1-epoch timelocks, 60 s epochs), sleeps past
the epoch boundary, generates **real proofs with snarkjs against the real zkeys** (transfer,
compliance, withdraw; each also verified locally), then executes the entry points and records
`gasUsed`. Merkle paths are real depth-20 paths into a tree of all deposited leaves.

To separate verification cost from the per-transaction floor, the script also **dry-runs N proofs in one
programmable transaction** (N = 1…24 `shielded_transfer`, 1…8 `zk_withdraw`). Dry-runs do not consume
state, so the same leaves are reused. First-use lazy work (applying the pending root / withdraw VK) is
absorbed by the first live call of each kind and reported separately from "steady state".

Alternatives rejected before building:
- *JSON-RPC reads of historical testnet gas* (the queue's idea): the sandbox's egress policy denies
  `fullnode.testnet.sui.io` (`CONNECT … 403`, confirmed tonight with `curl`). Not viable here.
- *`sui move test` gas*: the unit-test framework meters Move instructions with a test cost table, not
  the real protocol gas schedule and not natives at protocol prices. It would be an estimate, not a
  measurement.
- *Building the Sui workspace from source*: unnecessary — release binaries on `github.com`
  are reachable (the `api.github.com` listing is denied, but direct `releases/download/…` URLs work).

## Results

Measured 2026-10-01, `sui 1.81.0-bf0c491c17b8` localnet (`sui start --force-regenesis --with-faucet`),
protocol version 138, reference gas price 1000 MIST/unit, `contracts/` at this commit. All amounts in
MIST (1 SUI = 10⁹ MIST). **Net = computation + storage − storage rebate** — what the sender
actually loses. Raw per-transaction output: `raw/2026-10-01-gas-localnet.log` (human) and
`raw/2026-10-01-gas-localnet.json` (digests, all fields).

| Entry point | Computation (units) | Storage cost | Storage rebate | **Net (MIST)** | Net (SUI) |
|---|---|---|---|---|---|
| `publish` (6 modules) | 1,390 | 156,415,600 | 9,781,200 | **148,024,400** | 0.148 |
| `create_pool` | 1,000 | 8,496,800 | 978,120 | 8,518,680 | 0.0085 |
| `create_compliance_config` | 1,000 | 14,698,400 | 8,411,832 | 7,286,568 | 0.0073 |
| `deposit_and_register` | 1,000 | 9,264,400 | 8,464,500 | 1,799,900 | 0.0018 |
| `shielded_transfer` #1 (also applies pending root) | 1,000 | 14,485,600 | 12,610,224 | 2,875,376 | 0.0029 |
| `shielded_transfer` #2 (steady state) | 1,000 | 14,485,600 | 12,369,456 | **3,116,144** | 0.0031 |
| `compliant_transfer` (transfer + compliance proof) | 1,000 | 22,556,800 | 18,268,272 | **5,288,528** | 0.0053 |
| `zk_withdraw` #1 (also applies pending VK) | 1,000 | 15,823,200 | 12,369,456 | 4,453,744 | 0.0045 |
| `zk_withdraw` #2 (steady state) | 1,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.0045 |
| `update_commitment_root` (propose) | 1,000 | 8,983,200 | 8,652,600 | 1,330,600 | 0.0013 |
| `propose_withdraw_vk` | 1,000 | 12,213,200 | 8,893,368 | 4,319,832 | 0.0043 |
| `freeze_pool` / `unfreeze_pool` | 1,000 | 11,970,000 | 11,850,300 | 1,119,700 | 0.0011 |
| `propose_withdrawal` / `cancel_withdrawal` | 1,000 | 12,274,000 / 11,970,000 | 11,850,300 / 12,151,260 | 1,423,700 / 818,740 | 0.0014 / 0.0008 |
| `update_credential_root` (propose) | 1,000 | 8,717,200 | 8,389,260 | 1,327,940 | 0.0013 |

**Computation is at the protocol floor for everything.** Every transaction except `publish` pays
exactly 1,000 computation units (1,000,000 MIST) — including the ones that run a Groth16 verification
(two of them in `compliant_transfer`). Batching N proofs in one transaction exposes the real slope:

| `shielded_transfer` × N in one PTB (dry-run) | Computation (units) | Per-transfer increment | Net (MIST) |
|---|---|---|---|
| 1 | 1,000 (floor) | — | 3,116,144 |
| 2 | 1,000 (floor) | — | 5,127,864 |
| 4 | 1,510 | — | 9,661,304 |
| 8 | 2,760 | 312 (4→8) | 18,958,184 |
| 16 | 5,430 | 334 (8→16) | 37,721,944 |
| 24 | 8,240 | 351 (16→24) | 56,625,704 |

| `zk_withdraw` × N in one PTB (dry-run) | Computation (units) | Net (MIST) |
|---|---|---|
| 1 | 1,000 (floor) | 4,453,744 |
| 2 | 1,020 | 7,823,064 |
| 4 | 1,560 | 15,061,704 |
| 8 | 2,640 | 29,538,984 |

Linear fit on N = 8 and 24: computation ≈ 20 + 342.5·N units per `shielded_transfer`. A single
transfer therefore does ~360 units of real work and is billed 1,000: the floor, not the verifier,
sets the price. (`zk_withdraw`: ≈ 270 units/withdrawal, 4→8.) Each unit is 1,000 MIST here, so the
measured per-transfer work is ≈ 0.34M MIST against ≈ 3.1M MIST net, and this 342-unit
figure is an **upper bound on the Groth16 verification share** — it also contains hashing, the
epoch/threshold checks, three dynamic-field operations and event emission, which I did not separate out.

Storage is the cost: ≈ 2.0–2.4M MIST of net cost per additional transfer in the batch, almost all storage (by reading
`pool.move`, a transfer removes one commitment dynamic field and adds a nullifier and a new commitment
field, so net +1 field; the nullifier is permanent — the field-level split is inferred, not measured), and each
transaction rewrites the whole shared `Pool` object (gross storage ≈ 14.5M, of which ≈ 12.4M is
rebated — only the net moves the sender's balance).

### Verification (existing suites, run on the same machine — no code changed)

- `cd contracts && sui move test --build-env testnet` → `Test result: OK. Total tests: 124; passed: 124; failed: 0`
  (with both the 1.64.0 and the 1.81.0 CLI).
- `node circuits/test/transfer.test.mjs` → `Results: 43 passed, 0 failed`; `withdraw` → `35 passed, 0 failed`;
  `compliance` → `30 passed, 0 failed`. (Run per file; the chained `npm test` hang from queue item #12 is
  still open.) These ran against zkeys built from a **locally generated** ptau — see below.
- `cd scripts && bun run src/test-converter.ts` → `Results: 109 passed, 0 failed`.

### Reproduce

```
# 1. Sui CLI >= 1.81 (older release binaries cannot host this package, see Findings)
curl -sSL -o sui.tgz https://github.com/MystenLabs/sui/releases/download/testnet-v1.81.0/sui-testnet-v1.81.0-ubuntu-x86_64.tgz
tar xzf sui.tgz ./sui
# 2. circuits (circom 2.2.2 binary from the iden3/circom release page; ptau: see Tooling findings)
cd circuits && npm install && bash scripts/compile.sh && bash scripts/compile-withdraw.sh && bash scripts/compile-compliance.sh
# 3. local network, then the bench (~4.5 min; sleeps through one 60 s epoch)
sui start --force-regenesis --with-faucet &
cd scripts && bun install && node --experimental-strip-types bench/gas-localnet.ts > gas.json 2> gas.log
```

(`bun run` crashes inside snarkjs's worker threads — a Bun 1.3.14 bug in `web-worker`'s `dispatchEvent` —
so the bench runs under Node.)

## Caveats (read before quoting a number)

- **Localnet, not testnet/mainnet.** Reference gas price here is 1000 MIST/unit. Computation scales
  with the live RGP; the storage price per byte is a protocol parameter and should match for the same
  protocol version, but this was **not cross-checked** against a real network (egress denied). Treat
  the *ratios* (storage ≫ computation, floor-bound computation) as the finding and the absolute SUI
  figures as local-network figures.
- **One run.** Gas is deterministic given identical state, so repeats are not informative for
  computation; the `#1`/`#2` pairs show the lazy-apply effect. Proof generation timing is not part of
  this experiment.
- **Dry-run N× numbers** come from `dryRunTransactionBlock`, not executed transactions; the live and
  dry-run N = 1 rows agree exactly (3,116,144 MIST), which is the only cross-check available.
- `publish` bytecode was built with `--no-tree-shaking` against a framework rev newer than the
  localnet's own; the on-chain dependency list therefore differs from a CLI `publish`. The 148M MIST
  figure is the publish transaction as the bench sent it.

## Findings outside the hypothesis (real, reproducible, not fixed tonight)

1. **`contracts/` cannot be published to a Sui ≤ 1.70 network.** The pinned framework rev in
   `Move.toml` (`94ad8cc…`, 2026-05-12) compiles `dynamic_field::exists`, which does not exist on-chain
   before 1.81. A 1.64.0 and a 1.70.2 localnet both reject the publish with
   `VMVerificationOrDeserializationError`, node log `LOOKUP_FAILED … FunctionHandle 60` in module
   `pool`. 124/124 unit tests still pass because they link against the local framework source.
   Anyone deploying must target a network on ≥ 1.81; this is not documented anywhere.
2. **`circuits/scripts/compile*.sh` is broken on a clean checkout.** They download the Hermez ptau from
   `storage.googleapis.com/zkevm/ptau/…`, which now answers `AccessDenied` (the script then feeds the
   XML error body to snarkjs: `Invalid File format`). Tonight's workaround was a local
   `snarkjs powersoftau new/contribute/prepare phase2` for 2¹⁵ (≈ 8 min wall-clock).
   A pinned, checksummed ptau mirror (or a documented generation step) is needed. The baseline's
   constraint counts are unaffected (they do not depend on the ptau); zkey/vk *sizes* should be
   unaffected too, but the bytes are not identical to the 2026-07-22 run.
3. The faucet module's per-call mint is exactly `DENOM_LARGE`, so test deposits work only with one
   whole faucet coin each — noted because it silently caps bulk-deposit tests at 1,000 mints.

## Verdict

**KEEP.** `BASELINE.md` now carries measured gas for every entry point, closing the one axis
queue item #1 existed for. The experiment also produced the first quantitative argument about
the roadmap: because computation is floor-bound and storage dominates, proof aggregation (queue #3)
has a hard upper bound of ≈ 0.34M of ≈ 3.1M net MIST (≤ 11%) per transfer *before* paying for the
aggregation circuit itself, so it is re-ranked down. Reduced-storage designs move more of the
number Veil pays for.

## Where this could be used

- **Fee modelling for a relayer business** (`scripts/src/relayer.ts`): a relayer subsidising
  transfers needs ~0.0031 SUI (plain), ~0.0053 SUI (compliant), ~0.0045 SUI (withdraw) at the
  local RGP, and the compliant/plain ratio (1.7×) is directly usable as a pricing input for a
  confidential-payroll deployment that mixes both transfer types.
- **Any Groth16-on-Sui protocol** (private voting, sealed-bid auctions, ZK credentials on
  `sui::groth16`): the "verification is free under the 1,000-unit floor, state is what you pay for"
  result generalises — design such protocols around state footprint (nullifier sets, commitment
  maps), not verifier cost, until a single transaction carries ≳ 3 verifications. The
  `scripts/bench/gas-localnet.ts` harness is a template for that measurement.
- **Thesis chapter**: "cost model of ZK payment protocols on an object-based L1" — the storage-fund
  model (refundable rebate vs permanent nullifiers) is the interesting contrast to account-model
  chains where verification gas dominates.

## Open questions (become tomorrow's queue)

1. **Storage-minimal transfers.** Net per transfer is ≈ one permanent dynamic field (the nullifier)
   plus pool-object rewrite. Can the new-commitment dynamic field be dropped now that a Merkle root
   exists (index it off-chain, prove membership against the root)? What does that do to the 3.1M?
2. **Shared-object contention.** Every transfer mutates one shared `Pool`; consensus ordering and
   throughput under concurrent transfers is untouched by this measurement.
3. **Real-network cross-check** of RGP and storage price once egress to a Sui fullnode is permitted
   (or a testnet run by the owner): does the ratio hold?
4. **How much of the 342 units is the verifier?** Needs a verify-only call path (the verifier
   functions are `public(package)`); a test-only wrapper module in a scratch package would isolate it.
5. **Pin a ptau and the minimum Sui version** (findings 1 and 2) so the next bench run is one command.
