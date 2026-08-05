#!/bin/bash
# compile-withdraw.sh — Full-circuit comparison: withdraw.circom (circomlib
# Poseidon) vs withdraw_poseidon2.circom (taceo Poseidon2). Compiles both,
# runs a dev-only Groth16 trusted setup for both against the same
# Powers-of-Tau file, so `node circuits/bench/withdraw_compare.mjs` can time
# real fullProve calls on both.
#
# Usage: bash circuits/bench/compile-withdraw.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build-withdraw-compare"
PTAU_FILE="$BUILD_DIR/pot13_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_13.ptau"

cd "$CIRCUITS_DIR"
if [ ! -d node_modules/@taceo ]; then
  npm install
fi
if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found (see circuits/bench/compile.sh for how to build v2.2.2 from source)."
  exit 1
fi

mkdir -p "$BUILD_DIR"

echo "[1/3] Compiling withdraw.circom (original, circomlib Poseidon)..."
circom withdraw.circom --r1cs --wasm --sym --output "$BUILD_DIR" -l node_modules
npx snarkjs r1cs info "$BUILD_DIR/withdraw.r1cs"

echo "[2/3] Compiling withdraw_poseidon2.circom (Poseidon2 variant)..."
circom "$SCRIPT_DIR/withdraw_poseidon2.circom" --r1cs --wasm --sym --output "$BUILD_DIR" -l node_modules
npx snarkjs r1cs info "$BUILD_DIR/withdraw_poseidon2.r1cs"

if [ ! -f "$PTAU_FILE" ]; then
  echo "[3/3] Fetching pot13 Powers of Tau (8192 constraints — withdraw_poseidon2 needs ~5,900)..."
  curl -sS -L -o "$PTAU_FILE" "$PTAU_URL"
fi

for f in withdraw withdraw_poseidon2; do
  npx snarkjs groth16 setup "$BUILD_DIR/$f.r1cs" "$PTAU_FILE" "$BUILD_DIR/${f}_0000.zkey"
  echo "bench-dev-entropy-$(date +%s)" | npx snarkjs zkey contribute \
    "$BUILD_DIR/${f}_0000.zkey" "$BUILD_DIR/${f}_final.zkey" --name="bench-dev" -v
  npx snarkjs zkey export verificationkey "$BUILD_DIR/${f}_final.zkey" "$BUILD_DIR/${f}_vk.json"
done

echo ""
echo "=== Done ==="
echo "Run: node circuits/bench/withdraw_compare.mjs --runs 10"
echo "Negative test: node circuits/bench/withdraw_poseidon2_negative_test.mjs"
