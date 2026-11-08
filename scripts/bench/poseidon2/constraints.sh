#!/usr/bin/env bash
# constraints.sh — compile each Poseidon vs Poseidon2 circuit and print circom's constraint counts.
#   CIRCOM=/path/to/circom2 bash scripts/bench/poseidon2/constraints.sh [outdir]
# (CIRCOM may be the `circom2` npm WASM build or a native circom >= 2.1; default: `circom`.)
set -euo pipefail
CIRCOM=${CIRCOM:-circom}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${1:-/tmp/veil-poseidon2-out}
mkdir -p "$OUT"
cd "$ROOT/circuits"
for opt in O1 O2; do
  echo "######## optimisation --$opt"
  for f in experiments/poseidon2/micro_poseidon_t3 experiments/poseidon2/micro_poseidon2_t3 \
           experiments/poseidon2/micro_poseidon_t5 experiments/poseidon2/micro_poseidon2_t4 \
           transfer experiments/poseidon2/transfer_p2_merkle experiments/poseidon2/transfer_p2_all; do
    n=$(basename "$f"); mkdir -p "$OUT/$opt/$n"
    echo "== $n"
    $CIRCOM "$f.circom" --r1cs --wasm "--$opt" --output "$OUT/$opt/$n" -l node_modules 2>&1 \
      | grep -E "non-linear constraints|linear constraints|error" || true
  done
done
