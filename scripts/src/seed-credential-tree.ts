/**
 * seed-credential-tree.ts
 *
 * Builds a depth-20 Poseidon Merkle tree with a single demo credential at index 0.
 * Outputs the full credential JSON (leaf, kycLevel, expiry, issuerId, merkleProof, merkleIndex)
 * and saves it to frontend/src/lib/demoCredential.json.
 *
 * Usage: cd scripts && bun run src/seed-credential-tree.ts
 */

import { writeFileSync } from "fs";
import { resolve } from "path";
import {
  buildPoseidon,
  computeCredentialLeaf,
  buildMerkleTree,
  getMerkleProof,
} from "./compliance-utils.js";

// ---------------------------------------------------------------------------
// Demo credential parameters (matches on-chain root)
// ---------------------------------------------------------------------------

const USER_SECRET = 12345n;
const KYC_LEVEL = 1n;
const EXPIRY_EPOCH = 99999999n;
const ISSUER_ID = 42n;
const MERKLE_INDEX = 0;
const TREE_DEPTH = 20;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Building Poseidon instance...");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  console.log("Computing credential leaf...");
  const leaf = computeCredentialLeaf(
    poseidon,
    F,
    USER_SECRET,
    KYC_LEVEL,
    EXPIRY_EPOCH,
    ISSUER_ID,
  );
  console.log(`  leaf = 0x${leaf.toString(16).padStart(64, "0")}`);

  console.log(`Building depth-${TREE_DEPTH} Merkle tree (this may take ~60s)...`);
  const tree = buildMerkleTree(poseidon, F, [leaf], TREE_DEPTH);
  console.log(`  root = 0x${tree.root.toString(16).padStart(64, "0")}`);

  // Verify root matches expected on-chain root bytes
  const expectedRootBytes = [41, 39, 217, 219, 245, 200, 86, 125, 100, 175, 142, 147, 1, 90, 53, 166, 188, 187, 170, 14, 71, 174, 61, 190, 243, 248, 140, 28, 42, 229, 178, 38];
  const rootLE = bigintToLE32(tree.root);
  const rootMatch = expectedRootBytes.every((b, i) => b === rootLE[i]);
  if (rootMatch) {
    console.log("  ROOT MATCHES on-chain credential root!");
  } else {
    console.log("  WARNING: root does NOT match expected on-chain bytes.");
    console.log(`  Expected: [${expectedRootBytes.join(",")}]`);
    console.log(`  Got:      [${Array.from(rootLE).join(",")}]`);
  }

  console.log("Extracting Merkle proof for index 0...");
  const proof = getMerkleProof(tree.layers, MERKLE_INDEX, TREE_DEPTH);

  // Format output as hex strings
  const credential = {
    leaf: `0x${leaf.toString(16).padStart(64, "0")}`,
    kycLevel: Number(KYC_LEVEL),
    expiry: Number(EXPIRY_EPOCH),
    issuerId: Number(ISSUER_ID),
    merkleProof: proof.pathElements.map(
      (el) => `0x${el.toString(16).padStart(64, "0")}`,
    ),
    merkleIndex: MERKLE_INDEX,
    merkleRoot: `0x${tree.root.toString(16).padStart(64, "0")}`,
  };

  const outputPath = resolve(
    import.meta.dir ?? ".",
    "../../frontend/src/lib/demoCredential.json",
  );

  writeFileSync(outputPath, JSON.stringify(credential, null, 2) + "\n");
  console.log(`\nCredential saved to: ${outputPath}`);
  console.log("\nDone.");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bigintToLE32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
