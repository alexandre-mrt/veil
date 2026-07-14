// Generates ground-truth values + snarkjs input.json for the canonical spike witness,
// using the SAME circomlibjs used by Veil's circuit tests.
import { buildPoseidon } from "../../../circuits/node_modules/circomlibjs/main.js";
import { writeFileSync } from "node:fs";

const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (inputs) => F.toObject(poseidon(inputs));

// Canonical witness (mirrored in the Rust tests)
const userSecret = 123456789n;
const randomnessOld = 111111n;
const randomnessNew = 222222n;
const cumulativeOld = 100n;
const txAmount = 400n;
const cumulativeNew = cumulativeOld + txAmount;
const threshold = 1000n;
const epochId = 42n;
const salt = 987654321n;

const oldCommitment = H([1n, cumulativeOld, randomnessOld, userSecret]);
const newCommitment = H([1n, cumulativeNew, randomnessNew, userSecret]);
const nullifier = H([2n, userSecret, epochId, randomnessOld]);
const txAmountHash = H([3n, txAmount, salt]);

// Depth-20 tree, single leaf (oldCommitment) at index 0, empty leaves = 0
const DEPTH = 20;
const zeros = [0n];
for (let i = 0; i < DEPTH; i++) zeros.push(H([zeros[i], zeros[i]]));
let node = oldCommitment;
const pathElements = [];
const pathIndices = [];
for (let i = 0; i < DEPTH; i++) {
  pathElements.push(zeros[i].toString());
  pathIndices.push(0);
  node = H([node, zeros[i]]);
}
const merkleRoot = node;

const input = {
  oldCommitment: oldCommitment.toString(),
  newCommitment: newCommitment.toString(),
  threshold: threshold.toString(),
  epochId: epochId.toString(),
  nullifier: nullifier.toString(),
  txAmountHash: txAmountHash.toString(),
  merkleRoot: merkleRoot.toString(),
  cumulativeOld: cumulativeOld.toString(),
  cumulativeNew: cumulativeNew.toString(),
  txAmount: txAmount.toString(),
  randomnessOld: randomnessOld.toString(),
  randomnessNew: randomnessNew.toString(),
  userSecret: userSecret.toString(),
  salt: salt.toString(),
  pathElements,
  pathIndices,
};
writeFileSync(new URL("./input.json", import.meta.url), JSON.stringify(input, null, 2));

console.log("== circomlib ground truth ==");
console.log("H(1,2,3,4)      =", H([1n, 2n, 3n, 4n]).toString());
console.log("H2(1,2)         =", H([1n, 2n]).toString());
console.log("H3(1,2,3)       =", H([1n, 2n, 3n]).toString());
console.log("oldCommitment   =", oldCommitment.toString());
console.log("newCommitment   =", newCommitment.toString());
console.log("nullifier       =", nullifier.toString());
console.log("txAmountHash    =", txAmountHash.toString());
console.log("merkleRoot      =", merkleRoot.toString());
