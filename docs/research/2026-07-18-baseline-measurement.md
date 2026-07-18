# 2026-07-18 — BASELINE.md: Veil's own numbers, measured once on one machine

## Hypothesis

Every number in Veil's docs that matters for a scalability or crypto decision — per-circuit
R1CS constraint count, Groth16 proving time, proof/VK size, on-chain gas per entry point, and
in-browser WASM proving latency — can be measured from a clean checkout on one machine in one
run, and the resulting `docs/research/BASELINE.md` becomes the fixed reference every future
experiment in this loop diffs against. This is not a hypothesis about the protocol; it's the
precondition for every hypothesis that follows. (Queue item #1, `EXPERIMENTS.md`.)

## Threat / privacy model

This experiment changes no code and adds no cryptography — it establishes a measurement
baseline. There is no new adversary to define. What follows is scoped to *why the baseline
matters* to the existing model in `docs/threat-model.md`:

- **Chain observer** — unaffected. No on-chain behavior changed.
- **Colluding relayer** — unaffected.
- **Malicious auditor** — unaffected.
- **Statistical deanonymiser** — indirectly relevant: the anonymity-set-size questions queued
  below (Merkle accumulator at scale) depend on having real proving-time and gas numbers first,
  since anonymity set size trades off against prover cost and gas per entry.
- **Malicious prover** — unaffected; no constraint changed.
- **Quantum adversary** — unaffected here; queued as its own item (`EXPERIMENTS.md`).

**What this does NOT do:** it does not validate soundness, does not add a negative test, and
does not change `docs/threat-model.md`'s STRIDE table. Those requirements in the nightly-loop
prompt apply to *circuit changes*; this experiment recompiles the circuits exactly as committed
and performs a fresh dev-only trusted-setup contribution to get artifacts to measure against —
it does not modify `transfer.circom`, `compliance.circom`, or `withdraw.circom`.

**Assumptions carried forward unchanged:** Groth16 soundness under the BN254 discrete-log
assumption; the existing (unaudited, single-contributor, dev-only) trusted setup described in
`README.md` and `docs/threat-model.md` RR2. This experiment performs its *own* fresh dev-only
setup (see Approach) purely to produce artifacts to time — it is not a production ceremony and
does not touch the setup shipped to any deployed instance (nothing is currently deployed; see
Results, on-chain gas).

## Approach

**What was measured, and how:**

1. **Circuit compilation & constraint counts.** No native `circom` binary was installable in
   this session (see "What was blocked," below), so circuits were compiled with
   [`circom2`](https://www.npmjs.com/package/circom2) — the same compiler (circom 2.2.3),
   distributed as a WASM build via npm rather than as a Rust binary. `snarkjs r1cs info`
   was then run against the resulting `.r1cs` files.
2. **Groth16 trusted setup.** A fresh, single-contributor, dev-only setup was run per circuit
   (`snarkjs groth16 setup` → `snarkjs zkey contribute` → `snarkjs zkey export
   verificationkey`), using the project's own `pot15` Powers-of-Tau file, downloaded fresh from
   the URL already hardcoded in `circuits/scripts/compile.sh`. This mirrors exactly what
   `compile.sh` / `compile-compliance.sh` / `compile-withdraw.sh` already do; those scripts
   just require a native `circom` on `$PATH`, which this environment doesn't have.
3. **Node-side proving time, proof size, VK size.** `scripts/bench/prove-bench.mjs` builds the
   same valid witness each circuit's own test file uses (`circuits/test/*.test.mjs`
   `buildValidWitness()`), runs `groth16.fullProve` 5 times per circuit, and reports
   min/mean/max wall-clock time, proof byte size (JSON-encoded, as it would be sent off-chain
   before conversion — see `scripts/src/proof-converter.ts` for the 128-byte on-chain format),
   VK size, zkey size, and WASM witness-calculator size.
4. **Browser (WASM) proving latency.** `scripts/bench/browser-prove-bench.mjs` serves
   `circuits/build/` and snarkjs's browser bundle (`snarkjs.min.js`) over a local HTTP server,
   drives the pre-installed headless Chromium via `playwright-core`, and times
   `snarkjs.groth16.fullProve()` **inside the page**, three times, for `transfer.circom` (the
   circuit users actually prove in the frontend's hot path). This is the number a real user's
   browser pays, not a Node.js extrapolation — Node's proving path uses different WASM
   instantiation and doesn't reflect first-load compile cost or the browser's JS engine.
5. **On-chain gas per entry point.** Attempted, blocked. See below.
6. **Full test suite.** Ran everything runnable per `README.md`'s documented commands (there is
   no `CLAUDE.md` in this repo yet — see `docs/research/NIGHTLY_PROMPT.md`).

**Alternatives rejected:**

- *Estimating gas from Move bytecode instruction counts without executing anything* — rejected
  outright. The nightly-loop rule is explicit: no estimates presented as measurements. An
  instruction-count guess is not a gas number.
- *Building `sui` from the MystenLabs/sui monorepo via `cargo install --git`* — rejected. GitHub
  access in this session is scoped to `alexandre-mrt/veil` only (confirmed: cloning
  `iden3/circom` was refused by the GitHub App with "GitHub access to this repository is not
  enabled for this session"). The Sui monorepo is not on crates.io as a real package (`cargo
  search sui` returns a placeholder `sui = "0.0.1"` reserved crate, not the CLI), so there is no
  path to it that doesn't go through GitHub.
- *Downloading a prebuilt `circom` binary from `github.com/iden3/circom/releases`* — same
  GitHub-scope block. Fell back to `circom2` (npm/WASM), which is the same upstream compiler.

**What was blocked, and exactly why:**

```
$ which sui
(not found)
$ cargo search sui --limit 5
sui = "0.0.1"                          # This crate is reserved for the Sui project
drasi-source-sui-deepbook = "0.1.5"    # Sui DeepBook V3 source plugin for Drasi
sui-id = "0.76.9"                      # Self-hosted, single-binary OpenID Connect provider...
ic_sis = "0.2.1"                       # Integrate Sui wallet-based authentication...
csv-cli = "0.1.1"                      # CLI tool for CSV Adapter...
$ npm view sui-cli --json | head -5   # name-squatted, unrelated package from 2018, ISC license,
                                        # "git-clone"/"shelljs" deps — not Mysten Labs' CLI
$ curl -sSL https://github.com/iden3/circom/releases/download/v2.1.9/circom-linux-amd64
{"message":"GitHub access to this repository is not enabled for this session. ..."}
$ git clone https://github.com/iden3/circom.git  # same block, confirms the restriction
  is GitHub-repo-scope, not a general network/proxy issue (raw.githubusercontent.com and
  storage.googleapis.com are both reachable; crates.io and registry.npmjs.org are reachable)
```

There is no already-deployed Veil package on any network to dry-run a gas estimate against
either (`.env.testnet.example` is a template with no real IDs; `git log --all -- docs/research`
and a repo-wide grep for a real package ID both come up empty). Publishing one requires
`sui move build` — the Move compiler, which ships only inside the `sui` binary — so there is no
way to produce bytecode to publish even via the TypeScript SDK's raw dry-run RPC calls.

**Verdict on gas: BLOCKED**, not estimated. Recorded honestly rather than guessed. See "Open
questions" for what unblocks it.

## Results

All artifacts were built fresh on this machine (Intel Xeon @ 2.10GHz, 4 vCPU, 15GiB RAM, Linux
x86_64, Node v22.22.2, circom2 0.2.23 wrapping circom compiler 2.2.3, snarkjs 0.7.6) from
`origin/main` at `b1ca081`. Reproduce with:

```bash
cd circuits && npm install
npx circom2 transfer.circom   --r1cs --wasm --sym --output build            -l node_modules
npx circom2 compliance.circom --r1cs --wasm --sym --output build-compliance -l node_modules
npx circom2 withdraw.circom   --r1cs --wasm --sym --output build-withdraw   -l node_modules
curl -L -o build/pot15_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
# groth16 setup + contribute + export vk, once per circuit into its own build dir (see
# circuits/scripts/compile*.sh for the exact snarkjs invocations — same steps, just circom2
# instead of a native circom binary)
node ../scripts/bench/prove-bench.mjs --runs 5
node ../scripts/bench/browser-prove-bench.mjs --runs 3
```

### Circuit constraints (`snarkjs r1cs info`)

| Circuit | Non-linear | Linear | **Total constraints** | Public / private inputs | Wires |
|---|---:|---:|---:|---|---:|
| `transfer.circom` | 6,470 | 7,141 | **13,611** | 7 / 47 | 13,632 |
| `compliance.circom` | 6,057 | 6,686 | **12,743** | 6 / 45 | 12,762 |
| `withdraw.circom` | 1,465 | 1,593 | **3,058** | 5 / 5 | 3,058 |

Matches the counts already published in `README.md` exactly — this run is an independent
reproduction (different compiler binary: WASM circom2 vs the native circom the README assumed),
which is itself a useful confirmation that the constraint counts aren't compiler-toolchain
dependent.

### Proving time, proof size, artifact size (Node.js, `groth16.fullProve`, 5 runs each)

| Circuit | Mean prove | Min | Max | Proof size (JSON) | VK size | zkey size | WASM size |
|---|---:|---:|---:|---:|---:|---:|---:|
| `transfer` | 966.4 ms | 834.3 ms | 1236.4 ms | 723 B | 4,022 B | 6,001,427 B | 2,846,127 B |
| `compliance` | 914.5 ms | 817.1 ms | 1009.9 ms | 721 B | 3,839 B | 5,682,162 B | 2,931,887 B |
| `withdraw` | 279.6 ms | 262.8 ms | 292.6 ms | 723 B | 3,655 B | 1,385,340 B | 2,346,258 B |

`groth16.verify` returned `true` for every circuit. Raw tool output:

```
$ node scripts/bench/prove-bench.mjs --runs 5
benchmarking transfer (5 runs)...
  mean=966.4ms min=834.3ms max=1236.4ms proof=723B vk=4022B zkey=6001427B wasm=2846127B verify=true
benchmarking compliance (5 runs)...
  mean=914.5ms min=817.1ms max=1009.9ms proof=721B vk=3839B zkey=5682162B wasm=2931887B verify=true
benchmarking withdraw (5 runs)...
  mean=279.6ms min=262.8ms max=292.6ms proof=723B vk=3655B zkey=1385340B wasm=2346258B verify=true
```

Individual run timings (ms), transfer: `[1236.4, 834.3, 882.7, 879.2, 999.3]` — the first run
includes one-time WASM instantiation inside the same Node process; still included above, not
dropped, per "no estimates, only what actually ran."

Note: proof size here is the raw JSON-encoded snarkjs proof (3 G1 points + metadata), not the
128-byte packed format `scripts/src/proof-converter.ts` produces for the on-chain call — that
converter is exactly why the two numbers differ, and it's already covered by the 109 passing
converter tests below.

### Browser (WASM) proving latency — `transfer.circom`, real headless Chromium

```
$ node scripts/bench/browser-prove-bench.mjs --runs 3
{
  "circuit": "transfer",
  "runs": 3,
  "times": [2616.6, 1384.7, 1458.1],
  "verifyOk": true,
  "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
  "hardwareConcurrency": 4
}
```

First proof in a fresh page: **2616.6 ms** (includes WASM module fetch + compile + instantiate,
which a real first-time user also pays once per session). Warm proofs on the same page:
**1384.7 ms** and **1458.1 ms**. All three verified. This is headless Chromium on the same
4-vCPU container as the Node numbers above — a real phone will be slower, not faster; that
mobile-vs-desktop gap is exactly the "WASM proving latency on mobile" item already in the
explore list and now queued explicitly below.

### On-chain gas per entry point

**UNMEASURED / BLOCKED.** No `sui` CLI (Move compiler + publisher + gas-metered executor)
reachable from this session (see Approach). No already-deployed Veil package to dry-run
against. This is the one number `BASELINE.md` ships without, clearly marked, rather than
guessed.

### Test suite

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | **43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Fuzz (fast-check, 6 properties × 500 cases) | **all 6 pass** | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19 pass** | `cd frontend && bunx vitest run` |
| Move (`sui move test`, 124 tests per README) | **NOT RUN — no `sui` CLI in this session** | n/a |

Every non-Move suite is green — 309/309 across the seven suites above. Move is the one gap,
and it's a tooling gap, not a red test: nothing in this PR touches `contracts/`. Two operational
notes from running these concurrently: (1) `circuits/test/transfer.test.mjs` and
`withdraw.test.mjs`, run as background jobs in parallel with two other CPU-heavy processes on
this 4-vCPU box, printed their full "N passed, 0 failed" results but then never exited — their
Node processes sat idle (all threads in `ep_poll`/`futex_wait`, zero further CPU consumed) for
minutes after finishing, and had to be `kill -9`'d to reap. This looks like snarkjs/
`circom_runtime`'s worker-thread pool not being torn down on completion (a process-exit hygiene
issue, not a test failure — every assertion in both files passed before the hang). Run these
sequentially, not concurrently, if reproducing. (2) `compliance.circom`'s tests ran to
completion normally.

## Verdict

**KEEP (partial) — merged, `BASELINE.md` created.** Circuit constraints, Node proving time,
proof/artifact sizes, and browser proving latency are real, reproducible, committed numbers.
On-chain gas per entry point is explicitly **BLOCKED**, not estimated, and requeued as
`EXPERIMENTS.md` #1 with the exact unblock condition. This is not a REJECT (nothing was tested
and found wanting) and not a full BLOCKED (most of the baseline did get measured) — "partial
KEEP" is the honest label for a multi-part measurement where one part couldn't run.

## Where this could be used

- **Any Circom/Groth16 project bootstrapping a numbers-driven optimization backlog** — the
  pattern here (compiler-toolchain-agnostic constraint verification via `circom2`, a
  reusable Node bench script, a real-browser bench script using a headless-Chromium +
  local-static-server harness) is generic; nothing in `scripts/bench/prove-bench.mjs` or
  `browser-prove-bench.mjs` is Veil-specific beyond the witness-building functions.
- **Sandboxed/CI agent environments with restricted GitHub scope** — the `circom2` fallback
  (WASM compiler via npm, same upstream circom) is a reusable workaround anywhere a native
  Rust toolchain build or a GitHub release download is blocked by an execution sandbox's repo
  allowlist, which is increasingly common in agentic CI.
  Sui-specific: a project needing gas numbers in the same kind of sandbox should provision
  either a pre-built `sui` binary in the environment image or an already-deployed testnet
  instance with its package ID committed (not to `.env`, to a public non-secret file) so gas
  can be measured via RPC dry-run without a local compiler at all.
- **Thesis chapter: "Reproducible ZK protocol benchmarking under research-agent execution
  constraints."** The gap this run hit — full crypto toolchain (compile, prove, verify) is
  npm/WASM-portable; full blockchain toolchain (compile Move, publish, meter gas) currently
  is not — is itself a reusable observation about which parts of a ZK-on-L1 stack are
  sandbox-portable today and which still require a native, heavyweight, often network-gated
  binary.

## Open questions

1. **Unblock on-chain gas.** Two independent paths, either sufficient: (a) this session's
   environment gets `sui` CLI pre-installed or GitHub access widened to
   `MystenLabs/sui` releases; (b) a real (non-secret) testnet package ID gets committed
   somewhere in the repo from a session that *does* have `sui`, after which gas can be
   measured forever after via `@mysten/sui`'s `dryRunTransactionBlock` against public RPC,
   with no local Move compiler needed at all. (b) is cheaper and only needs to happen once.
2. **Mobile WASM proving latency.** Tonight's browser number is desktop headless Chromium on a
   4-vCPU cloud box — not a mobile device. Needs a real device or, at minimum, Chromium's
   mobile CPU-throttling emulation, to be a legitimate "mobile" data point.
3. **`compliance` proving is only marginally cheaper than `transfer`** despimte having ~800
   fewer constraints (12,743 vs 13,611, a 6% difference) but measuring within noise of each
   other (914.5ms vs 966.4ms mean, well within the run-to-run variance seen on `transfer`
   itself: 834–1236ms). Constraint count alone doesn't predict proving time cleanly at this
   scale on this machine — worth another look once gas numbers exist to weigh against.
4. **Depth-20 Merkle accumulator at scale** (10^5–10^7 commitments) is still unmeasured:
   nothing here touched batch insertion, indexer throughput, or the anonymity-set-vs-depth
   trade-off. Now that per-proof cost is a known constant, this is the natural next item.
5. **Batched/aggregated proofs** (N transfers → 1 on-chain verification) is the highest-leverage
   remaining item precisely because it multiplies against a now-known per-proof gas *and* prove
   cost baseline — moved to the top of the non-blocked queue below.
