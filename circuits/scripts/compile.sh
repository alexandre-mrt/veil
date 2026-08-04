#!/bin/bash
# compile.sh — Compile transfer.circom and run Groth16 trusted setup
# Usage: bash scripts/compile.sh [--skip-ptau]
#
# Requires: circom 2.1.x, snarkjs 0.7.x (global or via npx)
# Output artifacts go to circuits/build/
#
# Compiles with --O2 (full constraint simplification) — measured
# 2026-08-04 to cut this circuit from 13,611 to 6,384 R1CS constraints
# (-53%) and Node proving time from ~770ms to ~614ms, with the existing
# 43-test suite passing unchanged against the O2 build. See
# docs/research/2026-08-04-poseidon2-vs-poseidon.md. NOTE: this changes
# the compiled R1CS relative to any deployment built with the prior
# (O1/default) flags, which changes the verifying key — an existing
# on-chain deployment must go through the timelocked VK-update path
# (see README.md), not a silent redeploy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build"
CIRCUIT_NAME="transfer"
PTAU_FILE="$BUILD_DIR/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"

cd "$CIRCUITS_DIR"

echo "=== Veil Circuit Compiler ==="
echo "Working directory: $CIRCUITS_DIR"

# ── Install dependencies if needed ───────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "[1/5] Installing dependencies..."
  npm install
else
  echo "[1/5] Dependencies already installed."
fi

# ── Check circom ──────────────────────────────────────────────────────────────
if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found. Install it with:"
  echo "  curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh"
  echo "  cargo install circom"
  exit 1
fi

CIRCOM_VERSION=$(circom --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
echo "circom version: $CIRCOM_VERSION"

mkdir -p "$BUILD_DIR"

# ── Compile circuit ───────────────────────────────────────────────────────────
echo "[2/5] Compiling $CIRCUIT_NAME.circom..."
circom "$CIRCUIT_NAME.circom" \
  --r1cs \
  --wasm \
  --sym \
  --O2 \
  --output "$BUILD_DIR"

echo "Constraint count:"
snarkjs r1cs info "$BUILD_DIR/$CIRCUIT_NAME.r1cs"

# ── Download powers of tau (skip if already present or --skip-ptau) ──────────
SKIP_PTAU=false
for arg in "$@"; do
  [ "$arg" = "--skip-ptau" ] && SKIP_PTAU=true
done

if [ ! -f "$PTAU_FILE" ] && [ "$SKIP_PTAU" = "false" ]; then
  echo "[3/5] Downloading Powers of Tau (pot15, ~85MB)..."
  curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"
elif [ -f "$PTAU_FILE" ]; then
  echo "[3/5] Powers of Tau already present."
else
  echo "[3/5] Skipping ptau download (--skip-ptau flag set)."
  echo "      Place pot15_final.ptau in $BUILD_DIR to proceed."
  exit 0
fi

# ── Groth16 setup ─────────────────────────────────────────────────────────────
echo "[4/5] Running Groth16 trusted setup..."
snarkjs groth16 setup \
  "$BUILD_DIR/$CIRCUIT_NAME.r1cs" \
  "$PTAU_FILE" \
  "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey"

# Single dev contribution (non-production — for testing only)
echo "veil-dev-entropy-$(date +%s)" | snarkjs zkey contribute \
  "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey" \
  "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
  --name="veil-dev" \
  -v

# ── Export verification key ───────────────────────────────────────────────────
echo "[5/5] Exporting verification key..."
snarkjs zkey export verificationkey \
  "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
  "$BUILD_DIR/${CIRCUIT_NAME}_vk.json"

echo ""
echo "WARNING: DEV-ONLY single-contributor setup. For production, run: bash scripts/ceremony.sh"
echo ""

echo ""
echo "=== Build complete ==="
echo "Artifacts:"
echo "  R1CS:             $BUILD_DIR/$CIRCUIT_NAME.r1cs"
echo "  WASM:             $BUILD_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"
echo "  Final zkey:       $BUILD_DIR/${CIRCUIT_NAME}_final.zkey"
echo "  Verification key: $BUILD_DIR/${CIRCUIT_NAME}_vk.json"
echo ""
echo "Run tests with: npm test"
