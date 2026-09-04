#!/bin/bash
# compile-poseidon2-bench.sh — Compile the six circuits/bench/*.circom circuits
# (three Veil hash "shapes" x {current: circomlib Poseidon, poseidon2: TACEO
# Poseidon2 sponge}) and run a dev-only Groth16 trusted setup for each.
#
# Usage: bash scripts/compile-poseidon2-bench.sh
#
# Why circom2 (WASM) instead of native `circom`, unlike compile.sh/compile-*.sh:
# this experiment ran in a sandboxed session with no GitHub access (blocks both
# downloading a prebuilt circom binary and `cargo install --git .../iden3/circom`)
# and no reachable ptau CDN (blocks compile.sh's own PTAU_URL). `circom2` ships
# circom compiled to WASM as an npm package (reachable via the allowlisted npm
# registry) and was validated against the existing baseline before being trusted
# for new circuits: compiling the real transfer.circom with it reproduces
# BASELINE.md's exact non-linear/linear constraint counts (6470 / 7141). The
# Powers of Tau file is generated locally (single dev contribution, `snarkjs
# powersoftau new` + `contribute` + `prepare phase2`) instead of downloaded, for
# the same reachability reason — this is the same trust level BASELINE.md's own
# ptau already was ("single dev-only Groth16 contribution... not a production
# ceremony").
#
# Requires: node_modules/circom2, node_modules/@taceo/circom-lib (npm install in
# circuits/), snarkjs 0.7.x (via npx).
# Output artifacts go to circuits/build-bench/<name>/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build-bench"
PTAU_DIR="$BUILD_DIR/ptau"
PTAU_FILE="$PTAU_DIR/pot15_final.ptau"

CIRCUITS=(
  transfer_hash_current
  transfer_hash_poseidon2
  compliance_hash_current
  compliance_hash_poseidon2
  withdraw_hash_current
  withdraw_hash_poseidon2
)

cd "$CIRCUITS_DIR"

echo "=== Veil Poseidon2 bench compiler ==="

if [ ! -d node_modules/circom2 ] || [ ! -d "node_modules/@taceo/circom-lib" ]; then
  echo "[1/4] Installing circom2 + @taceo/circom-lib (devDependencies)..."
  npm install
else
  echo "[1/4] Dependencies already installed."
fi

CIRCOM2="node_modules/.bin/circom2"
echo "circom2: $("$CIRCOM2" --version)"

echo "[2/4] Compiling ${#CIRCUITS[@]} bench circuits..."
for name in "${CIRCUITS[@]}"; do
  mkdir -p "$BUILD_DIR/$name"
  echo "--- $name ---"
  "$CIRCOM2" "bench/$name.circom" --r1cs --wasm --sym --output "$BUILD_DIR/$name" -l node_modules
  npx --yes snarkjs r1cs info "$BUILD_DIR/$name/$name.r1cs"
done

echo "[3/4] Powers of Tau (pot15, local dev-only — see header comment)..."
if [ ! -f "$PTAU_FILE" ]; then
  mkdir -p "$PTAU_DIR"
  npx --yes snarkjs powersoftau new bn128 15 "$PTAU_DIR/pot15_0000.ptau" -v
  echo "veil-poseidon2-bench-dev-$(date +%s)" | npx --yes snarkjs powersoftau contribute \
    "$PTAU_DIR/pot15_0000.ptau" "$PTAU_DIR/pot15_0001.ptau" --name="veil-bench-dev" -v
  npx --yes snarkjs powersoftau prepare phase2 "$PTAU_DIR/pot15_0001.ptau" "$PTAU_FILE" -v
else
  echo "Powers of Tau already present at $PTAU_FILE."
fi

echo "[4/4] Groth16 setup (dev-only single contribution) per circuit..."
for name in "${CIRCUITS[@]}"; do
  echo "--- $name ---"
  npx --yes snarkjs groth16 setup "$BUILD_DIR/$name/$name.r1cs" "$PTAU_FILE" "$BUILD_DIR/$name/${name}_0000.zkey"
  echo "veil-poseidon2-bench-entropy-$(date +%s)" | npx --yes snarkjs zkey contribute \
    "$BUILD_DIR/$name/${name}_0000.zkey" "$BUILD_DIR/$name/${name}_final.zkey" --name="veil-bench-dev" -v
  npx --yes snarkjs zkey export verificationkey \
    "$BUILD_DIR/$name/${name}_final.zkey" "$BUILD_DIR/$name/${name}_vk.json"
done

echo ""
echo "WARNING: DEV-ONLY setup, not a production ceremony. These circuits are a research"
echo "benchmark (circuits/bench/) and are not used by the deployed protocol."
echo ""
echo "=== Build complete: $BUILD_DIR ==="
