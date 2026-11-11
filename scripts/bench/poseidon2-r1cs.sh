#!/usr/bin/env bash
# poseidon2-r1cs.sh — R1CS cost of Poseidon2 (BN254, t=3) vs circomlib Poseidon(2), alone, in a
# depth-20 Merkle path, and inside transfer.circom. Also checks the circom Poseidon2 template
# against the HorizenLabs known-answer vector and runs the negative test.
#
#   bash scripts/bench/poseidon2-r1cs.sh            # default circom flags (what compile*.sh use)
#   OPT=--O2 bash scripts/bench/poseidon2-r1cs.sh   # full linear simplification
#
# Prereqs: circom 2.2.x on PATH; `npm ci` in circuits/ and scripts/bench/.
# Output: circuits/research/build/ (gitignored). Proving-time half: poseidon2-prove.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="$ROOT/circuits"
OUT="$C/research/build${OPT:+-${OPT#--}}"
SNARKJS="$C/node_modules/.bin/snarkjs"
mkdir -p "$OUT"

node "$ROOT/scripts/bench/poseidon2/poseidon2.mjs" >/dev/null && echo "JS reference KAT: PASS"
node "$ROOT/scripts/bench/poseidon2/gen-circom.mjs" >/dev/null

# transfer_p2.circom = transfer.circom with the Merkle template swapped, nothing else.
sed -e 's#include "templates/merkle_proof.circom";#include "research/merkle_proof_p2.circom";#' \
    -e 's#MerkleProof(20)#MerkleProofP2(20)#' "$C/transfer.circom" > "$OUT/transfer_p2.circom"
diff <(sed 's#research/merkle_proof_p2#templates/merkle_proof#; s#MerkleProofP2#MerkleProof#' "$OUT/transfer_p2.circom") "$C/transfer.circom" \
  && echo "transfer_p2.circom differs from transfer.circom only in the Merkle hasher"

echo "circom: $(circom --version)   flags: ${OPT:-<default>}"
printf "%-14s %10s %10s %10s %8s\n" circuit constraints nonlinear linear wires
count() { # name path
  circom "$2" --r1cs --sym ${3:+--wasm} ${OPT:-} -o "$OUT" -l "$C" -l "$C/node_modules" > "$OUT/$1.compile.log" 2>&1
  local info; info="$(cat "$OUT/$1.compile.log")"
  local nl l w
  nl=$(grep -oP 'non-linear constraints: \K[0-9]+' <<<"$info"); l=$(grep -oP '^linear constraints: \K[0-9]+' <<<"$info")
  w=$(grep -oP 'wires: \K[0-9]+' <<<"$info")
  printf "%-14s %10d %10d %10d %8d\n" "$1" $((nl + l)) "$nl" "$l" "$w"
}
for n in p1_hash2 p2_hash2 p1_hash3 p1_hash4 p1_hash5 p1_merkle20 p2_merkle20; do count "$n" "$C/research/bench/$n.circom"; done
count transfer "$C/transfer.circom" wasm
count transfer_p2 "$OUT/transfer_p2.circom" wasm
count p2_perm3_kat "$C/research/bench/p2_perm3_kat.circom" wasm

# Known-answer test: circom witness for in=[0,1,2] must equal the HorizenLabs vector,
# and a tampered output must violate the R1CS.
node "$ROOT/scripts/bench/poseidon2/kat-circom.mjs" "$OUT"
