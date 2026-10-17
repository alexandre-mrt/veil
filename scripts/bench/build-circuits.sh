#!/bin/bash
# build-circuits.sh — compile all three Veil circuits and run a dev-only Groth16 setup for each,
# into circuits/build{,-withdraw,-compliance}/ (the layout the other scripts/bench/* read).
#
# Usage: PTAU=/path/to/pot15_final.ptau bash scripts/bench/build-circuits.sh
# Requires: circom on PATH, circuits/node_modules installed (snarkjs 0.7.6).
# The ptau only has to be a valid phase-2-prepared 2^15 BN254 file; for gas / size / timing
# numbers its provenance is irrelevant (it is NOT a ceremony — see docs/threat-model.md RR2).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PTAU="${PTAU:?set PTAU=/path/to/pot15_final.ptau}"
SNARKJS="$ROOT/circuits/node_modules/.bin/snarkjs"
cd "$ROOT/circuits"
for pair in transfer:build withdraw:build-withdraw compliance:build-compliance; do
  c="${pair%%:*}"; d="${pair##*:}"
  mkdir -p "$d"
  circom "$c.circom" --r1cs --wasm --sym --output "$d" -l node_modules
  "$SNARKJS" r1cs info "$d/$c.r1cs"
  "$SNARKJS" groth16 setup "$d/$c.r1cs" "$PTAU" "$d/${c}_0000.zkey"
  echo "veil-bench-entropy-$c" | "$SNARKJS" zkey contribute "$d/${c}_0000.zkey" "$d/${c}_final.zkey" --name=bench >/dev/null
  "$SNARKJS" zkey export verificationkey "$d/${c}_final.zkey" "$d/${c}_vk.json"
done
