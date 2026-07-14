#!/usr/bin/env bash
# Bootstrap the Veil x contra devnet experiment.
#
# Encodes four things that are NOT obvious and each cost a failed run:
#   1. The Sui CLI ships its own framework, and contra HEAD needs a recent one: it calls
#      `sui::rangeproofs::verify_bulletproofs_with_dst_ristretto255`, which does not exist
#      before ~1.75. Homebrew's 1.72 AND devnet-v1.73.0 both fail with "unbound module
#      member". devnet-v1.75.0 builds it. (Live devnet reports 1.76.0.)
#   2. On macOS, Apple's clang has no wasm32 backend, so the Bulletproofs WASM crate
#      fails to cross-compile (`clear_on_drop`/`blst` C deps). Point cc-rs at brew's LLVM.
#   3. Devnet is periodically wiped and re-genesised. contra's `Move.toml` pins a stale
#      devnet chain id, and `contra-utils` reads the chain id from the ACTIVE Sui CLI env
#      — so we use an isolated SUI_CONFIG_DIR pinned to devnet (never ~/.sui, which holds
#      real keys) and rewrite the pin to the live chain id.
#   4. ts-utils depends on ts-sdk, so ts-sdk must be built FIRST.
set -euo pipefail

cd "$(dirname "$0")"
VENDOR="vendor/confidential-transfers"
SUI_BIN_DIR="/tmp/sui-devnet-175"
export SUI_CONFIG_DIR="${SUI_CONFIG_DIR:-/tmp/veil-ctcfg}"

echo "▸ 1/5  contra source"
if [ ! -d "$VENDOR" ]; then
  mkdir -p vendor
  git clone --depth 1 https://github.com/MystenLabs/confidential-transfers.git "$VENDOR"
fi

echo "▸ 2/5  sui devnet-v1.75.0 binary"
if [ ! -x "$SUI_BIN_DIR/sui" ]; then
  mkdir -p "$SUI_BIN_DIR"
  (cd "$SUI_BIN_DIR" \
    && gh release download devnet-v1.75.0 -R MystenLabs/sui -p '*macos-arm64.tgz' --clobber \
    && tar xzf ./*.tgz \
    && xattr -dr com.apple.quarantine . 2>/dev/null || true)
fi
export PATH="$SUI_BIN_DIR:$PATH"
sui --version

echo "▸ 3/5  isolated devnet Sui config ($SUI_CONFIG_DIR)"
mkdir -p "$SUI_CONFIG_DIR"
cat > "$SUI_CONFIG_DIR/client.yaml" <<EOF
keystore:
  File: $SUI_CONFIG_DIR/sui.keystore
envs:
  - alias: devnet
    rpc: "https://fullnode.devnet.sui.io:443"
    ws: ~
    basic_auth: ~
active_env: devnet
active_address: ~
EOF
[ -f "$SUI_CONFIG_DIR/sui.keystore" ] || echo '[]' > "$SUI_CONFIG_DIR/sui.keystore"
CHAIN_ID="$(sui client chain-identifier)"
echo "   live devnet chain id: $CHAIN_ID"

# contra pins a devnet chain id that goes stale on every devnet re-genesis.
printf '[package]\nname = "contra"\nedition = "2024"\n\n[environments]\ndevnet = "%s"\n' \
  "$CHAIN_ID" > "$VENDOR/move/Move.toml"

echo "▸ 4/5  Bulletproofs WASM (Rust → wasm32)"
if [ ! -d "$VENDOR/utils/bulletproofs-wasm/nodejs" ]; then
  LLVM="$(brew --prefix llvm)"
  (cd "$VENDOR/utils/bulletproofs-wasm" \
    && CC_wasm32_unknown_unknown="$LLVM/bin/clang" \
       AR_wasm32_unknown_unknown="$LLVM/bin/llvm-ar" \
       pnpm build:wasm)
fi

echo "▸ 5/5  TypeScript (ts-sdk before ts-utils — ts-utils depends on it)"
(cd "$VENDOR/ts-sdk" && pnpm install --silent && pnpm build >/dev/null)
(cd "$VENDOR/utils/ts-utils" && pnpm install --force --silent && pnpm build >/dev/null)
pnpm install --silent

echo
echo "✅ ready — run:  ./run.sh"
