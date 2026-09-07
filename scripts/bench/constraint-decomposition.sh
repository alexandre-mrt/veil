#!/bin/bash
# constraint-decomposition.sh — measures the non-linear/linear R1CS constraint
# cost of each circomlib gadget Veil's circuits are built from, in isolation,
# alongside a fresh compile of the three production circuits.
#
# This answers: of transfer.circom's 6,470 non-linear constraints (per
# BASELINE.md), how much comes from Poseidon vs. Num2Bits vs. comparators?
# That split is the input the Poseidon2 experiment (EXPERIMENTS.md #2) needs
# before it can claim a predicted saving instead of a guessed one.
#
# Usage: bash scripts/bench/constraint-decomposition.sh
# Requires: circom 2.2.x on PATH, snarkjs (circuits/node_modules or npx),
#           circuits/node_modules installed (npm install in circuits/).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROBES_DIR="$SCRIPT_DIR/constraint-probes"
CIRCUITS_DIR="$REPO_ROOT/circuits"
OUT_DIR="${1:-$SCRIPT_DIR/constraint-decomposition-out}"

command -v circom >/dev/null || { echo "ERROR: circom not on PATH"; exit 1; }
[ -d "$CIRCUITS_DIR/node_modules" ] || { echo "ERROR: run 'npm install' in circuits/ first"; exit 1; }

mkdir -p "$OUT_DIR"
cd "$REPO_ROOT"

echo "circom version: $(circom --version)"
echo

run_probe() {
  local name="$1"
  local file="$PROBES_DIR/$name.circom"
  circom "$file" --r1cs -o "$OUT_DIR" -l "$CIRCUITS_DIR/node_modules" > "$OUT_DIR/$name.compile.log" 2>&1
  echo "=== probe: $name ==="
  npx --prefix "$CIRCUITS_DIR" snarkjs r1cs info "$OUT_DIR/$name.r1cs"
  echo
}

run_circuit() {
  local name="$1"
  circom "$CIRCUITS_DIR/$name.circom" --r1cs -o "$OUT_DIR" -l "$CIRCUITS_DIR/node_modules" > "$OUT_DIR/$name.compile.log" 2>&1
  echo "=== circuit: $name ==="
  npx --prefix "$CIRCUITS_DIR" snarkjs r1cs info "$OUT_DIR/$name.r1cs"
  echo
}

for p in poseidon2 poseidon3 poseidon4 poseidon5 merkle20 \
         num2bits64 num2bits8 greaterthan64 greaterequalthan64 greaterequalthan8 lessequalthan64; do
  run_probe "$p"
done

for c in transfer compliance withdraw; do
  run_circuit "$c"
done
