#!/bin/bash
# setup-variant.sh — compile a circuit + run a (dev-only!) Groth16 trusted setup
# into an arbitrary output directory, at an arbitrary circom optimization level.
# Used by the 2026-08-22 Poseidon2/O2 research run to build multiple circuit
# variants side by side without disturbing circuits/build{,-withdraw,-compliance}.
#
# Usage: setup-variant.sh <circuit.circom> <circuit_name> <outdir> <O_FLAG>
set -euo pipefail
CIRCOM="${CIRCOM_BIN:-circom}"
CIRCUITS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUIT_FILE="$1"
NAME="$2"
OUTDIR="$3"
OFLAG="${4:---O1}"
PTAU="$CIRCUITS_DIR/build/pot15_final.ptau"

cd "$CIRCUITS_DIR"
mkdir -p "$OUTDIR"

"$CIRCOM" "$CIRCUIT_FILE" --r1cs --wasm --sym "$OFLAG" -o "$OUTDIR" -l node_modules

npx snarkjs groth16 setup "$OUTDIR/$NAME.r1cs" "$PTAU" "$OUTDIR/${NAME}_0000.zkey"
echo "veil-research-$(date +%s)-entropy" | npx snarkjs zkey contribute "$OUTDIR/${NAME}_0000.zkey" "$OUTDIR/${NAME}_final.zkey" --name="dev contribution"
npx snarkjs zkey export verificationkey "$OUTDIR/${NAME}_final.zkey" "$OUTDIR/${NAME}_vk.json"
rm -f "$OUTDIR/${NAME}_0000.zkey"
echo "[done] $OUTDIR/${NAME}_final.zkey"
