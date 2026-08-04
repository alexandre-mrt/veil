#!/bin/bash
# build-circuits.sh — Compile the three Poseidon2-vs-Poseidon research
# circuits and run a minimal Groth16 setup for the negative-test circuit.
#
# Usage: bash scripts/bench/poseidon2-vs-poseidon/build-circuits.sh
#
# Requires: circom 2.2.x, snarkjs 0.7.x (via npx from circuits/node_modules)
# Output goes to scripts/bench/poseidon2-vs-poseidon/build/
#
# This reproduces the exact measurements in
# docs/research/2026-08-04-poseidon2-vs-poseidon.md:
#   - main_poseidon2_t3.circom   — the Poseidon2 (t=3) permutation
#   - main_poseidon_t3.circom    — circomlib's Poseidon(2), same t=3 width
#   - main_poseidon2_commit.circom — commitment wrapper for the negative test
#     (circuits/test/poseidon2.test.mjs)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../../circuits" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
PTAU_FILE="$BUILD_DIR/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found (need 2.2.x). See circuits/scripts/compile.sh for install instructions."
  exit 1
fi

mkdir -p "$BUILD_DIR"
cd "$SCRIPT_DIR"

echo "[1/4] Compiling main_poseidon2_t3.circom (default O1, matches Veil's compile*.sh)..."
circom main_poseidon2_t3.circom --r1cs --wasm --sym -o "$BUILD_DIR" -l "$CIRCUITS_DIR/node_modules"
echo "[1/4] snarkjs r1cs info:"
npx --prefix "$CIRCUITS_DIR" snarkjs r1cs info "$BUILD_DIR/main_poseidon2_t3.r1cs"

echo "[2/4] Compiling main_poseidon_t3.circom (circomlib Poseidon(2), same t=3, default O1)..."
circom main_poseidon_t3.circom --r1cs --wasm --sym -o "$BUILD_DIR" -l "$CIRCUITS_DIR/node_modules/circomlib/circuits"
echo "[2/4] snarkjs r1cs info:"
npx --prefix "$CIRCUITS_DIR" snarkjs r1cs info "$BUILD_DIR/main_poseidon_t3.r1cs"

echo "[3/4] Compiling main_poseidon2_commit.circom (negative-test wrapper)..."
circom main_poseidon2_commit.circom --r1cs --wasm --sym -o "$BUILD_DIR" -l "$CIRCUITS_DIR/node_modules"

echo "[4/4] Groth16 setup for main_poseidon2_commit (dev-only, for testing)..."
if [ ! -f "$PTAU_FILE" ]; then
  curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"
fi
npx --prefix "$CIRCUITS_DIR" snarkjs groth16 setup \
  "$BUILD_DIR/main_poseidon2_commit.r1cs" "$PTAU_FILE" "$BUILD_DIR/main_poseidon2_commit_0000.zkey"
echo "veil-research-dev-entropy-$(date +%s)" | npx --prefix "$CIRCUITS_DIR" snarkjs zkey contribute \
  "$BUILD_DIR/main_poseidon2_commit_0000.zkey" "$BUILD_DIR/main_poseidon2_commit_final.zkey" --name="dev" -v
npx --prefix "$CIRCUITS_DIR" snarkjs zkey export verificationkey \
  "$BUILD_DIR/main_poseidon2_commit_final.zkey" "$BUILD_DIR/main_poseidon2_commit_vk.json"

echo ""
echo "=== Build complete === Run: cd circuits && node --experimental-vm-modules test/poseidon2.test.mjs"
