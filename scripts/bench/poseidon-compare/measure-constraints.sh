#!/bin/bash
# measure-constraints.sh — recompiles every Poseidon1 / Poseidon2 micro-benchmark
# circuit in this directory and prints its R1CS constraint breakdown via
# `snarkjs r1cs info`. Reproduces the constraint-count table in
# docs/research/2026-08-13-poseidon2-merkle-compression.md.
#
# Requires: a `circom` binary on $CIRCOM (built from iden3/circom v2.2.2 if not
# packaged — see that report's Approach section) and this repo's
# circuits/node_modules (for circomlib, the vendored Poseidon2's peer dep).
#
# Usage: CIRCOM=/path/to/circom bash measure-constraints.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CIRCOM="${CIRCOM:-circom}"
CIRCOMLIB_NODE_MODULES="$(cd "$SCRIPT_DIR/../../../circuits" && pwd)/node_modules"

mkdir -p build

for f in circuits/*.circom; do
  name=$(basename "$f" .circom)
  echo "=== $name ==="
  "$CIRCOM" "$f" --r1cs -o build -l "$CIRCOMLIB_NODE_MODULES"
  npx --prefix "$(cd "$SCRIPT_DIR/../../../circuits" && pwd)" snarkjs r1cs info "build/$name.r1cs"
  echo
done
