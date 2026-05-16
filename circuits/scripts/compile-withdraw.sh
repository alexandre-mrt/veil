#!/bin/bash
# compile-withdraw.sh — Compile withdraw.circom and run Groth16 trusted setup
# Usage: bash scripts/compile-withdraw.sh [--skip-ptau]
#
# Requires: circom 2.1.x, snarkjs 0.7.x (global or via npx)
# Output artifacts go to circuits/build-withdraw/
#
# NOTE: This uses a single dev contributor for the trusted setup.
# For production, use ceremony.sh with multiple contributors.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build-withdraw"
CIRCUIT_NAME="withdraw"
PTAU_FILE="$CIRCUITS_DIR/build/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"
FRONTEND_CIRCUITS_DIR="$CIRCUITS_DIR/../frontend/public/circuits"

cd "$CIRCUITS_DIR"

echo "=== Veil Withdraw Circuit Compiler ==="
echo "Working directory: $CIRCUITS_DIR"

# -- Install dependencies if needed -----------------------------------------------
if [ ! -d node_modules ]; then
  echo "[1/6] Installing dependencies..."
  npm install
else
  echo "[1/6] Dependencies already installed."
fi

# -- Check circom -----------------------------------------------------------------
if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found. Install it with:"
  echo "  curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh"
  echo "  cargo install circom"
  exit 1
fi

CIRCOM_VERSION=$(circom --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
echo "circom version: $CIRCOM_VERSION"

mkdir -p "$BUILD_DIR"

# -- Compile circuit ---------------------------------------------------------------
echo "[2/6] Compiling $CIRCUIT_NAME.circom..."
circom "$CIRCUIT_NAME.circom" \
  --r1cs \
  --wasm \
  --sym \
  --output "$BUILD_DIR"

echo "Constraint count:"
snarkjs r1cs info "$BUILD_DIR/$CIRCUIT_NAME.r1cs"

# -- Download powers of tau (skip if already present or --skip-ptau) ---------------
SKIP_PTAU=false
for arg in "$@"; do
  [ "$arg" = "--skip-ptau" ] && SKIP_PTAU=true
done

if [ ! -f "$PTAU_FILE" ] && [ "$SKIP_PTAU" = "false" ]; then
  echo "[3/6] Downloading Powers of Tau (pot15, ~85MB)..."
  mkdir -p "$(dirname "$PTAU_FILE")"
  curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"
elif [ -f "$PTAU_FILE" ]; then
  echo "[3/6] Powers of Tau already present."
else
  echo "[3/6] Skipping ptau download (--skip-ptau flag set)."
  echo "      Place pot15_final.ptau in $(dirname "$PTAU_FILE") to proceed."
  exit 0
fi

# -- Groth16 setup -----------------------------------------------------------------
echo "[4/6] Running Groth16 trusted setup..."
snarkjs groth16 setup \
  "$BUILD_DIR/$CIRCUIT_NAME.r1cs" \
  "$PTAU_FILE" \
  "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey"

# Single dev contribution (non-production — for testing only)
echo "veil-withdraw-entropy-$(date +%s)" | snarkjs zkey contribute \
  "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey" \
  "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
  --name="veil-withdraw-dev" \
  -v

# -- Export verification key -------------------------------------------------------
echo "[5/6] Exporting verification key..."
snarkjs zkey export verificationkey \
  "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
  "$BUILD_DIR/${CIRCUIT_NAME}_vk.json"

# -- Copy artifacts to frontend/public/circuits/ ----------------------------------
echo "[6/6] Copying artifacts to frontend..."
if [ -d "$FRONTEND_CIRCUITS_DIR" ]; then
  cp "$BUILD_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm" "$FRONTEND_CIRCUITS_DIR/${CIRCUIT_NAME}.wasm"
  cp "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" "$FRONTEND_CIRCUITS_DIR/${CIRCUIT_NAME}_final.zkey"
  cp "$BUILD_DIR/${CIRCUIT_NAME}_vk.json" "$FRONTEND_CIRCUITS_DIR/${CIRCUIT_NAME}_vk.json"
  echo "  Copied to $FRONTEND_CIRCUITS_DIR/"
else
  echo "  WARNING: $FRONTEND_CIRCUITS_DIR does not exist. Skipping frontend copy."
  echo "  Create it and re-run, or copy manually."
fi

echo ""
echo "=== Build complete ==="
echo "Artifacts:"
echo "  R1CS:             $BUILD_DIR/$CIRCUIT_NAME.r1cs"
echo "  WASM:             $BUILD_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"
echo "  Final zkey:       $BUILD_DIR/${CIRCUIT_NAME}_final.zkey"
echo "  Verification key: $BUILD_DIR/${CIRCUIT_NAME}_vk.json"
echo ""
echo "Run tests with: npm test"
