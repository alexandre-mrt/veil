#!/bin/bash
# poseidon-arity-compile.sh — Compile the standalone single-hash benchmark circuits under
# circuits/bench-circuits/ and produce Groth16 artifacts for poseidon-arity-latency.mjs.
#
# Each circuit instantiates exactly one hash call (circomlib Poseidon(n), or the
# @taceo/circom-lib Poseidon2 permutation at state width t) with no surrounding logic, so the
# resulting R1CS/zkey/proving-time numbers isolate that one primitive's cost.
#
# Uses a FRESH, LOCAL, single-contributor Powers of Tau (bn128, 2^12) generated entirely
# offline via `snarkjs powersoftau` — not the project's Hermez pot15.ptau, since these circuits
# are tiny (<1000 constraints) and a fresh local ceremony avoids depending on network access to
# a third-party ptau host. Same "dev-only, not for production" caveat as circuits/scripts/compile.sh.
#
# Usage:
#   export CIRCOM=/path/to/circom   # circom 2.2.x binary (not always on PATH — see README)
#   bash scripts/bench/poseidon-arity-compile.sh
#
# Requires: circom 2.1.x/2.2.x, snarkjs 0.7.x, circuits/node_modules (circomlib +
# @taceo/circom-lib — run `npm install @taceo/circom-lib` in circuits/ first if missing).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../circuits" && pwd)"
BUILD_DIR="$CIRCUITS_DIR/bench-build"
CIRCOM="${CIRCOM:-circom}"

CIRCUITS=(poseidon_t2 poseidon_t3 poseidon_t4 poseidon_t5 poseidon2_t3 poseidon2_t4 poseidon2_compress2)

cd "$CIRCUITS_DIR"
mkdir -p "$BUILD_DIR"

if ! command -v "$CIRCOM" &> /dev/null; then
  echo "ERROR: circom not found at '$CIRCOM'. Set CIRCOM=/path/to/circom or add it to PATH."
  echo "  (built from source: git clone https://github.com/iden3/circom && cd circom && cargo build --release)"
  exit 1
fi

echo "circom version: $("$CIRCOM" --version)"

echo "[1/3] Compiling ${#CIRCUITS[@]} standalone hash circuits..."
for name in "${CIRCUITS[@]}"; do
  echo "  - $name"
  "$CIRCOM" "bench-circuits/${name}.circom" --r1cs --wasm --sym --output "$BUILD_DIR" -l node_modules
done

echo "[2/3] Generating a fresh local Powers of Tau (bn128, 2^12, single dev contribution)..."
if [ ! -f "$BUILD_DIR/pot12_final.ptau" ]; then
  npx snarkjs powersoftau new bn128 12 "$BUILD_DIR/pot12_0000.ptau" -v
  echo "veil-bench-entropy-$(date +%s)" | npx snarkjs powersoftau contribute \
    "$BUILD_DIR/pot12_0000.ptau" "$BUILD_DIR/pot12_0001.ptau" --name="veil-bench" -v
  npx snarkjs powersoftau prepare phase2 "$BUILD_DIR/pot12_0001.ptau" "$BUILD_DIR/pot12_final.ptau" -v
else
  echo "  pot12_final.ptau already present, skipping."
fi

echo "[3/3] Groth16 setup per circuit..."
for name in "${CIRCUITS[@]}"; do
  npx snarkjs groth16 setup "$BUILD_DIR/${name}.r1cs" "$BUILD_DIR/pot12_final.ptau" "$BUILD_DIR/${name}_0000.zkey"
  echo "veil-bench-$name" | npx snarkjs zkey contribute \
    "$BUILD_DIR/${name}_0000.zkey" "$BUILD_DIR/${name}_final.zkey" --name="veil-bench"
  npx snarkjs zkey export verificationkey "$BUILD_DIR/${name}_final.zkey" "$BUILD_DIR/${name}_vk.json"
done

echo ""
echo "=== Constraint counts (raw snarkjs r1cs info) ==="
for name in "${CIRCUITS[@]}"; do
  echo "--- $name ---"
  npx snarkjs r1cs info "$BUILD_DIR/${name}.r1cs"
done

echo ""
echo "=== Artifact sizes ==="
for name in "${CIRCUITS[@]}"; do
  echo "$name zkey: $(stat -c %s "$BUILD_DIR/${name}_final.zkey") bytes"
done

echo ""
echo "Done. Run: node scripts/bench/poseidon-arity-latency.mjs --runs 20"
