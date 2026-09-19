#!/bin/bash
# compile-poseidon2.sh — Compile the three Poseidon2 Merkle-hash-swap research
# circuits (transfer_poseidon2.circom, compliance_poseidon2.circom,
# withdraw_poseidon2.circom) and run their Groth16 trusted setup.
#
# These are NOT deployed circuits — see docs/research/2026-09-19-poseidon2-merkle-swap.md.
# They exist to measure a real constraint/proving-time delta against the
# production circuits, using the same build/ directory and the same
# pot15_final.ptau as transfer.circom (run compile.sh first, or generate a
# local dev ptau — see the fallback below).
#
# Usage: bash scripts/compile-poseidon2.sh [--skip-ptau]
#
# Requires: circom 2.2.x, snarkjs 0.7.x (global or via npx)
# Output artifacts go to circuits/build/ (alongside the production circuits).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build"
PTAU_FILE="$BUILD_DIR/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"
CIRCUITS=(transfer_poseidon2 compliance_poseidon2 withdraw_poseidon2)

cd "$CIRCUITS_DIR"

echo "=== Veil Poseidon2 Merkle-Hash-Swap Circuit Compiler ==="

if [ ! -d node_modules ]; then
  echo "[1/5] Installing dependencies..."
  npm install
else
  echo "[1/5] Dependencies already installed."
fi

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found. Install it with:"
  echo "  curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh"
  echo "  cargo install --git https://github.com/iden3/circom --tag v2.2.2"
  exit 1
fi
echo "circom version: $(circom --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo unknown)"

mkdir -p "$BUILD_DIR"

echo "[2/5] Compiling ${CIRCUITS[*]}..."
for name in "${CIRCUITS[@]}"; do
  echo "  -- $name.circom"
  circom "$name.circom" --r1cs --wasm --sym --output "$BUILD_DIR" -l node_modules
  snarkjs r1cs info "$BUILD_DIR/$name.r1cs"
done

SKIP_PTAU=false
for arg in "$@"; do
  [ "$arg" = "--skip-ptau" ] && SKIP_PTAU=true
done

if [ -f "$PTAU_FILE" ]; then
  echo "[3/5] Powers of Tau already present (shared with transfer.circom's build)."
elif [ "$SKIP_PTAU" = "false" ]; then
  echo "[3/5] Downloading Powers of Tau (pot15, ~85MB)..."
  if ! curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"; then
    echo "  Download failed (network policy, offline environment, ...). Falling back to a"
    echo "  locally-generated dev ptau — cryptographically fine for benchmarking (same curve,"
    echo "  same power of tau), NOT a substitute for a real multi-party ceremony:"
    npx snarkjs powersoftau new bn128 15 "$BUILD_DIR/pot15_0000.ptau" -v
    echo "veil-poseidon2-dev-$(date +%s)" | npx snarkjs powersoftau contribute \
      "$BUILD_DIR/pot15_0000.ptau" "$BUILD_DIR/pot15_0001.ptau" --name="veil-dev" -v
    npx snarkjs powersoftau prepare phase2 "$BUILD_DIR/pot15_0001.ptau" "$PTAU_FILE" -v
  fi
else
  echo "[3/5] Skipping ptau (--skip-ptau). Place pot15_final.ptau in $BUILD_DIR to proceed."
  exit 0
fi

echo "[4/5] Running Groth16 trusted setup (single dev contribution — see ceremony.sh for production)..."
for name in "${CIRCUITS[@]}"; do
  echo "  -- $name"
  snarkjs groth16 setup "$BUILD_DIR/$name.r1cs" "$PTAU_FILE" "$BUILD_DIR/${name}_0000.zkey"
  echo "veil-$name-entropy-$(date +%s)" | snarkjs zkey contribute \
    "$BUILD_DIR/${name}_0000.zkey" "$BUILD_DIR/${name}_final.zkey" --name="veil-$name-dev" -v
done

echo "[5/5] Exporting verification keys..."
for name in "${CIRCUITS[@]}"; do
  snarkjs zkey export verificationkey "$BUILD_DIR/${name}_final.zkey" "$BUILD_DIR/${name}_vk.json"
done

echo ""
echo "=== Build complete ==="
echo "Run tests with: node --experimental-vm-modules test/poseidon2-merkle.test.mjs"
