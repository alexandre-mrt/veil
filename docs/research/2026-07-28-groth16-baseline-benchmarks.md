# 2026-07-28 — Groth16 baseline: constraints, proving time, proof/VK size, browser latency

Queue item #1 from `docs/research/EXPERIMENTS.md`: `BASELINE.md` did not exist. Nothing else in the
queue (PLONK migration, batching, accumulator redesigns) can be judged "faster" or "cheaper" without
a real, reproduced-on-one-machine baseline to compare against.

## Hypothesis

Falsifiable claim: the R1CS constraint counts already asserted in the README (13,611 / 12,743 /
3,058 for transfer/compliance/withdraw) are exact reproductions of a real compile, not stale or
estimated figures — and Groth16 proving time for the largest circuit (`transfer`, 13,611 constraints)
is under 2 seconds server-side and under 3 seconds in-browser on ordinary hardware, with no prior
run of either measurement existing anywhere in the repo's history to check them against.

Result: **not falsified** on the numbers that could be measured. Constraint counts matched exactly.
Server-side proving time for `transfer` was under 2s (mean 970.5 ms). Browser proving time was only
measurable for `withdraw` (see Approach — why), at a mean of 682.3 ms, comfortably under the 3s bar;
`transfer`/`compliance` browser proving remains **UNMEASURED** because neither is wired into the
frontend's proving path yet, so there is no real page to drive.

## Threat / privacy model

This is a measurement change, not a protocol change — no circuit, no Move contract, and no
cryptographic parameter was touched. There is no new adversary and no new attack surface from the
diff itself. What changed is that a threat the repo already names now has real numbers attached to
it:

- **Adversary: griefer / DoS attacker (STRIDE `D2`/`D3` in `docs/threat-model.md`).** What they can
  do: spam `shielded_transfer`/`zk_withdraw`/relayer calls to burn other users' time or the relayer's
  budget. What they observe: nothing new — proving time and proof size were already implicitly
  bounded by the compiled circuits, this report just makes the bound legible. Knowing that `transfer`
  proving takes ~1s server-side / roughly similar-order in-browser, and that a 6 MiB zkey has to be
  fetched by every prover, is exactly the kind of number a griefing-cost or rate-limit design (`D2`:
  10 req/min/IP in `scripts/src/relayer.ts`) should be set against.
- **What this does NOT defend against — residual surface.** This report establishes cost, not
  correctness or privacy. It says nothing about whether the circuits are sound (that's queue item
  #9, a soundness sweep) or what a chain observer learns from on-chain calldata (unchanged — still
  governed by `docs/privacy-red-team-report.md`'s existing findings, since no on-chain behavior
  changed). It also does **not** establish real on-chain gas cost — that dimension is BLOCKED (see
  Approach) — so any DoS-cost argument built on this baseline is still missing its most important
  number: what verification actually costs the caller in gas.
- **Assumptions.** Same trusted setup and BN254 hardness assumptions the repo already documents
  (`docs/threat-model.md`, "ZK Proof Generation" trust boundary); this run reused the existing
  single-dev-contributor setup pattern (`circuits/scripts/compile.sh`) for `transfer`/`compliance`,
  and ran an equivalent one-off setup for `withdraw`. None of these zkeys are the production
  artifacts — they're throwaway, generated fresh for this benchmark, and are not committed (see
  `.gitignore`).
- **STRIDE mapping.** `docs/threat-model.md` Denial of Service section, entries `D2` (relayer spam)
  and `D3` (pool-spam via fake commitments). No Spoofing/Tampering/Repudiation/Information
  Disclosure/Elevation-of-Privilege entries are affected — this PR changes no verification logic.

## Approach

**What I built:**

1. A reproducible circuit-compile pipeline using `circom2` (the WASM build of the real circom 2.2.3
   compiler, published as an npm package) instead of the native `circom` binary the repo's
   `compile.sh` scripts expect — the native binary isn't installable in this sandbox (see rejected
   alternatives). `npx circom2 <circuit>.circom --r1cs --wasm --sym -o build -l node_modules`
   compiles the exact same circuit source the native compiler would.
2. `scripts/bench/circuit-bench.mjs` — Groth16 `setup`/`fullProve`/`verify` timing and artifact-size
   measurement for all three circuits, reusing the exact witness-construction logic already in
   `circuits/test/*.test.mjs` (Poseidon commitments, nullifiers, and a real depth-20 Merkle path) so
   the benchmarked witnesses are the same shape the existing test suite already treats as valid.
3. `scripts/bench/browser-bench.mjs` — spins up a static file server, launches the pre-installed
   headless Chromium via Playwright, loads `snarkjs`'s browser (UMD) bundle plus the compiled
   wasm/zkey, and runs `groth16.fullProve` inside the page, timed with `performance.now()`. This is
   the same code path the frontend's proving Web Worker uses, just driven headlessly instead of by a
   real user.

**Alternatives rejected, and why:**

- *Native `circom` via `cargo install circom`* — rejected. `crates.io`'s API returned an explicit
  "unable to process your request... in violation of our API data access policy" error for even a
  metadata lookup (`curl https://crates.io/api/v1/crates/circom`), so `cargo install` cannot resolve
  the crate in this environment. `circom2` (WASM build, same compiler, same output) was a direct,
  verifiable substitute — constraint counts matched the README exactly, which is itself evidence the
  WASM build isn't producing different R1CS than native circom would.
- *Sui gas via `sui move test` / real `sui` CLI* — rejected, not by choice. No `sui` binary is
  preinstalled. Building it from source (the Sui monorepo, in Rust) was not attempted: `cargo`'s
  crates.io access is broken in this sandbox as noted above, and even with a working index, a
  from-source Sui CLI build is a multi-hour proposition, not something to attempt inside one night's
  budget. Precompiled binaries from `MystenLabs/sui`'s GitHub releases are unreachable — this
  session's GitHub access is scoped to `alexandre-mrt/veil` only; `api.github.com` requests for any
  other repo return "GitHub access to this repository is not enabled for this session." This is not
  a hypothetical gap: `.github/workflows/ci.yml`'s own `move-tests` job installs `sui` by calling
  `curl https://api.github.com/repos/MystenLabs/sui/releases`, the exact call that fails here —
  confirmed by running it directly (`curl --cacert /root/.ccr/ca-bundle.crt
  https://api.github.com/repos/MystenLabs/sui/releases`), same "access... not enabled" response.
  This session cannot run the Move suite by any path the repo's own CI already relies on.
- *Sui JSON-RPC directly, against the deployed testnet package* (`0x5cd79f85f1adca022513d76c60...`
  from the README) — rejected, not by choice. Tried four public testnet RPC endpoints
  (`fullnode.testnet.sui.io:443`, `sui-testnet-rpc.publicnode.com`, `sui-testnet.blockvision.org`,
  `rpc-testnet.suiscan.xyz:443`); all four failed identically: `curl: (56) CONNECT tunnel failed,
  response 403` — the sandbox's network egress is an allowlist, and none of these hosts are on it
  (`storage.googleapis.com`, used for the Powers-of-Tau download, is on it; general Sui RPC infra is
  not).
- **Net result: on-chain gas per entry point is BLOCKED**, not estimated. No number for it appears
  anywhere in this report or in `BASELINE.md` — it's marked BLOCKED in both, and requeued as
  `EXPERIMENTS.md` item #1 for a session with either a working `sui` CLI or unblocked RPC egress.

## Results

Reference machine: 4 vCPU (Intel Xeon @ 2.80GHz), 15 GiB RAM, Node v22.22.2, circom 2.2.3 (via
`circom2`), snarkjs 0.7.6, headless Chromium 141.

### Circuit size — README claim vs. reproduced

| Circuit | README claim | Reproduced | Match |
|---|---|---|---|
| `transfer.circom` | 13,611 | 13,611 | Yes |
| `compliance.circom` | 12,743 | 12,743 | Yes |
| `withdraw.circom` | 3,058 | 3,058 | Yes |

### Groth16 setup / artifact sizes

| Circuit | Setup time | zkey size | vk.json size |
|---|---|---|---|
| `transfer` | 9.34 s | 6,001,431 B | 4,024 B |
| `compliance` | 9.15 s | 5,682,157 B | 3,837 B |
| `withdraw` | 3.22 s | 1,385,335 B | 3,655 B |

### Proving time — Node.js, 5 runs each

| Circuit | Mean | Median | Min | Max | proof.json | Verify |
|---|---|---|---|---|---|---|
| `transfer` | 970.5 ms | 911.3 ms | 869.6 ms | 1256.0 ms | 722 B | OK |
| `compliance` | 862.1 ms | 846.2 ms | 831.0 ms | 895.1 ms | 724 B | OK |
| `withdraw` | 283.2 ms | 282.4 ms | 270.9 ms | 292.2 ms | 722 B | OK |

### Proving time — browser (headless Chromium, WASM), 5 runs, `withdraw` only

| Run | 1 (cold) | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| ms | 1352.0 | 629.2 | 576.7 | 400.1 | 453.4 |

Mean (all 5): 682.3 ms. Warm mean (runs 2–5, excluding wasm-compile cold start): 514.9 ms.
proof size: 722 B. Verify: OK.

### On-chain gas per entry point

BLOCKED — see Approach. No number reported; not estimated.

### Raw command output

```
$ cd circuits && npm install --no-audit --no-fund && npm install --no-audit --no-fund --save-dev circom2
added 96 packages
added 31 packages
$ npx circom2 --version
circom2 npm package 0.2.23
circom compiler 2.2.3

$ npx circom2 transfer.circom --r1cs --wasm --sym -o build -l node_modules
linear constraints: 7141
public inputs: 7
private inputs: 47
public outputs: 0
wires: 13632
labels: 20437
Written successfully: build/transfer.r1cs
$ npx snarkjs r1cs info build/transfer.r1cs
[INFO]  snarkJS: Curve: bn-128
[INFO]  snarkJS: # of Wires: 13632
[INFO]  snarkJS: # of Constraints: 13611
[INFO]  snarkJS: # of Private Inputs: 47
[INFO]  snarkJS: # of Public Inputs: 7
[INFO]  snarkJS: # of Labels: 20437
[INFO]  snarkJS: # of Outputs: 0

(compliance.circom -> 12,743 constraints; withdraw.circom -> 3,058 constraints — same commands,
 circuit name substituted. Full output in the PR's CI log / session transcript.)

$ npx snarkjs groth16 setup build/transfer.r1cs build/pot15_final.ptau build/transfer_0000.zkey
[INFO]  snarkJS: Circuit hash: aded5adb 50fd996e 8e29fc87 19e4dca2 ...
(setup wall time measured externally: 9336 ms)
$ echo "veil-dev-entropy-<ts>" | npx snarkjs zkey contribute build/transfer_0000.zkey build/transfer_final.zkey --name="veil-dev" -v
[INFO]  snarkJS: Contribution Hash: d6a1bb8a 40afa4d9 d003fd8a b9ecde51 ...
$ npx snarkjs zkey export verificationkey build/transfer_final.zkey build/transfer_vk.json
[INFO]  snarkJS: EXPORT VERIFICATION KEY FINISHED
$ stat -c%s build/transfer_final.zkey build/transfer_vk.json
6001431
4024

$ node scripts/bench/circuit-bench.mjs --runs 5
=== Veil circuit-bench (5 runs per circuit) ===
Node v22.22.2, platform linux x64
--- transfer ---
  runs (ms): 1256.0, 911.3, 921.8, 893.8, 869.6
  mean=970.5ms median=911.3ms min=869.6ms max=1256.0ms
  proof.json size: 722 bytes, public signals: 7
  zkey size: 6001431 bytes, vk.json size: 4024 bytes
  verify: OK
--- compliance ---
  runs (ms): 831.0, 894.0, 844.1, 895.1, 846.2
  mean=862.1ms median=846.2ms min=831.0ms max=895.1ms
  proof.json size: 724 bytes, public signals: 6
  zkey size: 5682157 bytes, vk.json size: 3837 bytes
  verify: OK
--- withdraw ---
  runs (ms): 292.2, 280.3, 270.9, 290.0, 282.4
  mean=283.2ms median=282.4ms min=270.9ms max=292.2ms
  proof.json size: 722 bytes, public signals: 5
  zkey size: 1385335 bytes, vk.json size: 3655 bytes
  verify: OK

$ node scripts/bench/browser-bench.mjs --runs 5
=== Veil browser-bench (withdraw, 5 runs, headless Chromium) ===
UA: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36
runs (ms): 1352.0, 629.2, 576.7, 400.1, 453.4
mean=682.3ms proof_bytes=722 verify=OK

$ for url in fullnode.testnet.sui.io:443 sui-testnet-rpc.publicnode.com sui-testnet.blockvision.org rpc-testnet.suiscan.xyz:443; do
    curl -sS -o /dev/null -w "HTTP:%{http_code}\n" --max-time 15 --cacert /root/.ccr/ca-bundle.crt \
      -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"sui_getLatestSuiSystemState","params":[]}' "https://$url"
  done
curl: (56) CONNECT tunnel failed, response 403   [x4, one per endpoint]

$ curl -sS --cacert /root/.ccr/ca-bundle.crt https://crates.io/api/v1/crates/circom
{"errors":[{"detail":"We are unable to process your request at this time. This usually means that
you are in violation of our API data access policy..."}]}
```

## Verdict: **KEEP** (partial — gas dimension **BLOCKED**)

`docs/research/BASELINE.md` is created and merged with everything that could be honestly measured:
circuit size, Groth16 setup cost, proving time (server + one circuit's browser path), and
proof/VK/zkey sizes. The on-chain gas dimension is explicitly BLOCKED, not filled in with an
estimate, and is now `EXPERIMENTS.md` item #1 for the next session with real Sui tooling access.

## Where this could be used

- **Beyond Veil, any Circom + Groth16 privacy protocol on a chain with native pairing verification**
  (Sui's `sui::groth16`, or the EVM's `ecPairing` precompile) needs exactly this three-legged number
  before it can evaluate anything else: constraint count → prover cost, proof/VK size → calldata/gas
  cost, browser latency → whether client-side proving is even a usable UX. This baseline shape is
  reusable as-is for e.g. a confidential-payroll protocol on Sui with a t-of-n auditor board (queue
  item #7 is a direct extension of that idea), or a ZK-gated DeFi KYC layer using the same
  cumulative-threshold pattern Veil already implements.
- **Thesis framing:** this is the "empirical cost model" chapter every later claim in the research
  loop gets measured against — a PLONK/Halo2 migration chapter, a batching chapter, and a Poseidon2
  chapter all need a "faster/cheaper than what" baseline, and this is now it.
- **Practical reuse today:** `scripts/bench/circuit-bench.mjs` and `scripts/bench/browser-bench.mjs`
  are generic enough to rerun after any circuit change (constraint-count regression check) or before
  a hardware/algorithm swap (PLONK, GPU MSM, etc.) without modification beyond pointing at new
  build artifacts.

## Open questions (queue for tomorrow)

1. On-chain gas per entry point — needs a `sui`-CLI-capable environment or unblocked RPC egress.
   Now `EXPERIMENTS.md` #1.
2. `transfer`/`compliance` browser proving latency — UNMEASURED because neither is wired into the
   frontend's proving flow yet (only `withdraw` is). Extend `browser-bench.mjs` once they are.
3. Mobile / throttled-CPU proving latency — UNMEASURED, no device or CPU-throttling harness run.
4. Does the Node vs. browser proving-time gap (283 ms vs. 515 ms warm, for `withdraw`) hold in the
   same ratio for the larger `transfer`/`compliance` circuits once #2 is answered? If it scales
   roughly linearly, `transfer` in-browser would land somewhere around 1.5–2s warm — worth checking
   against the "under 3s" bar in this report's own hypothesis once it's a real measurement instead of
   an extrapolation.
5. Every subsequent PLONK/batching/accumulator experiment should cite `BASELINE.md`'s numbers
   directly rather than re-measuring Groth16 from scratch.
