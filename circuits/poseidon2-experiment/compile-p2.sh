#!/bin/bash
# compile-p2.sh — Compile the three EXPERIMENTAL Poseidon2 circuit variants and
# run a dev-only Groth16 trusted setup for each, mirroring ../scripts/compile*.sh.
#
# Usage: bash compile-p2.sh [--skip-ptau]
#
# Requires: circom 2.2.2+ (this experiment's poseidon2_hash.circom needs 2.2.2 —
#   see ../../docs/research/2026-09-01-poseidon2-constraint-delta.md's Approach
#   section for how to build it: `cargo build --release` against
#   `iden3/circom` tag `v2.2.2`, same as the 2026-07-22 baseline), snarkjs 0.7.x.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
PTAU_FILE="$BUILD_DIR/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"

cd "$SCRIPT_DIR"

if [ ! -d node_modules ]; then
  echo "[1/4] Installing dependencies (circomlib, @taceo/circom-lib)..."
  npm install
fi

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH. See this script's header comment."
  exit 1
fi
echo "circom version: $(circom --version)"

mkdir -p "$BUILD_DIR"

SKIP_PTAU=false
for arg in "$@"; do
  [ "$arg" = "--skip-ptau" ] && SKIP_PTAU=true
done

if [ ! -f "$PTAU_FILE" ] && [ "$SKIP_PTAU" = "false" ]; then
  echo "[2/4] Downloading Powers of Tau (pot15, ~36MB, same file the production circuits use)..."
  curl -sS -L -o "$PTAU_FILE" "$PTAU_URL"
fi

for name in transfer_p2 compliance_p2 withdraw_p2; do
  echo "[3/4] Compiling $name.circom..."
  circom "$name.circom" --r1cs --wasm --sym --output "$BUILD_DIR" -l .
  snarkjs r1cs info "$BUILD_DIR/$name.r1cs"

  echo "[4/4] Groth16 setup for $name (dev-only, single contribution — NOT production)..."
  snarkjs groth16 setup "$BUILD_DIR/$name.r1cs" "$PTAU_FILE" "$BUILD_DIR/${name}_0000.zkey"
  echo "veil-p2-bench-entropy-$(date +%s%N)" | snarkjs zkey contribute \
    "$BUILD_DIR/${name}_0000.zkey" "$BUILD_DIR/${name}_final.zkey" --name="veil-p2-bench" -v
  snarkjs zkey export verificationkey "$BUILD_DIR/${name}_final.zkey" "$BUILD_DIR/${name}_vk.json"
done

echo ""
echo "=== Build complete === (all artifacts under $BUILD_DIR, gitignored)"
echo "Next: node ../../scripts/bench/poseidon2-prove-latency.mjs --runs 10"
echo "      node negative-test.mjs"
