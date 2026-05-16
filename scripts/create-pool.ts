import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { readFileSync } from "fs";
import { vkToSuiBytes } from "./src/proof-converter.js";

const PACKAGE_ID = "0x5cd79f85f1adca022513d76c60d557f8b17afed91f741d14016c7a23cab6c228";
const THRESHOLD = 1000_000_000; // 1000 VEIL (6 decimals)
const EPOCH_DURATION_MS = 3_600_000; // 1 hour for testnet

const client = new SuiGrpcClient({ url: "https://sui-testnet.mystenlabs.com:443" });

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

// Create pool with new signature: (transfer_vk, threshold, epoch_duration_ms)
const tx = new Transaction();
tx.moveCall({
  target: `${PACKAGE_ID}::pool::create_pool`,
  arguments: [
    tx.pure.vector("u8", vkBytes),
    tx.pure.u64(THRESHOLD),
    tx.pure.u64(EPOCH_DURATION_MS),
  ],
});

const result = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx,
  include: { objectChanges: true },
});

console.log("TX digest:", result.Transaction?.digest ?? result.FailedTransaction?.digest);
const objectChanges = result.Transaction?.objectChanges ?? [];
for (const change of objectChanges) {
  if (change.$kind === "Created") {
    const otype = change.Created.objectType ?? "";
    const oid = change.Created.objectId ?? "";
    if (otype.includes("Pool")) console.log("POOL_ID=" + oid);
    if (otype.includes("AdminCap")) console.log("ADMIN_CAP_ID=" + oid);
  }
}
