#!/bin/bash
# compile-poseidon2.sh — Compile transfer_poseidon2.circom and run Groth16 trusted setup
# Usage: bash scripts/compile-poseidon2.sh [--skip-ptau]
#
# Requires: circom 2.2.x, snarkjs 0.7.x (global or via npx)
# Output artifacts go to circuits/build-poseidon2/
#
# transfer_poseidon2.circom is a RESEARCH VARIANT (docs/research/2026-09-26-poseidon2-merkle-path.md):
# identical to transfer.circom except the depth-20 Merkle membership check (C0) uses Poseidon2
# compression instead of circomlib Poseidon(2) sponge. It is NOT wired into pool.move, the
# frontend, or any production path — this script intentionally has no "copy to frontend" step,
# unlike compile-withdraw.sh / compile-compliance.sh.
#
# NOTE: This uses a single dev contributor for the trusted setup, same as compile.sh.
# For production, use ceremony.sh with multiple contributors.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build-poseidon2"
CIRCUIT_NAME="transfer_poseidon2"
PTAU_FILE="$CIRCUITS_DIR/build/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"

cd "$CIRCUITS_DIR"

echo "=== Veil Poseidon2 Merkle-path research circuit compiler ==="
echo "Working directory: $CIRCUITS_DIR"

# -- Install dependencies if needed -----------------------------------------------
if [ ! -d node_modules ]; then
  echo "[1/5] Installing dependencies..."
  npm install
else
  echo "[1/5] Dependencies already installed."
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
echo "[2/5] Compiling $CIRCUIT_NAME.circom..."
circom "$CIRCUIT_NAME.circom" \
  --r1cs \
  --wasm \
  --sym \
  --output "$BUILD_DIR"

echo "Constraint count:"
snarkjs r1cs info "$BUILD_DIR/$CIRCUIT_NAME.r1cs"

# -- Powers of tau: reuse circuits/build/pot15_final.ptau (same 2^15, shared with transfer.circom) --
SKIP_PTAU=false
for arg in "$@"; do
  [ "$arg" = "--skip-ptau" ] && SKIP_PTAU=true
done

if [ ! -f "$PTAU_FILE" ] && [ "$SKIP_PTAU" = "false" ]; then
  echo "[3/5] Downloading Powers of Tau (pot15, ~85MB)..."
  echo "      If this GCS URL 403s (bucket permissions can change), generate a local"
  echo "      ceremony instead: see docs/research/2026-09-26-poseidon2-merkle-path.md."
  mkdir -p "$(dirname "$PTAU_FILE")"
  curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"
elif [ -f "$PTAU_FILE" ]; then
  echo "[3/5] Powers of Tau already present (reused from circuits/build/)."
else
  echo "[3/5] Skipping ptau download (--skip-ptau flag set)."
  echo "      Place pot15_final.ptau in $(dirname "$PTAU_FILE") to proceed."
  exit 0
fi

# -- Groth16 setup -----------------------------------------------------------------
echo "[4/5] Running Groth16 trusted setup..."
snarkjs groth16 setup \
  "$BUILD_DIR/$CIRCUIT_NAME.r1cs" \
  "$PTAU_FILE" \
  "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey"

# Single dev contribution (non-production — for testing/research only)
echo "veil-poseidon2-entropy-$(date +%s)" | snarkjs zkey contribute \
  "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey" \
  "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
  --name="veil-poseidon2-dev" \
  -v

# -- Export verification key -------------------------------------------------------
echo "[5/5] Exporting verification key..."
snarkjs zkey export verificationkey \
  "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
  "$BUILD_DIR/${CIRCUIT_NAME}_vk.json"

echo ""
echo "WARNING: DEV-ONLY single-contributor setup, research variant only — not production."
echo ""
echo "=== Build complete ==="
echo "Artifacts:"
echo "  R1CS:             $BUILD_DIR/$CIRCUIT_NAME.r1cs"
echo "  WASM:             $BUILD_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"
echo "  Final zkey:       $BUILD_DIR/${CIRCUIT_NAME}_final.zkey"
echo "  Verification key: $BUILD_DIR/${CIRCUIT_NAME}_vk.json"
echo ""
echo "Benchmark with: node ../scripts/bench/prove-latency.mjs --runs 10"
