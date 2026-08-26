#!/usr/bin/env bash
# compile-poseidon2-bench.sh — build the 8 isolated hash benchmark circuits under
# circuits/bench-poseidon2/ (circomlib Poseidon(n) vs @taceo/circom-lib Poseidon2Sponge,
# at the exact arities n=2,3,4,5 Veil's production circuits call Poseidon(n) with today)
# and run a real Groth16 trusted setup for each, so poseidon2-arity-bench.mjs can time
# actual proving, not just constraint counts.
#
# Does NOT touch circuits/transfer.circom, withdraw.circom, or compliance.circom — this
# only benchmarks isolated hash circuits to isolate the per-hash-call constraint/proving
# delta. See docs/research/2026-08-26-poseidon2-arity-gap.md for why.
#
# The powers-of-tau here is a throwaway, locally-generated, single-contribution ceremony
# for benchmark purposes ONLY -- it is not, and must never be treated as, a usable Groth16
# setup for any real circuit. (Same caveat applies to circuits/scripts/compile*.sh's
# dev-only pot15 ceremony; this one is smaller and never leaves this machine.)
#
# Requires: node, and either a `circom` binary on PATH or `npx circom2` (WASM build of
# the same compiler, verified in the report to reproduce identical constraint counts).
set -euo pipefail

cd "$(dirname "$0")/../../circuits"

if command -v circom &> /dev/null; then
  CIRCOM="circom"
else
  CIRCOM="npx circom2"
fi

BENCH_DIR="bench-poseidon2"
BUILD_DIR="$BENCH_DIR/build"
mkdir -p "$BUILD_DIR"

echo "circom: $($CIRCOM --version 2>&1 | tail -1)"

CIRCUITS=(poseidon_n2 poseidon_n3 poseidon_n4 poseidon_n5 poseidon2_n2 poseidon2_n3 poseidon2_n4 poseidon2_n5)

for name in "${CIRCUITS[@]}"; do
  echo "── compiling $name ──"
  $CIRCOM "$BENCH_DIR/$name.circom" --r1cs --wasm --sym --output "$BUILD_DIR" -l node_modules
  npx snarkjs r1cs info "$BUILD_DIR/$name.r1cs"
done

echo "── generating throwaway powers-of-tau (2^12, single dev contribution) ──"
npx snarkjs powersoftau new bn128 12 "$BUILD_DIR/pot12_0000.ptau" -v
npx snarkjs powersoftau contribute "$BUILD_DIR/pot12_0000.ptau" "$BUILD_DIR/pot12_0001.ptau" \
  --name="bench-only, throwaway" -v -e="$(head -c 64 /dev/urandom | base64)"
npx snarkjs powersoftau prepare phase2 "$BUILD_DIR/pot12_0001.ptau" "$BUILD_DIR/pot12_final.ptau" -v

for name in "${CIRCUITS[@]}"; do
  echo "── Groth16 setup: $name ──"
  npx snarkjs groth16 setup "$BUILD_DIR/$name.r1cs" "$BUILD_DIR/pot12_final.ptau" "$BUILD_DIR/${name}_0000.zkey"
  npx snarkjs zkey contribute "$BUILD_DIR/${name}_0000.zkey" "$BUILD_DIR/${name}_final.zkey" \
    --name="bench" -e="$(head -c 32 /dev/urandom | base64)"
done

echo "Done. Artifacts in $BUILD_DIR/ (gitignored)."
