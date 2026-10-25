#!/usr/bin/env bash
# Attribute R1CS constraints to Poseidon instances vs Merkle path vs range checks.
# Usage: scripts/bench/constraint-breakdown.sh   (needs `npm i` in circuits/ and `npm i circom2` somewhere;
# set CIRCOM2=/path/to/circom2, default: circom2 on PATH)
set -euo pipefail
CIRCOM2=${CIRCOM2:-circom2}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
cp -r "$ROOT/circuits/templates" "$ROOT/circuits/"*.circom "$W/"
mkdir -p "$W/node_modules" && cp -r "$ROOT/circuits/node_modules/circomlib" "$W/node_modules/"
cd "$W"
count() { "$CIRCOM2" "$1" --r1cs -o . 2>&1 | grep -E "^(non-linear|linear) constraints" | tr '\n' ' '; echo; }
echo "--- Poseidon(n) standalone (circomlib), non-linear / linear"
for n in 2 3 4 5; do
  cat > p$n.circom <<EOT
pragma circom 2.0.0; include "node_modules/circomlib/circuits/poseidon.circom";
template T(){signal input i[$n];signal output o;component h=Poseidon($n);for(var k=0;k<$n;k++){h.inputs[k]<==i[k];}o<==h.out;} component main=T();
EOT
  printf "Poseidon(%s): " $n; count p$n.circom
done
echo "--- MerkleProof(d) standalone"
for d in 1 10 20; do
  cat > m$d.circom <<EOT
pragma circom 2.1.0; include "templates/merkle_proof.circom"; component main=MerkleProof($d);
EOT
  printf "MerkleProof(%s): " $d; count m$d.circom
done
echo "--- Range/comparator block of transfer.circom (4x Num2Bits(64) + GreaterThan(64) + LessEqThan(64))"
cat > r.circom <<'EOT'
pragma circom 2.1.0;
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
template R(){ signal input a; signal input b; signal input c; signal input d; signal input e;
 component gt=GreaterThan(64); gt.in[0]<==a; gt.in[1]<==0; gt.out===1;
 component n1=Num2Bits(64); n1.in<==b; component n2=Num2Bits(64); n2.in<==a; component n3=Num2Bits(64); n3.in<==c; component n4=Num2Bits(64); n4.in<==d;
 component le=LessEqThan(64); le.in[0]<==c; le.in[1]<==d; le.out===1; }
component main=R();
EOT
count r.circom
echo "--- full circuits"
for c in transfer compliance withdraw; do printf "%s: " $c; count $c.circom; done
