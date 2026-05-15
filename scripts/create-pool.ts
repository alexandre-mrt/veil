import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { readFileSync } from "fs";
import { vkToSuiBytes } from "./src/proof-converter.js";

const PACKAGE_ID = "0x2cacdf4d2502f3870497bef4952bbb6f9646b4db03e446cfaa2e03d333b1c581";
const THRESHOLD = 1000_000_000; // 1000 VEIL

const client = new SuiClient({ url: "https://fullnode.testnet.sui.io" });

// Load keypair from sui keystore
const keystorePath = `${process.env.HOME}/.sui/sui_config/sui.keystore`;
const keys = JSON.parse(readFileSync(keystorePath, "utf-8"));
const activeAddress = "0x2a3e5ad47e9e5837361280c9d0e2f156c4242d6b841d5378ccc975556bb949ad";

// Find matching key
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

// Load VK
const vk = JSON.parse(readFileSync("../circuits/build/transfer_vk.json", "utf-8"));
const vkBytes = Array.from(vkToSuiBytes(vk));

// Create pool
const tx = new Transaction();
tx.moveCall({
  target: `${PACKAGE_ID}::pool::create_pool`,
  arguments: [
    tx.pure.vector("u8", vkBytes),
    tx.pure.u64(THRESHOLD),
  ],
});

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
    if (otype.includes("Pool")) console.log("POOL_ID=" + oid);
    if (otype.includes("AdminCap")) console.log("ADMIN_CAP_ID=" + oid);
  }
}
