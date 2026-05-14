# Ground Truth: Codebase Health

## Status: NEW PROJECT
No existing codebase. Starting from scratch.

## Dependencies (planned)

### Circom / snarkjs
- circom 2.1.x compiler
- snarkjs 0.7.x (WASM BN254 Groth16)
- circomlib 2.0.5+ (Poseidon, comparators, mux)
- Powers of Tau: Hermez 2^15 (sufficient for ~52K constraints)

### Sui Move
- Sui CLI (latest)
- Move 2024 edition
- sui::groth16 (native, no external dep)
- sui::poseidon (native, BN254 only)
- sui::clock (epoch management)

### Frontend
- Next.js 14+ (App Router)
- @mysten/dapp-kit-react 2.x
- @mysten/sui 2.16+
- snarkjs 0.7.x (client-side proving)
- Vite config: optimizeDeps.exclude: ["snarkjs"]

### Rust (future, not MVP)
- arkworks 0.5.0 (git deps + patch.crates-io)
- light-poseidon (circom-compatible)
- ark-circom (bridge to circom artifacts)

## Known Risks
1. snarkjs → Sui proof byte conversion (biggest integration risk)
2. Poseidon parameter compatibility (Sui neptune vs circom)
3. Circom Powers of Tau ceremony (need to download ~45MB ptau file)
4. Client-side proving time for 52K constraints (~5-15s)
5. arkworks 0.5 API instability (for thesis phase)

## Test Infrastructure
- Circom: circom compiler + witness generation + snarkjs verify
- Move: sui move test
- Frontend: Vitest + Playwright (if QA)
- E2E: scripts/e2e-test.ts (deploy contract + generate proof + verify on testnet)

## CI/CD
- GitHub Actions (after initial dev)
- Vercel for frontend
- Sui testnet for contract
