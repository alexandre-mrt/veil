#!/usr/bin/env bash
# run-gas-local.sh — Real on-chain gas for every Veil entry point, measured on a throwaway local
# Sui network. Wraps gas-local.mjs (which does the measuring) with the network/publish setup.
#
# Prerequisites:
#   - `sui` CLI on PATH (tested with testnet-v1.84.1 built from source:
#       git clone --depth 1 --branch testnet-v1.84.1 https://github.com/MystenLabs/sui.git
#       cargo build --release --bin sui)
#   - circuit artifacts built: circuits/scripts/compile{,-withdraw,-compliance}.sh
#   - `npm ci` in scripts/bench
#
# Usage: bash scripts/bench/run-gas-local.sh [out-dir]
# Leaves raw JSON (publish effects + per-tx gasUsed) in out-dir (default: a mktemp dir).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$(mktemp -d)}"
mkdir -p "$OUT"
RPC="http://127.0.0.1:9000"
EPOCH_MS="${EPOCH_MS:-60000}"

sui --version

# ── local network (fresh genesis every run, so results don't depend on prior state) ──
sui start --with-faucet --force-regenesis > "$OUT/sui-start.log" 2>&1 &
NET_PID=$!
trap 'kill $NET_PID 2>/dev/null || true' EXIT
for i in $(seq 1 120); do
  if curl -s -m 2 -X POST "$RPC" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}' | grep -q result; then
    break
  fi
  sleep 1
done
curl -s -X POST "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'; echo

# ── client env + funded address ──
sui client --yes new-env --alias local --rpc "$RPC" >/dev/null 2>&1 || true
sui client switch --env local
sui client active-address >/dev/null 2>&1 || sui client new-address ed25519 >/dev/null
for i in 1 2 3; do sui client faucet >/dev/null 2>&1 && break || sleep 3; done
sleep 3
sui client gas --json | head -c 400; echo

# ── publish Veil + the VK-preparation bench package ──
publish() {
  local dir="$1" out="$2"
  ( cd "$dir" && sui client test-publish --build-env testnet --gas-budget 2000000000 --json > "$out" 2> "$out.stderr" ) \
    || ( cd "$dir" && sui client publish --gas-budget 2000000000 --json > "$out" 2> "$out.stderr" )
  grep -q '"published"' "$out" || { echo "publish failed for $dir"; cat "$out.stderr"; exit 1; }
}
publish "$ROOT/contracts" "$OUT/publish-veil.json"
publish "$HERE/move-pvk" "$OUT/publish-pvk.json"

node "$HERE/gas-local.mjs" --publish-json "$OUT/publish-veil.json" --pvk-publish-json "$OUT/publish-pvk.json" \
  --rpc "$RPC" --epoch-ms "$EPOCH_MS" --out "$OUT/gas-results.json"
echo "raw results: $OUT"
