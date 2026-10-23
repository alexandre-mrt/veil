#!/usr/bin/env bash
# run.sh — A/B/C constraint + proving-time comparison: circomlib Poseidon vs Poseidon2 shim.
# Usage: CIRCOM=/path/to/circom WORK=/path/to/workdir bash scripts/bench/poseidon2/run.sh [RUNS]
# Needs: circuits/node_modules (npm ci), scripts/bench/poseidon2/node_modules (npm i), $CIRCOM.
# Powers of Tau: uses $WORK/pot15_final.ptau if present, else generates a LOCAL dev-only 2^15 one
# (proving time depends on circuit structure, not ptau entropy; NOT a secure setup).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
CIRCOM="${CIRCOM:-circom}"; WORK="${WORK:?set WORK}"; RUNS="${1:-10}"
SNARKJS="$ROOT/circuits/node_modules/.bin/snarkjs"
mkdir -p "$WORK"; cd "$WORK"

if [ ! -f pot15_final.ptau ]; then
  $SNARKJS powersoftau new bn128 15 pot15_0.ptau -v >/dev/null
  echo "veil-bench-entropy" | $SNARKJS powersoftau contribute pot15_0.ptau pot15_1.ptau --name=bench >/dev/null
  $SNARKJS powersoftau prepare phase2 pot15_1.ptau pot15_final.ptau >/dev/null
fi

echo "##### A. micro: constraints per hash arity (circom output) #####"
for n in 2 3 4 5; do
  for impl in circomlib poseidon2; do
    f="micro_${impl}_$n.circom"
    if [ $impl = circomlib ]; then inc="$ROOT/circuits/node_modules/circomlib/circuits/poseidon.circom"; else inc="$HERE/poseidon2.circom"; fi
    printf 'pragma circom 2.1.0;\ninclude "%s";\ncomponent main = Poseidon(%s);\n' "$inc" "$n" > "$f"
    out=$($CIRCOM "$f" --r1cs 2>&1)
    nl=$(sed -n 's/^non-linear constraints: //p' <<<"$out"); li=$(sed -n 's/^linear constraints: //p' <<<"$out")
    echo "Poseidon($n) $impl: non-linear=$nl linear=$li"
  done
done

echo "##### B. full circuits (base=circomlib, p2=poseidon2 shim, o2=circomlib + circom --O2, p2o2=poseidon2 + --O2) #####"
for c in transfer withdraw compliance; do
  for v in base o2 p2 p2o2; do
    d="$WORK/$v-$c"; rm -rf "$d"; mkdir -p "$d/src/templates"
    cp "$ROOT/circuits/$c.circom" "$d/src/"; cp "$ROOT/circuits/templates/"*.circom "$d/src/templates/"
    ln -sfn "$ROOT/circuits/node_modules" "$d/src/node_modules"
    OPT=""; { [ $v = o2 ] || [ $v = p2o2 ]; } && OPT="--O2"   # control: circomlib Poseidon, circom --O2 linear-constraint elimination
    if [ $v = p2 ] || [ $v = p2o2 ]; then
      sed -i 's#include "\(\.\./\)\?node_modules/circomlib/circuits/poseidon.circom";#include "poseidon2.circom";#' "$d/src/$c.circom" "$d/src/templates/merkle_proof.circom"
      L="-l $HERE"
    else L=""; fi
    echo "== $v $c =="
    (cd "$d/src" && $CIRCOM $c.circom --r1cs --wasm --sym $OPT -o "$d" $L 2>&1 | grep -E "^(non-linear|linear) constraints|^wires")
    $SNARKJS r1cs info "$d/$c.r1cs" 2>&1 | grep -E "Constraints|Wires|Private|Public"
    $SNARKJS groth16 setup "$d/$c.r1cs" pot15_final.ptau "$d/${c}_0.zkey" >/dev/null
    echo "bench-$v" | $SNARKJS zkey contribute "$d/${c}_0.zkey" "$d/${c}_final.zkey" --name=bench >/dev/null
    ls -l "$d/${c}_final.zkey" | awk '{print "zkey bytes:", $5}'
  done
done

echo "##### C. proving time (Node, mean of $RUNS runs, includes witness gen) #####"
cd "$HERE" && WORK="$WORK" node prove-ab.mjs --runs "$RUNS"
