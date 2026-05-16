#!/bin/bash
# ceremony.sh — Multi-contributor trusted setup ceremony for Veil circuits
# Usage: bash scripts/ceremony.sh
#
# Runs a 3-contributor ceremony + random beacon for both transfer and compliance
# circuits. Each contributor uses cryptographic entropy from /dev/urandom.
#
# For mainnet: independent parties on separate machines should each run their
# own contribution step. This script simulates the ceremony locally for
# hackathon/testnet deployments.
#
# Requires: snarkjs 0.7.x, circom 2.1.x
# Prerequisite: both circuits must be compiled first (run compile.sh and
# compile-compliance.sh, or this script will error with instructions).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build"
FRONTEND_CIRCUITS_DIR="$CIRCUITS_DIR/../frontend/public/circuits"
PTAU_FILE="$BUILD_DIR/pot15_final.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"

NUM_CONTRIBUTORS=3
BEACON_HASH="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
BEACON_ITERATIONS=10

CIRCUITS=("transfer" "compliance")

cd "$CIRCUITS_DIR"

echo "=============================================="
echo "  Veil Multi-Contributor Trusted Setup Ceremony"
echo "=============================================="
echo ""
echo "Working directory: $CIRCUITS_DIR"
echo "Build directory:   $BUILD_DIR"
echo "Contributors:      $NUM_CONTRIBUTORS + random beacon"
echo ""

# ── Step 0: Check prerequisites ──────────────────────────────────────────────

# Resolve snarkjs binary (local node_modules preferred, fallback to global)
if [ -x "$CIRCUITS_DIR/node_modules/.bin/snarkjs" ]; then
  SNARKJS="$CIRCUITS_DIR/node_modules/.bin/snarkjs"
elif command -v snarkjs &> /dev/null; then
  SNARKJS="snarkjs"
else
  echo "ERROR: snarkjs not found. Install with: npm install (in circuits/) or npm install -g snarkjs"
  exit 1
fi
echo "[OK] Using snarkjs: $SNARKJS"

# Check that both .r1cs files exist
MISSING_CIRCUITS=()
for CIRCUIT in "${CIRCUITS[@]}"; do
  if [ ! -f "$BUILD_DIR/$CIRCUIT.r1cs" ]; then
    MISSING_CIRCUITS+=("$CIRCUIT")
  fi
done

if [ ${#MISSING_CIRCUITS[@]} -gt 0 ]; then
  echo "ERROR: Missing compiled circuits: ${MISSING_CIRCUITS[*]}"
  echo ""
  echo "Compile them first:"
  echo "  bash scripts/compile.sh        # for transfer.r1cs"
  echo "  bash scripts/compile-compliance.sh  # for compliance.r1cs"
  exit 1
fi

echo "[OK] Both circuit .r1cs files found."

# Check / download Powers of Tau
if [ ! -f "$PTAU_FILE" ]; then
  echo "[*] Downloading Powers of Tau (pot15, ~85MB)..."
  mkdir -p "$BUILD_DIR"
  curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"
else
  echo "[OK] Powers of Tau file found."
fi

echo ""

# ── Step 1: Run ceremony for each circuit ────────────────────────────────────

for CIRCUIT in "${CIRCUITS[@]}"; do
  echo "=============================================="
  echo "  Ceremony: $CIRCUIT"
  echo "=============================================="
  echo ""

  R1CS_FILE="$BUILD_DIR/$CIRCUIT.r1cs"
  ZKEY_PREFIX="$BUILD_DIR/$CIRCUIT"

  TOTAL_STEPS=$(( NUM_CONTRIBUTORS + 4 ))

  # 1a. Initial Groth16 setup
  echo "[1/$TOTAL_STEPS] Running Groth16 setup for $CIRCUIT..."
  $SNARKJS groth16 setup \
    "$R1CS_FILE" \
    "$PTAU_FILE" \
    "${ZKEY_PREFIX}_0000.zkey"
  echo "  -> ${CIRCUIT}_0000.zkey created"

  # 1b. Multi-contributor contributions
  for i in $(seq 1 $NUM_CONTRIBUTORS); do
    PREV=$(printf "%04d" $((i - 1)))
    NEXT=$(printf "%04d" $i)
    ENTROPY="$(head -c 64 /dev/urandom | xxd -p)"

    echo "[$(( i + 1 ))/$TOTAL_STEPS] Contribution $i of $NUM_CONTRIBUTORS (Contributor $i)..."
    $SNARKJS zkey contribute \
      "${ZKEY_PREFIX}_${PREV}.zkey" \
      "${ZKEY_PREFIX}_${NEXT}.zkey" \
      --name="Contributor $i" \
      -e="$ENTROPY"
    echo "  -> ${CIRCUIT}_${NEXT}.zkey created"
  done

  # 1c. Apply random beacon
  FINAL_CONTRIB=$(printf "%04d" $NUM_CONTRIBUTORS)
  echo "[$(( NUM_CONTRIBUTORS + 2 ))/$TOTAL_STEPS] Applying random beacon..."
  $SNARKJS zkey beacon \
    "${ZKEY_PREFIX}_${FINAL_CONTRIB}.zkey" \
    "${ZKEY_PREFIX}_final.zkey" \
    "$BEACON_HASH" \
    "$BEACON_ITERATIONS" \
    --name="Final Beacon"
  echo "  -> ${CIRCUIT}_final.zkey created"

  # 1d. Export verification key
  echo "[$(( NUM_CONTRIBUTORS + 3 ))/$TOTAL_STEPS] Exporting verification key..."
  $SNARKJS zkey export verificationkey \
    "${ZKEY_PREFIX}_final.zkey" \
    "${ZKEY_PREFIX}_vk.json"
  echo "  -> ${CIRCUIT}_vk.json created"

  # 1e. Verify the final zkey
  echo "[$(( NUM_CONTRIBUTORS + 4 ))/$TOTAL_STEPS] Verifying final zkey..."
  $SNARKJS zkey verify \
    "$R1CS_FILE" \
    "$PTAU_FILE" \
    "${ZKEY_PREFIX}_final.zkey"
  echo "  -> ${CIRCUIT}_final.zkey VERIFIED"

  # 1f. Clean up intermediate files
  echo "  Cleaning up intermediate zkey files..."
  for i in $(seq 0 $NUM_CONTRIBUTORS); do
    INTERMEDIATE=$(printf "%04d" $i)
    rm -f "${ZKEY_PREFIX}_${INTERMEDIATE}.zkey"
  done
  echo "  -> Intermediate files removed"

  echo ""
  echo "  Ceremony for $CIRCUIT complete!"
  echo ""
done

# ── Step 2: Generate WASM if not present ─────────────────────────────────────

for CIRCUIT in "${CIRCUITS[@]}"; do
  WASM_DIR="$BUILD_DIR/${CIRCUIT}_js"
  WASM_FILE="$WASM_DIR/$CIRCUIT.wasm"

  if [ ! -f "$WASM_FILE" ]; then
    echo "[*] Generating WASM for $CIRCUIT..."
    circom "$CIRCUIT.circom" \
      --wasm \
      --output "$BUILD_DIR"
    echo "  -> $WASM_FILE created"
  else
    echo "[OK] WASM for $CIRCUIT already present."
  fi
done

# ── Step 3: Copy final artifacts to frontend ─────────────────────────────────

echo ""
echo "Copying artifacts to frontend/public/circuits/..."
mkdir -p "$FRONTEND_CIRCUITS_DIR"

for CIRCUIT in "${CIRCUITS[@]}"; do
  cp "$BUILD_DIR/${CIRCUIT}_final.zkey" "$FRONTEND_CIRCUITS_DIR/"
  cp "$BUILD_DIR/${CIRCUIT}_vk.json" "$FRONTEND_CIRCUITS_DIR/"
  cp "$BUILD_DIR/${CIRCUIT}_js/$CIRCUIT.wasm" "$FRONTEND_CIRCUITS_DIR/"
  echo "  -> Copied ${CIRCUIT}_final.zkey, ${CIRCUIT}_vk.json, ${CIRCUIT}.wasm"
done

# ── Step 4: Print SHA256 hashes ──────────────────────────────────────────────

echo ""
echo "=============================================="
echo "  Artifact SHA256 Hashes"
echo "=============================================="

for CIRCUIT in "${CIRCUITS[@]}"; do
  echo ""
  echo "--- $CIRCUIT ---"
  shasum -a 256 "$BUILD_DIR/${CIRCUIT}_final.zkey"
  shasum -a 256 "$BUILD_DIR/${CIRCUIT}_vk.json"
  shasum -a 256 "$BUILD_DIR/${CIRCUIT}_js/$CIRCUIT.wasm"
done

echo ""
echo "=============================================="
echo "  Ceremony Complete!"
echo "=============================================="
echo ""
echo "Final artifacts in: $BUILD_DIR/"
echo "Frontend copies in: $FRONTEND_CIRCUITS_DIR/"
echo ""
echo "NOTE: This ceremony used $NUM_CONTRIBUTORS local contributors + a random beacon."
echo "For mainnet, independent parties on separate machines should contribute."
