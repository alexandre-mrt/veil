#!/bin/bash
# run.sh — measure the isolated R1CS constraint cost of every distinct circomlib
# gadget Veil's three circuits instantiate (Poseidon(2..5), Num2Bits(8/64),
# GreaterThan(64), GreaterEqThan(8/64), LessEqThan(64), MultiMux1(2)), plus the
# composite MerkleProof(20) template, by compiling each as its own tiny circuit
# and reading `snarkjs r1cs info`.
#
# Why: transfer.circom/compliance.circom/withdraw.circom's R1CS constraint
# counts are known (BASELINE.md) but never broken down by which gadget
# contributes how much. This script produces that breakdown, gadget by gadget,
# from real compiles — see docs/research/2026-09-10-poseidon-constraint-breakdown.md
# for how these numbers reconstruct each circuit's total exactly (component sum
# + a fixed, explained correction for circom's default --O1 signal-to-signal /
# signal-to-constant elimination).
#
# Usage: bash scripts/bench/circuit-gadget-cost/run.sh
# Requires: circom 2.2.x on PATH, and circuits/node_modules installed
#   (cd circuits && npm install).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../../circuits" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH. See circuits/scripts/compile.sh for install instructions."
  exit 1
fi

echo "circom version: $(circom --version)"
mkdir -p "$BUILD_DIR"

for f in "$SCRIPT_DIR"/circuits/*.circom; do
  name="$(basename "$f" .circom)"
  echo ""
  echo "=== $name ==="
  circom "$f" --r1cs -o "$BUILD_DIR" 2>&1 | grep -E "non-linear|linear constraints|private inputs"
  npx --prefix "$CIRCUITS_DIR" snarkjs r1cs info "$BUILD_DIR/$name.r1cs" 2>&1 | grep -E "Constraints"
done
