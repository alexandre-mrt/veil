/**
 * witness.mjs — shared valid-witness builder for transfer.circom, used by both
 * the Node bench (circuit-baseline.mjs) and the browser bench
 * (browser-proving-bench.mjs, via a generated witness.json).
 *
 * Matches transfer.circom's current (2026-07-14) public signals, including
 * the depth-20 Merkle membership proof — unlike circuits/test/transfer.test.mjs,
 * whose witness builder predates that addition (see docs/research/2026-07-14-baseline.md).
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";

const MERKLE_DEPTH = 20;
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;

function toBI(F, val) {
  return typeof val === "bigint" ? val : F.toObject(val);
}

/** Standard incremental Merkle root over an all-zero-sibling path (genesis leaf at index 0). */
function computeEmptyPathRoot(poseidon, F, leaf, depth) {
  let node = leaf;
  const pathElements = [];
  const pathIndices = [];
  for (let i = 0; i < depth; i++) {
    pathElements.push(0n);
    pathIndices.push(0n); // node is always the left child on this synthetic path
    node = toBI(F, poseidon([node, 0n]));
  }
  return { root: node, pathElements, pathIndices };
}

/** Resolve circomlibjs/snarkjs from circuits/node_modules — this script has no deps of its own. */
export async function loadCircuitsDeps(circuitsDir) {
  const circuitsRequire = createRequire(circuitsDir + "/package.json");
  const circomlibjs = await import(pathToFileURL(circuitsRequire.resolve("circomlibjs")).href);
  const snarkjs = await import(pathToFileURL(circuitsRequire.resolve("snarkjs")).href);
  return { buildPoseidon: circomlibjs.buildPoseidon, groth16: snarkjs.groth16 };
}

export async function buildTransferWitness(buildPoseidon) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const userSecret = 424242n;
  const cumulativeOld = 0n;
  const txAmount = 100n;
  const randomnessOld = 0n;
  const randomnessNew = 12345n;
  const epochId = 1n;
  const threshold = 1_000_000_000n;
  const salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;

  const oldCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(F, poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const { root: merkleRoot, pathElements, pathIndices } = computeEmptyPathRoot(poseidon, F, oldCommitment, MERKLE_DEPTH);

  return {
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
    pathElements: pathElements.map(String),
    pathIndices: pathIndices.map(String),
  };
}
