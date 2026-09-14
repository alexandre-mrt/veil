# Veil performance baseline

Measured 2026-07-22, on one machine, in one run. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) for the full
methodology, raw command output, and what's still missing. Superseded rows should be replaced in
place with a note in `LEDGER.md` pointing at the experiment that changed them — this file always
reflects the current state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2).

As of 2026-09-14, `compile.sh` and CI (`.github/workflows/ci.yml`) fall back to generating the
`pot15` Powers of Tau locally (`snarkjs powersoftau new/contribute/prepare phase2`, ~6 minutes,
no network) when the Hermez download is unreachable — see
[`2026-09-14-ci-ptau-blocker-and-constraint-attribution.md`](2026-09-14-ci-ptau-blocker-and-constraint-attribution.md).
Either source is an equally non-production, dev-only setup; the numbers above are unaffected
either way.

## Constraint counts, artifact sizes

| Circuit | R1CS constraints | Non-linear | Linear | Wires | Public / private inputs | zkey (bytes) | vk (bytes) | Compressed on-chain proof (bytes) |
|---|---|---|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 13,632 | 7 / 47 | 6,001,431 | 4,025 | 128 |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 12,762 | 6 / 45 | 5,682,155 | 3,841 | 128 |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 3,058 | 5 / 5 | 1,385,335 | 3,656 | 128 |

Groth16 proofs are three fixed-size group elements (2×G1 + 1×G2) regardless of circuit — the
128-byte compressed on-chain figure (from `scripts/src/test-converter.ts`, `proofToSuiBytes`) is
constant across all three circuits. snarkjs's own JSON proof encoding (decimal-string field
elements) runs ~721–726 bytes for the same data.

## Proving time (mean of 10 runs, includes witness generation)

| Circuit | Node.js (this machine) | Chromium (headless, this machine) | Browser / Node ratio |
|---|---|---|---|
| `transfer.circom` | 751.9 ms (σ 17.3) | 1213.3 ms (σ 32.6, 8 runs) | 1.61x |
| `compliance.circom` | 738.1 ms (σ 20.9) | 1163.4 ms (σ 58.6, 8 runs) | 1.58x |
| `withdraw.circom` | 244.3 ms (σ 7.9) | 382.9 ms (σ 9.9, 8 runs) | 1.57x |

Reproduce: `node scripts/bench/prove-latency.mjs --runs 10` and
`node scripts/bench/browser-latency.mjs --runs 8` (see that directory for prerequisites).

## Constraint attribution (2026-09-14)

Where each circuit's non-linear constraints actually come from, measured by compiling each
circomlib gadget in isolation (`circuits/bench/components/`,
`bash scripts/bench/component-constraints.sh`) and summing — cross-checked to reproduce the
constraint counts above exactly.

| Circuit | Merkle path (20× arity-2 Poseidon) | Other Poseidon (fixed arity) | Range/comparator gadgets |
|---|---:|---:|---:|
| `transfer.circom` | 76.0% (4,920 / 6,470) | 18.0% | 6.0% |
| `compliance.circom` | 81.3% (4,920 / 6,057) | 14.1% | 4.6% |
| `withdraw.circom` (no Merkle path) | — | 78.0% | 22.0% |

The depth-20 Poseidon Merkle-membership proof — not the four fixed-arity identity/nullifier/
credential hashes — is the dominant non-linear-constraint cost in both circuits that include it.
This is why a Poseidon2 swap (measured 2026-09-13, open unmerged PR #61, verdict REJECT) barely
moves overall proving time even where it doesn't regress: at Veil's actual call arities it only
ever touched the 18–24% of the budget outside the Merkle path. Full writeup:
[`2026-09-14-ci-ptau-blocker-and-constraint-attribution.md`](2026-09-14-ci-ptau-blocker-and-constraint-attribution.md).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | No `sui` CLI binary available or installable in this session, and five public JSON-RPC endpoints (`fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`, `sui-testnet.public.blastapi.io`, `sui-testnet-rpc.publicnode.com`, `rpc.ankr.com`) all denied at the network-policy level as of 2026-09-14 — an organization-level egress policy, not a one-off tool-approval prompt. Re-confirmed twice now (2026-07-22, 2026-09-14); one unmerged backlog PR (#59) reportedly unblocked this via a local Sui network instead of the public one — worth checking whether that's reproducible before trying the public RPC path again. Top of the queue. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |
| Client-side Merkle tree reconstruction cost at depth 20 | **MEASURED, real problem found (2026-09-14)** | `scripts/src/compliance-utils.ts`'s `buildMerkleTree` is O(2^depth): 64.2s wall time to build a depth-20 tree with a single real leaf (pads to 2^20 = 1,048,576 leaves, no cached-zero-subtree optimization). Fine at today's near-empty testnet pool; does not scale to the 10^5–10^7-commitment anonymity sets `EXPERIMENTS.md` item 4 targets. Needs a sparse-tree fix, not just awareness — queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
