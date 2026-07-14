#!/usr/bin/env bash
# Run the confidential-payroll PoC against Sui devnet.
# Requires ./setup.sh to have been run once. See setup.sh for why each of these matters.
set -euo pipefail

cd "$(dirname "$0")"
export PATH="/tmp/sui-devnet-175:$PATH"
export SUI_CONFIG_DIR="${SUI_CONFIG_DIR:-/tmp/veil-ctcfg}"

# Refresh the devnet chain-id pin: devnet is wiped periodically and a stale pin
# silently builds against the wrong environment.
CHAIN_ID="$(sui client chain-identifier)"
printf '[package]\nname = "contra"\nedition = "2024"\n\n[environments]\ndevnet = "%s"\n' \
  "$CHAIN_ID" > vendor/confidential-transfers/move/Move.toml

exec pnpm poc
