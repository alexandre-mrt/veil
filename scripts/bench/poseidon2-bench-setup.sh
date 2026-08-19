#!/bin/bash
# poseidon2-bench-setup.sh — Compile the Poseidon-vs-Poseidon2 arity benchmark circuits
# (circuits/research/poseidon2/bench/*.circom) and run a real (test-only, single-contribution,
# LOCALLY GENERATED — no network fetch) Groth16 trusted setup for each, so
# poseidon2-prove-latency.mjs can time real snarkjs.groth16.fullProve calls.
#
# All eight benchmark circuits are small (<=1663 R1CS constraints — see
# docs/research/2026-08-19-poseidon2-arity-benchmark.md), so a single pot12 (2^12 = 4096)
# Powers of Tau, generated fresh in a few seconds, covers every one of them; there is no need to
# download the pot15 ptau circuits/scripts/compile.sh uses for the real protocol circuits.
#
# Usage: bash scripts/bench/poseidon2-bench-setup.sh
# Requires: circom 2.2.x on PATH, snarkjs 0.7.x (via npx, from circuits/node_modules)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BENCH_DIR="$REPO_ROOT/circuits/research/poseidon2/bench"
BUILD_DIR="$BENCH_DIR/build"
CIRCUITS=(poseidon_n2 poseidon_n3 poseidon_n4 poseidon_n5 poseidon2_n2 poseidon2_n3 poseidon2_n4_padded_t8 poseidon2_n5_padded_t8)

cd "$REPO_ROOT/circuits"

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH."
  exit 1
fi

mkdir -p "$BUILD_DIR"

echo "[1/3] Compiling ${#CIRCUITS[@]} benchmark circuits..."
for name in "${CIRCUITS[@]}"; do
  circom "research/poseidon2/bench/${name}.circom" --r1cs --wasm --sym --output "$BUILD_DIR"
done

PTAU="$BUILD_DIR/pot12_final.ptau"
if [ ! -f "$PTAU" ]; then
  echo "[2/3] Generating a fresh local pot12 Powers of Tau (test-only, single contribution)..."
  npx snarkjs powersoftau new bn128 12 "$BUILD_DIR/pot12_0000.ptau" -v
  npx snarkjs powersoftau contribute "$BUILD_DIR/pot12_0000.ptau" "$BUILD_DIR/pot12_0001.ptau" \
    --name="veil-research bench (not for production)" -v -e="$(head -c32 /dev/urandom | base64)"
  npx snarkjs powersoftau prepare phase2 "$BUILD_DIR/pot12_0001.ptau" "$PTAU" -v
else
  echo "[2/3] Reusing existing $PTAU"
fi

echo "[3/3] Groth16 setup (per circuit)..."
for name in "${CIRCUITS[@]}"; do
  ZKEY0="$BUILD_DIR/${name}_0000.zkey"
  ZKEY="$BUILD_DIR/${name}_final.zkey"
  if [ -f "$ZKEY" ]; then
    echo "  $name: zkey already exists, skipping"
    continue
  fi
  npx snarkjs groth16 setup "$BUILD_DIR/${name}.r1cs" "$PTAU" "$ZKEY0"
  npx snarkjs zkey contribute "$ZKEY0" "$ZKEY" \
    --name="veil-research bench (not for production)" -v -e="$(head -c32 /dev/urandom | base64)"
  npx snarkjs zkey export verificationkey "$ZKEY" "$BUILD_DIR/${name}_vk.json"
  rm -f "$ZKEY0"
done

echo "Done. Artifacts in $BUILD_DIR"
