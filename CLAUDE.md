# Veil — Privacy Payment Protocol on Sui

## Overview
ZK privacy payments with cumulative spending proofs and tiered KYC on Sui.

## Structure
- contracts/ — Sui Move (pool, verifier, token)
- circuits/ — Circom ZK circuits
- frontend/ — Next.js + dApp-kit + snarkjs
- scripts/ — deployment, proof conversion

## Commands
- Build contract: `cd contracts && sui move build`
- Test contract: `cd contracts && sui move test`
- Compile circuit: `cd circuits && bash scripts/compile.sh`
- Test circuit: `cd circuits && npm test`
- Frontend dev: `cd frontend && bun run dev`
- Install all: `bash scripts/init.sh`

## Stack
Circom 2.1 + snarkjs (BN254 Groth16), Sui Move 2024, Next.js 14, @mysten/dapp-kit 1.x
