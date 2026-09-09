# 2026-09-09 — Poseidon2 vs Poseidon (queue item #2), on-chain gas retry (queue item #1)

## Hypothesis

Swapping Veil's circomlib-Poseidon hash calls for Poseidon2 (the widened-S-box, reduced-round
successor published by Grassi et al., using Horizen Labs' reference construction via
`@taceo/circom-lib`) reduces the R1CS constraint count of at least one of Veil's three circuits —
and, since Groth16 prover time is dominated by constraint count, that number is where Veil would
actually feel the win: less time spent proving `shielded_transfer` in a browser.

It does not. Measured, exactly: the swap makes **all three** circuits worse (+17.4% for
`transfer.circom`, +5.2% for `compliance.circom`, +93.0% for `withdraw.circom`), because Veil's
dominant hash calls use arities (4 and 5 inputs) that Poseidon2's optimized linear layer does not
support, forcing a padded, wider permutation that costs more than the S-box rounds it saves. The
one piece that *is* a real, isolated win — the depth-20 Merkle accumulator's hasher, swapped to
Poseidon2's purpose-built 2-to-1 compression mode — moves only -6.3%, nowhere near enough to
offset the rest.

This experiment also spent its first ~40 minutes on queue item #1 (on-chain gas per entry point,
top of `EXPERIMENTS.md` after two prior blocks) before falling back to item #2; see "On-chain gas
retry" below for what changed and what didn't.

## On-chain gas retry (queue item #1)

Two things were tried tonight that weren't available in the 2026-07-22 run:

- **Direct JSON-RPC to a public Sui testnet fullnode** (`fullnode.testnet.sui.io:443`, no CLI
  needed): denied by the network egress proxy — `CONNECT tunnel failed, response 403`. Same
  outcome as the "denied by the sandbox's tool-approval layer" block in the 2026-07-22 run, now
  confirmed to be a network-policy block rather than a one-off tool-approval issue: no route to
  `fullnode.testnet.sui.io` exists from this sandbox at all, on any port.
- **Building the `sui` CLI from source** (`git clone` access to `github.com` works over the git
  protocol even though plain HTTPS `GET`s to `github.com` return 403; `crates.io` is reachable but
  does not host the real `sui` crate — the name is squatted by an unrelated 2022 placeholder). A
  release binary was also unreachable (`github.com/MystenLabs/sui/releases` → 403, same as last
  time). So a from-source build was started tonight: `cargo build --release --bin sui -p sui`
  against a shallow, blobless clone of `MystenLabs/sui` (690 workspace crates — the `sui` binary
  alone pulls in most of the Move VM, RPC, and indexer dependency graph, not just a thin CLI). Kicked
  off in the background early in this session so it wouldn't block the rest of the run — it did not
  finish before I had to stop it: about 20 minutes in, with the build still deep in third-party
  dependency compilation (not yet at any `sui-*` crate), its CPU usage started measurably slowing
  down this experiment's own `snarkjs` zkey generation (`uptime` load average 6.5 on a 4-core box).
  With a hard choice between "let a secondary, already-twice-blocked goal keep running" and "get the
  primary experiment's proving-time numbers", I killed the build (`pkill cargo build`/`rustc`/
  rocksdb's C++ compile) and gave the freed CPU to the Poseidon2 experiment. That was a judgment
  call, not a forced outcome — a future run with nothing else competing for CPU, or one willing to
  spend the whole session on this alone, might get further.

Item #1 remains blocked by the same root cause as before (no network route to a fullnode, no
reachable prebuilt binary), plus a new data point: a from-source build is possible but slow enough,
and heavy enough on shared CPU, that it needs a session of its own rather than a warm-up to another
experiment. Re-ranked below with that update.

## Threat / privacy model

**Adversary considered:** none new. This experiment does not change what's deployed — the
Poseidon2 circuits (`circuits/experiments/poseidon2/`) are standalone measurement fixtures, not
wired into `contracts/`, `scripts/`, or `frontend/`. The relevant question is narrower: *if* this
swap were ever merged into the real circuits, what would change for a **chain observer** (sees
public inputs and events only) and a **malicious prover** (controls the witness)?

- **Chain observer.** No new leakage. Poseidon2Hash's sponge keeps Veil's existing domain-tag
  convention (the numeric tag — 1 for commitments, 2/7 for nullifiers, etc. — is still the first
  *data* element absorbed, exactly as circomlib's `Poseidon(nInputs)` does it today); nothing about
  which values are public vs. private changes, so I2/I6 in `docs/threat-model.md`
  (amounts hidden in commitments; nullifiers pseudorandom) are unaffected either way.
- **Malicious prover.** This is the one soundness-relevant question a hash swap actually raises,
  and it's exactly what the negative test in `test/merkle_proof2.test.mjs` checks for
  `MerkleProof2`: that the boundary constraint (`pathIndices[i] * (1 - pathIndices[i]) === 0`,
  copied verbatim from the original `MerkleProof`) still rejects an out-of-{0,1} path bit, and that
  the new hasher still *binds* — a different leaf on the same sibling path cannot produce the same
  root. Both hold (see Approach/Results). The commitment/nullifier hashes (`Poseidon2Hash`) have no
  separate constraint to break — they're pure function calls (`out <== ...`), so their only
  soundness property is "is this actually a one-way, collision-resistant function", which is
  Poseidon2's own security claim, not something introduced by wrapping it in a sponge; I did not
  invent a new sponge construction — the sponge parameters (rate, capacity index, absorb order)
  are `@taceo/circom-lib`'s own `Poseidon2Sponge`, cross-checked (see Approach) against its
  published JS counterpart rather than reimplemented from scratch.
- **What this does NOT defend against, and does not claim to.** This experiment says nothing about
  Poseidon2's cryptanalytic security margin vs. classic Poseidon (both are treated as sound;
  comparing their algebraic security is out of scope — the question tonight was cost, not
  strength) and nothing about `RR2` (single-contributor trusted setup) beyond the obvious fact
  that swapping the hash function would require an *entirely new* Groth16 ceremony and VK, on top
  of an already-not-production-safe one — one more reason this is not a change to make lightly
  even where it did win.

**Assumptions**, unchanged from `docs/threat-model.md`: Groth16 soundness under the BN254
discrete-log assumption; Poseidon2's permutation is assumed pseudorandom (same class of assumption
the existing Poseidon relies on, not a new one). Maps to `T3`/`T4` (VK-update timelock — relevant
*if* this were ever deployed, since any hash-function change forces a VK rotation) and `RR5`
(Merkle accumulator as the anonymity-set mechanism — the one part of this experiment that touches
RR5 directly, see Where this could be used).

## Approach

**What I built**, all under `circuits/experiments/poseidon2/` (not wired into the real proving
pipeline):

- `templates/poseidon2_hash.circom` — `Poseidon2Hash(nInputs)`, a drop-in replacement for
  circomlib's `Poseidon(nInputs)` (same `signal input inputs[n]` / `signal output out` interface),
  built on `@taceo/circom-lib`'s `Poseidon2Sponge(N, T)`. Picks the smallest Poseidon2-supported
  width `T ∈ {2,3,4,8,12,16}` that fits `nInputs` in one permutation's rate (`T-1`); Veil's own
  arities land at `T = 3, 4, 8, 8` for `n = 2, 3, 4, 5`. **There is no supported `T = 5` or `T = 6`**
  — Poseidon2's external linear layer (both Horizen Labs' reference and `@taceo/circom-lib`,
  independently) is only defined for `t ∈ {2, 3} ∪ {4k}`, because its optimized MDS-like matrix is
  built from a circulant block construction over groups of 4. Veil's two dominant hash calls
  (`Poseidon(4)` for commitments/transfer-nullifier, `Poseidon(5)` for the credential leaf) fall
  exactly in that gap and pay for a `T=8` permutation — 4 or 5 real inputs plus 2–3 wasted padding
  slots — instead of a tight `T=5`/`T=6` that doesn't exist as a published construction.
- `templates/merkle_proof2.circom` — `MerkleProof2(depth)`, structurally identical to the
  original `templates/merkle_proof.circom` (same `MultiMux1`-based sibling selection, same
  explicit boolean constraint on each path bit) but with the per-level hash replaced by
  `@taceo/circom-lib`'s own recommended pattern for this exact job (copied from that library's
  `binary_merkle_root.circom`): a raw `T=2` Poseidon2 permutation used in *compression* mode (no
  capacity element — both state slots are the two children) plus a Miyaguchi-Preneel feed-forward
  (`out = permutation(left, right)[0] + left`). This is not an arbitrary choice — see the header
  comment in that file for why the feed-forward is required for one-wayness (Poseidon2's
  permutation alone is a public bijection; without feed-forward, `out` would be invertible).
- `transfer2.circom`, `compliance2.circom`, `withdraw2.circom` — line-for-line copies of the
  production circuits with every `Poseidon(n)` swapped for `Poseidon2Hash(n)` and every
  `MerkleProof(20)` swapped for `MerkleProof2(20)`; nothing else changed (verified: I diffed the
  constraint graphs mentally against the originals while writing them, and the arithmetic
  cross-check in Results — whole-circuit deltas summing exactly to the per-instance micro-benchmark
  deltas — is an independent confirmation that no stray constraint was added or dropped elsewhere).
- `micro/{old,new}{2,3,4,5}.circom`, `micro/{old,new}merkle.circom` — isolated single-hash-call
  circuits (one `Poseidon(n)`/`Poseidon2Hash(n)` or one `MerkleProof`/`MerkleProof2(20)`, nothing
  else) for a clean per-instance constraint delta, independent of any specific circuit's shape.
- `scripts/bench/witnesses-poseidon2.mjs` + `scripts/bench/prove-latency-poseidon2.mjs` — a
  Poseidon2-side counterpart to the existing `witnesses.mjs`/`prove-latency.mjs`, for proving-time
  measurement on the three full experiment circuits, following the same benchmark methodology
  (mean of N `groth16.fullProve` runs, one discarded warm-up) as `BASELINE.md`.
- `test/merkle_proof2.test.mjs` — the negative/soundness test described above.

**Correctness cross-check (why the JS witness builder can be trusted).** `transfer2.circom`'s
public inputs (`oldCommitment`, `nullifier`, `merkleRoot`, ...) are all inputs, not
circuit-computed outputs — so proving requires a JS-side function that computes the *same*
Poseidon2 hash the circuit does, off-circuit, to fill them in correctly. I used
`@taceo/poseidon2` (npm, same publisher as `@taceo/circom-lib`, documented as "compatible with
[the] Horizen Labs parameter script") for this rather than reimplementing round constants by hand
— a mismatched constant table is exactly the kind of bug that fails *silently* here (a wrong
witness a circuit accepts is impossible by construction, but a wrong witness a circuit *rejects*
would look like a crash, not a wrong number, so I didn't skip verifying it). Cross-checked directly
before relying on it: compiled a bare `Poseidon2(2)` permutation circuit
(`micro/rawperm2.circom`), ran it on `[111, 222]` via the real wasm witness calculator, and
compared against `@taceo/poseidon2`'s `bn254.t2.permutation([111n, 222n])` in Node — bit-for-bit
identical output (see Results). Only after that check did I build the full witness-builder on top
of the JS package.

**What I rejected.**

- *Reimplementing Poseidon2 by hand in circom*, deriving my own round constants — rejected
  because getting a permutation's round constants and internal-matrix diagonal wrong is a silent
  security bug, not a compile error, and there was no way to independently verify a hand-rolled
  constant table tonight. Using a published, cross-checked library (see above) instead of a novel
  implementation is itself part of this experiment's soundness argument, not just a convenience.
- *Migrating the real production circuits in place* — rejected before writing a single number,
  because a hash-function change forces a brand new trusted-setup ceremony and VK for every
  affected circuit, which is a much bigger commitment than a one-night measurement justifies. This
  is also why the result matters less than it would for a circuit already close to a KEEP: even the
  Merkle-only partial win (see Results) isn't "free" to take.
- *A generic N-to-1 sponge for every arity, ignoring the t=2 compression option for Merkle* —
  rejected because it would understate Poseidon2's real advantage for the one place it actually
  has one; using the library's own purpose-built pattern for the Merkle case specifically is a
  fairer comparison, not a thumb on the scale (it's the *only* config where Poseidon2 won at all).
- *Downloading a public Powers of Tau file* (the URL `compile.sh` and the 2026-07-22 baseline both
  use, `storage.googleapis.com/zkevm/...`) — tried first, got the same class of block as the gas
  RPC attempt (`403` through the egress proxy; `googleapis.com` is not on the reachable list
  tonight). Fell back to generating a **local, dev-only, single-contributor Powers of Tau** from
  scratch (`snarkjs powersoftau new bn128 15` → `contribute` → `prepare phase2`) — exactly the same
  "not a production ceremony" caveat the repo's own `compile.sh`/`ceremony.sh` already carry for
  the *existing* circuits' setups, so this doesn't introduce a new class of caveat, just a second
  instance of an existing one, scoped to this experiment's own throwaway zkeys.

## Results

### R1CS constraint counts — full circuits (real `circom --r1cs` compiles; no witness needed for this)

| Circuit | Baseline (2026-07-22, unchanged) | Poseidon2 experiment | Δ constraints | Δ % |
|---|---:|---:|---:|---:|
| `transfer.circom` / `transfer2.circom` | 13,611 (6,470 NL / 7,141 L) | 15,979 (6,119 NL / 9,860 L) | **+2,368** | **+17.4%** |
| `compliance.circom` / `compliance2.circom` | 12,743 (6,057 NL / 6,686 L) | 13,405 (5,556 NL / 7,849 L) | **+662** | **+5.2%** |
| `withdraw.circom` / `withdraw2.circom` | 3,058 (1,465 NL / 1,593 L) | 5,902 (1,651 NL / 4,251 L) | **+2,844** | **+93.0%** |

Non-linear (S-box) constraints go *down* in every circuit — Poseidon2's fewer, wider rounds really
do cost less S-box work. But linear constraints go up by far more (the external/internal matrix
multiplications Poseidon2 needs per round, plus the padding overhead of forcing 4- and 5-input
hashes into a `T=8` permutation), so every circuit's *total* gets worse.

Raw commands and output:

```
$ /tmp/circom-src/target/release/circom transfer2.circom --r1cs -o build -l ../../node_modules
template instances: 40
non-linear constraints: 6119
linear constraints: 9860
public inputs: 7
private inputs: 47
public outputs: 0
wires: 16000
labels: 49204
Written successfully: build/transfer2.r1cs

$ npx snarkjs r1cs info build/transfer2.r1cs
[INFO]  snarkJS: # of Wires: 16000
[INFO]  snarkJS: # of Constraints: 15979
[INFO]  snarkJS: # of Private Inputs: 47
[INFO]  snarkJS: # of Public Inputs: 7

$ /tmp/circom-src/target/release/circom compliance2.circom --r1cs -o build -l ../../node_modules
non-linear constraints: 5556
linear constraints: 7849
public inputs: 6
private inputs: 45
wires: 13424

$ npx snarkjs r1cs info build/compliance2.r1cs
[INFO]  snarkJS: # of Constraints: 13405

$ /tmp/circom-src/target/release/circom withdraw2.circom --r1cs -o build -l ../../node_modules
non-linear constraints: 1651
linear constraints: 4251
public inputs: 5
private inputs: 5
wires: 5902

$ npx snarkjs r1cs info build/withdraw2.r1cs
[INFO]  snarkJS: # of Constraints: 5902
```

### R1CS constraint counts — isolated per-instance micro-benchmarks

One hash call per circuit, nothing else, compiled the same way:

| Hash call | circomlib `Poseidon` (its `t`) | Poseidon2 (its `t`) | Δ | Δ % |
|---|---:|---:|---:|---:|
| 2-input (`Poseidon(2)`, t=3) | 517 (243 NL / 274 L) | 580 (240 NL / 340 L), t=3 | +63 | +12.2% |
| 3-input (`Poseidon(3)`, t=4) | 605 (264 NL / 341 L) | 852 (264 NL / 588 L), t=4 | +247 | +40.8% |
| 4-input (`Poseidon(4)`, t=5 — **no Poseidon2 t=5**) | 736 (300 NL / 436 L) | 1,663 (363 NL / 1,300 L), padded to t=8 | **+927** | **+126.0%** |
| 5-input (`Poseidon(5)`, t=6 — **no Poseidon2 t=6**) | 835 (324 NL / 511 L) | 1,663 (363 NL / 1,300 L), padded to t=8 | **+828** | **+99.2%** |
| Depth-20 Merkle path (20× `Poseidon(2)` sponge) | 10,400 (4,920 NL / 5,480 L) | 9,740 (4,380 NL / 5,360 L), 20× t=2 compression | **-660** | **-6.3%** |

Raw output (one representative pair shown; all ten circuits compiled identically):

```
$ circom old4.circom --r1cs -o build -l ../../../node_modules   # Poseidon(4), t=5
non-linear constraints: 300
linear constraints: 436

$ circom new4.circom --r1cs -o build -l ../../../node_modules   # Poseidon2Hash(4), padded t=8
non-linear constraints: 363
linear constraints: 1300

$ circom oldmerkle.circom --r1cs -o build -l ../../../node_modules   # MerkleProof(20)
non-linear constraints: 4920
linear constraints: 5480

$ circom newmerkle.circom --r1cs -o build -l ../../../node_modules   # MerkleProof2(20)
non-linear constraints: 4380
linear constraints: 5360
```

**Cross-check — the micro-benchmarks fully explain the whole-circuit deltas**, constraint for
constraint (strong evidence neither set of numbers has a measurement error hiding in it):

- `transfer2`: 1×Merkle(-660) + 2×Poseidon(4)(+927 each, `oldHash`/`newHash`) + 1×Poseidon(4)(+927,
  `nfHash`) + 1×Poseidon(3)(+247, `txHash`) = **+2,368** — matches the whole-circuit delta exactly.
- `compliance2`: 1×Merkle(-660) + 1×Poseidon(5)(+828, `leafHash`) + 2×Poseidon(3)(+247 each,
  `nfHash`/`ctxHash`) = **+662** — exact match.
- `withdraw2`: 3×Poseidon(4)(+927 each, `commHash`/`changeHash`/`nfHash`) + 1×Poseidon(2)(+63,
  `recipHash`), no Merkle proof in this circuit = **+2,844** — exact match.

### Poseidon2 permutation cross-check (JS witness-builder correctness)

```
$ node micro/verify-perm.mjs   # circom wasm witness vs @taceo/poseidon2 bn254.t2.permutation
circom out[0]: 17586962640166440105434062941744091348166207598647280186160510314114679108999
circom out[1]: 5773269556866071876605074733351600547540170800771405714697588743059715088491
js     out[0]: 17586962640166440105434062941744091348166207598647280186160510314114679108999
js     out[1]: 5773269556866071876605074733351600547540170800771405714697588743059715088491
MATCH: true
```

### Negative/soundness test — `MerkleProof2`

```
$ node --experimental-vm-modules circuits/experiments/poseidon2/test/merkle_proof2.test.mjs
[PASS] binding: leaf 12345 -> root 2176825364602598384764925128164591455691161811089822840584570758616599467526,
                leaf 67890 -> root 17105435690238782471240915480506611491260824602514886348695905764864118912605 (distinct)
[PASS] determinism: repeated witness calculation is stable
ERROR:  4 Error in template MerkleProof2_11 line: 35
[PASS] malicious witness: non-boolean pathIndices[0] = 2 is rejected at witness generation

3/3 checks passed.
```

(The `ERROR:` line is circom's own witness-calculator diagnostic for the deliberately-invalid
witness — expected, and the test asserts it was thrown, not that it's absent.)

### Proving time (Node, mean of N `groth16.fullProve` runs) — attempted, not completed

`scripts/bench/prove-latency-poseidon2.mjs` and its zkey-generation prerequisites (`snarkjs groth16
setup` → `zkey contribute` → `zkey export verificationkey`, per circuit) were built and started
tonight, but the `groth16 setup` step for `transfer2` alone (15,979 constraints) was still running
after 14+ minutes of continuous 99% CPU when this report was finalized — far slower than the
2026-07-22 baseline's equivalent step for the original `transfer.circom` (13,611 constraints), which
this session did not independently re-time but which did not block that report. Root cause not
isolated (candidates: this session's CPU is simply slower for `snarkjs`'s pure-JS/WASM curve
arithmetic than 2026-07-22's; the local from-scratch Powers of Tau behaves differently from the
downloaded one snarkjs is more commonly benchmarked against; residual contention from the `sui`
build's C++ (rocksdb) child processes, which `pkill`'s process-name matching may not have fully
caught). Rather than let a secondary, confirmatory measurement consume the rest of the session
budget the way the on-chain-gas retry already had, this was cut off in favor of finishing and
writing up the primary, already-solid result. No proving-time number is reported here as a
consequence — **not measured, not estimated, left honestly blank** — but the verdict below does not
depend on it: Groth16 prover cost is dominated by the multi-scalar-multiplication over the R1CS
constraint set, so a circuit measured with 17–93% more *constraints*, on the same curve, same
proof system, same machine, is not a circuit that could plausibly turn out faster to prove. The
constraint-count results above are the load-bearing measurement; this section exists to record
that a direct proving-time confirmation was attempted, not to leave the gap silent.

Rerunning this specific measurement — with nothing else competing for CPU, ideally on a machine
where a from-source `snarkjs`/`circom` toolchain has already been shown to set up zkeys quickly —
is queue item open question #5 below.

## Verdict: **REJECT** (full swap) / **PARK** (Merkle-only partial swap)

Poseidon2, via the only published implementations reachable tonight, makes every one of Veil's
three circuits *more* expensive to prove, not less — by 5% to 93% more constraints, dominated
entirely by the fact that Veil's own commitment/nullifier hashing arities (4 and 5 inputs) fall in
a gap Poseidon2's standard construction doesn't cover. That's the opposite of the hypothesis, and
it's not a close call for `withdraw.circom` (+93%) or `transfer.circom` (+17.4%) — those two are
unambiguous. `compliance.circom` at +5.2% is the closest, and still a clear loss.

The one real, isolated win — the depth-20 Merkle accumulator hasher specifically, at -6.3% for
that component alone — is genuine and reproducible, but it is a small slice of any circuit that
uses it (`transfer.circom`, `compliance.circom`; `withdraw.circom` has no Merkle proof at all and
gets zero benefit from this half of the swap). Applying *only* that piece (leave the
identity-binding commitment/nullifier hashes on classic Poseidon, swap only the Merkle hasher) is
arithmetically a real win — `transfer.circom` at 13,611 - 660 = 12,951 (-4.85%),
`compliance.circom` at 12,743 - 660 = 12,083 (-5.18%) — computed directly from the measured,
cross-validated micro-benchmark delta above, not compiled as its own whole-circuit variant tonight
(ran out of session budget for a fourth and fifth full-circuit compile; the arithmetic is exact
given how precisely the other three whole-circuit deltas matched their component sums). That's
**PARK**, not KEEP: it's promising enough to be worth a dedicated night, but it needs (a) an actual
compiled `transfer3.circom`/`compliance3.circom` confirming the arithmetic holds for real, not just
in projection, (b) a decision about whether mixing two hash families inside one circuit (classic
Poseidon for commitments, Poseidon2 for the accumulator) is an acceptable complexity/audit-surface
trade for a ~5% constraint reduction, and (c) — most importantly — it still requires a full new
trusted-setup ceremony and VK for any circuit it touches, which this one-night experiment
deliberately did not attempt to cost out.

`BASELINE.md` is **not** updated — nothing about the deployed circuits changed.

## Where this could be used

- **Any Circom/Groth16 protocol choosing a hash function for a fixed-arity, non-power-of-4
  identity/commitment scheme** (UTXO-style commitments bound to `k` fields where `k ∉ {2,3,4,8,...}`)
  should check Poseidon2's supported widths *before* assuming it's a free upgrade — this experiment
  is a concrete, measured counterexample to "Poseidon2 is strictly better," which is easy to assume
  from its marketing (fewer rounds) without checking the arity-coverage gap.
- **A thesis chapter or survey comparing Poseidon vs. Poseidon2 for ZK identity/commitment
  schemes** gets a real data point here: the win is real but arity-dependent, and the paper's own
  headline efficiency numbers (usually quoted for `t=3` Merkle-tree hashing) don't transfer to
  wider-arity identity binding without re-measuring.
- **Any protocol using a depth-`d` Merkle accumulator with Poseidon** (this repo's own item #4,
  "Merkle accumulator at scale") has a clean, low-risk, isolated win available here — swap only the
  tree hasher to Poseidon2 compression mode, leave everything else alone. That's the PARK item to
  pick up.
- **Confidential payroll or compliance-gated DeFi on Sui** (the recurring use case from the
  2026-07-22 report): the same 4-/5-input identity-binding pattern (secret + several attribute
  fields, hashed together) is exactly the shape that doesn't benefit from Poseidon2 today — worth
  flagging before anyone designs a t-of-n auditor board's credential leaf hash around it.

## Open questions (next queue)

1. **Confirm the Merkle-only PARK numbers with a real compile** (`transfer3.circom`,
   `compliance3.circom`: classic `Poseidon(4)`/`Poseidon(5)` for identity hashes, `MerkleProof2`
   for the accumulator only) rather than relying on the arithmetic projection above. Cheap — same
   toolchain, same templates, already built tonight.
2. **On-chain gas per entry point** — still the top of the queue. Network access to a public
   fullnode is confirmed blocked at the proxy level (not a one-off tool-approval denial), and a
   from-source `sui` CLI build was started tonight but deliberately stopped partway through (it was
   competing for CPU with this experiment's own zkey generation; see "On-chain gas retry" above).
   Budget a full session specifically for the from-source build, uninterrupted by another
   experiment, given how deep the workspace dependency graph turned out to be.
3. Does a **hand-tuned `T=5`/`T=6` Poseidon2 parameter set** (deriving fresh round constants and an
   internal matrix for the non-standard widths Veil actually needs, rather than padding to `T=8`)
   close the gap? This wasn't attempted tonight — deriving Poseidon2 round constants safely needs
   the reference Sage/Python generation script run with the right security-margin parameters, not
   a hand-rolled guess, and independent verification before trusting the output in a circuit.
   Possible, but a multi-night cryptographic-parameter-generation effort, not a quick follow-up.
4. Poseidon2's linear-constraint growth (the actual cause of every regression here) comes from the
   external/internal matrix multiplications circom can't fold away the way it apparently can for
   circomlib's classic Poseidon MDS matrix. Worth understanding *why* circom's constraint optimizer
   handles one better than the other — if it's an optimizer gap rather than an inherent cost, a
   circom compiler improvement (or restructuring `ExternalMatMulT`/`InternalMatMulT`) could recover
   some of this for free, independent of which Poseidon variant is used.
5. **Re-run the proving-time benchmark** (`scripts/bench/prove-latency-poseidon2.mjs`,
   already built tonight) on a session with nothing else competing for CPU. Tonight's `snarkjs
   groth16 setup` for `transfer2` alone didn't finish in 14+ minutes of continuous 99% CPU, which is
   itself worth understanding — whether that's this session's hardware, the from-scratch local
   Powers of Tau behaving differently from a downloaded one, or leftover contention this report
   couldn't fully rule out (see Results) — before trusting any future proving-time number measured
   the same way, including a re-check of `BASELINE.md`'s own original ~750ms Node proving-time
   figures on this same machine, which this session did not re-verify.
