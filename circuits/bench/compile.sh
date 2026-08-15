#!/bin/bash
# compile.sh — Compile the 8 Poseidon1-vs-Poseidon2 arity benchmark circuits and run a
# (dev-only) Groth16 trusted setup for each, reusing pot15 like the production circuits.
# Usage: bash circuits/bench/compile.sh
#
# Requires: circom 2.2.x on PATH, node/npx (snarkjs).
# Output artifacts go to circuits/bench/build/ (gitignored).
#
# See docs/research/2026-08-15-poseidon2-benchmark.md for what this benchmark measures and why.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_DIR="$SCRIPT_DIR"
CIRCUITS_DIR="$(cd "$BENCH_DIR/.." && pwd)"
BUILD_DIR="$BENCH_DIR/build"
PTAU_FILE="$BUILD_DIR/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"

cd "$BENCH_DIR"

if [ ! -d "$CIRCUITS_DIR/node_modules" ]; then
  echo "Installing circuits/ dependencies (circomlib, @taceo/circom-lib, snarkjs)..."
  (cd "$CIRCUITS_DIR" && npm install)
fi

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH. Install it (see README.md prerequisites)."
  exit 1
fi

mkdir -p "$BUILD_DIR"

if [ ! -f "$PTAU_FILE" ]; then
  echo "Downloading pot15 Powers of Tau..."
  curl -sS -o "$PTAU_FILE" "$PTAU_URL"
fi

CIRCUITS=(poseidon1_n2 poseidon1_n3 poseidon1_n4 poseidon1_n5 poseidon2_n2 poseidon2_n3 poseidon2_n4 poseidon2_n5)

for name in "${CIRCUITS[@]}"; do
  echo "=== $name ==="
  circom "circuits/${name}.circom" --r1cs --wasm --sym -o "$BUILD_DIR" -l "$CIRCUITS_DIR/node_modules"
  npx --prefix "$CIRCUITS_DIR" snarkjs groth16 setup "$BUILD_DIR/${name}.r1cs" "$PTAU_FILE" "$BUILD_DIR/${name}_0000.zkey"
  echo "bench-dev-contribution-${name}" | npx --prefix "$CIRCUITS_DIR" snarkjs zkey contribute \
    "$BUILD_DIR/${name}_0000.zkey" "$BUILD_DIR/${name}_final.zkey" --name="bench dev contribution" -v
  npx --prefix "$CIRCUITS_DIR" snarkjs zkey export verificationkey "$BUILD_DIR/${name}_final.zkey" "$BUILD_DIR/${name}_vk.json"
  npx --prefix "$CIRCUITS_DIR" snarkjs r1cs info "$BUILD_DIR/${name}.r1cs"
done

echo "Done. Artifacts in $BUILD_DIR"
