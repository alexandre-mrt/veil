# Veil -- Privacy Payment Protocol on Sui

## Overview
ZK privacy payments with cumulative spending proofs and UTXO-style commitments on Sui.
Circuit v2: Poseidon(4) identity-bound commitments, note-based nullifiers, domain-separated txAmountHash.
6-loop security audit (4 contract + 1 comprehensive 11-agent + 1 validation). Final grade: 157.8/165 (95.6%). 124 Move tests, 3456+ total tests, 0 failures.
Tier 3 compliance: dual Groth16 proofs (transfer + compliance.circom), context-bound credential nullifiers (unique per transfer), ECDH P-256 + AES-GCM auditor encryption.
Merkle accumulator (depth-20 Poseidon tree) for commitment privacy. Multi-sig governance (multisig.move). Partial ZK withdrawal.
Frontend: @mysten/dapp-kit-react v2 + SuiGrpcClient. Compliance UI wired end-to-end.

## Structure
- `contracts/` -- Sui Move (pool, compliance, verifier, token, multisig + token_faucet)
- `circuits/` -- Circom ZK circuits (transfer.circom 11c, compliance.circom ~7200c, withdraw.circom 9c)
- `frontend/` -- Next.js 14 + @mysten/dapp-kit + snarkjs WASM
- `scripts/` -- deployment, proof conversion, E2E pipeline, relayer
- `docs/` -- architecture, C4 diagrams, HTML report

## Commands

### Build
- Build contract: `cd contracts && sui move build`
- Compile circuit: `cd circuits && bash scripts/compile.sh`
- Frontend dev: `cd frontend && bun run dev`
- Install all: `bash scripts/init.sh`

### Test
- Move tests (124): `cd contracts && sui move test`
- Circuit tests (100): `cd circuits && npm test`
- Converter tests (109): `cd scripts && bun run src/test-converter.ts`
- Frontend tests (19): `cd frontend && bun run test`
- E2E pipeline: `cd scripts && bun run src/e2e-test.ts`

### Relayer (Sender Privacy)
- Demo: `cd scripts && bun run relayer:demo`
- Server: `cd scripts && bun run relayer` (port 3001)
- Help: `cd scripts && bun run src/relayer.ts --help`

## Stack
- Circom 2.1 + snarkjs 0.7 (BN254 Groth16)
- Sui Move 2024 + `sui::groth16` native verifier
- Next.js 14 + @mysten/dapp-kit 1.x
- VEIL token: 6 decimals, TreasuryCap + faucet

## Key Architecture Decisions
- **Merkle accumulator**: commitments inserted into off-chain Poseidon Merkle tree (depth 20), root stored on-chain with admin timelock updates. Transfer circuit proves membership (anonymity set = all commitments ever inserted)
- **UTXO model**: old commitment consumed, new commitment created per transfer
- **Note-based nullifiers**: Poseidon(2, secret, epoch, randOld) -- unique per transfer, not per epoch
- **Identity-bound commitments**: Poseidon(1, cum, rand, userSecret) -- prevents commitment theft
- **Standard deposits**: 100/500/1000 TOKEN denominations only (amount correlation resistance)
- **VK timelock**: 1-epoch delay for verification key updates (both transfer VK and withdraw VK)
- **Privacy events**: no sender, recipient, or amount in any emitted event
- **Sponsored tx relayer**: hides sender address on-chain via Sui gas sponsorship

## Security Audit Summary
- Loop 1: 92 findings, 16 critical fixes
- Loop 2: 24 findings, UTXO model introduced
- Loop 3: 5 findings, UTXO verified correct
- Loop 4: CLEAN (0 critical, 0 high, 0 medium)
- Loop 5: 11-agent comprehensive audit (68 findings: 3C, 5H, 15M, 25L, 20I) -- see docs/loop5-audit-report.md
- Privacy red team: 15 findings, standard deposits applied
- Final grade: **157.8/165 (95.6%) -- EXCEPTIONAL** (7 grading iterations) -- see docs/final-grade-report.md

## Error Codes
### pool.move (1-35)
```
E_FROZEN=1, E_NULLIFIER_SPENT=2, E_INVALID_PROOF=3, E_NOT_POOL_ADMIN=4,
E_THRESHOLD_MISMATCH=5, E_INSUFFICIENT_BALANCE=6, E_INVALID_INPUTS_LENGTH=7,
E_EPOCH_MISMATCH=8, E_COMMITMENT_CHAIN_BROKEN=9, E_COMMITMENT_EXISTS=10,
E_DUST_DEPOSIT=11, E_NON_STANDARD_AMOUNT=14, E_COMPLIANCE_REQUIRED=15,
E_COMMITMENT_NOT_MATURE=16, E_VK_UPDATE_PENDING=17, E_INVALID_VK_LENGTH=18,
E_COMPLIANCE_TOGGLE_PENDING=19, E_POOL_NOT_FROZEN=20, E_WITHDRAWAL_PENDING=21,
E_WITHDRAWAL_NOT_READY=22, E_NO_PENDING_WITHDRAWAL=23, E_NO_PENDING_COMPLIANCE_TOGGLE=24,
E_COMPLIANCE_CONFIG_ALREADY_SET=25, E_EMERGENCY_WITHDRAW_NOT_READY=26,
E_NO_COMPLIANCE_CONFIG=27, E_INVALID_WITHDRAW_PROOF=28, E_NO_WITHDRAW_VK=29,
E_INVALID_RECIPIENT=30, E_INVALID_EPOCH_DURATION=31,
E_MERKLE_ROOT_MISMATCH=32, E_INVALID_COMMITMENT_ROOT_LENGTH=33,
E_COMMITMENT_ROOT_UPDATE_PENDING=34, E_EPOCH_DURATION_UPDATE_PENDING=35
```
### compliance.move (100-115)
```
E_COMPLIANCE_PROOF_INVALID=100, E_CREDENTIAL_NULLIFIER_SPENT=101,
E_CREDENTIAL_ROOT_MISMATCH=102, E_INVALID_COMPLIANCE_INPUTS=103,
E_CREDENTIAL_INVALID=105, E_CONFIG_POOL_MISMATCH=106,
E_CREDENTIAL_ROOT_UPDATE_PENDING=108, E_INVALID_ENCRYPTED_AMOUNT=109,
E_INVALID_AUDITOR_KEY=110, E_AUDITOR_KEY_UPDATE_PENDING=111,
E_INVALID_VK_LENGTH=112, E_KYC_LEVEL_UPDATE_PENDING=113,
E_COMPLIANCE_VK_UPDATE_PENDING=114, E_POOL_NOT_FROZEN=115
```
### multisig.move (200-205)
```
E_NOT_SIGNER=200, E_ALREADY_APPROVED=201, E_INSUFFICIENT_APPROVALS=202,
E_ACTION_NOT_APPROVED=203, E_INVALID_SIGNER_COUNT=204, E_POOL_MISMATCH=205
```

## Testnet Deployment
- Package: `0x5cd79f85f1adca022513d76c60d557f8b17afed91f741d14016c7a23cab6c228`
- Pool: `0x6ba8019987c7c5d02d2c2b11e0eddd491428d0cc6bbed05ab79760e069ce913a`
- ComplianceConfig: `0xa6c92b963d9b67896416ae2eb23f0fadbbc62e90fba6ca18db5f96b6bc4f63c7`
- AdminCap: `0x038754ce782a7670884961335a7d7e50215a4793d2c44dde208c2527eeed28d4`
- TreasuryCap: `0xdc0f16084cbd2d33d1fc3630e80bac565469550e93c5e147a7d9c04fa4a3058f`
- UpgradeCap: `0x81637da203607af529fc2652c49d709e48d2246bc6097963ffb358d6b28a018e`
- Frontend: https://frontend-sepia-nine-30.vercel.app
- Chain: testnet, Epoch duration: 1h, Move edition 2024

## Deployment Gotchas
- **CSP**: Next.js needs `unsafe-inline` + `unsafe-eval` in script-src. Wallet SDKs need `*.sui.io`, `api.slush.app` in connect-src. Google Fonts need style-src + font-src entries.
- **gRPC URL**: use `fullnode.testnet.sui.io:443` (not `sui-testnet.mystenlabs.com` which has no DNS)
- **Dynamic imports**: `new Function("m", "return import(m)")` fails in production bundles. Use real `import()` in a switch with `@ts-expect-error`.
- **Vercel deploy**: always `vercel --prod --force --yes`. Plain `--prod` may not update the alias.
- **TreasuryCap**: owned by deployer after publish. Transfer to user/multisig if faucet should be user-callable.
- **Module splits**: when moving functions between modules, update ALL frontend references to the new target path.

## Skills
- `/sui-move` -- Sui Move patterns
- `/blockchain-dev` -- cross-chain development
