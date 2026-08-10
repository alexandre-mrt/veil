#!/bin/bash
# build.sh — Compile all six Poseidon-vs-Poseidon2 benchmark circuits and run
# a real (dev-only, single-contributor) Groth16 trusted setup for each, so
# scripts/bench/poseidon2-latency.mjs and `snarkjs r1cs info` have real
# artifacts to measure against.
#
# See docs/research/2026-08-10-poseidon2-merkle.md for what these circuits
# are and why.
#
# Requires: circom 2.2.x on PATH (or CIRCOM_BIN env var pointing at the
# binary), snarkjs 0.7.x (installed via scripts/bench/package.json).
#
# Usage:
#   bash scripts/bench/circuits/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../../circuits" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
PTAU_FILE="$BUILD_DIR/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"
CIRCOM="${CIRCOM_BIN:-circom}"
SNARKJS="npx --prefix $SCRIPT_DIR/../../bench snarkjs"

CIRCUITS=(
  merkle_poseidon
  merkle_poseidon2
  hash_arity3_poseidon
  hash_arity3_poseidon2
  hash_arity4_poseidon
  hash_arity4_poseidon2_padded
)

mkdir -p "$BUILD_DIR"

if [ ! -f "$PTAU_FILE" ]; then
  echo "Downloading Powers of Tau (pot15, ~36MB)..."
  curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"
fi

for name in "${CIRCUITS[@]}"; do
  echo "=== $name ==="
  "$CIRCOM" "$SCRIPT_DIR/$name.circom" --r1cs --wasm --sym --output "$BUILD_DIR" -l "$CIRCUITS_DIR/node_modules"
  $SNARKJS r1cs info "$BUILD_DIR/$name.r1cs"
  $SNARKJS groth16 setup "$BUILD_DIR/$name.r1cs" "$PTAU_FILE" "$BUILD_DIR/${name}_0000.zkey"
  echo "veil-bench-entropy-$name-$RANDOM" | $SNARKJS zkey contribute \
    "$BUILD_DIR/${name}_0000.zkey" "$BUILD_DIR/${name}_final.zkey" --name="veil-bench" -v
  echo
done

echo "=== Build complete. Run: node $SCRIPT_DIR/../poseidon2-latency.mjs --runs 10 ==="
