#!/bin/bash
# run-all.sh — run every Veil BASELINE.md benchmark and print the exact
# commands used, so the numbers in docs/research/*.md are always reproducible.
#
# Prerequisites:
#   cd circuits && npm install
#   circom transfer.circom --r1cs --wasm --sym --output build -l node_modules
#   circom compliance.circom --r1cs --wasm --sym --output build-compliance -l node_modules
#   circom withdraw.circom --r1cs --wasm --sym --output build-withdraw -l node_modules
#   bash scripts/compile.sh            # or run groth16 setup manually per circuit
#   bash scripts/compile-compliance.sh
#   bash scripts/compile-withdraw.sh
#   cd scripts/bench && npm install    # circomlibjs, snarkjs, playwright (this dir)
#
# Usage: bash scripts/bench/run-all.sh [iterations]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../circuits" && pwd)"
ITERATIONS="${1:-10}"

echo "=== R1CS constraint counts ==="
for pair in "transfer:build" "compliance:build-compliance" "withdraw:build-withdraw"; do
  name="${pair%%:*}"; dir="${pair##*:}"
  echo "--- $name ---"
  npx --prefix "$CIRCUITS_DIR" snarkjs r1cs info "$CIRCUITS_DIR/$dir/$name.r1cs"
done

echo ""
echo "=== Groth16 proving time / proof size / VK size (Node) ==="
node "$SCRIPT_DIR/prove-latency.mjs" "$ITERATIONS"

echo ""
echo "=== Groth16 proving time (headless Chromium, transfer circuit only) ==="
node "$SCRIPT_DIR/prove-latency-browser.mjs" "$ITERATIONS"

echo ""
echo "On-chain gas per entry point: BLOCKED — no 'sui' CLI binary available in this"
echo "environment (no apt package, GitHub release download out of session's repo"
echo "scope, building MystenLabs/sui from source is a multi-hour/multi-GB build)."
echo "See docs/research/2026-07-25-baseline.md and EXPERIMENTS.md item 2/3."
