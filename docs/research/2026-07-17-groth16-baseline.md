# 2026-07-17 — Groth16 baseline: circuits, proving, gas, browser latency

Queue item: #1 (`BASELINE.md`), `docs/research/EXPERIMENTS.md`.

## Hypothesis

Veil's own numbers — per-circuit R1CS constraints, Groth16 setup/prove/verify time, proof and VK
size, and (if measurable) on-chain gas per entry point and browser WASM proving latency — have never
been measured together, on one machine, in one run. Establishing them turns every future
cryptography/scalability comparison in this loop from a half-blind guess into a grounded before/after.
There is no single number this hypothesis "moves" — it's the zero point every later experiment moves
*from*.

## Threat / privacy model

This experiment does not change any circuit, contract, or protocol behavior — it only runs existing
code and records real output. So the relevant question isn't "what does a new adversary learn" but
"does the measurement process itself leak anything, and does establishing these numbers change any
STRIDE entry in `docs/threat-model.md`."

**What this does NOT touch:** no changes to `transfer.circom`, `compliance.circom`, `withdraw.circom`,
or any `contracts/sources/*.move` file. All Groth16 artifacts generated tonight (`*_final.zkey`,
`*_vk.json`) are **dev-only single-contributor trusted setups** — same caveat as
`circuits/scripts/compile.sh` already carries, RR2 in the threat model. They are not committed (see
`.gitignore`) and are not the VKs deployed on testnet. Nothing here is fit for, or intended for,
deployment.

**Residual surface:** none created by this experiment. The numbers below describe *this sandbox's*
performance (a shared/virtualized CPU, see the noise discussion in Results) — they are not a
production SLA and should not be quoted as one without re-measuring on real target hardware (a
production build server for prove time, a real phone for browser latency, real testnet gas for the
on-chain number).

**Assumptions:** same as the existing trust boundaries in `docs/threat-model.md` boundary 5 — Groth16
soundness under the BN254 discrete-log assumption, honest-enough trusted-setup ceremony (not
applicable here since tonight's zkeys are dev-only and thrown away, not the deployed ones).

**STRIDE mapping:** none. No new mitigation, no new threat, no change to any existing entry's status.
This report is infrastructure for future experiments that *will* touch STRIDE entries (e.g. queue
items 4, 7, 9, 10 in `EXPERIMENTS.md`).

## Approach

Compiled all three circuits from source with `circom` 2.2.3 (matches the README's stated prerequisite,
`circom` 2.2.x) and ran a real Groth16 trusted setup (pot15 Powers of Tau, single dev contribution) for
each, then measured:

1. R1CS constraint counts via `snarkjs r1cs info` (reproducing the README's existing claim).
2. Witness generation, proving, and verification wall-clock time, and proof/VK/zkey sizes, via a new
   reusable script `scripts/bench/groth16-bench.mjs` (5 iterations per circuit, median reported —
   raw per-iteration numbers are in the command output below, because this sandbox's CPU is noisy
   enough that a single sample would be misleading).
3. The same witness proved inside real headless Chromium (via Playwright, `snarkjs`'s browser WASM
   bundle) instead of Node, using `scripts/bench/browser-harness/` — to get a real, if imperfect,
   browser-vs-Node comparison for the number the frontend actually pays.
4. On-chain gas per entry point (`shielded_transfer`, `compliant_transfer`, `deposit`, `withdraw`) —
   attempted, blocked. See below.

**Alternatives rejected:**
- *Estimating gas from Move bytecode instruction counts instead of measuring it.* Rejected outright —
  the nightly loop's one rule is no estimates presented as measurements. An instruction-count proxy
  isn't gas; it would report a fabricated number under a real-sounding label. Marked BLOCKED instead.
- *Building `sui` CLI from source to unblock gas measurement.* Considered, then rejected for
  tonight: a shallow sparse clone of `MystenLabs/sui` shows **1,615 crates** in `Cargo.lock` — a
  release build of just the `sui` binary from that graph is not a same-night job on this sandbox's
  CPU/disk budget (~30 GB free). Documented as the queue item's blocker instead of attempting a
  multi-hour build with no restart-safety in this session.
- *Downloading a prebuilt `sui` release binary from GitHub.* Attempted — `github.com` release asset
  URLs return **403 from the egress proxy**, which the proxy's own diagnostics classify as an
  organization policy denial ("do not retry or route around it — report the blocked host"), not a
  transient failure. Confirmed via `curl -sSI https://github.com/MystenLabs/sui/releases/latest` →
  `403`.
- *Simulating mobile proving latency by CPU-throttling the Node benchmark.* Rejected — a throttled
  desktop Node process modeling a phone is exactly the kind of "estimate presented as a measurement"
  the loop forbids. Used real headless Chromium instead, and labeled the result "headless Chromium on
  this sandbox," explicitly not a phone.

## Results

### Circuit sizes (reproduces README's existing claim)

```
$ cd circuits && circom transfer.circom --r1cs --wasm --sym --output build
template instances: 221
non-linear constraints: 6470
linear constraints: 7141
public inputs: 7
private inputs: 47
public outputs: 0
wires: 13632
labels: 20437
Written successfully: build/transfer.r1cs
Everything went okay
real 0m3.239s

$ circom compliance.circom --r1cs --wasm --sym --output build-compliance
non-linear constraints: 6057
linear constraints: 6686
public inputs: 6
private inputs: 45
Everything went okay
real 0m3.281s

$ circom withdraw.circom --r1cs --wasm --sym --output build-withdraw
non-linear constraints: 1465
linear constraints: 1593
public inputs: 5
private inputs: 5
Everything went okay
real 0m2.198s
```

```
$ npx snarkjs r1cs info build/transfer.r1cs
[INFO]  snarkJS: Curve: bn-128
[INFO]  snarkJS: # of Wires: 13632
[INFO]  snarkJS: # of Constraints: 13611
[INFO]  snarkJS: # of Private Inputs: 47
[INFO]  snarkJS: # of Public Inputs: 7
[INFO]  snarkJS: # of Labels: 20437
[INFO]  snarkJS: # of Outputs: 0

$ npx snarkjs r1cs info build-compliance/compliance.r1cs
[INFO]  snarkJS: # of Constraints: 12743
[INFO]  snarkJS: # of Private Inputs: 45
[INFO]  snarkJS: # of Public Inputs: 6

$ npx snarkjs r1cs info build-withdraw/withdraw.r1cs
[INFO]  snarkJS: # of Constraints: 3058
[INFO]  snarkJS: # of Private Inputs: 5
[INFO]  snarkJS: # of Public Inputs: 5
```

| Circuit | R1CS constraints | Public / private inputs | R1CS file size |
|---|---|---|---|
| `transfer.circom` | 13,611 | 7 / 47 | 1,851,820 B |
| `compliance.circom` | 12,743 | 6 / 45 | 1,726,984 B |
| `withdraw.circom` | 3,058 | 5 / 5 | 436,320 B |

Constraint counts match the README exactly (`circom` 2.2.3, matching the README's stated prerequisite
`circom` 2.2.x). Confirmed reproducible on a clean machine, not just self-reported.

### Groth16 setup time (dev, single contribution, pot15)

```
$ time npx snarkjs groth16 setup build/transfer.r1cs build/pot15_final.ptau build/transfer_0000.zkey
real  0m10.316s
$ time npx snarkjs groth16 setup build-compliance/compliance.r1cs build-compliance/pot15_final.ptau build-compliance/compliance_0000.zkey
real  0m9.852s
$ time npx snarkjs groth16 setup build-withdraw/withdraw.r1cs build-withdraw/pot15_final.ptau build-withdraw/withdraw_0000.zkey
real  0m3.446s
```

### Node.js proving benchmark (`node scripts/bench/groth16-bench.mjs`, 5 iterations/circuit, median)

Raw per-iteration numbers (ms), transfer, showing the noise:

```
witnessMsAll: [122.3, 131.2, 589.9, 307.0, 353.9]
proveMsAll:   [2395.0, 1123.6, 1297.7, 1531.4, 921.1]
verifyMsAll:  [36.2, 45.9, 36.4, 28.3, 40.6]
```

This sandbox's CPU is noisy (shared/virtualized — the same circuit's prove time varies by >2.5x
run-to-run). The table below uses the median of 5 runs per circuit; treat these as directional, not a
tight SLA.

| Circuit | Witness ms (median) | Prove ms (median) | Verify ms (median) | Proof (B) | VK (B) | zkey (B) |
|---|---|---|---|---|---|---|
| `transfer` | ~120–310 | ~1000–1300 | ~36–40 | 722–723 | 4,025 | 6,001,424 |
| `compliance` | ~107–126 | ~900–960 | ~18–42 | 722–723 | 3,840 | 5,682,148 |
| `withdraw` | ~68–72 | ~254–265 | ~34–38 | 721–723 | 3,655 | 1,385,328 |

(Ranges above are across two separate 5-iteration runs of the bench script, not a single run's min/max
— included instead of one cherry-picked run, per the noise observed.) `transfer` proves slower than
`compliance` despite only ~7% more constraints (13,611 vs 12,743) — consistent with the extra
Merkle-membership gadget (`C0` in the README's constraint table) adding proportionally more non-linear
work than raw constraint count alone suggests; not chased further tonight, flagged as a question below.

### Browser proving benchmark (`node scripts/bench/browser-harness/serve-and-bench.mjs`)

Real headless Chromium (Playwright, `chrome-linux/chrome`), same witness as the Node benchmark above,
via `snarkjs`'s browser WASM bundle (`snarkjs.min.js`) loaded over a local HTTP server (not `file://`,
for WASM streaming-compile compatibility):

```
$ node scripts/bench/browser-harness/serve-and-bench.mjs
iter 0: fullProve=10665.2ms verify=31.1ms ok=true
iter 1: fullProve=5873.8ms  verify=30.1ms ok=true
iter 2: fullProve=1954.5ms  verify=29.7ms ok=true
iter 3: fullProve=3387.4ms  verify=22.9ms ok=true
iter 4: fullProve=1438.6ms  verify=21.9ms ok=true
userAgent: Mozilla/5.0 (X11; Linux x86_64) ... HeadlessChrome/141.0.0.0 Safari/537.36
```

| | Node (`transfer`, witness+prove combined) | Headless Chromium (`transfer`, fullProve = witness+prove) |
|---|---|---|
| Median | ~1,200–1,600 ms | ~3,400 ms |
| Min–max across 5 runs | ~1,050–2,900 ms | 1,439–10,665 ms |
| Verify | ~36–40 ms | ~22–31 ms |

**Read this carefully — what this is NOT:** this is headless Chromium on the same noisy sandbox VM as
the Node benchmark, not a mobile device. It is a real measurement of the actual `snarkjs` WASM path the
frontend ships (`frontend/`'s Web Worker uses the same `snarkjs` browser bundle), which makes it more
honest than a Node number alone, but it is not the number a user's phone would see — mobile WASM
proving is typically several times slower than desktop-class WASM due to weaker single-core
performance and thermal throttling. That gap is exactly why queue item 3 (real-device browser latency)
stays open rather than being closed by this result.

### On-chain gas per entry point — BLOCKED

```
$ which sui
(nothing — not installed)

$ curl -sSI https://github.com/MystenLabs/sui/releases/latest
HTTP/1.1 403   # egress proxy: organization policy denial, not transient

$ git clone --depth 1 --filter=blob:none --sparse https://github.com/MystenLabs/sui.git
$ git sparse-checkout set Cargo.toml Cargo.lock
$ grep -c "^name = " Cargo.lock
1615
```

No `sui` binary exists in this sandbox. GitHub release-asset downloads (where a prebuilt binary would
come from) are denied by the outbound egress policy (403, confirmed policy-classified, not
transient — the proxy's own troubleshooting guide says not to retry these). Building the full Sui
monorepo from source is not attempted: `Cargo.lock` shows 1,615 crates in the dependency graph, which
is not a one-night build on this sandbox's CPU and ~30 GB free disk. This is now queue item 2 in
`EXPERIMENTS.md`, unblocked only by a sandbox image that ships `sui` preinstalled, an allowed download
mirror, or a binary supplied out-of-band.

### Test suite (per the README's existing table, re-run tonight on the artifacts built above)

```
$ cd circuits && node --experimental-vm-modules test/transfer.test.mjs
=== Results: 43 passed, 0 failed ===   (real Groth16 fullProve + verify per case, incl. C0-C11 negative tests)

$ node --experimental-vm-modules test/compliance.test.mjs
=== Results: 30 passed, 0 failed ===

$ node --experimental-vm-modules test/withdraw.test.mjs
=== Results: 35 passed, 0 failed ===

$ cd ../scripts && bun run src/test-converter.ts
Results: 109 passed, 0 failed

$ bun run src/test-compliance-utils.ts
Results: 67 passed, 0 failed

$ cd ../frontend && bun install && bunx vitest run
Test Files  3 passed (3)
     Tests  19 passed (19)
```

**Not run:** `cd contracts && sui move test` (124 tests per the README) — no `sui` binary in this
sandbox, same blocker as the on-chain gas measurement above. This is a genuine gap in tonight's test
coverage, not a passing or failing result — it simply did not execute. Nothing in this PR touches
`contracts/`, so the risk is low, but it is not the same as a green Move suite and should not be read
as one.

Everything that *could* run, ran green: 43 + 30 + 35 (circuits, real proofs) + 109 + 67 (scripts) + 19
(frontend) = 303 passing tests, 0 failures, 0 skipped, 0 loosened.

## Verdict: KEEP (partial)

**KEEP** for what was measured — circuit constraints, Groth16 setup/prove/verify time, proof/VK/zkey
sizes, and a first (imperfect but real) Node-vs-browser proving comparison, all backed by commands
run on this machine tonight and captured in `scripts/bench/`. `BASELINE.md` is created and populated
with these numbers (see repo root).

**BLOCKED** for the two sub-metrics that could not be measured this run: on-chain gas per entry point,
and real-device (as opposed to headless-Chromium) browser proving latency. Both are carried forward
as queue items 2 and 3 in `EXPERIMENTS.md` rather than re-blocking the whole baseline — the parts that
*could* be measured are real and worth keeping now, not withheld until the sandbox grows a `sui`
binary and a phone.

## Where this could be used

- **Any Circom + Groth16 + Sui `sui::groth16` project** that wants a "is my circuit big or small"
  reference point before optimizing — 13,611 constraints for a 4-Poseidon-plus-Merkle-membership
  circuit is a useful anchor for judging whether a redesign (Poseidon2, PLONK, batching) is worth the
  engineering cost.
- **Thesis chapter on ZK payment-protocol prover economics**: the Node-vs-headless-Chromium proving
  gap (roughly 3x median, `transfer`) is a concrete, if sandbox-bound, data point for a "prover cost
  asymmetry between server-side and client-side proving" argument — worth re-running on real
  hardware (a real phone, a real build server) before citing in anything formal.
- **`scripts/bench/groth16-bench.mjs` and `scripts/bench/browser-harness/`** are reusable as-is for
  any future circuit change in this repo (Poseidon2 swap, batching, etc.) — re-run them before/after
  and diff the table, which is exactly the loop's intended before/after pattern for the next several
  queue items (4, 6, 7 in `EXPERIMENTS.md`).
- **Confidential payroll on Sui with a t-of-n auditor board** (queue item 10): before touching that
  design, it's useful to know the compliance circuit alone already costs ~900ms median prove time
  and 12,743 constraints — a dual-proof (`compliant_transfer`) UX has to budget for transfer + 
  compliance proving sequentially or in parallel, and this baseline is the number that budget starts
  from.

## Open questions (next queue candidates)

1. Why does `transfer.circom` prove ~30–40% slower than `compliance.circom` despite only ~7% more
   R1CS constraints? Worth a constraint-by-constraint prove-time breakdown before assuming raw
   constraint count is a reliable enough proxy for prove time on its own (it's the number used to rank
   queue item 4, Poseidon2 — if the relationship isn't linear, that ranking rationale needs revisiting).
2. Real on-chain gas per entry point (queue item 2) and real-device browser proving latency (queue
   item 3) — both explicitly blocked tonight, both high-value, both actionable once the toolchain gap
   is closed.
3. How much of the ~3x Node-vs-browser prove gap is WASM-vs-native-witness-calculator overhead vs.
   genuine browser-engine overhead vs. this sandbox's noise floor? The comparison used Node's own WASM
   witness calculator (via `snarkjs.wtns.calculate`), not a native one, so the two benchmarks are more
   comparable than they might look — but this wasn't isolated from run-to-run VM noise, which was
   large enough (up to 7x on a single iteration) to swamp a real signal. A longer run (20+ iterations)
   on a quieter machine would sharpen this before anyone treats "3x" as more than a rough ballpark.
