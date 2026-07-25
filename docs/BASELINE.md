# Baseline — measured numbers, one machine, one run

This file exists so every future performance or gas claim about Veil has
something real to compare against. It is updated only by the nightly research
loop (`docs/research/`), and only when a re-measurement changes a number
enough to matter — see `docs/research/LEDGER.md` for the history.

**First measured:** 2026-07-25 (`docs/research/2026-07-25-baseline.md`).
**Machine:** 4-vCPU Intel Xeon @2.80GHz, 15 GiB RAM, Linux x64, Node v22.22.2,
circom 2.2.2, snarkjs 0.7.6, Chromium 141.0.7390.37 (headless, via Playwright
1.56.1). Every number below is machine- and toolchain-specific — re-measure
before trusting it as a hardware-independent constant.

**Reproduce everything in this file:** `bash scripts/bench/run-all.sh`
(prerequisites and exact per-step commands are in that script's header and in
`docs/research/2026-07-25-baseline.md`).

## Circuit constraints (`snarkjs r1cs info`)

| Circuit | Constraints (total) | Non-linear | Linear | Wires | Public / Private inputs |
|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 13,632 | 7 / 47 |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 12,762 | 6 / 45 |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 3,058 | 5 / 5 |

## Groth16 trusted setup time (dev single-contributor, pot15 ptau)

| Circuit | `groth16 setup` | `zkey contribute` |
|---|---|---|
| `transfer` | 9.85s | 3.54s |
| `compliance` | 9.37s | 3.40s |
| `withdraw` | 3.10s | 1.40s |

## Proving / verifying time, proof & key size — Node (n=10 `groth16.fullProve`)

| Circuit | Prove (mean ± σ) | Verify (mean ± σ) | proof.json | vk.json | zkey |
|---|---|---|---|---|---|
| `transfer` | 952.0ms ± 113.0ms | 18.9ms ± 4.9ms | 725 B | 4,023 B | 5,861 KB |
| `compliance` | 878.0ms ± 12.9ms | 18.0ms ± 4.5ms | 720 B | 3,838 B | 5,549 KB |
| `withdraw` | 299.2ms ± 14.4ms | 18.3ms ± 3.1ms | 725 B | 3,655 B | 1,353 KB |

On-chain proof size (arkworks-compressed, what `sui::groth16` actually consumes)
is 128 bytes per `docs/SPEC.md` — the `proof.json` figures above are the
decimal-string snarkjs output size, a different (larger) number for a different
purpose.

## Proving time in a real browser (headless Chromium, transfer circuit)

| Runtime | Prove (mean ± σ, n=10) | Verify (mean ± σ) | vs. Node |
|---|---|---|---|
| Node v22.22.2 | 952.0ms ± 113.0ms | 18.9ms ± 4.9ms | 1.0x |
| Headless Chromium 141 (clean, idle machine) | 1284.5ms ± 89.8ms | 20.7ms ± 2.9ms | 1.35x |
| Headless Chromium 141 (machine under contention) | 1920.6ms ± 528.2ms | 27.0ms ± 4.8ms | 2.01x |

Headless-VM Chromium, not a phone and not a real desktop tab with extensions. The
ratio is sensitive to system load — read it as "roughly 1.3-2x on this machine,"
not a precise constant; see `docs/research/2026-07-25-baseline.md` for the full
story and `docs/research/EXPERIMENTS.md` item 10 for the mobile follow-up.

## On-chain gas per entry point — UNMEASURED

Blocked: no `sui` CLI available in the research environment, and obtaining one
(prebuilt release or source build) was not feasible in a single night. Full
reasoning in `docs/research/2026-07-25-baseline.md` § Verdict. Tracked as
`docs/research/EXPERIMENTS.md` items 2 (get `sui` into the environment) and 3
(the actual gas measurement). Do not cite a gas number for Veil until this file
is updated with one.
