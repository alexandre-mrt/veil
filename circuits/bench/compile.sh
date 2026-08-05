#!/bin/bash
# compile.sh — Compile the Poseidon vs Poseidon2 constraint-count/proving-time
# benchmark circuits and run a dev-only Groth16 trusted setup for each.
#
# Usage: bash circuits/bench/compile.sh
#
# Requires: circom 2.2.x, snarkjs 0.7.x (via npx), @taceo/circom-lib
# (installed as a circuits/ devDependency — `npm install` in circuits/ first).
#
# Produces circuits/bench/build/*.r1cs (all 8 widths, --O2 fully-optimized
# constraint counts — this is the number quoted in the research report) and
# circuits/bench/build/*_final.zkey + *_js/*.wasm for the four circuits used
# in the proving-time comparison (poseidon1_n3, poseidon2_t4_n3, poseidon1_n4,
# poseidon2_t8_n4).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
PTAU_FILE="$BUILD_DIR/pot12_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau"

cd "$CIRCUITS_DIR"
if [ ! -d node_modules/@taceo ]; then
  echo "[setup] Installing circuits/ dependencies (needs @taceo/circom-lib)..."
  npm install
fi

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found. Build from source (matches the rest of this repo's toolchain):"
  echo "  git clone --depth 1 --branch v2.2.2 https://github.com/iden3/circom.git /tmp/circom-src"
  echo "  cd /tmp/circom-src && cargo build --release"
  echo "  # then use /tmp/circom-src/target/release/circom below, or put it on PATH"
  exit 1
fi

mkdir -p "$BUILD_DIR"

echo "[1/3] Compiling all 8 width variants (--O2, fully-optimized R1CS)..."
cd "$SCRIPT_DIR"
for f in poseidon1_n2 poseidon1_n3 poseidon1_n4 poseidon1_n5 \
         poseidon2_t3_n2 poseidon2_t4_n3 poseidon2_t8_n4 poseidon2_t8_n5; do
  echo "--- $f ---"
  circom "$f.circom" --r1cs --wasm --sym --O2 --output "$BUILD_DIR" -l "$CIRCUITS_DIR/node_modules"
  npx snarkjs r1cs info "$BUILD_DIR/$f.r1cs"
done

echo "[2/3] Fetching pot12 Powers of Tau (4096 constraints, enough for every variant here)..."
if [ ! -f "$PTAU_FILE" ]; then
  curl -sS -L -o "$PTAU_FILE" "$PTAU_URL"
fi

echo "[3/3] Groth16 dev-only trusted setup for the proving-time comparison pairs..."
for f in poseidon1_n3 poseidon2_t4_n3 poseidon1_n4 poseidon2_t8_n4; do
  npx snarkjs groth16 setup "$BUILD_DIR/$f.r1cs" "$PTAU_FILE" "$BUILD_DIR/${f}_0000.zkey"
  echo "bench-dev-entropy-$(date +%s)" | npx snarkjs zkey contribute \
    "$BUILD_DIR/${f}_0000.zkey" "$BUILD_DIR/${f}_final.zkey" --name="bench-dev" -v
  npx snarkjs zkey export verificationkey "$BUILD_DIR/${f}_final.zkey" "$BUILD_DIR/${f}_vk.json"
done

echo ""
echo "=== Done ==="
echo "Constraint counts: see the 'snarkjs r1cs info' output above for each of the 8 widths."
echo "Proving-time: node scripts/bench/poseidon2-latency.mjs --runs 10"
