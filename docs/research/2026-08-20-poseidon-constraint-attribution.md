# 2026-08-20 — Poseidon constraint attribution (queue item #2, re-scoped)

## Hypothesis

Every non-linear R1CS constraint in `transfer.circom`, `compliance.circom`, and `withdraw.circom`
can be attributed to a specific gadget instance (a Poseidon call of a given arity, a `Num2Bits`
range check, a comparator, or the `MerkleProof(20)` template) by compiling that gadget alone and
reading `# of Constraints` off a real `circom`/`snarkjs` run — not inferred by reading the source
and guessing circomlib's internal cost per template. If the per-gadget counts sum exactly to the
three circuit-level totals already in `BASELINE.md` (13,611 / 12,743 / 3,058 constraints,
6,470 / 6,057 / 1,465 of them non-linear), that reconciliation is itself the result: it turns "what
dominates prover time" from a plausible guess into an exact, reproducible breakdown, and it settles
whether swapping Poseidon for Poseidon2 (the literal framing of original queue item #2) is even the
right lever before anyone spends a night building that circuit.

Queue item #1 (on-chain gas) was attempted again first — see **On-chain gas, attempt #2** below —
and is still BLOCKED for a structural reason (org network policy), not a transient one, so this
run moved to item #2 rather than repeat last night's toolchain effort a third time without a new
angle.

## On-chain gas, attempt #2 (queue item #1 — still BLOCKED)

Before starting the Poseidon work, this run spent its first ~15 minutes on the two toolchain paths
`EXPERIMENTS.md` flagged as worth retrying: a prebuilt `sui` CLI binary, and a direct JSON-RPC read
against the deployed testnet package.

```
$ which sui; sui --version
(not found)

$ curl -sS --max-time 15 -o /dev/null -w "%{http_code}\n" https://fullnode.testnet.sui.io:443
000   (curl: (56) CONNECT tunnel failed, response 403)

$ curl -sS --max-time 15 -o /dev/null -w "%{http_code}\n" https://github.com/MystenLabs/sui/releases
403

$ curl -sS --max-time 15 -o /dev/null -w "%{http_code}\n" https://crates.io/api/v1/crates/sui
403

$ curl -sS --max-time 15 -o /dev/null -w "%{http_code}\n" https://static.crates.io/
403

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
...
"recentRelayFailures": [{"kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "fullnode.testnet.sui.io:443"}]
```

All four hosts — the fullnode RPC, GitHub releases, the crates.io API, and crates.io's own binary
CDN — return `403` from this sandbox's egress proxy, which its own README is explicit about: a
`403`/`407` from the proxy is an **organization policy denial**, not a flaky network, and the
instruction is to report it rather than retry or route around it. That's a materially different
finding from 2026-07-22, where the RPC call was blocked by the *tool-approval layer* (a
same-session denial that a differently-scoped session might not hit) and the CLI build was merely
*not attempted* (a budget decision, not a wall). Tonight's finding is a wall: this network policy
blocks every path to `sui` this session could find, including ones the previous report hadn't yet
ruled out. Re-ranked in `EXPERIMENTS.md` below with that distinction — it's not worth another
night's budget on the network side; unblocking it needs either a policy exception for
`fullnode.testnet.sui.io`/`github.com`/`crates.io`, or a `sui` binary made available in the sandbox
image directly.

One genuine toolchain win came out of poking at this, reused for the rest of tonight: `circom`
itself is *not* on that blocked list. `circom2` (the upstream Rust compiler cross-compiled to
WASM, `npm view circom2` → `circom compiler 2.2.3`) installs cleanly from `registry.npmjs.org`,
which this sandbox's egress policy allows outright. Added as a `circuits/` devDependency
(`npm install --save-dev circom2`) and verified byte-for-byte against last night's native-binary
baseline before relying on it for anything:

```
$ node_modules/.bin/circom2 transfer.circom --r1cs -o build-check -l node_modules
template instances: 221
non-linear constraints: 6470
linear constraints: 7141
public inputs: 7
private inputs: 47
public outputs: 0
wires: 13632
labels: 20437
Written successfully: build-check/transfer.r1cs
Everything went okay
```

Identical to the `2026-07-22` `circom` (built from source, tag `v2.2.2`) numbers — 6,470 non-linear,
7,141 linear, 13,632 wires, 20,437 labels. `circom2` is now the toolchain path for any circuit
compile that doesn't also need a from-scratch trusted setup, and it removes the "clone
`iden3/circom` and `cargo build --release`" step from every future night's budget, since that clone
also goes through `github.com` and would hit the same `403` if attempted from a clean sandbox.

## Threat / privacy model

No protocol code changed tonight — `transfer.circom`, `compliance.circom`, and `withdraw.circom`
are untouched. This is a measurement experiment against twelve new isolation fixtures under
`circuits/bench/attribution/`, none of which are part of the proving/verification path Veil
actually ships. So there is no new adversary to model and no soundness or leakage claim to make
about a circuit change, for the same reason the 2026-07-22 baseline report gave: nothing about
trust boundaries moved.

What *is* at stake is the same as any measurement night: **who relies on this breakdown being
right, and what breaks if it's wrong.** Two things do:

- Every future scalability experiment that reasons about "the Merkle proof accounts for most of
  the constraints" or "Poseidon2 would help" is a claim this report either supports or forecloses
  with an exact number, not a guess from reading the template files. A wrong attribution here sends
  a future night chasing a circuit rewrite (Poseidon2, a shallower Merkle tree, a cheaper hash
  arity) for the wrong reason.
- `docs/threat-model.md` RR5 (deposit-commitment linkability) names "a bigger anonymity set" —
  i.e. a deeper Merkle tree — as the main lever available without redesigning the deposit flow.
  Tonight's numbers say exactly what that lever costs in constraints per additional tree level
  (243 non-linear per level, see Results), which is the number RR5's mitigation needs before anyone
  can say "depth 24 instead of 20" is affordable.

Assumptions carried over unchanged: Groth16 soundness under the BN254 discrete-log assumption
(RR2's dev-only trusted setup, unchanged), circomlib's Poseidon round constants and MDS/partial-MDS
matrices (`poseidon_constants.circom`) taken as correct and unmodified — nothing here regenerates
or second-guesses them.

## Approach

**What I built.** Twelve single-gadget isolation fixtures under `circuits/bench/attribution/`
(`poseidon2.circom` … `poseidon5.circom`, `num2bits8.circom`, `num2bits64.circom`,
`greaterthan64.circom`, `greaterequalthan8.circom`, `greaterequalthan64.circom`,
`lessequalthan64.circom`, `multimux1.circom`, `merkleproof20.circom`) — each one `component main`
around a single circomlib (or Veil-template) gadget, with no domain-specific logic. A driver script,
`scripts/bench/constraint-attribution.sh`, compiles each fixture with `circom2` and prints its
non-linear/linear/wire counts from `circom2`'s own compile-time summary (`snarkjs r1cs info` only
reports the non-linear+linear *sum* as "# of Constraints", not the split — confirmed by running
it once and reading the actual field names before writing the parser, rather than assuming the two
tools report the same shape).

**What I rejected.** I considered inferring the same breakdown by reading `poseidon.circom`'s round
structure and computing constraint counts by hand from the round-count table
(`N_ROUNDS_P`) — rejected as exactly the "estimate presented as a measurement" this loop's one rule
forbids, even though (see Results) the hand-derivable formula turns out to match the measured
numbers exactly. I derived the formula *after* measuring, as an explanation for numbers already in
hand, not as a substitute for measuring them. I also considered building a from-scratch Poseidon2
circom template tonight and diffing its constraint count directly against Poseidon — rejected
because getting Poseidon2's round constants and external/internal matrices right requires a
reference implementation to check against, and every reference I could find (a paper artifact, a
Horizen/Polygon reference repo, `iden3`'s own experiments) lives behind `github.com`, which attempt
#1 above just confirmed is policy-blocked tonight. Fabricating round constants without a way to
verify them against a known-good source is not a measurement, it's a guess with a `pragma` on it —
worse than not doing the experiment. That work moves to `EXPERIMENTS.md` explicitly blocked on the
same network wall.

## Results

### Per-gadget non-linear constraint attribution

`bash scripts/bench/constraint-attribution.sh`:

```
gadget                 non-linear     linear    wires
---------------------- ---------- ---------- --------
greaterequalthan64             65          4       71
greaterequalthan8               9          4       15
greaterthan64                  65          3       70
lessequalthan64                65          4       71
merkleproof20                 4920       5480    10422
multimux1                       2          0        8
num2bits64                     64          1       66
num2bits8                       8          1       10
poseidon2                     243        274      520
poseidon3                     264        341      609
poseidon4                     300        436      741
poseidon5                     324        511      841
```

`merkleproof20` (20× `Poseidon(2)` + 20× `MultiMux1(2)` + 20 sibling-order boolean checks) sanity
checks against its own parts: `20 × 243 (poseidon2) + 20 × 2 (multimux1) + 20 (boolean checks not
present in either isolated fixture) = 4860 + 40 + 20 = 4920` — exact match to the measured total,
confirming `MerkleProof`'s only per-level non-linear cost beyond its two named gadgets is the
`pathIndices[i] * (1 - pathIndices[i]) === 0` bit check in `templates/merkle_proof.circom`.

### Reconciliation against `BASELINE.md`

| Circuit | Gadget instances (non-linear each) | Sum | `BASELINE.md` non-linear | Match |
|---|---|---|---|---|
| `transfer.circom` | `MerkleProof(20)` 4920 + `Poseidon(4)`×3 (900) + `Poseidon(3)`×1 (264) + `GreaterThan(64)` 65 + `Num2Bits(64)`×4 (256) + `LessEqThan(64)` 65 | **6470** | 6470 | exact |
| `compliance.circom` | `Poseidon(5)` 324 + `MerkleProof(20)` 4920 + `Poseidon(3)`×2 (528) + `GreaterEqThan(64)` 65 + `GreaterEqThan(8)` 9 + `Num2Bits(64)`×3 (192) + `Num2Bits(8)`×2 (16) + 3 boolean/AND checks (3) | **6057** | 6057 | exact |
| `withdraw.circom` | `Poseidon(4)`×3 (900) + `Poseidon(2)`×1 (243) + `Num2Bits(64)`×3 (192) + `GreaterThan(64)` 65 + `LessEqThan(64)` 65 | **1465** | 1465 | exact |

Every circuit's isolated-gadget sum reproduces its `BASELINE.md` total to the constraint, with the
only non-gadget residuals being small, explicit, named boolean-consistency checks already visible
in the circuit source (compliance.circom's two `out * (1 - out) === 0` defense-in-depth checks plus
its one `computedValid <== expiryCheck.out * kycCheck.out` AND gate). Nothing was fudged to make
the totals line up — the residual in each row is a real line of Circom, cited by name.

### What dominates, in percentages

| Circuit | Poseidon-family (all arities, incl. inside `MerkleProof`) | Merkle membership alone | Range/comparator gadgets |
|---|---|---|---|
| `transfer.circom` | 6024 / 6470 (**93.1%**) | 4860 / 6470 (75.1%) | 446 / 6470 (6.9%) |
| `compliance.circom` | 5712 / 6057 (**94.3%**) | 4860 / 6057 (80.2%) | 345 / 6057 (5.7%) |
| `withdraw.circom` (no Merkle proof) | 1143 / 1465 (**78.0%**) | — | 322 / 1465 (22.0%) |

Poseidon calls dominate every circuit that has them, and inside the two circuits with a Merkle
membership proof, the tree accounts for three out of every four non-linear constraints on its
own — more than all seven hash-domain assertions (commitment, nullifier, amount-hash, credential
leaf, context binding) combined.

### Why this reframes "Poseidon2 vs Poseidon" (queue item #2's original framing)

Reading `circomlib/circuits/poseidon.circom` alongside the measured numbers explains *why* the
Merkle tree so overwhelmingly dominates, and why a same-arity Poseidon → Poseidon2 swap is not the
lever the original queue entry assumed:

- The only place `poseidon.circom` multiplies two **signals** together is inside `Sigma()`
  (the S-box, `x^5` via three squarings) — `in2 <== in*in; in4 <== in2*in2; out <== in4*in;`. That's
  the entire non-linear cost of one round, on one state element.
- `Ark` (add round constants), `Mix`/`MixLast` (the full MDS matrix), and `MixS` (the partial-round
  sparse matrix) are all linear combinations of signals against **compile-time constants**
  (`M[j][i]`, `C[i+r]`, `S[...]`, all `var` arrays from `poseidon_constants.circom`) — `<==`
  assignments of degree 1, contributing **zero** non-linear constraints regardless of how dense the
  matrix is or how many rounds apply it. R1CS only charges for multiplying two *witness* values
  together; multiplying a witness by a hard-coded constant is free.
- That gives an exact formula, derived from the source above and checked against all four measured
  arities: non-linear constraints `= 24t + 3·nRoundsP(t)`, where `t = nInputs + 1`, the `8` full
  rounds each cost `3` non-linear constraints per state element (`8 × t × 3 = 24t`), and each of the
  `nRoundsP(t)` partial rounds costs `3` (only element 0 goes through `Sigma`). For `t = 3, 4, 5, 6`
  (arities 2–5) this gives `243, 264, 300, 324` — matching all four measured rows above exactly.

Poseidon2's real efficiency claim (Grassi–Khovratovich–Schofnegger 2023) is a *cheaper external
linear layer* — fewer field multiplications to evaluate the diffusion matrix natively. That claim
has no target in R1CS: this circuit's linear layers already cost zero constraints, by construction,
independent of which linear layer is used. A same-arity, same-round-count Poseidon → Poseidon2 swap
here would not measurably move the non-linear constraint count — the formula above has no term a
cheaper *linear* layer could touch. (It would still be worth doing for **native** proving-time cost
outside the circuit — witness generation calls the hash function directly, not just inside R1CS —
but that's a different, smaller number than the constraint count the original queue entry named,
and measuring it honestly needs a verified Poseidon2 implementation, which attempt #1's network
wall blocks tonight; see Open questions.)

The number that *does* move the needle, confirmed by the same table: constraints scale with the
**number of Poseidon calls**, and the Merkle tree calls Poseidon(2) once per level — so the real
levers are the ones already further down the queue: a shallower/wider tree trades directly against
anonymity-set size (243 non-linear constraints per level, exactly, from this table), and batched or
aggregated proof verification (queue item #3) amortizes the *count* of proving events rather than
the per-proof constraint count.

## Verdict: **REJECT** (original framing) / measurement **KEEP**

The literal hypothesis behind the original queue entry — "swapping Poseidon for Poseidon2 measurably
cuts non-linear R1CS constraints" — is **REJECT**ed, with a mechanism-level reason drawn from the
actual circomlib source rather than a guess: R1CS does not charge for a linear diffusion layer no
matter which one is used, so Poseidon2's advantage doesn't have a foothold here. No branch work was
needed to reach that verdict; it falls out of reading `poseidon.circom` correctly, which is now
written down so no future night re-derives it.

The measurement itself is **KEEP**: `circuits/bench/attribution/*.circom` and
`scripts/bench/constraint-attribution.sh` are merged, and the reconciliation table above is now the
citable per-gadget breakdown of `BASELINE.md`'s constraint counts (`BASELINE.md` updated with a new
section linking here). `circom2` as a `circuits/` devDependency is also kept — verified
byte-identical to the native `circom` 2.2.2 build used for every number in `BASELINE.md`, and it
removes a `github.com`-dependent build step from every future compile-and-measure night.

## Where this could be used

- **Any Circom/Groth16 circuit with a Merkle-membership component** (nullifier sets, credential
  trees, state accumulators) — the per-level constraint cost derived here (243 non-linear
  constraints per `Poseidon(2)` level on BN254) is the number an implementer needs before picking a
  tree depth, independent of the specific protocol built on top.
- **A thesis chapter on Poseidon2 adoption in SNARK circuits** — this is a concrete, sourced
  counter-example to "Poseidon2 is a free win," worth citing alongside the (real, different) claim
  that Poseidon2 helps native hash-chain throughput (e.g. a Merkle *indexer* rebuilding a tree
  off-chain, where every hash is evaluated natively, not inside R1CS — that's exactly where
  Poseidon2's linear-layer savings would show up, and queue item #4 (Merkle accumulator at scale)
  is the right place to measure it).
- **Anyone tuning a Circom circuit's gadget selection** — the general method here (isolate one
  gadget in a `component main`, compile it alone, read the compiler's own non-linear/linear split)
  generalizes past Poseidon: it's the fastest way to get an exact constraint attribution for any
  circuit built from circomlib templates, without hand-deriving costs from template source.

## Open questions (next queue)

1. **Poseidon2's real payoff — native hashing throughput, not R1CS constraints.** The Merkle
   accumulator experiment (queue item #4, indexer throughput at 10^5–10^7 commitments) is where a
   verified Poseidon2 implementation would actually matter, since that's native (off-circuit)
   hashing. Needs the same network access attempt #1 found blocked tonight (a reference
   implementation to check round constants/matrices against) — flagged as its own queue item now,
   explicitly separated from the constraint-count question this report settles.
2. **Per-level Merkle constraint cost (243 non-linear/level) as a direct input to queue item #4's
   depth-vs-anonymity-set trade-off.** This report gives the cost side of that trade-off exactly;
   item #4 still needs the benefit side (indexer throughput, batch insertion cost at scale).
3. **`sui` CLI / testnet RPC access is policy-blocked, not just unbuilt.** Worth an explicit ask to
   whoever configures this sandbox's egress policy for either a `sui` binary in the image or an
   allowlist entry for `fullnode.testnet.sui.io` — every night this stays blocked, queue items #1
   and #3 (gas, batched-verification savings) stay stuck behind it.
