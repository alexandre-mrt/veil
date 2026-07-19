#!/bin/bash
# build-circuit.sh — compile a circuit with @distributedlab/circom2 (WASM build),
# retrying until the r1cs/wasm output actually round-trips.
#
# Found empirically (docs/research/2026-07-19-baseline.md): circom2's WASM codegen
# occasionally segfaults mid-write or silently truncates build/<name>.r1cs or
# build/<name>_js/<name>.wat under this toolchain. Re-running the same command
# reliably succeeds within a few attempts and produces byte-identical constraint
# counts every time it does — this is a retry-worthy flake, not a determinism bug.
#
# Usage: ./build-circuit.sh <circuit-name>   (e.g. ./build-circuit.sh transfer)
set -euo pipefail
NAME=$1
CIRCOM=./node_modules/.bin/circom2
SNARKJS=./node_modules/.bin/snarkjs
MAX_ATTEMPTS=8

echo "=== Compiling $NAME (r1cs + sym) ==="
for attempt in $(seq 1 $MAX_ATTEMPTS); do
  rm -f "build/$NAME.r1cs" "build/$NAME.sym"
  $CIRCOM "$NAME.circom" --r1cs --sym --output build -l node_modules || true
  if $SNARKJS r1cs info "build/$NAME.r1cs" > /tmp/r1cs-info-$NAME.txt 2>&1; then
    echo "r1cs valid on attempt $attempt:"
    cat /tmp/r1cs-info-$NAME.txt
    break
  fi
  echo "attempt $attempt produced an invalid r1cs, retrying..."
  if [ "$attempt" = "$MAX_ATTEMPTS" ]; then
    echo "ERROR: $NAME.r1cs still invalid after $MAX_ATTEMPTS attempts" >&2
    exit 1
  fi
done

echo "=== Compiling $NAME (wasm witness generator) ==="
# The real validity check is "does wat2wasm.mjs succeed" — a truncated .wat can
# still end in a stray ')' from an inner s-expression, so a byte/tail check
# isn't reliable; only a successful parse proves the file is complete.
WASM_OK=false
for attempt in $(seq 1 $MAX_ATTEMPTS); do
  rm -rf "build/${NAME}_js"
  $CIRCOM "$NAME.circom" --wasm --output build -l node_modules || true
  WAT="build/${NAME}_js/${NAME}.wat"
  if [ -f "$WAT" ]; then
    sed -e 's/\bget_local\b/local.get/g' \
        -e 's/\bset_local\b/local.set/g' \
        -e 's/\btee_local\b/local.tee/g' \
        -e 's#i32\.wrap/i64#i32.wrap_i64#g' \
        -e 's#i64\.extend_u/i32#i64.extend_i32_u#g' \
        "$WAT" > "build/${NAME}_js/${NAME}_fixed.wat"
    if node wat2wasm.mjs "build/${NAME}_js/${NAME}_fixed.wat" "build/${NAME}_js/${NAME}.wasm"; then
      echo "wasm built on attempt $attempt"
      WASM_OK=true
      break
    fi
    echo "attempt $attempt produced an unparseable .wat, retrying..."
  else
    echo "attempt $attempt produced no .wat, retrying..."
  fi
done
if [ "$WASM_OK" != "true" ]; then
  echo "ERROR: $NAME wasm build still failing after $MAX_ATTEMPTS attempts" >&2
  exit 1
fi
echo "=== Done: build/${NAME}_js/${NAME}.wasm ==="
