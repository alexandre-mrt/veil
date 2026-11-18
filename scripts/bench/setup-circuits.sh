#!/bin/bash
# setup-circuits.sh — Build the three circuit artifact sets the bench scripts read
# (circuits/build{,-withdraw,-compliance}/<name>_js/<name>.wasm, <name>_final.zkey, <name>_vk.json).
#
# Usage: bash scripts/bench/setup-circuits.sh [path/to/pot15_final.ptau]
#
# If no ptau is given and circuits/build/pot15_final.ptau is missing, a LOCAL single-party
# Powers of Tau (2^15) is generated with snarkjs. That is fine for benchmarking — constraint
# counts, proof/VK sizes, proving time and on-chain verification gas do not depend on who
# contributed to the ceremony — but it is NOT a production setup (see docs/threat-model.md RR2).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="$ROOT/circuits"
S="$C/node_modules/.bin/snarkjs"
PTAU="${1:-$C/build/pot15_final.ptau}"
mkdir -p "$C/build" "$C/build-withdraw" "$C/build-compliance"

if [ ! -f "$PTAU" ]; then
  echo "[ptau] generating local 2^15 Powers of Tau (bench-only)"
  T=$(mktemp -d)
  "$S" powersoftau new bn128 15 "$T/p0.ptau"
  "$S" powersoftau contribute "$T/p0.ptau" "$T/p1.ptau" --name=bench -e="veil-bench-$(date +%s)"
  "$S" powersoftau prepare phase2 "$T/p1.ptau" "$PTAU"
  rm -rf "$T"
fi

for spec in "transfer build" "withdraw build-withdraw" "compliance build-compliance"; do
  set -- $spec; name=$1; dir="$C/$2"
  (cd "$C" && circom "$name.circom" --r1cs --wasm --sym --output "$dir" -l node_modules)
  "$S" groth16 setup "$dir/$name.r1cs" "$PTAU" "$dir/${name}_0000.zkey"
  "$S" zkey contribute "$dir/${name}_0000.zkey" "$dir/${name}_final.zkey" --name=bench -e="veil-bench-$name-$(date +%s)"
  "$S" zkey export verificationkey "$dir/${name}_final.zkey" "$dir/${name}_vk.json"
  rm -f "$dir/${name}_0000.zkey"
done
echo "[ok] artifacts ready"
