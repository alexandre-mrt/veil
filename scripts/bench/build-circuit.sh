#!/bin/bash
# build-circuit.sh — compile one Veil circuit + dev Groth16 setup, print R1CS stats.
# Usage (from repo root):
#   bash scripts/bench/build-circuit.sh <circuit.circom> <out-dir> [ptau]
# Defaults: ptau = circuits/build/pot15_final.ptau. If the Hermez ptau URL is 403 (it is, from
# CI and from the nightly sandbox), generate a local dev ptau first:
#   S=circuits/node_modules/.bin/snarkjs
#   $S powersoftau new bn128 15 circuits/build/pot15_0000.ptau
#   $S powersoftau contribute circuits/build/pot15_0000.ptau circuits/build/pot15_0001.ptau --name=dev -e=dev
#   $S powersoftau prepare phase2 circuits/build/pot15_0001.ptau circuits/build/pot15_final.ptau
# Dev-only single-contributor setup: fine for constraint counts and proving time, NOT for deployment.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$1"; OUT="$2"; PTAU="${3:-$ROOT/circuits/build/pot15_final.ptau}"
NAME="$(basename "$SRC" .circom)"
S="$ROOT/circuits/node_modules/.bin/snarkjs"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
cd "$ROOT/circuits"
echo "circom: $(circom --version)"
circom "$SRC" --r1cs --wasm --sym --output "$OUT" -l node_modules
"$S" r1cs info "$OUT/$NAME.r1cs"
"$S" groth16 setup "$OUT/$NAME.r1cs" "$PTAU" "$OUT/${NAME}_0000.zkey" >/dev/null
"$S" zkey contribute "$OUT/${NAME}_0000.zkey" "$OUT/${NAME}_final.zkey" --name=dev -e="dev-$NAME" >/dev/null
"$S" zkey export verificationkey "$OUT/${NAME}_final.zkey" "$OUT/${NAME}_vk.json" >/dev/null
rm -f "$OUT/${NAME}_0000.zkey"
ls -l "$OUT/${NAME}_final.zkey" "$OUT/${NAME}_vk.json"
