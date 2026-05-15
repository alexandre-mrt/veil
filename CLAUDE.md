# Veil -- Privacy Payment Protocol on Sui

## Overview
ZK privacy payments with cumulative spending proofs and UTXO-style commitments on Sui.
Circuit v2: Poseidon(4) identity-bound commitments, note-based nullifiers, domain-separated txAmountHash.
4-loop security audit + sui-critic review (88/100). 85 Move tests, 0 failures.
Tier 3 compliance: dual Groth16 proofs (transfer + compliance.circom), context-bound credential nullifiers (unique per transfer), ECDH P-256 + AES-GCM auditor encryption.
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
- Move tests (85): `cd contracts && sui move test`
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
- Package: `0x468e707669e33ef8664fd0f25fb16ee86623feab98254cc9c22044e79a371737`
- Pool: `0x9b8e6bb7f09a483d8ec50c91f9e9f64a1d91bac64706afe56653c46a1ed720ba`
- ComplianceConfig: `0x5999ace2cfcc952dc66dce83b3314930e435f99ee49abc11972871b5ecf5ed29`
- AdminCap: `0xd35a6feee94564c8a65d709a8f0968819f3cc2527db4f8dc0f98a4f8fad8e5d3`
- TreasuryCap: `0xf2b51f2995dc8fdebb0342cabc3d162b7159a91cda2ecb1d1b46988129e366d2`
- Frontend: https://frontend-sepia-nine-30.vercel.app
- Chain: testnet, Toolchain: sui 1.72.1, Move edition 2024

## Skills
- `/sui-move` -- Sui Move patterns
- `/blockchain-dev` -- cross-chain development
