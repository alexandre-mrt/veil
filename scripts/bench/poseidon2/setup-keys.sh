#!/usr/bin/env bash
# Dev-only Groth16 keys for the 4 compared circuits, built in parallel (snarkjs setup is single-threaded).
# Usage: bash scripts/bench/poseidon2/setup-keys.sh   (run from repo root; needs circuits/build-p2 artifacts)
set -euo pipefail
B="$(cd "$(dirname "$0")/../../../circuits/build-p2" && pwd)"
SJ="$B/../node_modules/.bin/snarkjs"
one() { # circuit variant dir
  local tag="$1-$2" d="$3"
  [ -f "$B/$tag.zkey" ] && return 0
  $SJ groth16 setup "$d/$1.r1cs" "$B/pot15.ptau" "$B/${tag}_0.zkey" >/dev/null
  $SJ zkey contribute "$B/${tag}_0.zkey" "$B/$tag.zkey" --name=dev -e="veil-bench-dev-only" >/dev/null
  $SJ zkey export verificationkey "$B/$tag.zkey" "$B/$tag.vk.json" >/dev/null
  echo "done $tag"
}
one transfer baseline "$B/base" & one transfer poseidon2-merkle "$B" &
one compliance baseline "$B/base" & one compliance poseidon2-merkle "$B" &
wait
