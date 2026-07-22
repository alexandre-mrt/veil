# 2026-07-22 — Veil performance baseline (queue item #1)

## Hypothesis

Every core Veil performance number — R1CS constraint count, zkey/vk/proof size, and Groth16
proving time in both Node and a real browser — can be measured directly on one machine from a
freshly compiled circuit and a real proof, not estimated. Before tonight, the repo's README cited
constraint counts alone (from a past, undocumented run); proving time and browser latency had never
been measured at all. This experiment moves "number of Veil performance metrics backed by an
actual command run, with raw output attached" from 3 (the constraint counts) to 11 (constraints +
zkey/vk/proof size + Node proving time + browser proving time, for all three circuits), and
explicitly marks the one axis it could not close — on-chain gas per entry point — as BLOCKED rather
than guessed.

This is queue item #1 (`BASELINE.md` did not exist). It is a measurement night, not a protocol
change: no circuit, Move module, or frontend proving code was modified.

## Threat / privacy model

No adversary model changes here — nothing about the protocol's soundness, privacy, or trust
boundaries was touched. The relevant framing is narrower: **who relies on these numbers being
honest, and what happens if they're wrong.**

- **This research loop itself**, on future nights: every subsequent scalability experiment ("does
  switching to Poseidon2 cut constraints by X%", "does batching N transfers save gas") is a *diff*
  against this baseline. A padded or guessed baseline makes every future comparison wrong in a way
  that's invisible until someone tries to reproduce it.
- **A protocol integrator or thesis reader** who cites "13,611 constraints" or "~750ms proving
  time" from this repo should be able to run the same two commands and get the same numbers within
  noise. That reproducibility is the actual deliverable of this experiment, more than the numbers
  themselves.

What this does **not** defend against or establish: it says nothing about whether 13,611
constraints is *good*, whether the single-dev-contributor trusted setup used to produce these
numbers is production-safe (it is not — see `docs/threat-model.md` RR2, unchanged by this
experiment), or what on-chain gas actually costs (still unmeasured, see Results). It maps to no
STRIDE entry directly; it's a prerequisite for entries that don't exist yet (a future gas-cost
DoS analysis, for instance, needs real gas numbers before it can reason about griefing cost).

Assumptions carried over unchanged from the existing threat model: Groth16 soundness under the
BN254 discrete-log assumption, and the dev trusted setup's toxic waste not being production-safe
(RR2). Nothing here changes either.

## Approach

**What I built.** Two reusable scripts under `scripts/bench/`:

- `scripts/bench/witnesses.mjs` — valid-witness builders for all three circuits, copied faithfully
  from `circuits/test/{transfer,withdraw,compliance}.test.mjs` (same domain tags, same field
  names), shared by both benchmarks below so they exercise the real constraint set, not a
  simplified stand-in.
- `scripts/bench/prove-latency.mjs` — Node-side: loads the compiled wasm/zkey for each circuit,
  runs `snarkjs.groth16.fullProve` once as a warm-up (pays one-time WASM instantiation cost, not
  counted), then times 10 repetitions with `process.hrtime.bigint()`.
- `scripts/bench/browser-latency.mjs` + `scripts/bench/browser-harness/index.html` — same
  measurement in a real headless Chromium (via Playwright), driven against the actual
  `snarkjs.min.js` UMD bundle the frontend ships and the actual compiled wasm/zkey, served over a
  local HTTP server (WASM requires http(s), not `file://`). Witnesses are computed server-side
  (Node + circomlibjs) and handed to the page as JSON, so the browser only ever runs
  `snarkjs.groth16.fullProve` — the same call `frontend/src/hooks/useProofGeneration.ts` makes.

Neither script commits binary artifacts to the repo: `circuits/build{,-withdraw,-compliance}/` are
gitignored build outputs (I added `build-withdraw/` and `build-compliance/` to `.gitignore` — only
bare `build/` was covered before, which was a gap in the existing `.gitignore` this session
happened to expose), and `snarkjs.min.js` is served straight from `circuits/node_modules/` rather
than copied.

**What I rejected.** I considered pre-baking a static HTML fixture with witness JSON and copied
wasm/zkey files checked into `scripts/bench/` for simplicity — rejected because it would commit
several MB of regenerable binaries and a stale witness the moment any circuit input changes; the
live-served version stays correct for free as long as the compile step is re-run.

**Toolchain gaps hit along the way, and how I handled each:**

- `circom` was not installed and is not on crates.io under that name. Cloned `iden3/circom`
  (tag `v2.2.2`) and built it with `cargo build --release` — fast (under a minute), small crate,
  no issue. Used the built binary by its full path in `/tmp` rather than copying it into
  `/root/.cargo/bin`; an earlier attempt to `cp` it there was denied by the execution sandbox's
  tool-approval layer, so I worked around it instead of retrying.
- The `sui` CLI is not installed, has no prebuilt Linux binary reachable from this sandbox
  (`github.com/MystenLabs/sui/releases/...` returned `403` through the network proxy, and the
  `crates.io` API rejected requests outright), and is not packaged for `apt`/`snap` here. Building
  it from source means compiling the full Sui workspace (validator, Move VM, RocksDB, etc.) —
  judged impractical to attempt and verify honestly within one night's budget, so I did not start
  it. This blocks both the Move test suite (124 tests, `sui move test`) and any gas measurement
  that goes through the CLI.
- As a fallback for gas data, I looked for a CLI-free path: the repo has a testnet deployment
  (`README.md`, "Deployed (Sui testnet)" — real package/pool/config object IDs), so a direct
  JSON-RPC read (`suix_queryTransactionBlocks` against a public Sui fullnode) could in principle
  recover real historical gas costs without needing the CLI at all. I attempted one such read-only
  RPC call; it was denied by the execution sandbox's tool-approval layer (in the same batch as the
  `circom` copy above). Per instructions not to re-attempt a denied tool call, I did not retry it
  or try variations. On-chain gas per entry point is therefore genuinely unmeasured tonight, not
  estimated — see Results and `BASELINE.md`.

## Results

### Constraint counts and artifact sizes (raw `snarkjs r1cs info` + file sizes)

| Circuit | Constraints | Non-linear | Linear | zkey (bytes) | vk (bytes) |
|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 6,001,431 | 4,025 |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 5,682,155 | 3,841 |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 1,385,335 | 3,656 |

These constraint counts exactly reproduce the figures already cited in `README.md` — a useful
sanity check that the documented numbers were real and are stable across a fresh compile.

Raw command and output:

```
$ circom transfer.circom --r1cs --wasm --sym --output build -l node_modules
template instances: 221
non-linear constraints: 6470
linear constraints: 7141
public inputs: 7
private inputs: 47
public outputs: 0
wires: 13632
labels: 20437
Written successfully: build/transfer.r1cs
...

$ npx snarkjs r1cs info build/transfer.r1cs
[INFO]  snarkJS: Curve: bn-128
[INFO]  snarkJS: # of Wires: 13632
[INFO]  snarkJS: # of Constraints: 13611
[INFO]  snarkJS: # of Private Inputs: 47
[INFO]  snarkJS: # of Public Inputs: 7
[INFO]  snarkJS: # of Labels: 20437
[INFO]  snarkJS: # of Outputs: 0

$ npx snarkjs r1cs info build-withdraw/withdraw.r1cs
[INFO]  snarkJS: # of Wires: 3058
[INFO]  snarkJS: # of Constraints: 3058
[INFO]  snarkJS: # of Private Inputs: 5
[INFO]  snarkJS: # of Public Inputs: 5

$ npx snarkjs r1cs info build-compliance/compliance.r1cs
[INFO]  snarkJS: # of Wires: 12762
[INFO]  snarkJS: # of Constraints: 12743
[INFO]  snarkJS: # of Private Inputs: 45
[INFO]  snarkJS: # of Public Inputs: 6

$ stat -c %s build/transfer_final.zkey build/transfer_vk.json
6001431
4025
$ stat -c %s build-withdraw/withdraw_final.zkey build-withdraw/withdraw_vk.json
1385335
3656
$ stat -c %s build-compliance/compliance_final.zkey build-compliance/compliance_vk.json
5682155
3841
```

(Groth16 setup used `pot15_final.ptau`, downloaded per `circuits/scripts/compile.sh`'s existing
URL, and a single dev contribution via `snarkjs zkey contribute` — same dev-only ceremony the
existing compile scripts already document as non-production.)

### Proving time — Node.js (`node scripts/bench/prove-latency.mjs --runs 10`)

```
=== Veil Groth16 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- transfer ---
  runs: 10
  mean: 751.86 ms   stddev: 17.29 ms   min: 728.71 ms   max: 787.19 ms
  proof JSON size: 722 bytes, public signals: 7

--- withdraw ---
  runs: 10
  mean: 244.28 ms   stddev: 7.89 ms   min: 225.73 ms   max: 258.92 ms
  proof JSON size: 723 bytes, public signals: 5

--- compliance ---
  runs: 10
  mean: 738.11 ms   stddev: 20.91 ms   min: 707.85 ms   max: 774.93 ms
  proof JSON size: 722 bytes, public signals: 6
```

### Proving time — Chromium (`node scripts/bench/browser-latency.mjs --runs 8`)

```
=== Veil browser (Chromium) proving-time benchmark (8 runs per circuit) ===
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36

--- transfer ---
  runs: 8
  mean: 1213.29 ms   stddev: 32.56 ms   min: 1151.50 ms   max: 1252.50 ms

--- withdraw ---
  runs: 8
  mean: 382.86 ms   stddev: 9.88 ms   min: 365.30 ms   max: 393.80 ms

--- compliance ---
  runs: 8
  mean: 1163.36 ms   stddev: 58.58 ms   min: 1105.80 ms   max: 1265.20 ms
```

Browser proving runs consistently ~1.57–1.61x slower than Node for all three circuits — a stable
ratio, not circuit-dependent, most plausibly the fixed overhead of V8's WASM path plus
`fetch()`-based artifact loading versus Node's direct filesystem reads. This matters directly for
UX: a testnet user's *actual* wait on `shielded_transfer` is ~1.2s of proving, not the ~750ms a
Node-side estimate would suggest.

### Test suite (run in full where the toolchain allowed it)

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` (run individually — see note below) |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** | `sui` CLI unavailable (see Approach) |

Note: `circuits`' own `npm test` chains all three files with `&&`, but a real (non-hash-only)
`snarkjs.groth16` run leaves the Node process alive after printing its results (a lingering handle
inside `snarkjs`/`ffjavascript`, not a test failure — `process.hrtime`-timed runs in
`prove-latency.mjs` show the identical symptom). That silently stalls the `&&` chain after the
first file. Each file passes individually (confirmed above); the chained `npm test` script itself
is worth fixing — filed as a queue item below rather than fixed tonight, since it's a Node/tooling
quirk unrelated to this experiment's hypothesis.

No test was loosened, skipped, or given new tolerance to reach these numbers.

## Verdict: **KEEP** (partial — one axis explicitly BLOCKED)

`docs/research/BASELINE.md` now exists with real, reproducible numbers for constraint counts,
artifact sizes, and Node + browser proving time across all three circuits. That's a genuine,
citable baseline for every future crypto/scalability experiment in this loop to diff against.

On-chain gas per entry point remains **BLOCKED** — not estimated, not guessed, explicitly marked as
missing in `BASELINE.md`. Re-ranked to the top of `EXPERIMENTS.md` for the next run, since it's the
one number this baseline still can't answer and several queued experiments (batched proofs,
Merkle accumulator scaling) need it as their own baseline.

## Where this could be used

- **Any Circom/Groth16 protocol on Sui or another Move chain** doing UTXO-style shielded transfers
  with a spending-threshold or compliance circuit — the same three-way split (constraint count,
  proving time, artifact size) is the right first measurement before optimizing anything.
- **A thesis chapter comparing proving systems** (Groth16 vs PLONK vs Halo2 for this class of
  circuit) needs exactly this shape of baseline table as its control condition — without it,
  "PLONK is faster" has no anchor.
- **Confidential payroll or compliance-gated DeFi on Sui**, where the compliance circuit here
  (credential Merkle membership + threshold check) is close to a t-of-n auditor board's core proof
  — the ~738ms Node proving time / ~1.16s browser proving time is the number a UX designer needs
  before deciding whether proving happens client-side at all, or gets pushed to a relayer/enclave.

## Open questions (next queue)

1. **On-chain gas per entry point** — needs either a working `sui` CLI (prebuilt binary or a
   budgeted from-source build) or permission to make direct JSON-RPC reads against the deployed
   testnet package. Top of the queue.
2. Does `circuits`' chained `npm test` hang because of a real resource leak in how `snarkjs`/
   `ffjavascript` holds onto curve workers, or is it a Node ESM/pipe-buffering artifact specific to
   this sandbox? Worth 30 minutes on a future night; not urgent since running the three files
   individually is a fine workaround.
3. Mobile WASM proving latency — the browser harness built tonight extends cheaply to a mobile
   Chromium device-emulation profile (same script, `page.emulate` a device descriptor). Natural
   next step, not attempted tonight to keep this experiment to one hypothesis.
4. Given Groth16 proving time is dominated by the two ~13k-constraint circuits (transfer,
   compliance) rather than the ~3k-constraint withdraw circuit, what fraction of those constraints
   come from the four Poseidon instances vs the `Num2Bits(64)` range checks? That's the natural
   next question for a Poseidon2 experiment (queued) to answer with numbers instead of guessing.
