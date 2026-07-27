# Veil baseline — measured, not estimated

Source of truth for Veil's own numbers. Every figure here comes from a command in
`scripts/bench/prove-bench.mjs` or the `circuits/scripts/compile*.sh` scripts, run on one
machine, one night, with raw output preserved in
[`2026-07-27-baseline.md`](./2026-07-27-baseline.md). Superseded by a later `KEEP` baseline
run if one lands — check `LEDGER.md` for the current row before trusting a number below.

Last measured: **2026-07-27**. Machine: 4 vCPU Intel Xeon @ 2.10GHz, 15 GiB RAM, Node v20.20.2,
circom 2.1.9, circomlib 2.0.5, snarkjs 0.7.6, single-contributor dev Groth16 setup (NOT the
production ceremony — see `circuits/scripts/ceremony.sh`).

## Circuit constraints (R1CS, `snarkjs r1cs info`)

| Circuit | Non-linear constraints | Linear constraints | Public / private inputs | Wires |
|---|---:|---:|---|---:|
| `transfer.circom` | 6,384 | 0 | 7 / 47 | 6,407 |
| `withdraw.circom` | 1,439 | 0 | 5 / 5 | 1,441 |
| `compliance.circom` | 5,979 | 0 | 6 / 45 | 5,998 |

Documented figures elsewhere in this repo (`README.md`, `docs/architecture.md`,
`docs/threat-model.md`) previously said 13,611 / 3,058 / 12,743 — roughly 2× these numbers.
That gap and the likely cause are in the report below; the docs have been corrected to point
here.

## Groth16 proving (Node.js, `snarkjs.groth16.fullProve`, 5 runs, single-contributor test zkey)

| Circuit | Prove mean | Prove median | Verify mean | Proof size (JSON) |
|---|---:|---:|---:|---:|
| `transfer.circom` | 707 ms | 656 ms | 17.6 ms | 722 B |
| `withdraw.circom` | 258 ms | 245 ms | 14.5 ms | 725 B |
| `compliance.circom` | 601 ms | 595 ms | 17.3 ms | 725 B |

Browser/WASM proving latency (what users actually experience) is **UNMEASURED** — see
`docs/research/EXPERIMENTS.md` item #2.

## Artifact sizes

| Circuit | .r1cs | .wasm | .zkey (final) | .vk (json) |
|---|---:|---:|---:|---:|
| `transfer.circom` | 3.18 MB | 2.66 MB | 4.26 MB | 3.9 KB |
| `withdraw.circom` | 985.6 KB | 2.23 MB | 1.53 MB | 3.6 KB |
| `compliance.circom` | 2.77 MB | 2.77 MB | 3.61 MB | 3.8 KB |

The `.zkey` is what a client downloads (or the server streams) to prove; it dominates
first-load cost. The `.wasm` witness calculator is downloaded once and cached.

## On-chain gas per entry point (Sui Move)

**BLOCKED.** No `sui` CLI available in the measurement environment; `cargo install --git
.../MystenLabs/sui` hit a transient upstream git-fetch failure on first attempt and was still
compiling on a retry when this baseline closed. Tracked as `docs/research/EXPERIMENTS.md`
item #1 — top of the queue for the next run.

## Reproduce

```bash
cd circuits && npm install
bash scripts/compile.sh            # transfer.circom -> build/
bash scripts/compile-withdraw.sh    # withdraw.circom -> build-withdraw/
bash scripts/compile-compliance.sh  # compliance.circom -> build-compliance/
cd .. && node scripts/bench/prove-bench.mjs --runs 5
```
