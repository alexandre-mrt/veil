import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { readFileSync } from "fs";
import { vkToSuiBytes } from "./src/proof-converter.js";

const PACKAGE_ID = "0x5cd79f85f1adca022513d76c60d557f8b17afed91f741d14016c7a23cab6c228";
const POOL_ID = "0x6ba8019987c7c5d02d2c2b11e0eddd491428d0cc6bbed05ab79760e069ce913a";
const ADMIN_CAP_ID = "0x038754ce782a7670884961335a7d7e50215a4793d2c44dde208c2527eeed28d4";

const client = new SuiGrpcClient({ url: "https://sui-testnet.mystenlabs.com:443" });

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

// Empty Merkle root (32 zero bytes) -- initial state with no credentials
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

// Note: compliance_required toggle uses propose_compliance_toggle (1-epoch timelock)
// instead of the old set_compliance_required. For fresh deploys, compliance starts
// disabled. Use propose_compliance_toggle separately after the ComplianceConfig is created.

console.log("Deploying compliance config...");

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
    if (otype.includes("ComplianceConfig")) {
      console.log("COMPLIANCE_CONFIG_ID=" + oid);
      console.log("\nUpdate your .env.testnet and constants.ts with this value.");
    }
  }
}
