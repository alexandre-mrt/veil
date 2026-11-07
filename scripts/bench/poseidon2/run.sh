#!/usr/bin/env bash
# Reproduce the 2026-11-07 Poseidon2-vs-Poseidon Merkle-node experiment end to end.
#   bash scripts/bench/poseidon2/run.sh [runs]        (from repo root; ~2 min on 4 cores)
# Needs network only for `npm ci` / `npx circom2` (npm registry). Powers of Tau is generated locally
# (dev-only; proving time does not depend on ptau contents).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; cd "$ROOT/circuits"
RUNS="${1:-10}"
[ -d node_modules ] || npm ci --silent
[ -d ../scripts/bench/node_modules ] || (cd ../scripts/bench && npm ci --silent --ignore-scripts)
CIRCOM="${CIRCOM:-npx --yes circom2}"
node ../scripts/bench/poseidon2/poseidon2.mjs   # known-answer test vs the HorizenLabs reference vector
node ../scripts/bench/poseidon2/gen.mjs
rm -rf build-p2; mkdir -p build-p2/base
for c in hash_circomlib2 hash_poseidon2 transfer compliance withdraw; do
  echo "== $c"; $CIRCOM build-p2src/$c.circom --r1cs --wasm --sym -o build-p2 2>&1 | grep -E "non-linear|linear con|wires|rror"
done
for c in transfer compliance; do $CIRCOM $c.circom --r1cs --wasm --sym -o build-p2/base >/dev/null; done
SJ=node_modules/.bin/snarkjs
$SJ powersoftau new bn128 15 build-p2/p0.ptau >/dev/null 2>&1
$SJ powersoftau contribute build-p2/p0.ptau build-p2/p1.ptau --name=dev -e="veil-bench-dev-only" >/dev/null 2>&1
$SJ powersoftau prepare phase2 build-p2/p1.ptau build-p2/pot15.ptau >/dev/null 2>&1
bash ../scripts/bench/poseidon2/setup-keys.sh
node ../scripts/bench/poseidon2/compare.mjs --runs "$RUNS"
