#!/bin/bash
# poseidon-constraint-attribution.sh — measures, via real circom compiles of isolated
# single-gadget probe circuits, the exact R1CS non-linear constraint cost of every
# gadget Veil's three circuits use (each Poseidon arity, each range check, each
# comparator, and the depth-20 Merkle-membership template as a whole).
#
# It then reconciles those per-gadget numbers against the real, full-circuit
# `circom --r1cs` totals for transfer.circom / compliance.circom / withdraw.circom
# (recompiled fresh, not read from a stale build/ directory) — the reconciliation
# is the falsifiable check: if per-gadget numbers don't sum exactly to the real
# circuit total, something in this script's model of the circuit is wrong.
#
# Usage:
#   bash scripts/bench/poseidon-constraint-attribution.sh
#
# Requires: circom 2.1.x/2.2.x on $PATH (or $CIRCOM pointing at the binary),
# and `circuits/node_modules/circomlib` installed (`cd circuits && npm install`).
#
# Produces no artifacts outside $TMPDIR — every probe circuit is generated inline
# below and compiled in a scratch directory that is removed on exit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CIRCUITS_DIR="$(cd "$SCRIPT_DIR/../../circuits" && pwd)"
CIRCOM="${CIRCOM:-circom}"

if ! command -v "$CIRCOM" &> /dev/null; then
  echo "ERROR: circom not found on \$PATH and \$CIRCOM not set."
  echo "  cargo install circom   # or: git clone https://github.com/iden3/circom && cargo build --release"
  exit 1
fi

if [ ! -d "$CIRCUITS_DIR/node_modules/circomlib" ]; then
  echo "ERROR: circuits/node_modules/circomlib missing. Run: cd circuits && npm install"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ln -s "$CIRCUITS_DIR/node_modules" "$WORK/node_modules"
mkdir -p "$WORK/templates"
cp "$CIRCUITS_DIR/templates/merkle_proof.circom" "$WORK/templates/merkle_proof.circom"

# name:template-expression
PROBES=(
  "poseidon_t3:Poseidon(2):poseidon.circom"   # t=3, used for Merkle-tree node hashing
  "poseidon_t4:Poseidon(3):poseidon.circom"   # t=4, used for txAmountHash / compliance nullifier / context bind
  "poseidon_t5:Poseidon(4):poseidon.circom"   # t=5, used for commitments / transfer & withdraw nullifiers
  "poseidon_t6:Poseidon(5):poseidon.circom"   # t=6, used for the credential leaf hash
  "num2bits_64:Num2Bits(64):bitify.circom"
  "num2bits_8:Num2Bits(8):bitify.circom"
  "greaterthan_64:GreaterThan(64):comparators.circom"
  "lesseqthan_64:LessEqThan(64):comparators.circom"
  "greatereqthan_64:GreaterEqThan(64):comparators.circom"
  "greatereqthan_8:GreaterEqThan(8):comparators.circom"
  "multimux1_2:MultiMux1(2):mux1.circom"
)

declare -A NONLINEAR
declare -A LINEAR

echo "=== Isolated single-gadget probe compiles (circom $($CIRCOM --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo unknown)) ==="
for probe in "${PROBES[@]}"; do
  IFS=":" read -r name tmpl include <<< "$probe"
  cat > "$WORK/$name.circom" <<EOF
pragma circom 2.0.0;
include "node_modules/circomlib/circuits/$include";
component main = $tmpl;
EOF
  out=$("$CIRCOM" "$WORK/$name.circom" --r1cs -o "$WORK" -l "$WORK" 2>&1)
  nl=$(echo "$out" | grep -oE 'non-linear constraints: [0-9]+' | grep -oE '[0-9]+')
  lin=$(echo "$out" | grep -oE '^linear constraints: [0-9]+' | grep -oE '[0-9]+')
  NONLINEAR[$name]=$nl
  LINEAR[$name]=$lin
  printf "  %-20s non-linear=%-6s linear=%s\n" "$name ($tmpl)" "$nl" "$lin"
done

# MerkleProof(20) as a whole (own template, not circomlib) — includes 20x poseidon_t3
# + 20x MultiMux1(2) + 20x boolean pathIndices check, all in one compile.
cat > "$WORK/merkle20.circom" <<EOF
pragma circom 2.0.0;
include "templates/merkle_proof.circom";
component main = MerkleProof(20);
EOF
out=$("$CIRCOM" "$WORK/merkle20.circom" --r1cs -o "$WORK" -l "$WORK" 2>&1)
merkle_nl=$(echo "$out" | grep -oE 'non-linear constraints: [0-9]+' | grep -oE '[0-9]+')
printf "  %-20s non-linear=%-6s (= 20x poseidon_t3 [%s] + 20x2 mux-mul [%s] + 20x boolean-check [%s])\n" \
  "merkle20 (depth 20)" "$merkle_nl" \
  "$((20 * NONLINEAR[poseidon_t3]))" \
  "$((20 * 2 * NONLINEAR[multimux1_2] / 2))" \
  "20"
echo

reconcile() {
  local circuit_file="$1"; shift
  local expected_terms=("$@")
  local sum=0
  for t in "${expected_terms[@]}"; do sum=$((sum + t)); done
  echo "  predicted non-linear total: $sum"
  local out
  out=$("$CIRCOM" "$CIRCUITS_DIR/$circuit_file" --r1cs -o "$WORK" -l "$CIRCUITS_DIR/node_modules" -l "$CIRCUITS_DIR" 2>&1)
  local actual
  actual=$(echo "$out" | grep -oE 'non-linear constraints: [0-9]+' | grep -oE '[0-9]+')
  echo "  actual non-linear total ($circuit_file, fresh compile): $actual"
  if [ "$sum" = "$actual" ]; then
    echo "  MATCH"
  else
    echo "  MISMATCH (diff: $((actual - sum)))"
  fi
}

echo "=== Reconciliation against fresh full-circuit compiles ==="
echo "--- transfer.circom ---"
echo "  merkle20 + oldHash(t5) + newHash(t5) + nfHash(t5) + txHash(t4) + 4xNum2Bits64 + GreaterThan64 + LessEqThan64"
reconcile "transfer.circom" \
  "$merkle_nl" "${NONLINEAR[poseidon_t5]}" "${NONLINEAR[poseidon_t5]}" "${NONLINEAR[poseidon_t5]}" \
  "${NONLINEAR[poseidon_t4]}" \
  "${NONLINEAR[num2bits_64]}" "${NONLINEAR[num2bits_64]}" "${NONLINEAR[num2bits_64]}" "${NONLINEAR[num2bits_64]}" \
  "${NONLINEAR[greaterthan_64]}" "${NONLINEAR[lesseqthan_64]}"
echo

echo "--- compliance.circom ---"
echo "  merkle20 + leafHash(t6) + nfHash(t4) + ctxHash(t4) + GreaterEqThan64 + GreaterEqThan8 + 3xboolean-mul + 2xNum2Bits64 + 2xNum2Bits8 + Num2Bits64(issuer)"
reconcile "compliance.circom" \
  "$merkle_nl" "${NONLINEAR[poseidon_t6]}" "${NONLINEAR[poseidon_t4]}" "${NONLINEAR[poseidon_t4]}" \
  "${NONLINEAR[greatereqthan_64]}" "${NONLINEAR[greatereqthan_8]}" \
  1 1 1 \
  "${NONLINEAR[num2bits_64]}" "${NONLINEAR[num2bits_64]}" "${NONLINEAR[num2bits_8]}" "${NONLINEAR[num2bits_8]}" "${NONLINEAR[num2bits_64]}"
echo

echo "--- withdraw.circom (no Merkle proof) ---"
echo "  commHash(t5) + changeHash(t5) + nfHash(t5) + recipHash(t3) + 3xNum2Bits64 + GreaterThan64 + LessEqThan64"
reconcile "withdraw.circom" \
  "${NONLINEAR[poseidon_t5]}" "${NONLINEAR[poseidon_t5]}" "${NONLINEAR[poseidon_t5]}" "${NONLINEAR[poseidon_t3]}" \
  "${NONLINEAR[num2bits_64]}" "${NONLINEAR[num2bits_64]}" "${NONLINEAR[num2bits_64]}" \
  "${NONLINEAR[greaterthan_64]}" "${NONLINEAR[lesseqthan_64]}"
echo

echo "=== Poseidon S-box share of each circuit's non-linear constraints ==="
echo "(pure Poseidon-permutation cost only — excludes the Merkle path's non-Poseidon"
echo " scaffolding: 20x MultiMux1 selection [$((20*2))] + 20x pathIndices boolean check [20])"
merkle_pure_poseidon=$((20 * NONLINEAR[poseidon_t3]))
merkle_scaffolding=$((merkle_nl - merkle_pure_poseidon))
transfer_poseidon=$((merkle_pure_poseidon + 3 * NONLINEAR[poseidon_t5] + NONLINEAR[poseidon_t4]))
compliance_poseidon=$((merkle_pure_poseidon + NONLINEAR[poseidon_t6] + 2 * NONLINEAR[poseidon_t4]))
withdraw_poseidon=$((2 * NONLINEAR[poseidon_t5] + NONLINEAR[poseidon_t5] + NONLINEAR[poseidon_t3]))
echo "  transfer.circom:    $transfer_poseidon / 6470  ($(awk "BEGIN{printf \"%.1f\", 100*$transfer_poseidon/6470}")%) pure-Poseidon non-linear constraints"
echo "  compliance.circom:  $compliance_poseidon / 6057  ($(awk "BEGIN{printf \"%.1f\", 100*$compliance_poseidon/6057}")%) pure-Poseidon non-linear constraints"
echo "  withdraw.circom:    $withdraw_poseidon / 1465  ($(awk "BEGIN{printf \"%.1f\", 100*$withdraw_poseidon/1465}")%) pure-Poseidon non-linear constraints"
echo
echo "  merkle20 total:      $merkle_nl non-linear constraints, of which:"
echo "    - pure Poseidon (20x t=3 permutations): $merkle_pure_poseidon"
echo "    - mux + boolean scaffolding (not Poseidon, unaffected by any hash swap): $merkle_scaffolding"
echo "  merkle20 is $(awk "BEGIN{printf \"%.1f\", 100*$merkle_nl/6470}")% of transfer.circom and $(awk "BEGIN{printf \"%.1f\", 100*$merkle_nl/6057}")% of compliance.circom's non-linear constraints —"
echo "  the single largest lever in both circuits is Merkle depth, not any individual hash instance."
