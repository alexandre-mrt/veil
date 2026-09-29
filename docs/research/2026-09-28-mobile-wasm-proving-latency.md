# 2026-09-28 — Mobile WASM proving latency (queue item #8)

## Hypothesis

A CPU-throttled headless-Chromium approximation of a mid/high-tier Android phone (Playwright's
"Pixel 7" viewport/UA/DPR descriptor, plus a 4x CPU throttle via CDP
`Emulation.setCPUThrottlingRate` — the same multiplier Lighthouse uses as its standard "mid-tier
mobile" default) will show Groth16 proving latency for all three of Veil's circuits **more than
1.5x slower** than the existing desktop-headless-Chromium numbers in `BASELINE.md`. Before tonight,
`BASELINE.md`'s "Mobile WASM proving latency" row said `NOT MEASURED`; every UX judgment about
whether Veil's client-side proving model is viable on a phone has been a guess.

This is queue item #8 — flagged as "spend an hour, get a real number... good candidate for a
lighter night," a fair description after item #1 (on-chain gas) turned out to be blocked again for
infrastructure reasons documented below, and item #2 (Poseidon2) turned out to require a from-scratch
circom implementation of round constants I could not verify against any reference (see "What I
rejected").

## Threat / privacy model

This experiment does not change any circuit, Move module, or trust boundary — it measures a
UX/performance number. But that number feeds directly into a design decision with a real privacy
consequence, which is the actual reason it belongs in this loop rather than being pure product work.

**The concrete adversary this speaks to isn't a chain observer or a malicious prover — it's the
protocol's own future implementer**, deciding where proving happens. Veil's entire privacy story
rests on proof generation staying client-side: `frontend/src/hooks/useProofGeneration.ts` runs
`snarkjs.groth16.fullProve` in a Web Worker in the user's own browser, so the full private witness —
`userSecret`, `txAmount`, `cumulativeOld`/`New`, the Merkle authentication path — never leaves the
device. If mobile proving latency is bad enough (multi-second, on a mid-tier device, worse still on
a low-tier one), a real deployment under UX pressure will be tempted to move proving server-side (a
"prover-as-a-service" relayer, or delegate proving to the sponsoring relayer already in the codebase).
That would leak the entire witness to whoever runs that server — strictly worse than anything
currently in `docs/threat-model.md`'s Information Disclosure section (I1–I6), all of which assume the
witness never leaves the client. This experiment's number is what tells an implementer how close to
that cliff Veil actually is.

**What this does NOT establish:**
- **Not a real mobile-hardware measurement.** Everything below ran on this machine's desktop x86_64
  CPU under headless Chromium. `--device "Pixel 7"` only emulates viewport, user-agent, device pixel
  ratio, and touch/mobile flags; `--cpu-throttle 4` slows the same x86_64 core via CDP. Real ARM
  silicon, a real mobile V8/WASM JIT, thermal throttling under sustained load, and background-tab
  suspension are all absent. Treat every number below as "CPU-throttled desktop Chromium
  approximating a mid-tier phone's CPU budget," never as "measured on a Pixel 7."
- **Not a statement about low-tier devices.** Pixel 7 (2022 flagship-adjacent) and a 4x throttle are
  a *mid/high-tier* approximation. A genuinely budget device would be slower still; this experiment
  says nothing about that end of the market.
- **Not a new mitigation.** No code path changed in `circuits/`, `contracts/`, or
  `frontend/src/hooks/`. This is measurement only — the "where should proving run" decision itself is
  still open and not addressed here.

**Assumptions unchanged:** Groth16 soundness under BN254 discrete log, the existing dev-only trusted
setup (RR2, untouched), snarkjs's own WASM witness-generation and proving code path (unaudited by
this experiment). Maps most directly to a *residual surface not yet in STRIDE*: the current I1–I6
rows in `docs/threat-model.md` all assume client-side proving; this experiment's finding is evidence
for why that assumption is worth stating explicitly and defending, not evidence that it's currently
violated.

## Approach

**What I built.** Extended the existing `scripts/bench/browser-latency.mjs` harness (built 2026-07-22
for the desktop baseline) with two flags, rather than writing a new script:

- `--device <PlaywrightDeviceName>` — creates the browser context with that device descriptor
  (viewport, user agent, `deviceScaleFactor`, `isMobile`/`hasTouch`), e.g. `"Pixel 7"`.
- `--cpu-throttle <rate>` — opens a CDP session on the page and calls
  `Emulation.setCPUThrottlingRate({ rate })` before the benchmark runs.

Both are optional and off by default, so the script's existing desktop-headless behavior (and
`BASELINE.md`'s documented repro command) is unchanged when neither flag is passed. The script now
also labels its own output clearly when device/throttle emulation is active, and tags each JSON
result with `device` and `cpuThrottleRate` so the raw output is self-describing.

**What I rejected:**
- **A real device farm (BrowserStack/Sauce Labs style).** Would give genuine hardware numbers, but
  requires outbound network access to a third-party service — this session's egress proxy blocks
  everything outside a small allowlist (see queue item #1 below), and provisioning a real-device CI
  step is a multi-night infrastructure project, not tonight's one-hypothesis budget.
- **A brand-new mobile-specific benchmark script.** Rejected for the same reason last night rejected
  duplicating the desktop harness: the desktop and mobile paths are the same measurement over the
  same witnesses and artifacts: differing only in browser-context options, so one parameterized
  script is more honest about what changed than a forked copy would be.
- **Poseidon2 (queue item #2), attempted first as the night's real target.** Rejected after
  investigation, not before: implementing Poseidon2 in circom means generating its round constants
  and MDS/partial-round matrices myself (no `circomlib`-style Poseidon2 circom template exists on
  npm — I checked; only JS/TS Poseidon2 *hashers*, e.g. `poseidon2`, `@zkpassport/poseidon2`,
  `@taceo/poseidon2`, none of them circom gadgets). Doing that from the paper's spec blind, with no
  reference implementation or published test vectors reachable to check against (GitHub repos other
  than this one, and every Sui/Aptos RPC/CDN host, are blocked by this session's network policy — see
  below), means I cannot verify the result is even the *correct* hash, let alone a sound one. Shipping
  an unverifiable hand-rolled permutation as a "soundness-argued" circuit change would violate the
  spirit of this loop's one rule more than skipping it does. Re-queued with that specific blocker
  noted (see Open questions).

**Queue item #1 (on-chain gas), attempted first, confirmed blocked again — new diagnostic
information.** Before picking item #8, I spent the "early part of the run" the queue note
recommended on unblocking item #1. Findings, more precise than the previous two attempts:
- `curl` to `fullnode.testnet.sui.io:443`, `sui-testnet.mystenlabs.com:443`, and
  `static.aptoslabs.com:443` all fail with `CONNECT tunnel failed, response 403`. The agent proxy's
  own status endpoint (`/__agentproxy/status`) confirms these as `connect_rejected` — **explicit
  organization egress-policy denials**, not a transient network fault, and not something to retry
  (the environment's own guidance says not to retry 403/407 policy denials).
- `api.github.com` for any repo other than this one returns a *different*, application-level 403
  ("GitHub access to this repository is not enabled for this session") — this session's GitHub
  access is scoped to `alexandre-mrt/veil` only, so a prebuilt `sui` binary from
  `github.com/MystenLabs/sui/releases` isn't reachable that way either. (Oddly, plain `git clone` of
  an unrelated public GitHub repo over HTTPS *does* work — I used it to fetch `iden3/circom` source,
  see below — so the release/API paths are blocked by a narrower rule than raw git-over-HTTPS.)
- `cargo search sui` / crates.io has no published `sui` CLI crate (confirmed again).
- **Confirmed the blocker is this session's environment, not a fundamental unavailability**: this
  PR's own CI (`Move contracts (sui move test)` job, unrestricted GitHub Actions network) installs a
  real `sui` testnet binary straight from `api.github.com/repos/MystenLabs/sui/releases` in under 30
  seconds and runs all 124 Move tests successfully (see Test suite below). The exact same request
  this session's egress proxy blocks with `403`/`connect_rejected` works fine from a runner without
  that proxy in front of it.

This is now a clearly diagnosed infrastructure blocker, not an ambiguous one: on-chain gas
measurement needs either `fullnode.testnet.sui.io` (or an equivalent Sui JSON-RPC host) added to this
environment's egress allowlist, or a `sui` binary vendored into the environment/repo ahead of time.
Neither is something a research-loop session can fix from inside itself. Still top of the queue,
carried forward with this sharper diagnosis (see Open questions) rather than attempted a fourth time
next run without an infrastructure change first.

**Toolchain note (unrelated to network policy, worth recording):** `circuits/build{,-withdraw,
-compliance}/` are gitignored and this session's container was freshly provisioned, so I rebuilt the
whole toolchain from scratch: cloned and built `circom` v2.2.3 from source (`cargo build --release`,
~1 minute — `github.com` git-over-HTTPS works fine, only the release/API paths above are blocked),
then generated a **fresh local `pot15` Powers-of-Tau** with `snarkjs powersoftau new` +
`contribute` + `prepare phase2` entirely offline, rather than downloading the Hermez ptau file the
existing `compile*.sh` scripts default to — `storage.googleapis.com` is *also* blocked by this
session's egress policy (another new data point beyond the Sui/GitHub hosts above). A fresh
same-size ptau is equally valid for a dev-only, non-production setup (this repo's `compile.sh`
already says as much about the downloaded one), and it means this whole benchmark no longer has any
external-network dependency at all — a small resilience improvement over the existing scripts,
though I didn't change the scripts themselves to default to it, to keep this PR to one hypothesis.
All three circuits recompiled to the exact constraint counts already in `BASELINE.md` (13,611 /
12,743 / 3,058) — a good sanity check that the fresh toolchain reproduces the existing baseline
before trusting the new numbers built on top of it.

## Results

### Desktop headless Chromium (today, same machine/toolchain, for a same-day comparison point)

| Circuit | Mean (ms) | stddev | min | max |
|---|---|---|---|---|
| `transfer` | 1228.03 | 49.71 | 1165.70 | 1309.00 |
| `withdraw` | 385.96 | 32.71 | 354.80 | 442.10 |
| `compliance` | 1193.95 | 34.41 | 1143.30 | 1255.20 |

(For reference, 2026-07-22's `BASELINE.md` desktop numbers were 1213.3 / 382.9 / 1163.4 ms — today's
run is within noise of that, on what is presumably different underlying host hardware between
sessions. Node-side proving (`prove-latency.mjs --runs 10`) also reproduced closely: 815.2 / 265.5 /
796.7 ms vs. baseline's 751.9 / 244.3 / 738.1 ms.)

### Mobile-approximated: Pixel 7 viewport/UA + 4x CPU throttle

| Circuit | Mean (ms) | stddev | min | max | vs. today's desktop |
|---|---|---|---|---|---|
| `transfer` | 2335.45 | 90.09 | 2210.20 | 2463.00 | **1.90x** |
| `withdraw` | 897.97 | 48.93 | 828.30 | 969.40 | **2.33x** |
| `compliance` | 2327.08 | 121.30 | 2205.10 | 2594.20 | **1.95x** |

All three exceed the 1.5x hypothesis threshold. Note the *non-uniformity*: `withdraw` — the smallest
circuit (3,058 constraints) and the fastest in absolute terms — slows down proportionally **more**
(2.33x) than the two ~13k-constraint circuits (1.90x, 1.95x) under identical throttling. A 4x CPU
throttle did not produce a 4x wall-clock slowdown for any circuit, which means a real fraction of
total proving time (WASM fetch/instantiation, V8 startup, witness JSON round-trip) is not CPU-bound
in the way `groth16.fullProve`'s field arithmetic is — that fraction stays roughly constant while the
throttled portion sits under it, and it's proportionally larger for the smaller, faster circuit. This
is a genuine, unexplained-in-full finding worth a follow-up (see Open questions), not a modeling
artifact I introduced — the same script, same witnesses, same artifacts as the desktop run, only the
context options differ.

### Raw command output

```
$ node scripts/bench/prove-latency.mjs --runs 10
=== Veil Groth16 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- transfer ---
  runs: 10
  mean: 815.19 ms   stddev: 23.01 ms   min: 787.45 ms   max: 856.95 ms
  proof JSON size: 722 bytes, public signals: 7

--- withdraw ---
  runs: 10
  mean: 265.49 ms   stddev: 15.22 ms   min: 236.12 ms   max: 289.84 ms
  proof JSON size: 719 bytes, public signals: 5

--- compliance ---
  runs: 10
  mean: 796.70 ms   stddev: 40.95 ms   min: 740.02 ms   max: 871.91 ms
  proof JSON size: 721 bytes, public signals: 6
```

```
$ node scripts/bench/browser-latency.mjs --runs 8
=== Veil browser (Chromium) proving-time benchmark (8 runs per circuit) ===
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36

--- transfer ---
  runs: 8
  mean: 1228.03 ms   stddev: 49.71 ms   min: 1165.70 ms   max: 1309.00 ms

--- withdraw ---
  runs: 8
  mean: 385.96 ms   stddev: 32.71 ms   min: 354.80 ms   max: 442.10 ms

--- compliance ---
  runs: 8
  mean: 1193.95 ms   stddev: 34.41 ms   min: 1143.30 ms   max: 1255.20 ms
```

```
$ node scripts/bench/browser-latency.mjs --runs 8 --device "Pixel 7" --cpu-throttle 4
=== Veil browser (Chromium, CPU-throttled 4x, emulating "Pixel 7") proving-time benchmark (8 runs per circuit) ===
NOTE: runs on this machine's desktop x86_64 CPU under headless Chromium with CPU throttling
(Emulation.setCPUThrottlingRate rate=4) and "Pixel 7"'s viewport/UA/DPR emulated. This approximates
a mobile device's CPU budget; it is not a measurement on real mobile hardware.
Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.37 Mobile Safari/537.36

--- transfer ---
  runs: 8
  mean: 2335.45 ms   stddev: 90.09 ms   min: 2210.20 ms   max: 2463.00 ms

--- withdraw ---
  runs: 8
  mean: 897.97 ms   stddev: 48.93 ms   min: 828.30 ms   max: 969.40 ms

--- compliance ---
  runs: 8
  mean: 2327.08 ms   stddev: 121.30 ms   min: 2205.10 ms   max: 2594.20 ms
```

```
$ circom transfer.circom --r1cs --wasm --sym --output build -l node_modules && npx snarkjs r1cs info build/transfer.r1cs
[INFO]  snarkJS: # of Constraints: 13611
$ npx snarkjs r1cs info build-withdraw/withdraw.r1cs
[INFO]  snarkJS: # of Constraints: 3058
$ npx snarkjs r1cs info build-compliance/compliance.r1cs
[INFO]  snarkJS: # of Constraints: 12743
```
(Exact match to `BASELINE.md`'s existing figures — confirms the freshly rebuilt toolchain, including
the locally generated ptau replacing the blocked Hermez download, reproduces the existing baseline
before trusting the new mobile numbers built on top of it.)

### Test suite

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **pass** (see below) | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **pass** (see below) | `cd frontend && bunx vitest run` |
| Property-based fuzz | **pass** (see below) | `cd scripts && bun run src/fuzz-tests.ts` |
| Move contracts | **NOT RUN inside this research session** (no `sui` CLI reachable under this environment's egress policy) — **124/124 pass in the repo's own CI** on this PR's head commit, confirmed after the fact (`Move contracts (sui move test)` job, `alexandre-mrt/veil#79`, `c1771a95e4bf224b5c15eee175ec997565030fdc`) — CI's runner has unrestricted network and installs `sui` straight from GitHub releases, which this session's proxy blocks | `sui move test` |

No test was loosened, skipped, or given new tolerance. No circuit, Move, or frontend proving code
changed — the only production-path file touched is the bench script itself.

## Verdict: **KEEP**

`docs/research/BASELINE.md`'s "Mobile WASM proving latency" row moves from `NOT MEASURED` to a real,
reproducible, clearly-caveated number. The harness change (`--device`/`--cpu-throttle` on the
existing script) is small, additive, and off-by-default, so it carries no regression risk to the
desktop benchmark other people may already be scripting against.

On-chain gas (queue item #1) remains **BLOCKED**, now with a precise diagnosis (organization
egress-policy denial, confirmed via the proxy's own status endpoint) rather than an ambiguous one.
Poseidon2 (queue item #2) is **PARKed**, not attempted, blocked on a verifiable circom reference
implementation or published test vectors (see Open questions).

## Where this could be used

- **Any client-side-proving wallet or dApp on a Circom/Groth16 stack** (not just Sui) making a
  build-vs-buy call on mobile support: this harness pattern (parameterize an existing desktop
  headless-Chromium benchmark with Playwright device descriptors + CDP CPU throttling, rather than
  standing up a real device lab) is a cheap first signal before investing in real-device CI.
- **A thesis chapter or design doc arguing for or against server-assisted proving** ("should a
  privacy wallet ever let a server see the witness for speed") needs exactly this shape of number as
  its opening argument — "2-2.3x slower on a throttled mid-tier-equivalent, without a real low-tier
  or real-hardware number yet" is a concrete, falsifiable place to start that argument instead of an
  assumption.
- **Confidential payroll or compliance-gated DeFi wallets** (the same class of app this repo's README
  points to) that expect a workforce to authorize disbursements from a phone, not a desktop — this is
  the number that decides whether "prove in the mobile app" is a real design or optimistic table talk.

## Open questions (next queue)

1. **Real mobile hardware.** This experiment is explicitly UNMEASURED for actual device numbers —
   CPU throttling a desktop x86_64 core is not the same silicon, thermal envelope, or WASM JIT as a
   real phone. A real-device run (BrowserStack/Sauce Labs, or a physical device over USB debugging)
   would need outbound network access this session's egress policy currently denies for every host I
   tried outside npm/GitHub-git/PyPI/crates.io. Next run: check whether a real-device provider is
   allowlisted before assuming it isn't.
2. **Why doesn't 4x throttle produce ~4x slowdown, and why does the smallest circuit (`withdraw`)
   regress proportionally the most (2.33x vs. 1.90–1.95x)?** Worth instrumenting
   `groth16.fullProve`'s internal phases (witness gen vs. proving) separately under throttling to see
   which phase is throttle-insensitive and by how much — that would turn "there's a fixed-overhead
   floor" from a plausible explanation into a measured one.
3. **A low-tier device profile** (Playwright ships slower devices like older Pixel/iPhone SE
   descriptors, and a higher throttle multiplier, e.g. 6-8x, better approximates a genuine budget
   Android phone) — same script, just different `--device`/`--cpu-throttle` values, another
   "spend an hour" night.
4. **On-chain gas (queue item #1), fourth attempt** — needs an environment-level change (egress
   allowlist for a Sui JSON-RPC host, or a vendored `sui` binary), not another in-session attempt.
   Flagging for whoever owns this environment's network policy, not something this loop can resolve
   itself.
5. **Poseidon2 (queue item #2)** — needs a circom-level reference implementation or published test
   vectors reachable from this environment to verify a from-scratch round-constant derivation against.
   Re-attempt once `github.com` API/release access is broadened past this one repo, or once a
   `circomlib`-compatible Poseidon2 template is published on npm.
