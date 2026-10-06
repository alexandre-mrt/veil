#!/usr/bin/env bash
# measure.sh — constraint counts + Node proving time for Veil's circuits with circomlib Poseidon
# (baseline) vs. a Poseidon2 (t=3) sponge drop-in. Everything it prints is measured, not derived.
#
#   CIRCOM=/path/to/circom bash scripts/bench/poseidon2/measure.sh [RUNS]
#
# Prereqs: circuits/node_modules installed (cd circuits && npm ci); circom 2.2.x at $CIRCOM;
# poseidon2_bn254_t3.circom (regenerate with gen-poseidon2.mjs). No network needed: a LOCAL dev
# powers-of-tau (2^15, single contribution) is generated, same trust level as circuits/scripts/compile*.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
CIRCOM="${CIRCOM:-circom}"; RUNS="${1:-10}"
SNARKJS="node $ROOT/circuits/node_modules/snarkjs/build/cli.cjs"
W="${WORK:-/tmp/p2measure}"; rm -rf "$W"; mkdir -p "$W"
$SNARKJS powersoftau new bn128 15 "$W/p0.ptau" >/dev/null
$SNARKJS powersoftau contribute "$W/p0.ptau" "$W/p1.ptau" --name=dev -e="p2 bench" >/dev/null
$SNARKJS powersoftau prepare phase2 "$W/p1.ptau" "$W/pot.ptau" >/dev/null

for variant in baseline poseidon2; do
  for c in transfer withdraw compliance; do
    D="$W/$variant/$c"; mkdir -p "$D/src"
    cp -r "$ROOT/circuits/templates" "$D/src/templates"; ln -s "$ROOT/circuits/node_modules" "$D/src/node_modules"
    cp "$ROOT/circuits/$c.circom" "$D/src/$c.circom"
    if [ "$variant" = poseidon2 ]; then
      cp "$HERE/poseidon2_bn254_t3.circom" "$D/src/"
      sed -i 's/Poseidon(/Poseidon2Sponge(/' "$D/src/$c.circom" "$D/src/templates/merkle_proof.circom"
      sed -i '1,/^include/{/^include/i include "poseidon2_bn254_t3.circom";
}' "$D/src/$c.circom"
      sed -i '0,/^include/s##include "../poseidon2_bn254_t3.circom";\ninclude#' "$D/src/templates/merkle_proof.circom"
    fi
    (cd "$D/src" && $CIRCOM $c.circom --r1cs --wasm -o "$D" -l node_modules >"$D/circom.log" 2>&1) || { cat "$D/circom.log"; exit 1; }
    echo "== $variant/$c"; $SNARKJS r1cs info "$D/$c.r1cs" 2>&1 | grep -E "Constraints|Wires|Private Inputs|Public Inputs"
    $SNARKJS groth16 setup "$D/$c.r1cs" "$W/pot.ptau" "$D/0.zkey" >/dev/null
    $SNARKJS zkey contribute "$D/0.zkey" "$D/$c.zkey" --name=dev -e="p2 bench $c" >/dev/null
    ls -l "$D/$c.zkey" | awk '{print "zkey bytes:", $5}'
  done
done
echo "(prove-latency step: node $HERE/prove-variants.mjs $W $RUNS)"
