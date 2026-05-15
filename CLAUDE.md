# Veil -- Privacy Payment Protocol on Sui

## Overview
ZK privacy payments with cumulative spending proofs and UTXO-style commitments on Sui.
Circuit v2: Poseidon(4) identity-bound commitments, note-based nullifiers, domain-separated txAmountHash.
4-loop security audit + sui-critic review (88/100). 79 Move tests, 0 failures.
Tier 3 compliance: dual Groth16 proofs (transfer + compliance.circom), epoch-scoped credential nullifiers, ECDH P-256 + AES-GCM auditor encryption.
Frontend: @mysten/dapp-kit-react v2 + SuiGrpcClient. Compliance UI wired end-to-end.

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
- Move tests (79): `cd contracts && sui move test`
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
E_DUST_DEPOSIT=11, E_NON_STANDARD_AMOUNT=14, E_COMPLIANCE_REQUIRED=15,
E_COMMITMENT_NOT_MATURE=16, E_VK_UPDATE_PENDING=17
```

## Testnet Deployment
- Package: `0x2cacdf4d2502f3870497bef4952bbb6f9646b4db03e446cfaa2e03d333b1c581`
- Pool: `0x867d3cc126ca82366c6f05e4dffa61bbb18d780b82f1ce35adba95695f2e856f`
- ComplianceConfig: `0xa01f5a2b89f38d8b4011c7abb6299a51dedd1bda977e0c5c14c52922b16d0859`
- AdminCap: `0xd154d5f8ff253a807398fb6daf84455cf2f0c5c8212adcd4ff2dfac4d892c106`
- TreasuryCap: `0x1a4570f7b66e93d87d696795686d915de35d9b069b0b4cf95bac7b3c5fef8b83`
- Frontend: https://frontend-sepia-nine-30.vercel.app
- Chain: testnet, Toolchain: sui 1.72.1, Move edition 2024

## Skills
- `/sui-move` -- Sui Move patterns
- `/blockchain-dev` -- cross-chain development
