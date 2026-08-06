#!/bin/bash
# gadget-constraints.sh — R1CS constraint decomposition of Veil's three circuits,
# gadget by gadget.
#
# transfer.circom, compliance.circom and withdraw.circom each compile to one
# opaque constraint count (see docs/research/BASELINE.md). This script isolates
# every distinct circomlib/local gadget those circuits call — Poseidon at each
# arity actually used, the depth-20 MerkleProof template, Num2Bits, and the
# comparator templates — into its own single-component circuit under
# circuits/bench/, compiles each alone, and reports its real R1CS cost. That
# lets the whole-circuit total be attributed back to "N instances of gadget X"
# instead of treated as one number.
#
# Usage:
#   bash scripts/bench/gadget-constraints.sh
#
# Prerequisite: a circom 2.1.x+ compiler and snarkjs on PATH. This repo has no
# circom npm package with a real compiler binary; the `circom2` npm package
# (a WASM build of the same compiler, published by antimatter15) works
# identically for this purpose and needs no native build step:
#   cd circuits && npm install --no-save circom2
#   PATH="$(pwd)/node_modules/.bin:$PATH"   # so `circom2` resolves
#
# Each row's "non-linear" / "linear" numbers are raw circom compiler output
# (the same two lines compile.sh already prints), not snarkjs r1cs info's
# combined total — the decomposition arithmetic in the report sums these two
# columns separately against the whole-circuit non-linear/linear split in
# BASELINE.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../circuits" && pwd)"
BENCH_DIR="$CIRCUITS_DIR/bench"
BUILD_DIR="$BENCH_DIR/build"

cd "$CIRCUITS_DIR"

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH. See the prerequisite note at the top of this script."
  exit 1
fi

echo "circom: $(circom --version 2>&1 | tr '\n' ' ')"
echo ""

mkdir -p "$BUILD_DIR"

GADGETS=(
  poseidon2
  poseidon3
  poseidon4
  poseidon5
  merkle20
  num2bits64
  num2bits8
  lesseqthan64
  greaterthan64
  greaterequalthan64
  greaterequalthan8
)

for g in "${GADGETS[@]}"; do
  echo "############ $g ############"
  circom "bench/$g.circom" --r1cs -o "$BUILD_DIR" -l node_modules 2>&1 \
    | grep -E "non-linear|linear constraints|template instances"
  echo ""
done
