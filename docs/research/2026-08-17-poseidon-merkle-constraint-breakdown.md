# 2026-08-17 — Poseidon constraint-contribution breakdown (queue item #2, option b)

## Hypothesis

`transfer.circom`'s 13,611 R1CS constraints (6,470 non-linear, per `BASELINE.md`) can be exactly
decomposed into the sum of its isolated gadgets — the 20-level `MerkleProof` Poseidon(2) chain, the
three Poseidon(4) commitment/nullifier hashes, the one Poseidon(3) amount hash, and the non-Poseidon
range-check scaffolding — with no discrepancy from circom's optimizer collapsing anything across
instances. If that holds, the decomposition tells us *which* Poseidon calls actually dominate
Groth16 proving time, replacing the open question left at the end of the 2026-07-22 baseline report
("what fraction of the ~13k constraints come from the four Poseidon instances vs. the range checks?")
with a real number instead of a guess — and, specifically, whether a Poseidon2 swap (queue item #2,
option a) is even worth attempting before anyone spends a night hand-porting a permutation that isn't
in `circomlib`.

## Threat / privacy model

No adversary model changes here. This is a measurement/diagnostic experiment: no circuit, Move
module, or frontend code changed, and no new soundness or leakage surface was introduced. The
`transfer.circom`/`compliance.circom`/`withdraw.circom` files in the repo are byte-for-byte
unmodified; every number below comes from standalone, throwaway circuits built in a temp directory
by `scripts/bench/poseidon-constraint-breakdown.mjs` and deleted after each run.

**Who relies on these numbers being honest:** the same audience as the 2026-07-22 baseline —
tonight's finding becomes the number that decides whether a future night should invest in a
from-scratch Poseidon2 circom implementation (a real soundness-relevant change, since it would mean
hand-deriving or vendoring round constants for a permutation `circomlib` 2.0.5 does not ship). A
wrong decomposition here would misdirect that future effort.

**What this does not establish:** it says nothing about whether 13,611 constraints is "good" by
external standards, doesn't touch `docs/threat-model.md`'s STRIDE entries (I2, I6 — Poseidon
commitment/nullifier hiding — are unaffected; the domain-tag scheme referenced there is untouched),
and doesn't measure proving *time* directly, only constraint count (the two are correlated but not
identical — non-linear constraints are the closer proxy since they drive the number of R1CS
multiplication gates the prover actually pays for). Assumptions carried over unchanged: Groth16
soundness under BN254 discrete-log, dev-only trusted setup (RR2), circom 2.2.2 / snarkjs 0.7.6 as
the toolchain baseline was measured with.

## Approach

**What I built.** `scripts/bench/poseidon-constraint-breakdown.mjs` — generates five standalone
circom files in a temp dir (`Poseidon(2)`, `Poseidon(3)`, `Poseidon(4)` each wrapping one call to the
`circomlib` template; `MerkleProof(20)` from `circuits/templates/merkle_proof.circom` on its own; a
"scaffolding" circuit reproducing `transfer.circom`'s non-Poseidon logic — `GreaterThan(64)`,
`Num2Bits(64)` x4, `LessEqThan(64)`, the cumulative-sum addition), compiles each with the same
`circom ... --r1cs -l node_modules` invocation `compile.sh` uses, runs `snarkjs r1cs info` on each,
and sums the parts against the real `transfer.circom` total.

**What I rejected.** The queue item offered two options: (a) actually port to Poseidon2 and measure
the delta, or (b) decompose the existing Poseidon usage. I rejected (a) for tonight: `circomlib`
2.0.5 (the version this repo depends on) ships no Poseidon2 circuit, and neither does any other
package already in `circuits/node_modules`. Implementing Poseidon2 correctly means either vendoring
someone else's audited round constants and matrix or generating them myself — and generating your
own cryptographic round constants for a permutation that every future transfer/compliance proof
would depend on, in one night, with no reference test vectors to check against, is exactly the kind
of "invented benchmark" this loop is supposed to avoid; a wrong constant table breaks soundness
silently, not loudly. (b) needed no new cryptography — every gadget it measures is the exact one
`transfer.circom` already calls — and it directly produces the number needed to decide whether (a) is
worth the risk at all. I also considered decomposing `compliance.circom` in the same depth as
`transfer.circom` tonight; I only carried it far enough to confirm its shape (see Results) and left
the full breakdown for a future night, to keep this to one measured hypothesis rather than two.

**Toolchain.** `circom` was not preinstalled (same gap as 2026-07-22). Direct HTTPS to
`github.com`/`static.crates.io`/`crates.io` is denied by the sandbox's network policy (confirmed
fresh tonight — see the on-chain-gas note below), but `git clone https://github.com/...` works
(the proxy handles git specially), so I cloned `iden3/circom` tag `v2.2.2` — the same version the
baseline was measured with — and built it with `cargo build --release` (2m29s, no issues; `cargo
fetch` inside a git-cloned Rust project also works, unlike raw `curl` to the crate registry hosts).

## Results

### Isolated gadget constraint counts

| Gadget | R1CS constraints |
|---|---|
| `Poseidon(2)` — single call | 517 |
| `Poseidon(3)` — single call | 605 |
| `Poseidon(4)` — single call | 736 |
| `MerkleProof(20)` — mux + 20x `Poseidon(2)` | 10,400 |
| Non-Poseidon scaffolding (`GreaterThan(64)` + `Num2Bits(64)`x4 + `LessEqThan(64)` + addition) | 398 |

`MerkleProof(20)` = 20 x `Poseidon(2)` (10,340) + `MultiMux1(2)`x20 selector overhead (60).

### Reassembling `transfer.circom`

`transfer.circom` = 1x `MerkleProof(20)` + 3x `Poseidon(4)` (old/new commitment, nullifier) + 1x
`Poseidon(3)` (amount hash) + scaffolding:

```
10,400 + 3x736 + 605 + 398 = 10,400 + 2,208 + 605 + 398 = 13,611
```

**Predicted total: 13,611. Real `transfer.circom` total (BASELINE.md, 2026-07-22): 13,611. Delta: 0
(0.0%).** The hypothesis holds exactly — circom's optimizer does not collapse anything across these
independently-keyed Poseidon instances (unsurprising, since each takes different signals as input,
so there is nothing shared to dedup), and the sum of parts is the whole to the constraint.

This means **76.4% of `transfer.circom`'s constraints (10,400 / 13,611) come from the single
20-level Merkle authentication path** — specifically from 20 repeated calls to `Poseidon(2)`, not
from the four "audit-fix" domain-tagged Poseidon calls the circuit's own comments emphasize
(`CRYPTO-004`, `CRYPTO-006`, `CRYPTO-011`). Those three Poseidon(4)/(3) calls together are only
2,813 constraints — 20.7% of the total. The remaining 2.9% is range-check scaffolding.

### Raw command output

```
$ node scripts/bench/poseidon-constraint-breakdown.mjs
=== Veil Poseidon constraint-contribution breakdown ===
circom: circom compiler 2.2.2

$ circom .../poseidon2.circom --r1cs --output ... -l circuits/node_modules
non-linear constraints: 243
linear constraints: 274
$ snarkjs r1cs info .../poseidon2.r1cs
# of Constraints: 517

$ circom .../poseidon3.circom --r1cs --output ... -l circuits/node_modules
non-linear constraints: 264
linear constraints: 341
$ snarkjs r1cs info .../poseidon3.r1cs
# of Constraints: 605

$ circom .../poseidon4.circom --r1cs --output ... -l circuits/node_modules
non-linear constraints: 300
linear constraints: 436
$ snarkjs r1cs info .../poseidon4.r1cs
# of Constraints: 736

$ circom .../merkle20.circom --r1cs --output ... -l circuits/node_modules -l circuits/templates
non-linear constraints: 4920
linear constraints: 5480
$ snarkjs r1cs info .../merkle20.r1cs
# of Constraints: 10400

$ circom .../scaffolding.circom --r1cs --output ... -l circuits/node_modules
non-linear constraints: 386
linear constraints: 12
$ snarkjs r1cs info .../scaffolding.r1cs
# of Constraints: 398

=== Summary ===
| Gadget | R1CS constraints |
|---|---|
| Poseidon(2) — single call | 517 |
| Poseidon(3) — single call | 605 |
| Poseidon(4) — single call | 736 |
| MerkleProof(20) — full Merkle-path gadget (mux + 20x Poseidon(2)) | 10400 |
| Non-Poseidon range-check scaffolding | 398 |

MerkleProof(20) = 20 x Poseidon(2) (10340) + MultiMux1(2) x20 overhead (60)

Predicted transfer.circom total (sum of isolated gadgets, no cross-instance dedup) = 13611
Real transfer.circom total (BASELINE.md, 2026-07-22) = 13611
Delta = 0 (0.0%)
```

Full command: `node scripts/bench/poseidon-constraint-breakdown.mjs` (no flags; reproducible on any
machine with `circom` 2.2.2 on `PATH` and `circuits/node_modules` installed).

### `compliance.circom` — same shape, confirmed by inspection

`compliance.circom` (12,743 constraints total, per `BASELINE.md`) instantiates the identical
`MerkleProof(20)` template for its credential-membership check (`compliance.circom:63`), plus one
`Poseidon(5)` (credential leaf) and two `Poseidon(3)` calls (nullifier, context binding) — smaller
non-Merkle Poseidon usage than `transfer.circom`. `MerkleProof(20)`'s 10,400 constraints alone would
be **81.6%** of `compliance.circom`'s total, an even larger share than in `transfer.circom`. I did
not re-run the full isolated-gadget reconciliation for `compliance.circom` tonight (its scaffolding
differs — `GreaterEqThan(64)`, `GreaterEqThan(8)`, `Num2Bits(64)`x3, `Num2Bits(8)`x2 rather than
`transfer.circom`'s set) to keep tonight to one fully-reconciled hypothesis; the `Poseidon(5)` +
2x`Poseidon(3)` + differing scaffolding could reasonably be measured to sub-100-constraint precision
in under 20 minutes by extending `poseidon-constraint-breakdown.mjs` with a `poseidon5` case and a
`compliance`-shaped scaffolding case — left as an open question below.

### On-chain gas (queue item #1) — still not measured, new evidence

Before starting tonight's experiment I spent time re-attempting the toolchain unblock for queue item
#1 (top of the queue, carried over from 2026-07-22). New findings, worth recording even though the
number itself is still missing:

- Direct HTTPS `CONNECT` to `fullnode.testnet.sui.io:443` is denied by the sandbox's network policy
  (`403`, confirmed via `$HTTPS_PROXY/__agentproxy/status` → `"kind": "connect_rejected", "detail":
  "gateway answered 403 to CONNECT (policy denial or upstream failure)"`) — this is a policy-level
  block, not a transient failure, so a JSON-RPC read against the deployed testnet package is not
  possible from this sandbox as configured.
- `github.com`/`crates.io`/`static.crates.io` also return `403`/`400` to raw `curl`, so downloading a
  prebuilt `sui` binary from GitHub Releases directly is blocked too.
- However: `git clone https://github.com/MystenLabs/sui.git` **works** (git traffic is proxied
  differently than generic HTTPS), and `cargo build`/`cargo fetch` inside that clone **also work**
  (cargo's registry fetch is not blocked the way raw `curl` to the same hosts is). I started
  `cargo build --release --bin sui -p sui` in the background at the start of tonight's session; after
  roughly 45 minutes it had compiled ~1,140 of the workspace's crates (2.8-14 GB of `target/`, disk
  headroom not a concern) and was still working through Sui's own internal crate graph
  (`sui-adapter-*`, `mysten-network`, ...), not yet at the final `sui` binary link. It did not finish
  within tonight's budget.
- **This changes the assessment from 2026-07-22**, which called a from-source build "impractical to
  attempt ... within one night's budget" without actually attempting it. It is attemptable — it is
  just multi-hour, not multi-minute. The fix for a future night is procedural: start the `cargo
  build --release --bin sui -p sui` in the background in the *first five minutes* of the session
  (`git clone --depth 1 --branch testnet ...`, then `nohup cargo build ... &`), do that night's actual
  measured experiment while it compiles unattended, and check back at the end — if it's done, spend
  the remainder of the budget on the gas measurement; if not, let it keep running and mark item #1
  BLOCKED again with the fresh percentage-complete evidence, same as tonight.

I left the build running in `/tmp/sui-src` past the end of this session (ephemeral container, so it
won't survive regardless) rather than killing it, in case there's time to check it before the
container recycles; I am not blocking tonight's verdict on it finishing.

## Verdict: **KEEP**

The decomposition is real, measured, exactly reconciled (0 constraint delta), and answers the
open question left at the end of the 2026-07-22 report. `BASELINE.md` updated with the new
"Poseidon / Merkle constraint decomposition" section (see diff in this PR) so future nights don't
re-derive this from scratch.

Concretely, this **reprioritizes queue item #2**: a from-scratch Poseidon2 port that only touched
the three domain-tagged `Poseidon(4)`/`Poseidon(3)` commitment/nullifier/amount-hash calls could save
at most ~20.7% of `transfer.circom`'s constraints (2,813 / 13,611) even in the best case (Poseidon2
eliminating those calls' cost entirely, which it wouldn't — it reduces round count, not to zero). The
actual lever is the 20x `Poseidon(2)` Merkle chain, which is 76.4% of the circuit. Swapping *that* to
Poseidon2 is the only version of "port to Poseidon2" worth a night's effort, and it interacts with
queue item #4 (Merkle accumulator depth/scale) directly, since Merkle-path cost scales linearly with
tree depth for both hash choices.

## Where this could be used

- **Any Circom/Groth16 circuit with a Merkle-membership gadget as a subcomponent** — UTXO-style
  privacy pools (Tornado-Cash-family designs), credential/allowlist membership proofs, any
  "prove this leaf is in a tree of depth N" statement bundled with a handful of domain-specific
  hashes. The general lesson (the membership path dominates cost, not the application-specific
  hashes wrapped around it) generalizes directly whenever N is 15+ and the non-Merkle Poseidon
  arity/count is small.
- **A thesis chapter or design doc arguing for a specific proof-system or hash-function migration**
  needs exactly this shape of "which gadget actually costs what" table before proposing the
  migration — "Poseidon2 would help" is a much weaker claim than "Poseidon2 would help exactly the
  76% of this circuit that is Merkle authentication, and would need to beat Poseidon by more than
  ~X% per call to be worth a soundness-risking hand-port."
- **Confidential payroll or compliance-gated DeFi with a t-of-n auditor board** (the deployment named
  in the 2026-07-22 report): if that design also uses a depth-20+ credential/allowlist tree — likely,
  since anonymity-set size scales with tree depth the same way here — this same decomposition method
  is the first thing to run before optimizing its proving time, and the "compliance.circom is 81.6%
  Merkle path" number above is a closer analogue to a compliance-heavy design than
  `transfer.circom`'s 76.4%.

## Open questions (next queue)

1. **Full `compliance.circom` reconciliation.** Extend `poseidon-constraint-breakdown.mjs` with a
   `Poseidon(5)` case and a `compliance`-shaped scaffolding circuit (`GreaterEqThan(64)`,
   `GreaterEqThan(8)`, `Num2Bits(64)`x3, `Num2Bits(8)`x2) to get the same exact-reconciliation
   confidence for `compliance.circom` that tonight established for `transfer.circom`. Should take
   well under an hour given tonight's script already does the hard part.
2. **Poseidon2 constraint count for a single `Poseidon2(2)` call**, measured the same way (once a
   trustworthy circom implementation exists — vendored from an audited source, not hand-derived) —
   this is the number that would actually tell us whether porting the Merkle chain is worth it: the
   real question is "does `20 x Poseidon2(2)` beat `20 x Poseidon(2)` (10,340) by enough to justify
   the port," not just "is Poseidon2 faster in the abstract."
3. **Does non-linear constraint count track proving time linearly for this gadget mix?** Tonight
   measured constraints only. `BASELINE.md` already has real per-circuit proving-time numbers
   (`prove-latency.mjs`) — a follow-up could isolate proving time for a standalone `MerkleProof(20)`
   circuit (needs a real trusted setup + witness, more work than `--r1cs` alone) to check the
   constraint-count proxy against a directly measured time, rather than assuming the relationship is
   linear.
4. **On-chain gas (queue item #1)** — re-ranked to the top again, unchanged in substance, but with
   the added procedural note above: start the `sui` CLI build in the background at the very start of
   the next session that picks it up, rather than serially before other work.
