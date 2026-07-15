# Veil — Baseline

The numbers below are Veil's real cost profile, measured in one run on one machine (this repo's
CI-sandbox container, no GPU, 2026-07-14). Every number here comes from a command in
`scripts/bench/` or from `git`/`snarkjs`/`bun` output pasted verbatim in
[`2026-07-14-baseline.md`](2026-07-14-baseline.md). Anything not measured is marked `UNMEASURED` or
`BLOCKED`, never estimated.

Re-run before trusting an old row: `cd circuits && npx circom2 <name>.circom --r1cs --wasm --sym
--output build && node ../scripts/bench/circuit-baseline.mjs`.

## Circuits (measured — circom2 0.2.23 / circom compiler 2.2.3, WASM build, BN254)

| circuit | non-linear | linear | **total constraints** | public in | private in | wires |
|---|---:|---:|---:|---:|---:|---:|
| `transfer.circom` | 6,470 | 7,141 | **13,611** | 7 | 47 | 13,632 |
| `compliance.circom` | 6,057 | 6,686 | **12,743** | 6 | 45 | 12,762 |
| `withdraw.circom` | 1,465 | 1,593 | **3,058** | 5 | 5 | 3,058 |

`transfer.circom`'s current source (`main`, 2026-07-14) proves Merkle membership of the spent
commitment in a depth-20 anonymity-set tree (`merkleRoot` public input, 20 `pathElements` +
20 `pathIndices` private) — this did not exist when `docs/SPEC.md` and `CLAUDE.md` last described the
circuit as "6 public inputs / 11 constraints." Fixed 2026-07-15 — see
[`2026-07-15-fix-stale-transfer-artifacts.md`](2026-07-15-fix-stale-transfer-artifacts.md).

## `transfer.circom` proving (measured — real Groth16 setup, real witness, this container's CPU)

| stage | value |
|---|---|
| Groth16 setup (phase 2, pot15) | 9.7 s |
| Witness gen + proving, Node.js | **1,498.8 ms** |
| Proving, headless Chromium, cold | **3,258.8 ms** |
| Proving, headless Chromium, warm | **~1,530–1,690 ms** |
| Verify (off-chain, snarkjs) | 20–27 ms |
| Proof size, on-chain compact (Sui `groth16`) | **128 bytes** |
| Proof size, raw snarkjs JSON | 725 bytes |
| VK size, on-chain compact | **488 bytes** |
| VK size, raw snarkjs JSON | 4,024 bytes |
| Public inputs, on-chain bytes | 224 bytes (7 × 32) |
| `.zkey` (proving key) | 5.72 MB |
| `.wasm` (witness calculator) | 2.71 MB |
| Client proving payload (wasm + zkey) | ~8.6 MB |

## On-chain gas — `BLOCKED`

The Sui CLI (`sui`) could not be installed in this environment: no apt package, no cached binary
anywhere on the filesystem. Both of its install paths route through hosts confirmed blocked by this
session's org egress policy — confirmed directly against `circom` (same policy, same two hosts):
`static.crates.io` (needed by any `cargo install`, incl. `sui`) returned `403`, and a
`github.com/.../releases/download/...` asset (`iden3/circom`'s own release binary) returned `403`
with the proxy's "org policy" signature, not a transient error. `sui`'s own release binary lives at
the same `github.com/.../releases/download/...` path shape, so the same block applies; not
re-verified against the literal `sui` URL to avoid re-poking a host already confirmed policy-denied.
`sui move test` and any real gas number are therefore not measured tonight.
**Do not treat any gas figure for Veil as measured until a session with `sui` CLI access runs it.**

## Test suites (measured — real command output in the baseline report)

| suite | result | note |
|---|---|---|
| `circuits` — `transfer.test.mjs` | **42 / 42 pass** | fixed 2026-07-15, see [report](2026-07-15-fix-stale-transfer-artifacts.md) |
| `circuits` — `compliance.test.mjs` | 30 / 30 pass | |
| `circuits` — `withdraw.test.mjs` | 35 / 35 pass | |
| `scripts` — `test-converter.ts` | 109 / 109 pass | |
| `frontend` — `bun run test` | 19 / 19 pass | |
| `contracts` — `sui move test` | `BLOCKED` | no `sui` CLI (reconfirmed 2026-07-15: `cargo install --git .../sui.git` and `static.crates.io` both fail — see report) |
| E2E pipeline | `BLOCKED` | needs `sui` CLI + live network |

## What's still `UNMEASURED`

- Mobile browser proving latency (only desktop headless Chromium measured tonight).
- On-chain gas for every entry point (`deposit_and_register`, `shielded_transfer`, `withdraw`,
  Merkle insert) — needs `sui` CLI.
- `compliance.circom` / `withdraw.circom` end-to-end proving time, proof/VK size (constraint counts
  only tonight — see Open Questions in the report for why).
- Merkle accumulator behavior at scale (10⁵–10⁷ commitments) — separate queue item.
- Relayer throughput.
