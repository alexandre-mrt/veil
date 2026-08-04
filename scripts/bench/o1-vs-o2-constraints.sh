#!/bin/bash
# o1-vs-o2-constraints.sh — Compare circom's default (O1) vs full (O2)
# constraint simplification on Veil's three real circuits.
#
# Usage: bash scripts/bench/o1-vs-o2-constraints.sh
#
# Requires: circom 2.2.x on PATH, circuits/node_modules installed
#           (cd circuits && npm install).
#
# Real numbers measured with this script on 2026-08-04:
#   transfer:   13,611 -> 6,384 constraints (-53.1%)
#   compliance: 12,743 -> 5,979 constraints (-53.1%)
#   withdraw:    3,058 -> 1,439 constraints (-52.9%)
# See docs/research/2026-08-04-poseidon2-vs-poseidon.md for the proving-time
# and zkey-size follow-up (scripts/bench/prove-latency.mjs) and for the full
# test-suite validation this script's output alone does not cover.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../circuits" && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found (need 2.2.x). See circuits/scripts/compile.sh for install instructions."
  exit 1
fi

cd "$CIRCUITS_DIR"

for circuit in transfer compliance withdraw; do
  echo "=== $circuit.circom — O1 (default) ==="
  mkdir -p "$OUT_DIR/${circuit}-o1"
  circom "$circuit.circom" --r1cs -o "$OUT_DIR/${circuit}-o1" -l node_modules
  npx snarkjs r1cs info "$OUT_DIR/${circuit}-o1/$circuit.r1cs"

  echo "=== $circuit.circom — O2 (full simplification) ==="
  mkdir -p "$OUT_DIR/${circuit}-o2"
  circom "$circuit.circom" --r1cs -o "$OUT_DIR/${circuit}-o2" -l node_modules --O2
  npx snarkjs r1cs info "$OUT_DIR/${circuit}-o2/$circuit.r1cs"
  echo ""
done
