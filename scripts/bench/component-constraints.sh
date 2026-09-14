#!/bin/bash
# component-constraints.sh — R1CS constraint count for each isolated circomlib gadget
# used inside Veil's three circuits (transfer/compliance/withdraw), plus the full
# depth-20 MerkleProof template.
#
# Purpose: attribute each circuit's total non-linear-constraint count to its
# constituent gadgets (Poseidon arity 2/3/4/5, Num2Bits, comparators, the Merkle
# path) so future prover-time optimization (e.g. a Poseidon2 migration) can be
# targeted at the actual dominant cost instead of guessed at.
#
# Usage:
#   bash scripts/bench/component-constraints.sh
#
# Requires: circom 2.1.x/2.2.x on PATH. Reads circuits/bench/components/*.circom
# (each a single isolated gadget wrapped in its own `component main`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../circuits" && pwd)"
COMPONENTS_DIR="$CIRCUITS_DIR/bench/components"
BUILD_DIR="$COMPONENTS_DIR/build"

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH." >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

echo "=== Veil per-gadget constraint benchmark ==="
echo "circom version: $(circom --version)"
echo ""
printf "%-18s %10s %10s %8s\n" "gadget" "non-linear" "linear" "wires"
printf "%-18s %10s %10s %8s\n" "------" "----------" "------" "-----"

for f in "$COMPONENTS_DIR"/*.circom; do
  name="$(basename "$f" .circom)"
  out="$(circom "$f" --r1cs -o "$BUILD_DIR" -l "$CIRCUITS_DIR/node_modules" 2>&1)"
  nonlinear="$(echo "$out" | grep -oE 'non-linear constraints: [0-9]+' | grep -oE '[0-9]+')"
  linear="$(echo "$out" | grep -oE '^linear constraints: [0-9]+' | grep -oE '[0-9]+')"
  wires="$(echo "$out" | grep -oE 'wires: [0-9]+' | grep -oE '[0-9]+')"
  printf "%-18s %10s %10s %8s\n" "$name" "$nonlinear" "$linear" "$wires"
done
