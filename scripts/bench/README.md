# scripts/bench

Reusable benchmark harnesses for the nightly research loop. Every number in
`docs/research/BASELINE.md` comes from one of these.

| Script | Measures | Needs |
|---|---|---|
| `prove-latency.mjs` | Node Groth16 proving time per circuit | compiled circuits |
| `browser-latency.mjs` | Same, inside headless Chromium (WASM) | compiled circuits + Playwright Chromium |
| `gas-localnet.mjs` | On-chain gas per Veil entry point, real proofs, real validator | compiled circuits + `sui` CLI + local network |

`witnesses.mjs` holds the shared valid-witness builders (optional per-field overrides; defaults are
the original fixed values).

## Compile the circuits (once)

```bash
cd circuits && npm ci
circom transfer.circom   --r1cs --wasm --sym --output build            -l node_modules
circom withdraw.circom   --r1cs --wasm --sym --output build-withdraw   -l node_modules
circom compliance.circom --r1cs --wasm --sym --output build-compliance -l node_modules
# then groth16 setup + zkey contribute + export verificationkey per circuit
# (circuits/scripts/compile*.sh); any pot15 ptau works, gas does not depend on it.
```

## Gas on a local Sui network

```bash
# terminal 1 — throwaway validator + faucet (does not touch ~/.sui of a real wallet if HOME is set)
sui start --force-regenesis --with-faucet --committee-size 1

# terminal 2
cd scripts/bench && npm ci
SUI_BIN=$(command -v sui) node gas-localnet.mjs --out gas.json
```

Takes ~5 minutes, nearly all of it waiting for one real 60 s pool epoch boundary (the 1-epoch
timelocks and commitment-maturity rule are exercised for real, not mocked). The script exits
explicitly: snarkjs leaves worker threads alive after `groth16.fullProve`.

`CONTRACTS_DIR` overrides the package to publish (default `contracts/`). The package is built with
`sui move build --dump-bytecode-as-base64 --no-tree-shaking` and published through the SDK, so no
`sui client` wallet config is needed.

Gas is deterministic for a given protocol version and state: two independent runs (fresh keypair,
fresh publish) produced byte-identical numbers across all 66 transactions — see
`docs/research/2026-10-10-onchain-gas-baseline.md`.

If `github.com` is not reachable (so `sui move build` cannot fetch the pinned framework), the
report documents how the 2026-10-10 run obtained the `sui` binary and framework sources instead.
