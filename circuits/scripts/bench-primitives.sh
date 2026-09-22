#!/bin/bash
# bench-primitives.sh — Compile each isolated gadget in bench-primitives/ and report its exact
# R1CS constraint count, so the whole-circuit totals in docs/research/BASELINE.md can be
# reconstructed as a sum of named parts instead of one opaque number.
#
# Usage: bash scripts/bench-primitives.sh
# Requires: circom on PATH, snarkjs (via npx, already a circuits/ dependency).
# Writes machine-readable output to build-bench-primitives/results.tsv and prints a table.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$CIRCUITS_DIR/bench-primitives"
BUILD_DIR="$CIRCUITS_DIR/build-bench-primitives"

cd "$CIRCUITS_DIR"

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH." >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
RESULTS="$BUILD_DIR/results.tsv"
echo -e "gadget\tr1cs_constraints\tnon_linear\tlinear\twires\tprivate_inputs" > "$RESULTS"

printf "%-22s %10s %10s %10s %8s\n" "gadget" "r1cs" "nonlin" "linear" "wires"
printf "%-22s %10s %10s %10s %8s\n" "------" "----" "------" "------" "-----"

for f in "$SRC_DIR"/*.circom; do
  name="$(basename "$f" .circom)"
  # circom's own --r1cs stdout prints the non-linear/linear constraint split;
  # `snarkjs r1cs info` (0.7.6) only reports the combined total, so we parse this instead.
  out="$(circom "$f" --r1cs -o "$BUILD_DIR" 2>&1)" || {
    echo "COMPILE FAILED: $name" >&2
    echo "$out" >&2
    continue
  }
  nonlin="$(echo "$out" | grep -m1 -oE '^non-linear constraints: [0-9]+' | grep -oE '[0-9]+' || echo "?")"
  lin="$(echo "$out" | grep -m1 -oE '^linear constraints: [0-9]+' | grep -oE '[0-9]+' || echo "?")"
  wires="$(echo "$out" | grep -m1 -oE '^wires: [0-9]+' | grep -oE '[0-9]+' || echo "?")"
  priv="$(echo "$out" | grep -m1 -oE '^private inputs: [0-9]+' | grep -oE '[0-9]+' || echo "?")"
  total=$(( nonlin + lin ))
  printf "%-22s %10s %10s %10s %8s\n" "$name" "$total" "$nonlin" "$lin" "$wires"
  echo -e "$name\t$total\t$nonlin\t$lin\t$wires\t$priv" >> "$RESULTS"
done

echo ""
echo "Raw results: $RESULTS"
