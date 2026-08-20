#!/bin/bash
# constraint-attribution.sh — per-gadget R1CS non-linear constraint attribution
# for Veil's three circuits.
#
# Compiles each isolated-gadget fixture in circuits/bench/attribution/*.circom
# (a single Poseidon(n), Num2Bits(n), comparator, or the full MerkleProof(20)
# template) and reads its non-linear constraint count straight from
# `snarkjs r1cs info`. The per-circuit totals in docs/research/BASELINE.md are
# then an exact sum of these gadget counts (see
# docs/research/2026-08-20-poseidon-constraint-attribution.md for the
# reconciliation) — this script answers "which gadget contributes how many
# constraints" without guessing from the circuit source.
#
# Requires: circom2 (installed as a circuits/ devDependency, no native circom
# build needed — `cd circuits && npm install` pulls it from npm).
#
# Usage:
#   bash scripts/bench/constraint-attribution.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../circuits" && pwd)"
FIXTURES_DIR="$CIRCUITS_DIR/bench/attribution"
BUILD_DIR="$CIRCUITS_DIR/bench/build"
CIRCOM="$CIRCUITS_DIR/node_modules/.bin/circom2"

if [ ! -x "$CIRCOM" ]; then
  echo "ERROR: circom2 not found at $CIRCOM. Run: cd circuits && npm install" >&2
  exit 1
fi

cd "$CIRCUITS_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

printf "%-22s %10s %10s %8s\n" "gadget" "non-linear" "linear" "wires"
printf "%-22s %10s %10s %8s\n" "----------------------" "----------" "----------" "--------"

for fixture in "$FIXTURES_DIR"/*.circom; do
  name="$(basename "$fixture" .circom)"
  # circom2's own compile-time summary is the source of the non-linear/linear
  # split; `snarkjs r1cs info` only reports their sum ("# of Constraints").
  out="$("$CIRCOM" "$fixture" --r1cs -o "$BUILD_DIR" -l node_modules)"
  nonlinear="$(echo "$out" | grep -oE 'non-linear constraints: [0-9]+' | grep -oE '[0-9]+$')"
  linear="$(echo "$out" | grep -oE '^linear constraints: [0-9]+' | grep -oE '[0-9]+$')"
  wires="$(echo "$out" | grep -oE '^wires: [0-9]+' | grep -oE '[0-9]+$')"
  printf "%-22s %10s %10s %8s\n" "$name" "$nonlinear" "$linear" "$wires"
done

rm -rf "$BUILD_DIR"
