import { CoreClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { readFileSync } from "fs";
import { vkToSuiBytes } from "./src/proof-converter.js";

const PACKAGE_ID = "0x2cacdf4d2502f3870497bef4952bbb6f9646b4db03e446cfaa2e03d333b1c581";
const POOL_ID = "0x867d3cc126ca82366c6f05e4dffa61bbb18d780b82f1ce35adba95695f2e856f";
const ADMIN_CAP_ID = "0xd154d5f8ff253a807398fb6daf84455cf2f0c5c8212adcd4ff2dfac4d892c106";

const client = new CoreClient({ url: "https://fullnode.testnet.sui.io" });

const keystorePath = `${process.env.HOME}/.sui/sui_config/sui.keystore`;
const keys = JSON.parse(readFileSync(keystorePath, "utf-8"));
const activeAddress = "0x2a3e5ad47e9e5837361280c9d0e2f156c4242d6b841d5378ccc975556bb949ad";

let keypair: Ed25519Keypair | null = null;
for (const b64key of keys) {
  try {
    const raw = Buffer.from(b64key, "base64");
    const kp = Ed25519Keypair.fromSecretKey(raw.subarray(1));
    if (kp.toSuiAddress() === activeAddress) {
      keypair = kp;
      break;
    }
  } catch {}
}
if (!keypair) { console.error("Keypair not found"); process.exit(1); }

const complianceVk = JSON.parse(readFileSync("../frontend/public/circuits/compliance_vk.json", "utf-8"));
const complianceVkBytes = Array.from(vkToSuiBytes(complianceVk));

// Empty Merkle root (32 zero bytes) — initial state with no credentials
const credentialRoot = Array.from(new Uint8Array(32));

// Demo auditor key: 33 bytes (compressed P-256 prefix 0x02 + 32 random bytes)
// In production this would be the regulator's real public key
const auditorKey = [0x02, ...Array.from({ length: 32 }, (_, i) => (i + 1) % 256)];

const REQUIRED_KYC_LEVEL = 1;

const tx = new Transaction();
tx.moveCall({
  target: `${PACKAGE_ID}::compliance::create_compliance_config`,
  arguments: [
    tx.object(ADMIN_CAP_ID),
    tx.object(POOL_ID),
    tx.pure.vector("u8", complianceVkBytes),
    tx.pure.vector("u8", credentialRoot),
    tx.pure.u64(REQUIRED_KYC_LEVEL),
    tx.pure.vector("u8", auditorKey),
  ],
});

// Also enable compliance_required on the pool
tx.moveCall({
  target: `${PACKAGE_ID}::pool::set_compliance_required`,
  arguments: [
    tx.object(ADMIN_CAP_ID),
    tx.object(POOL_ID),
    tx.pure.bool(true),
  ],
});

console.log("Deploying compliance config + enabling compliance on pool...");

const result = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx,
  options: { showObjectChanges: true },
});

console.log("TX digest:", result.digest);
for (const change of result.objectChanges ?? []) {
  if (change.type === "created") {
    const otype = (change as any).objectType ?? "";
    const oid = (change as any).objectId ?? "";
    if (otype.includes("ComplianceConfig")) {
      console.log("COMPLIANCE_CONFIG_ID=" + oid);
      console.log("\nUpdate your .env.testnet and constants.ts with this value.");
    }
  }
}
