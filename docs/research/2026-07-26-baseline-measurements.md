# Baseline measurements — Veil circuits, Groth16, and test suite

**Date:** 2026-07-26
**Branch:** `claude/intelligent-cannon-mb3k1j`
**Machine:** 4-core Intel(R) Xeon(R) Processor @ 2.80GHz, Linux 6.18.5 x86_64, Node v22.22.2, headless Chromium 1194 (via Playwright), `bun` 1.3.11, `snarkjs` 0.7.6, `circom2` (WASM build of circom) 2.2.3.

## Hypothesis

Veil's own numbers — per-circuit R1CS constraints, Groth16 witness/prove/verify time, proof and
verification-key size, and browser (WASM) proving latency — have never been measured together, on
one machine, in one run, before this report. Establishing them turns every future "before vs after"
experiment in this queue (PLONK/Halo2 migration, Poseidon2, batched proofs, deeper Merkle trees) from
a guess into an actual comparison. This is not a change to the protocol; it is the reference point
every future change gets measured against.

## Threat / privacy model

This experiment makes no cryptographic or protocol change, so there is no new adversary to define
and no new residual surface. It touches trust boundary 5 in `docs/threat-model.md` ("ZK Proof
Generation (client-side, trustless)") only by *measuring* it, not altering it. The one place this
report has security content is the honest description of what could **not** be measured (on-chain
gas) and why — see Results and Verdict below — which is itself relevant to `docs/threat-model.md`'s
residual risks (RR2, the single-contributor trusted setup, is unaffected either way; this experiment
did not touch the setup process, and the `_final.zkey` files generated for benchmarking here are
dev-only artifacts, not used anywhere on-chain or committed as protocol artifacts).

No STRIDE entries change status as a result of this report.

## Approach

**What was built:**

1. `scripts/bench/prove-bench.mjs` — a reusable Node.js benchmark. For each circuit it builds one
   valid witness (mirroring `circuits/test/*.test.mjs`'s `buildValidWitness`), then runs
   `N_WARMUP` discarded + `N_TRIALS` measured rounds of `snarkjs.wtns.calculate` (witness),
   `snarkjs.groth16.prove` (proving), and `snarkjs.groth16.verify` (verification), reporting
   mean/median/min/max wall-clock time per phase, proof size, and VK size. Supports
   `--circuit=<name>` to run one circuit per process (see "What broke" below for why that matters).
2. `scripts/bench/gen-browser-inputs.mjs` — precomputes the same witness inputs as static JSON, so
   the browser harness doesn't need to bundle `circomlibjs` for Poseidon.
3. `scripts/bench/browser-harness/index.html` + `scripts/bench/run-browser-bench.mjs` — a static
   page that loads `snarkjs`'s browser build (`snarkjs.min.js`) and runs
   `groth16.fullProve`/`groth16.verify` against the same compiled `wasm`/`zkey` artifacts, driven by
   Playwright in real headless Chromium (not Node, not jsdom) — the same code path
   `frontend/src/hooks/useProofGeneration.ts` uses client-side (`snarkjs.groth16.fullProve` against
   `/circuits/transfer.wasm` + `/circuits/transfer_final.zkey`).

**Circuit compilation.** `circom` was not installed and could not be installed in this sandbox
(`cargo install circom` fails — `circom` is not published on crates.io, and the canonical
install path builds from the `iden3/circom` git source, which this session cannot reach — GitHub
access is scoped to `alexandre-mrt/veil` only). The `circom2` npm package (`circom2@0.2.23`, wrapping
circom compiler `2.2.3` compiled to WASM) was used instead of the native binary the README specifies
(circom 2.1.x). This is a substitute toolchain, not the pinned one — flagged so a future run knows
why the exact circom patch version differs. It reproduced the exact constraint counts already
published in `README.md` (13,611 / 12,743 / 3,058), which is strong evidence the substitution didn't
change anything semantically.

**Trusted setup.** Ran `snarkjs groth16 setup` against a real Powers-of-Tau file
(`pot15_final.ptau`, downloaded from `storage.googleapis.com/zkevm/ptau/...`, the same URL
`circuits/scripts/compile.sh` uses) plus a single dev contribution — identical process to
`compile.sh`, run for all three circuits (the shipped script only builds `transfer`). These are
fresh, this-run-only dev artifacts (not committed, not used for anything except this benchmark).

**Alternatives rejected:**
- *Reusing `circuits/test/*.test.mjs`'s timing* — rejected because those files measure pass/fail per
  assertion, not wall-clock, and mix warmup-free single runs of many different (valid and
  deliberately-invalid) witnesses; not comparable across future runs.
- *Simulating browser latency by throttling Node* — rejected once Playwright + the pre-installed
  headless Chromium turned out to work directly; a real browser engine is strictly better evidence
  than a throttled approximation of one.
- *Querying Sui testnet RPC directly for real historical gas costs of the deployed package* (`README.md`
  lists deployed testnet object IDs) instead of running `sui move test` — attempted, blocked (see
  Results).

**What broke, worth recording:** the first full run of `prove-bench.mjs` (all three circuits, 12
witness/prove/verify rounds each, in one Node process) produced zero further output and zero further
CPU usage after some point, appearing hung — but killing and rerunning with `--circuit=<name>` as
three separate processes worked every time, and inspecting the log from the very first (all-in-one)
run's redirected file after the fact showed it had in fact *finished all computation and printed the
full results table* — it just never returned control to the shell afterward. Root cause is
unconfirmed (a lingering handle from `snarkjs`/`ffjavascript`'s curve-backend worker-thread pool is
the leading suspect, since it reproduces even with `wtns.calculate`/`groth16.prove` split apart from
`fullProve`), but an explicit `process.exit(0)` after the results are printed reliably works around
it and is now in the script. This is a real gremlin in the benchmark's own execution environment,
not a circuit or proof bug — logged in `prove-bench.mjs`'s own comments so it isn't rediscovered from
scratch next time.

## Results

### Circuit constraints (reproduced from `README.md`, via `circom2`)

| Circuit | Non-linear | Linear | **Total R1CS** | Public / private inputs |
|---|---|---|---|---|
| `transfer.circom` | 6,470 | 7,141 | **13,611** | 7 / 47 |
| `compliance.circom` | 6,057 | 6,686 | **12,743** | 6 / 45 |
| `withdraw.circom` | 1,465 | 1,593 | **3,058** | 5 / 5 |

Reproduce:
```
cd circuits && npx circom2 transfer.circom --r1cs --wasm --sym --output build -l node_modules
npx snarkjs r1cs info build/transfer.r1cs
```
Raw output (`transfer`):
```
[INFO]  snarkJS: Curve: bn-128
[INFO]  snarkJS: # of Wires: 13632
[INFO]  snarkJS: # of Constraints: 13611
[INFO]  snarkJS: # of Private Inputs: 47
[INFO]  snarkJS: # of Public Inputs: 7
[INFO]  snarkJS: # of Labels: 20437
[INFO]  snarkJS: # of Outputs: 0
```

### Groth16 proving — Node.js (`scripts/bench/prove-bench.mjs`, N=10 trials, 2 warmup, mean/median ms)

| Circuit | witness gen | proving | verification | **total** | proof size | VK size |
|---|---|---|---|---|---|---|
| `transfer` | 90.0 / 89.8 | 861.3 / 863.4 | 31.6 / 33.3 | **982.9 / 986.3** | 724 B | 4,024 B |
| `compliance` | 104.1 / 115.8 | 845.0 / 839.1 | 29.6 / 31.7 | **978.7 / 1,002.0** | 724 B | 3,838 B |
| `withdraw` | 76.3 / 70.1 | 259.2 / 258.5 | 27.6 / 28.7 | **363.1 / 357.4** | 724 B | 3,656 B |

Reproduce: `node scripts/bench/prove-bench.mjs --circuit=transfer --trials=10 --warmup=2` (and
`compliance`, `withdraw`). Full raw JSON per circuit is in the PR diff under `/tmp` is not committed;
rerun to regenerate — the script is the artifact, not a frozen log.

Constraint count and proving time track closely (transfer 13,611 → 861ms prove; compliance 12,743 →
845ms; withdraw 3,058 → 259ms — roughly linear, as expected for Groth16's dominant MSM cost). Proof
size is constant at 724 bytes regardless of circuit (expected: 2 G1 + 1 G2 point, fixed Groth16
format) — proof size does **not** scale with constraint count, only VK size does (public-input count
dependent: 7/6/5 public inputs → 4,024/3,838/3,656 bytes).

### Groth16 `fullProve` — real headless Chromium (`scripts/bench/run-browser-bench.mjs`, N=5 trials, 1 warmup, mean/median ms)

| Circuit | fullProve (witness+prove combined) | proof size |
|---|---|---|
| `transfer` | 1,513.7 / 1,477.6 | 723 B |
| `compliance` | 1,619.2 / 1,512.4 | 718 B |
| `withdraw` | 685.7 / 644.8 | 722 B |

This is desktop headless Chromium via `V8`'s WASM engine — **not mobile**, and not directly
comparable to the Node.js table above because it measures `fullProve` (witness + proving combined,
matching what `useProofGeneration.ts` actually calls) rather than the phases split apart. As a rough
same-machine comparison: Node witness+prove for `transfer` is 90.0+861.3 = 951.3ms vs. browser
`fullProve` 1,513.7ms — roughly 1.6x slower in-browser on the same hardware, consistent with V8's WASM
JIT having more overhead than Node's for this workload. Real mobile-device latency remains
unmeasured — queued as EXPERIMENTS.md item #8.

Reproduce: from repo root, `npx http-server -p 8977 --cors -c-1 .` in one process, then
`node scripts/bench/run-browser-bench.mjs`.

### On-chain gas per entry point — **BLOCKED**

`README.md` lists `sui` CLI as a prerequisite and a deployed testnet package (`0x5cd79f8...`), but
neither path to a real gas number was reachable from this sandbox:

1. **`sui` CLI is not installed** and could not be installed: `cargo install sui` would need to build
   the full Sui monorepo from `crates.io`/`static.crates.io`, both of which return `403` from this
   session's egress proxy (org policy — confirmed with `curl -sS -o /dev/null -w '%{http_code}\n'
   https://static.crates.io/` → `403`). A prebuilt release binary from `github.com/MystenLabs/sui`
   is out of scope too — this session's GitHub access is explicitly scoped to
   `alexandre-mrt/veil` only.
2. **Direct RPC query against the deployed testnet package**, sidestepping the CLI entirely (using
   `@mysten/sui`, already a dependency), was also attempted and also blocked:
   ```
   $ curl -sS -X POST https://fullnode.testnet.sui.io:443 -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"sui_getLatestCheckpointSequenceNumber","params":[]}'
   curl: (56) CONNECT tunnel failed, response 403
   ```

Entry points that would need measuring once either path unblocks (from `contracts/sources/pool.move`
and `compliance.move`): `create_pool`, `shielded_transfer`, `deposit_and_register`, `zk_withdraw`,
`compliant_transfer` (the dual-proof path), plus the admin/timelock functions
(`propose_vk_update`, `update_commitment_root`, `freeze_pool`, …). Carried forward as
`EXPERIMENTS.md` item #2.

### Full test suite (per `CLAUDE.md`-equivalent commands derived from `README.md`)

| Suite | Result | Command | Notes |
|---|---|---|---|
| `transfer.circom` (real Groth16) | **43/43 pass** | `cd circuits && node --experimental-vm-modules test/transfer.test.mjs` | Matches README's claimed count exactly. |
| `compliance.circom` (real Groth16) | **30/30 pass** | `cd circuits && node --experimental-vm-modules test/compliance.test.mjs` | Matches README. |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `cd circuits && node --experimental-vm-modules test/withdraw.test.mjs` | Matches README. |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` | Matches README. |
| Compliance utils (credential leaf, Merkle builder) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` | Matches README. Took ~6 minutes wall-clock — see note below. |
| Property-based fuzz (fast-check) | **6/6 properties, 500 cases each, all PASSED** | `cd scripts && bun run src/fuzz-tests.ts` | Uses depth-5 (32-leaf) trees deliberately — the suite's own comment says depth 20 would be "fast enough to avoid timeout" only at depth 5. |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` | Clean run, 2.70s total. |
| Move contract | **BLOCKED** | `cd contracts && sui move test` | No `sui` CLI — see gas section above for why it couldn't be installed. README claims 124 pass; not independently verified this run. |
| E2E (`scripts/src/e2e-test.ts`) | **BLOCKED** | `cd scripts && bun run src/e2e-test.ts` | File's own header states "Requires: sui CLI configured on testnet" — same blocker. |

**Compliance-utils note:** `buildMerkleTree(poseidon, F, [leaf], 20)` materializes a **dense array of
`1 << 20` (1,048,576) leaf slots** (zero-padded, not sparse) and then hashes 20 full levels — this is
not a lazy/sparse-zero-hash optimization the way `circuits/test/*.test.mjs`'s witness-side Merkle
helper is (that one only ever touches the single occupied path, staying O(depth)). Three separate
depth-20 trees get built across the suite (`buildMerkleTree` test, `getMerkleProof` test, and a
sibling-check test), and the whole suite — all 67 tests — took roughly 6 minutes wall-clock to
complete for that reason, versus well under a second for every other test file in this report. All
67 tests passed. This is itself a real, useful measurement: the
`compliance-utils.ts` reference implementation's `buildMerkleTree` is **not** the algorithm a real
indexer would use at scale (see `EXPERIMENTS.md` item #4 — 2^20 dense materialization is the whole
anonymity-set capacity at depth 20, and this is the *slow* way to build it once). It is a legitimate
correctness-testing helper, not a scalability bug in the protocol itself — the circuit-side witness
construction (`circuits/test/*.test.mjs`, `MerkleTree` in `frontend/src/lib/merkle-tree.ts`) is
`O(depth)`, not `O(2^depth)`.

## Verdict: **KEEP (partial)**

The measurable parts of this baseline — circuit constraints, Node.js Groth16 proving time, proof/VK
size, headless-Chromium `fullProve` latency, and 7 of 9 test suites (all except the two that require
the `sui` CLI) — are real, reproduced
numbers now committed as `scripts/bench/prove-bench.mjs`, `scripts/bench/run-browser-bench.mjs`, and
this report. On-chain gas and real-device (mobile) browser latency are genuinely **BLOCKED** by this
sandbox's toolchain and network policy, not estimated or guessed at — they're carried forward as
`EXPERIMENTS.md` items #2 and #8 rather than invented here. `BASELINE.md` is added at the repo root
summarizing the KEEP numbers, explicitly marked UNMEASURED where blocked.

## Where this could be used

- **Any Circom/Groth16 project on Sui** deciding whether to compile with the native `circom` binary
  or the WASM `circom2` build in a sandboxed CI runner without cargo/GitHub network access — this
  report is evidence the WASM build reproduces identical constraint counts, and documents the
  `process.exit(0)` workaround needed to run `snarkjs` benchmarks reliably in Node without hanging.
- **Confidential-payroll-style Sui deployments** (a plausible next real user of this exact
  transfer+compliance circuit pair — a t-of-n auditor board checking cumulative payroll spend against
  a regulatory threshold without seeing individual salaries) would use this same baseline as their
  own starting reference point before deciding whether Groth16's ~1s desktop / likely several-second
  mobile proving time is acceptable for their UX, or whether they need the PLONK/Halo2 migration
  queued as `EXPERIMENTS.md` item #3 first.
- **Thesis chapter on ZK proving-system benchmarking methodology in constrained/sandboxed CI
  environments** — the toolchain-substitution (native circom → `circom2` WASM) and the
  network-policy-blocked gas measurement are both concrete, citable examples of "what changes when
  you can't assume a fully-provisioned dev machine," relevant to any reproducibility-focused
  methodology section.

## Open questions (→ tomorrow's queue)

1. On-chain gas per entry point — needs a `sui` CLI or unblocked RPC access from a future session.
   (`EXPERIMENTS.md` #2)
2. Real mobile-device WASM proving latency, with a documented throttling factor vs. this report's
   desktop-Chromium numbers if a device still isn't available. (`EXPERIMENTS.md` #8)
3. Why does `prove-bench.mjs` hang without explicit `process.exit(0)` when circuits run
   back-to-back in one process? Worth a short, scoped investigation if it starts affecting other
   scripts (e.g. `e2e-test.ts` once gas measurement unblocks) rather than just working around it
   again.
4. `compliance-utils.ts`'s `buildMerkleTree` dense-array approach is a real bottleneck for anything
   that needs a depth-20 tree more than a few times (like a real indexer) — is this worth fixing even
   just as test-suite hygiene, independent of the production `EXPERIMENTS.md` #4 scaling work?
