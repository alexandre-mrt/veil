#!/bin/bash
# compile-bench.sh — build the Poseidon vs Poseidon2 microbenchmark circuits.
#
# Compiles 8 standalone circuits (baseline Poseidon hash2/hash3/merkle20,
# Poseidon2 hash2/hash3/merkle20, and two "checked" Poseidon2 wrappers used
# by the negative test in test/poseidon2-microbench.test.mjs), then runs a
# Groth16 setup for each against a *locally generated* dev-only Powers of Tau
# (this sandbox has no network path to the usual hosted ptau mirrors — both
# storage.googleapis.com/zkevm and the Hermez S3 bucket returned AccessDenied
# directly from the object store, not from a local proxy — so this generates
# its own, exactly like circuits/scripts/compile.sh's existing single-dev-
# contributor setup, just skipping the download).
#
# Usage: bash circuits/bench/compile-bench.sh
# Requires: circom 2.2.x on PATH, snarkjs (circuits/node_modules), Node 18+.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
PTAU="$BUILD_DIR/pot14_final.ptau"

cd "$CIRCUITS_DIR"

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH (see circuits/scripts/compile.sh for build-from-source instructions)."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[1/4] Installing circuits/ dependencies (includes @taceo/poseidon2, @zkpassport/poseidon2)..."
  npm install
fi

echo "[2/4] Regenerating bench/poseidon2.circom from the extraction script..."
node "$SCRIPT_DIR/../../scripts/bench/poseidon2-constants.mjs"

NAMES="hash2_poseidon hash3_poseidon hash2_poseidon2 hash3_poseidon2 merkle20_poseidon merkle20_poseidon2 hash2_poseidon2_checked hash3_poseidon2_checked"

echo "[3/4] Compiling circuits..."
mkdir -p "$BUILD_DIR"
for name in $NAMES; do
  mkdir -p "$BUILD_DIR/$name"
  circom "bench/mains/$name.circom" --r1cs --wasm --sym --output "$BUILD_DIR/$name" -l node_modules
done

echo "[4/4] Groth16 setup (local dev-only ptau, generated once and reused for every circuit here)..."
if [ ! -f "$PTAU" ]; then
  npx snarkjs powersoftau new bn128 14 "$BUILD_DIR/pot14_0000.ptau" -v
  echo "veil-bench-entropy-$(date +%s)" | npx snarkjs powersoftau contribute \
    "$BUILD_DIR/pot14_0000.ptau" "$BUILD_DIR/pot14_0001.ptau" --name="veil-bench" -v
  npx snarkjs powersoftau prepare phase2 "$BUILD_DIR/pot14_0001.ptau" "$PTAU" -v
fi

for name in $NAMES; do
  npx snarkjs groth16 setup "$BUILD_DIR/$name/$name.r1cs" "$PTAU" "$BUILD_DIR/$name/${name}_0000.zkey"
  echo "veil-bench-$(date +%s)" | npx snarkjs zkey contribute \
    "$BUILD_DIR/$name/${name}_0000.zkey" "$BUILD_DIR/$name/${name}_final.zkey" --name="veil-bench" -v
  npx snarkjs zkey export verificationkey \
    "$BUILD_DIR/$name/${name}_final.zkey" "$BUILD_DIR/$name/${name}_vk.json"
done

echo ""
echo "=== Bench build complete ==="
echo "Run: node scripts/bench/poseidon2-microbench.mjs"
