#!/bin/bash
# poseidon2-constraints.sh — R1CS constraint-count comparison: circomlib Poseidon vs
# @taceo/circom-lib Poseidon2, at the two arities Veil's circuits actually call (2 inputs / t=3,
# used by withdraw.circom's recipientHash; 3 inputs / t=4, used by transfer.circom's txAmountHash
# and compliance.circom's nfHash/ctxHash).
#
# Compiles all four circuits under circuits/bench/poseidon2/ twice: once with circom's default
# optimization (matches circuits/scripts/compile*.sh, which pass no -O flag — this is what actually
# ships), and once with --O2 (full linear-constraint elimination) to see whether the two encodings
# converge once the compiler is allowed to fully simplify. Then Groth16-setups each pair against a
# small locally-generated Powers of Tau (network access to the Hermez ptau host used by
# circuits/scripts/compile.sh is blocked by this environment's egress policy — generating a fresh
# small ptau locally is standard practice for a toy-sized circuit and needs no network at all) and
# times proving with the same snarkjs.groth16.fullProve call BASELINE.md's harness uses.
#
# Usage: bash scripts/bench/poseidon2-constraints.sh [--runs N]
#
# Requires: circom on PATH (cargo install --git https://github.com/iden3/circom.git --tag v2.2.2 circom),
# node, and circuits/node_modules installed (npm install in circuits/).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_DIR="$(cd "$SCRIPT_DIR/../../circuits/bench/poseidon2" && pwd)"
CIRCUITS_DIR="$(cd "$BENCH_DIR/../.." && pwd)"
RUNS=10
for ((i=1; i<=$#; i++)); do
  if [ "${!i}" = "--runs" ]; then
    j=$((i+1))
    RUNS="${!j}"
  fi
done

CIRCUITS=(main_poseidon_t3 main_poseidon2_t3 main_poseidon_t4 main_poseidon2_t4)

cd "$BENCH_DIR"

if ! command -v circom &> /dev/null; then
  echo "ERROR: circom not found on PATH." >&2
  exit 1
fi
echo "circom version: $(circom --version)"
echo

# ── 1. Constraint counts, default optimization (matches production compile*.sh) ─────────────────
echo "=== R1CS constraint counts — circom default optimization (no -O flag, matches circuits/scripts/compile*.sh) ==="
mkdir -p build
for c in "${CIRCUITS[@]}"; do
  echo "--- $c ---"
  circom "$c.circom" --r1cs --wasm --sym --output build
  echo
done

# ── 2. Constraint counts, full optimization ──────────────────────────────────────────────────────
echo "=== R1CS constraint counts — circom --O2 (full linear-constraint elimination) ==="
mkdir -p build-o2
for c in "${CIRCUITS[@]}"; do
  echo "--- $c ---"
  circom "$c.circom" --r1cs --wasm --sym --O2 --output build-o2
  echo
done

echo "=== snarkjs r1cs info (default build, cross-check against the compiler's own report above) ==="
for c in "${CIRCUITS[@]}"; do
  echo "--- $c ---"
  npx --prefix "$CIRCUITS_DIR" snarkjs r1cs info "build/$c.r1cs"
  echo
done

# ── 3. Local, dev-only Powers of Tau + per-circuit Groth16 setup (no network) ───────────────────
# 2^10 = 1024 constraints is enough headroom for all four circuits (largest is 852 total
# constraints, default build; well under 1024). This is the same "single dev-only contribution,
# not a production ceremony" pattern circuits/scripts/compile*.sh already uses for the real
# circuits — see docs/threat-model.md RR2 — just generated locally instead of reusing a
# downloaded pot15 file, since only 2^10 is needed and the network path to the Hermez ptau host
# is blocked here (see this experiment's report, "Toolchain gaps hit").
PTAU="build/pot10_final.ptau"
if [ ! -f "$PTAU" ]; then
  echo "=== Generating a local dev-only Powers of Tau (2^10, no network) ==="
  npx --prefix "$CIRCUITS_DIR" snarkjs powersoftau new bn128 10 build/pot10_0000.ptau -v
  npx --prefix "$CIRCUITS_DIR" snarkjs powersoftau contribute build/pot10_0000.ptau build/pot10_0001.ptau \
    --name="poseidon2-bench dev contribution" -v -e="$(date +%s%N)-poseidon2-bench"
  npx --prefix "$CIRCUITS_DIR" snarkjs powersoftau prepare phase2 build/pot10_0001.ptau "$PTAU" -v
fi

echo
echo "=== Groth16 setup (dev-only single contribution, same pattern as circuits/scripts/compile.sh) ==="
for c in "${CIRCUITS[@]}"; do
  if [ -f "build/${c}_final.zkey" ]; then
    echo "--- $c: zkey already present, skipping setup ---"
    continue
  fi
  echo "--- $c ---"
  npx --prefix "$CIRCUITS_DIR" snarkjs groth16 setup "build/$c.r1cs" "$PTAU" "build/${c}_0000.zkey"
  echo "poseidon2-bench-dev-entropy-$(date +%s%N)-$c" | npx --prefix "$CIRCUITS_DIR" snarkjs zkey contribute \
    "build/${c}_0000.zkey" "build/${c}_final.zkey" --name="poseidon2-bench-dev" -v
  npx --prefix "$CIRCUITS_DIR" snarkjs zkey export verificationkey "build/${c}_final.zkey" "build/${c}_vk.json"
done

echo
echo "=== Proving-time benchmark ($RUNS runs per circuit) ==="
node "$SCRIPT_DIR/poseidon2-prove-latency.mjs" --runs "$RUNS"
