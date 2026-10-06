# 2026-10-06 — Poseidon2 vs circomlib Poseidon: constraint count and proving time

**Verdict: REJECT** (as a drop-in; the knowledge survives — see Open questions).
Branch keeps the harness: `scripts/bench/poseidon2/`.

## Hypothesis

Replacing circomlib `Poseidon(n)` with a Poseidon2 (BN254, t=3) sponge in `transfer`, `withdraw` and
`compliance` reduces R1CS constraint count by ≥10% and Node proving time by ≥10% (queue item #2
claimed Poseidon is the dominant non-linear cost).

**Falsified.** Measured constraint count went *up* on two circuits and was flat on the third; proving time
is within run-to-run noise.

## Threat / privacy model

This is a performance experiment on a hash used inside circuits only. Nothing in the on-chain Move
code computes Poseidon (`contracts/sources/pool.move` only consumes roots/commitments as bytes), so a
hash swap would touch circuits + client + indexer, not the contract.

- **Adversary defended against:** none new. Intended security is unchanged: collision/preimage
  resistance of the commitment/nullifier hashes against a chain observer / malicious prover.
- **What it does NOT defend / residual surface:** the sponge construction used here (tag in the
  capacity lane, zero padding, rate 2) is a *measurement stand-in*, not a reviewed construction.
  Poseidon2 is newer than Poseidon (less cryptanalysis); BN254 t=3 is the only reference instance used.
  No claim is made about its security margin. Because the verdict is REJECT nothing here ships.
- **Assumptions:** the reference parameters (HorizenLabs/poseidon2, t=3, d=5, R_F=8, R_P=56) are
  sound; trusted setup unchanged (dev-only single contribution, RR2 in `docs/threat-model.md`).
- **STRIDE mapping:** would touch Tampering/Spoofing entries for commitments & nullifiers
  (`docs/threat-model.md`) only if adopted. No circuit change is merged, so no soundness argument,
  leakage analysis or negative test is owed by this PR (none of the repo's circuits changed).

## Approach

1. `gen-poseidon2.mjs` generates a circom Poseidon2 permutation (t=3) from the reference Rust
   constants (192 round constants, diag [1,1,2]).
2. Correctness: circom witness output for input [0,1,2] and the plain-JS port both equal the output
   of the reference `zkhash` crate (raw output below).
3. `Poseidon2Sponge(n)` — same ports as circomlib `Poseidon(n)` (`inputs[n]`, `out`), tag → capacity,
   remaining inputs absorbed 2 per permutation. `measure.sh` copies each real circuit (and
   `templates/merkle_proof.circom`), `sed`s `Poseidon(` → `Poseidon2Sponge(`, compiles, sets up and
   reports. `prove-variants.mjs` times `groth16.fullProve` with a matching JS hash for the witness.

Rejected before building: porting Poseidon2 at t=4/t=5 (no BN254 reference parameters exist in the
reference repo; generating and trusting new ones is out of scope for one night); a full
witness/negative-test suite for a variant that was expected to be a measurement only.

## Results

Constraints (circom 2.2.2, `--r1cs`; the baseline rows reproduce 2026-07-22 `BASELINE.md` exactly):

| Circuit | Baseline total | Poseidon2 total | Δ | Baseline non-linear | P2 non-linear |
|---|---|---|---|---|---|
| transfer | 13,611 | 14,394 | **+783 (+5.8%)** | 6,470 | 6,926 |
| withdraw | 3,058 | 3,948 | **+890 (+29.1%)** | 1,465 | 2,002 |
| compliance | 12,743 | 12,746 | +3 (+0.02%) | 6,057 | 6,105 |

zkey bytes: transfer 6,001,417 → 6,292,105; withdraw 1,385,321 → 1,717,377; compliance 5,682,141 → 5,687,325.

Node proving time, ms (mean, sd; this machine, 4 vCPU VM, includes witness generation). Two runs:

| Circuit | Poseidon (n=10 / n=20) | Poseidon2 (n=10 / n=20) |
|---|---|---|
| transfer | 1112.5±37.8 / 1026.9±40.6 | 1035.3±54.1 / 1047.0±60.3 |
| withdraw | 358.8±22.7 / 378.9±42.9 | 365.5±24.4 / 363.9±19.6 |
| compliance | 1063.5±69.8 / 1056.0±70.1 | 929.5±46.4 / 991.6±44.1 |

The direction flips between runs on transfer; no effect larger than noise (≈1–2 sd) is established.
I did not explain the compliance −6…−13% (more wires/zkey is not slower; could be witness-gen or
noise) and make no claim on it. Absolute times are ~35–45% above the 2026-07-22 baseline (different
VM, loaded) — only the same-run baseline-vs-variant pairs are comparable.

Why the sponge loses (cross-check, arithmetic only, but it matches measurement exactly for transfer):
a t=3 permutation costs 8·3·3+56·3 = 240 non-linear constraints vs circomlib's 243 at t=3 — a 1.2%
saving (measured: −60 over 20 Merkle levels). But Veil's 4-input hashes are t=5 in circomlib (300) and
become *two* t=3 permutations in a rate-2 sponge (480). Transfer: −60 (Merkle) +3×180 (three 4-input
hashes) −24 (the 3-input hash) = +456 non-linear — measured +456 (6,470→6,926). Poseidon2's real
advantage is native/plain-hash speed and its cheaper linear layer, which R1CS barely rewards.

Also notable: **Merkle depth-20 is 4,860 of transfer's 6,470 non-linear constraints (75%)** — the hash
function is not the lever; path length/arity is.

### Raw output

Reference-vector check (all three agree):

```
$ cargo run --release --example p2vec        # HorizenLabs zkhash, POSEIDON2_BN256_PARAMS, perm([0,1,2])
5297208644449048816064511434384511824916970985131888684874823260532015509555
21816030159894113985964609355246484851575571273661473159848781012394295965040
13940986381491601233448981668101586453321811870310341844570924906201623195336
$ circom unit.circom + generate_witness  # same three values (circom Poseidon2T3)
$ node scripts/bench/poseidon2/verify-vector.mjs
poseidon2 JS == HorizenLabs reference vector: OK
```

`CIRCOM=<circom-2.2.2> bash scripts/bench/poseidon2/measure.sh` (10 min, mostly local ptau + 6 setups):

```
== baseline/transfer      Wires 13632  Constraints 13611  Priv 47  Pub 7   zkey bytes: 6001417
== baseline/withdraw      Wires 3058   Constraints 3058   Priv 5   Pub 5   zkey bytes: 1385321
== baseline/compliance    Wires 12762  Constraints 12743  Priv 45  Pub 6   zkey bytes: 5682141
== poseidon2/transfer     Wires 14415  Constraints 14394  Priv 47  Pub 7   zkey bytes: 6292105
== poseidon2/withdraw     Wires 3948   Constraints 3948   Priv 5   Pub 5   zkey bytes: 1717377
== poseidon2/compliance   Wires 12765  Constraints 12746  Priv 45  Pub 6   zkey bytes: 5687325
non-linear / linear (circom logs): baseline transfer 6470/7141, withdraw 1465/1593, compliance 6057/6686;
poseidon2 transfer 6926/7468, withdraw 2002/1946, compliance 6105/6641
```

`node scripts/bench/poseidon2/prove-variants.mjs /tmp/p2measure 10` and `… 20`:

```
transfer   baseline  mean 1112.5 ms  sd 37.8  (n=10)    | transfer   baseline  mean 1026.9 ms  sd 40.6  (n=20)
transfer   poseidon2 mean 1035.3 ms  sd 54.1  (n=10)    | transfer   poseidon2 mean 1047.0 ms  sd 60.3  (n=20)
withdraw   baseline  mean 358.8 ms  sd 22.7  (n=10)     | withdraw   baseline  mean 378.9 ms  sd 42.9  (n=20)
withdraw   poseidon2 mean 365.5 ms  sd 24.4  (n=10)     | withdraw   poseidon2 mean 363.9 ms  sd 19.6  (n=20)
compliance baseline  mean 1063.5 ms  sd 69.8  (n=10)    | compliance baseline  mean 1056.0 ms  sd 70.1  (n=20)
compliance poseidon2 mean 929.5 ms  sd 46.4  (n=10)     | compliance poseidon2 mean 991.6 ms  sd 44.1  (n=20)
```

Caveats: ptau is locally generated (the Hermez download is blocked here — constraint counts and
proving cost don't depend on it, but zkeys are not production-comparable); circom was built from
`iden3/circom` tag v2.2.2. Existing repo tests were **not** run: no existing file changed (only
`scripts/bench/poseidon2/` and docs added), no `CLAUDE.md` exists in the repo to define the suite, and
`sui move test` is unavailable (see below).

## Verdict

**REJECT.** A t=3 Poseidon2 sponge is +5.8%/+29%/+0.02% constraints and not measurably faster.
Branch kept. `BASELINE.md` unchanged.

Queue #1 (on-chain gas) was attempted first and is **BLOCKED again**: the prebuilt `sui` release
download returns 403 through the sandbox proxy, `fullnode.testnet.sui.io` CONNECT returns 403, and
building the Sui workspace from source on 4 vCPU/15 GB was not attempted this run. Needs either an
allowlisted `sui` binary / fullnode RPC host, or a multi-night source build.

## Where this could be used

- Negative result for any circom/Groth16 payment pool that assumes "Poseidon2 ⇒ cheaper in-circuit":
  e.g. Tornado-style or Semaphore-style Merkle-membership circuits on BN254 gain ~1.2% per level at t=3.
- Poseidon2 remains the right choice where hashing happens *natively* (indexers hashing 10^6–10^7
  leaves, relayers) or in Plonkish/Halo2 arithmetizations — relevant to the thesis chapter on
  accumulator throughput at scale and on a future PLONK/Halo2 port (queue #9).
- Concrete: a confidential-payroll indexer on Sui rebuilding a 10^6-leaf tree client-side would profit
  from native Poseidon2 speed only if the circuit hash changed too — which this shows is not free.

## Open questions (tomorrow's queue)

1. **Merkle depth/arity is 75% of transfer's non-linear constraints.** Measure depth 16/20/24 and a
   4-ary tree (fewer levels, wider hash): constraints, proving time, anonymity-set trade-off. (Promote
   queue #4 to #2.)
2. Native-width Poseidon2 (t=4/t=5) would be ~288 vs 300 (≈−4%, **UNMEASURED**, derived) — requires
   generating/reviewing new BN254 parameters; likely not worth it.
3. Why did compliance prove ~6–13% faster with equal constraints? Witness-gen vs prover split not measured.
4. Gas, still: need `sui` access (see Verdict).
