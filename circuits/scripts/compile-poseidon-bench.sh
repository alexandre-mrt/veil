#!/bin/bash
# compile-poseidon-bench.sh — Compile the standalone Poseidon vs Poseidon2 benchmark
# circuits in circuits/bench/ and run a dev Groth16 setup for each.
#
# These circuits are NOT part of the protocol (transfer/compliance/withdraw are
# untouched) — they exist only to measure the constraint-count and proving-time
# delta between circomlib's Poseidon and TACEO's audited Poseidon2 port at the
# exact arities Veil's circuits use. See docs/research/ for the experiment
# this supports.
#
# Usage: bash scripts/compile-poseidon-bench.sh [--skip-ptau] [--O2]
#   --O2 compiles with circom's full constraint simplification instead of the
#   default --O1 that transfer.circom/compliance.circom/withdraw.circom are
#   actually built with (see compile*.sh) — useful for separating "real" R1CS
#   constraints from ones the production build's O1 pass leaves un-simplified.
#   Output goes to bench/build-O2/ instead of bench/build/ so both are kept.
# Requires: circom 2.2.x on PATH, snarkjs (via npx), @taceo/circom-lib installed
# (npm install in circuits/).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCH_DIR="$CIRCUITS_DIR/bench"

CIRCUITS="poseidon_n2 poseidon_n3 poseidon_n4 poseidon_n5 poseidon2_t3 poseidon2_t4 poseidon2_t8 poseidon2_check_t4"

cd "$CIRCUITS_DIR"

if [ ! -d node_modules ]; then
  echo "[setup] Installing dependencies..."
  npm install
fi

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH. See circuits/scripts/compile.sh for install instructions."
  exit 1
fi

SKIP_PTAU=false
OPT_FLAG=""
BUILD_DIR="$BENCH_DIR/build"
for arg in "$@"; do
  [ "$arg" = "--skip-ptau" ] && SKIP_PTAU=true
  if [ "$arg" = "--O2" ]; then
    OPT_FLAG="--O2"
    BUILD_DIR="$BENCH_DIR/build-O2"
  fi
done
PTAU_FILE="$BUILD_DIR/pot12_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau"

mkdir -p "$BUILD_DIR"

if [ ! -f "$PTAU_FILE" ] && [ "$SKIP_PTAU" = "false" ]; then
  echo "[setup] Downloading Powers of Tau (pot12, ~4.8MB — these circuits are all under 4096 constraints)..."
  curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"
fi

for name in $CIRCUITS; do
  echo ""
  echo "=== $name ==="
  circom "bench/$name.circom" --r1cs --wasm --sym $OPT_FLAG --output "$BUILD_DIR" -l node_modules
  echo "Constraint count:"
  npx snarkjs r1cs info "$BUILD_DIR/$name.r1cs"

  if [ -f "$PTAU_FILE" ]; then
    npx snarkjs groth16 setup "$BUILD_DIR/$name.r1cs" "$PTAU_FILE" "$BUILD_DIR/${name}_0000.zkey"
    echo "veil-bench-dev-entropy-$(date +%s)-$name" | npx snarkjs zkey contribute \
      "$BUILD_DIR/${name}_0000.zkey" "$BUILD_DIR/${name}_final.zkey" \
      --name="veil-bench-dev" -v
    rm -f "$BUILD_DIR/${name}_0000.zkey"
  fi
done

echo ""
echo "=== Bench build complete ==="
echo "Run: node ../scripts/bench/poseidon2-delta.mjs"
