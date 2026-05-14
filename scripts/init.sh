#!/bin/bash
set -e
echo "=== Veil: Installing dependencies ==="
command -v circom > /dev/null 2>&1 || echo "WARNING: circom not installed"
command -v snarkjs > /dev/null 2>&1 || npm install -g snarkjs
[ -d circuits/node_modules ] || (cd circuits && npm install)
[ -d frontend/node_modules ] || (cd frontend && bun install)
[ -d scripts/node_modules ] || (cd scripts && bun install)
command -v sui > /dev/null 2>&1 && (cd contracts && sui move build) || echo "WARNING: sui CLI not found"
echo "=== Done ==="
