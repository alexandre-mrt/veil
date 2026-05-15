# Veil -- Privacy Payment Protocol on Sui

## Overview
ZK privacy payments with cumulative spending proofs and UTXO-style commitments on Sui.
Circuit v2: Poseidon(4) identity-bound commitments, note-based nullifiers, domain-separated txAmountHash.
4-loop security audit complete (clean on loop 4). 186 tests, 0 failures.

## Structure
- `contracts/` -- Sui Move (pool, verifier, token)
- `circuits/` -- Circom ZK circuit (transfer.circom, 11 constraints)
- `frontend/` -- Next.js 14 + @mysten/dapp-kit + snarkjs WASM
- `scripts/` -- deployment, proof conversion, E2E pipeline
- `docs/` -- architecture, C4 diagrams, HTML report

## Commands

### Build
- Build contract: `cd contracts && sui move build`
- Compile circuit: `cd circuits && bash scripts/compile.sh`
- Frontend dev: `cd frontend && bun run dev`
- Install all: `bash scripts/init.sh`

### Test
- Move tests (37): `cd contracts && sui move test`
- Circuit tests (40): `cd circuits && npm test`
- Converter tests (109): `cd scripts && bun run src/test-converter.ts`
- E2E pipeline: `cd scripts && bun run src/e2e-test.ts`

## Stack
- Circom 2.1 + snarkjs 0.7 (BN254 Groth16)
- Sui Move 2024 + `sui::groth16` native verifier
- Next.js 14 + @mysten/dapp-kit 1.x
- VEIL token: 6 decimals, TreasuryCap + faucet

## Key Architecture Decisions
- **UTXO model**: old commitment consumed, new commitment created per transfer
- **Note-based nullifiers**: Poseidon(2, secret, epoch, randOld) -- unique per transfer, not per epoch
- **Identity-bound commitments**: Poseidon(1, cum, rand, userSecret) -- prevents commitment theft
- **Standard deposits**: 100/500/1000 TOKEN denominations only (amount correlation resistance)
- **VK timelock**: 1-epoch delay for verification key updates
- **Privacy events**: no sender, recipient, or amount in any emitted event

## Security Audit Summary
- Loop 1: 92 findings, 16 critical fixes
- Loop 2: 24 findings, UTXO model introduced
- Loop 3: 5 findings, UTXO verified correct
- Loop 4: CLEAN (0 critical, 0 high, 0 medium)
- Privacy red team: 15 findings, standard deposits applied

## Error Codes (pool.move)
```
E_FROZEN=1, E_NULLIFIER_SPENT=2, E_INVALID_PROOF=3, E_NOT_POOL_ADMIN=4,
E_THRESHOLD_MISMATCH=5, E_INSUFFICIENT_BALANCE=6, E_INVALID_INPUTS_LENGTH=7,
E_EPOCH_MISMATCH=8, E_COMMITMENT_CHAIN_BROKEN=9, E_COMMITMENT_EXISTS=10,
E_DUST_DEPOSIT=11, E_NON_STANDARD_AMOUNT=14
```

## Testnet Deployment
- Package: `0xd0598d2256bfa33b8324bc6316cee1118f9131cdde346f8f1f757adb594a66bb`
- Chain: testnet (4c78adac)
- Toolchain: sui 1.72.1, Move edition 2024

## Skills
- `/sui-move` -- Sui Move patterns
- `/blockchain-dev` -- cross-chain development
