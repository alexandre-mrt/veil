/**
 * onchain-gas.ts — Real on-chain gas cost per Veil entry point.
 *
 * Measured against a LOCAL Sui network, not the live testnet deployment. Two prior nights
 * (see docs/research/LEDGER.md, 2026-07-22) tried to reach `fullnode.testnet.sui.io` for this
 * number and were blocked by the sandbox's network policy both times. This run confirmed the
 * same host is still policy-denied (403 at the CONNECT layer — see the report), so instead of a
 * third attempt at the same blocked path, this script deploys the real, unmodified `contracts/`
 * package to a real local Sui validator (`sui start`) and calls each entry point with a real
 * Groth16 proof. Gas pricing (reference gas price, storage price, rebate rate) is protocol
 * config, identical between localnet and testnet in this Sui version — the numbers below are not
 * synthetic estimates, they are `effects.gasUsed` from real transaction execution.
 *
 * Usage:
 *   sui start --with-faucet --force-regenesis &          # background local validator
 *   sleep 5 && sui client switch --env localnet
 *   bun run scripts/bench/onchain-gas.ts
 *
 * Requires:
 *   - `sui` CLI on PATH (this project: built from source, see the report for the exact command)
 *   - circuits/build{,-withdraw,-compliance}/ compiled (bash circuits/scripts/compile*.sh)
 *   - an active `sui client` env pointed at the local network, with a keystore address
 *
 * Prints one JSON line per entry point call: { entryPoint, digest, gasUsed, status }.
 * `gasUsed` is Sui's four-field breakdown: computationCost, storageCost, storageRebate,
 * nonRefundableStorageFee (all in MIST, 1 SUI = 1e9 MIST).
 */
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error snarkjs has no TypeScript declarations
import * as snarkjs from "snarkjs";

import { deployContract } from "../src/deploy.js";
import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "../src/proof-converter.js";
import {
  computeCredentialLeaf,
  buildMerkleTree,
  getMerkleProof,
} from "../src/compliance-utils.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");

const RPC_URL = process.env.SUI_RPC_URL ?? "http://127.0.0.1:9000";
const FAUCET_URL = process.env.SUI_FAUCET_URL ?? "http://127.0.0.1:9123/gas";
const SUI_CLOCK_OBJECT_ID = "0x6";
const GAS_BUDGET = 200_000_000;
const EPOCH_DURATION_MS = 60_000; // minimum allowed by pool::create_pool
const MIN_SUI_BALANCE_MIST = 5_000_000_000; // 5 SUI
const FAUCET_MINT_AMOUNT = 1_000_000_000; // token_faucet::faucet mint amount == DENOM_LARGE
const TRANSFER_THRESHOLD = 1_000_000_000n;
const MERKLE_DEPTH = 20;

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;

const results: Array<{ entryPoint: string; digest: string; gasUsed: unknown; status: string }> = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[bench] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bigintTo32Bytes(n: bigint): Uint8Array {
  // Same encoding publicInputsToSuiBytes uses per-field: 32-byte little-endian.
  const bytes = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function loadKeypair(): Ed25519Keypair {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  if (!existsSync(keystorePath)) {
    throw new Error(`Sui keystore not found at ${keystorePath}. Run 'sui client' first.`);
  }
  const keystore: string[] = JSON.parse(readFileSync(keystorePath, "utf-8"));
  for (const key of keystore) {
    const raw = fromBase64(key);
    if (raw[0] !== 0) continue;
    try {
      const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
      if (kp.toSuiAddress() === activeAddress) return kp;
    } catch {
      // not an ed25519 key, skip
    }
  }
  throw new Error(`No Ed25519 key found matching active address ${activeAddress}`);
}

async function ensureBalance(client: SuiJsonRpcClient, address: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const balance = await client.getBalance({ owner: address });
    const totalMist = BigInt(balance.totalBalance);
    log(`balance: ${totalMist} MIST`);
    if (totalMist >= BigInt(MIN_SUI_BALANCE_MIST)) return;
    log("requesting local faucet...");
    const resp = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
    });
    if (!resp.ok) {
      throw new Error(`local faucet request failed: ${resp.status} ${await resp.text()}`);
    }
    await sleep(2000);
  }
  throw new Error("Could not fund address from local faucet after 5 attempts");
}

async function currentEpoch(client: SuiJsonRpcClient): Promise<bigint> {
  const clockObj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
  const content = clockObj.data?.content as { fields?: { timestamp_ms?: string } } | undefined;
  const timestampMs = BigInt(content?.fields?.timestamp_ms ?? Date.now());
  return timestampMs / BigInt(EPOCH_DURATION_MS);
}

async function waitForNextEpoch(client: SuiJsonRpcClient, fromEpoch: bigint): Promise<void> {
  log(`waiting for on-chain epoch to advance past ${fromEpoch} (epoch_duration_ms=${EPOCH_DURATION_MS})...`);
  while (true) {
    const epoch = await currentEpoch(client);
    if (epoch > fromEpoch) {
      log(`epoch advanced to ${epoch}`);
      return;
    }
    await sleep(5000);
  }
}

async function call(
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  entryPoint: string,
  build: (tx: Transaction) => void,
  opts: { allowFailure?: boolean } = {},
): Promise<{ status: string; digest: string; result: Awaited<ReturnType<SuiJsonRpcClient["signAndExecuteTransaction"]>> }> {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  const status = result.effects?.status?.status ?? "unknown";
  const digest = result.digest ?? "unknown";
  const gasUsed = result.effects?.gasUsed;
  console.log(JSON.stringify({ entryPoint, digest, status, gasUsed }));
  results.push({ entryPoint, digest, gasUsed, status });
  if (status !== "success" && !opts.allowFailure) {
    throw new Error(`${entryPoint} failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await client.waitForTransaction({ digest });
  return { status, digest, result };
}

// ---------------------------------------------------------------------------
// Witness / proof builders (epochId bound at call time — see report for why
// scripts/bench/witnesses.mjs's fixed epochId=1n can't be reused directly here)
// ---------------------------------------------------------------------------

async function buildTransferProof(poseidon: any, F: any, epochId: bigint) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const hash = (...xs: bigint[]) => F.toObject(poseidon(xs));
  const oldCommitment = hash(DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret);
  const newCommitment = hash(DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret);
  const nullifier = hash(DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld);
  const txAmountHash = hash(DOMAIN_TX_AMOUNT, txAmount, salt);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  let node = oldCommitment;
  for (let i = 0; i < MERKLE_DEPTH; i++) node = hash(node, 0n);
  const merkleRoot = node;

  const input = {
    oldCommitment: oldCommitment.toString(), newCommitment: newCommitment.toString(),
    threshold: TRANSFER_THRESHOLD.toString(), epochId: epochId.toString(),
    nullifier: nullifier.toString(), txAmountHash: txAmountHash.toString(),
    merkleRoot: merkleRoot.toString(),
    cumulativeOld: cumulativeOld.toString(), cumulativeNew: cumulativeNew.toString(),
    txAmount: txAmount.toString(), randomnessOld: randomnessOld.toString(),
    randomnessNew: randomnessNew.toString(), userSecret: userSecret.toString(),
    salt: salt.toString(),
    pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm"),
    join(CIRCUITS_DIR, "build", "transfer_final.zkey"),
  );
  return {
    proofBytes: proofToSuiBytes(proof),
    publicInputsBytes: publicInputsToSuiBytes(publicSignals),
    oldCommitmentBytes: bigintTo32Bytes(oldCommitment),
    merkleRootBytes: bigintTo32Bytes(merkleRoot),
  };
}

async function buildWithdrawProof(poseidon: any, F: any) {
  const cumulativeOld = 500_000_000n, randomnessOld = 12345n, userSecret = 555555555n;
  const withdrawAmount = 100_000_000n, recipientField = 0xABCDEF123456n, randomnessNew = 77777n;
  const hash = (...xs: bigint[]) => F.toObject(poseidon(xs));
  const commitment = hash(DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret);
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = hash(DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret);
  const nullifier = hash(DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld);
  const recipientHash = hash(DOMAIN_RECIPIENT_HASH, recipientField);

  const input = {
    commitment: commitment.toString(), withdrawAmount: withdrawAmount.toString(),
    nullifier: nullifier.toString(), recipientHash: recipientHash.toString(),
    newCommitment: newCommitment.toString(),
    cumulativeOld: cumulativeOld.toString(), randomnessOld: randomnessOld.toString(),
    userSecret: userSecret.toString(), recipient: recipientField.toString(),
    randomnessNew: randomnessNew.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm"),
    join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey"),
  );
  return {
    proofBytes: proofToSuiBytes(proof),
    publicInputsBytes: publicInputsToSuiBytes(publicSignals),
    commitmentBytes: bigintTo32Bytes(commitment),
  };
}

async function main(): Promise<void> {
  log(`RPC: ${RPC_URL}`);
  const keypair = loadKeypair();
  const address = keypair.toSuiAddress();
  log(`address: ${address}`);
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
  await ensureBalance(client, address);

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash = (...xs: bigint[]) => F.toObject(poseidon(xs));

  // ---- Deploy package ----------------------------------------------------
  log("publishing package...");
  const deployed = deployContract(PROJECT_ROOT, GAS_BUDGET);
  const { packageId, treasuryCapId } = deployed;
  if (!treasuryCapId) throw new Error("no TreasuryCap after publish");
  log(`package: ${packageId}`);

  const transferVkBytes = vkToSuiBytes(
    JSON.parse(readFileSync(join(CIRCUITS_DIR, "build", "transfer_vk.json"), "utf-8")),
  );
  const withdrawVkBytes = vkToSuiBytes(
    JSON.parse(readFileSync(join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json"), "utf-8")),
  );
  const complianceVkBytes = vkToSuiBytes(
    JSON.parse(readFileSync(join(CIRCUITS_DIR, "build-compliance", "compliance_vk.json"), "utf-8")),
  );

  // ---- create_pool ---------------------------------------------------------
  let poolId = "";
  {
    const { result } = await call(client, keypair, "pool::create_pool", (tx) => {
      tx.moveCall({
        target: `${packageId}::pool::create_pool`,
        arguments: [
          tx.pure.vector("u8", Array.from(transferVkBytes)),
          tx.pure.u64(TRANSFER_THRESHOLD),
          tx.pure.u64(BigInt(EPOCH_DURATION_MS)),
        ],
      });
    });
    const poolChange = result.objectChanges?.find(
      (c: any) => c.type === "created" && c.objectType?.includes("::pool::Pool"),
    ) as any;
    poolId = poolChange.objectId;
    log(`pool: ${poolId}`);
  }

  // Find AdminCap from the create_pool tx (owned object, not in deploy's objectChanges)
  const ownedObjects = await client.getOwnedObjects({
    owner: address,
    filter: { StructType: `${packageId}::pool::AdminCap` },
    options: { showContent: true },
  });
  const adminCapId = (ownedObjects.data[0]?.data as any)?.objectId;
  if (!adminCapId) throw new Error("AdminCap not found");
  log(`AdminCap: ${adminCapId}`);

  // ---- create_compliance_config -------------------------------------------
  const credentialUserSecret = 424242n;
  const credentialLeaf = computeCredentialLeaf(poseidon, F, credentialUserSecret, 2n, 999_999_999n, 42n);
  const credTree = buildMerkleTree(poseidon, F, [credentialLeaf], MERKLE_DEPTH);
  const credProof = getMerkleProof(credTree.layers, 0, MERKLE_DEPTH);
  const credentialRootBytes = bigintTo32Bytes(credTree.root);

  const auditorKeyPair = await crypto.webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const auditorPubRaw = new Uint8Array(
    await crypto.webcrypto.subtle.exportKey("raw", (auditorKeyPair as CryptoKeyPair).publicKey),
  );

  let complianceConfigId = "";
  {
    const { result } = await call(client, keypair, "compliance::create_compliance_config", (tx) => {
      tx.moveCall({
        target: `${packageId}::compliance::create_compliance_config`,
        arguments: [
          tx.object(adminCapId),
          tx.object(poolId),
          tx.pure.vector("u8", Array.from(complianceVkBytes)),
          tx.pure.vector("u8", Array.from(credentialRootBytes)),
          tx.pure.u64(1n),
          tx.pure.vector("u8", Array.from(auditorPubRaw)),
        ],
      });
    });
    const configChange = result.objectChanges?.find(
      (c: any) => c.type === "created" && c.objectType?.includes("::compliance::ComplianceConfig"),
    ) as any;
    complianceConfigId = configChange.objectId;
    log(`ComplianceConfig: ${complianceConfigId}`);
  }

  // ---- propose_withdraw_vk (timelocked admin op) --------------------------
  await call(client, keypair, "pool::propose_withdraw_vk", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdraw_vk`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(withdrawVkBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  // ---- cheap admin ops that need no timelock wait -------------------------
  await call(client, keypair, "pool::freeze_pool", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::freeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId), tx.object(SUI_CLOCK_OBJECT_ID)] });
  });
  await call(client, keypair, "pool::unfreeze_pool", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::unfreeze_pool`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  });
  await call(client, keypair, "pool::propose_vk_update", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_vk_update`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(transferVkBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  await call(client, keypair, "pool::cancel_vk_update", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::cancel_vk_update`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  });
  await call(client, keypair, "pool::propose_withdrawal", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdrawal`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.u64(1000n), tx.pure.address(address), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  await call(client, keypair, "pool::cancel_withdrawal", (tx) => {
    tx.moveCall({ target: `${packageId}::pool::cancel_withdrawal`, arguments: [tx.object(poolId), tx.object(adminCapId)] });
  });

  // ---- mint tokens (need 3: transfer leg, withdraw leg, compliance leg) --
  async function mintCoin(): Promise<string> {
    const { result } = await call(client, keypair, "token_faucet::faucet", (tx) => {
      tx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [tx.object(treasuryCapId)] });
    });
    const coinChange = result.objectChanges?.find(
      (c: any) => c.type === "created" && c.objectType?.includes("::token::TOKEN"),
    ) as any;
    return coinChange.objectId;
  }
  const coinForTransfer = await mintCoin();
  const coinForWithdraw = await mintCoin();
  const coinForCompliance = await mintCoin();

  // ---- build transfer + withdraw proofs against the epoch we'll deposit in
  const depositEpoch = await currentEpoch(client);
  const transferProof = await buildTransferProof(poseidon, F, depositEpoch);
  const withdrawProof = await buildWithdrawProof(poseidon, F);

  // ---- deposit_and_register x2 (transfer leg + withdraw leg) -------------
  await call(client, keypair, "pool::deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(poolId), tx.object(coinForTransfer), tx.pure.vector("u8", Array.from(transferProof.oldCommitmentBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  await call(client, keypair, "pool::deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(poolId), tx.object(coinForWithdraw), tx.pure.vector("u8", Array.from(withdrawProof.commitmentBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  // ---- update_commitment_root to match the transfer leg's Merkle root ----
  await call(client, keypair, "pool::update_commitment_root", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(transferProof.merkleRootBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  await waitForNextEpoch(client, depositEpoch);

  // ---- shielded_transfer (applies pending root + matures commitment) -----
  {
    const nowEpoch = await currentEpoch(client);
    // Rebuild with the (possibly ticked) current epoch to stay inside the ±1 grace window.
    const freshTransferProof = await buildTransferProof(poseidon, F, nowEpoch);
    await call(client, keypair, "pool::shielded_transfer", (tx) => {
      tx.moveCall({
        target: `${packageId}::pool::shielded_transfer`,
        arguments: [
          tx.object(poolId),
          tx.pure.vector("u8", Array.from(freshTransferProof.proofBytes)),
          tx.pure.vector("u8", Array.from(freshTransferProof.publicInputsBytes)),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
    });
  }

  // ---- zk_withdraw (applies pending withdraw_vk + matures commitment) ----
  await call(client, keypair, "pool::zk_withdraw", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::zk_withdraw`,
      arguments: [
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(withdrawProof.proofBytes)),
        tx.pure.vector("u8", Array.from(withdrawProof.publicInputsBytes)),
        tx.pure.address(address),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  }, { allowFailure: true }); // recorded either way — see report if this failed

  // ---- compliant_transfer: needs its own commitment + Merkle root cycle --
  const complianceDepositEpoch = await currentEpoch(client);
  const complianceLegProof = await buildTransferProof(poseidon, F, complianceDepositEpoch);

  await call(client, keypair, "pool::deposit_and_register", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [tx.object(poolId), tx.object(coinForCompliance), tx.pure.vector("u8", Array.from(complianceLegProof.oldCommitmentBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });
  await call(client, keypair, "pool::update_commitment_root", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.pure.vector("u8", Array.from(complianceLegProof.merkleRootBytes)), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  });

  await waitForNextEpoch(client, complianceDepositEpoch);

  {
    const nowEpoch = await currentEpoch(client);
    const freshLegProof = await buildTransferProof(poseidon, F, nowEpoch);

    // Compliance proof, bound to the transfer leg's nullifier via contextId.
    const transferNullifierField = hash(DOMAIN_NULLIFIER, 987654321n, nowEpoch, 0n);
    const contextId = hash(DOMAIN_CONTEXT_BINDING, transferNullifierField, credentialUserSecret);
    const credNullifier = hash(DOMAIN_COMPLIANCE_NULLIFIER, credentialUserSecret, contextId);

    const complianceInput = {
      merkleRoot: credTree.root.toString(), currentEpoch: nowEpoch.toString(),
      contextId: contextId.toString(), requiredKycLevel: "1",
      nullifier: credNullifier.toString(), validCredential: "1",
      userSecret: credentialUserSecret.toString(), kycLevel: "2",
      expiryEpoch: "999999999", issuerId: "42",
      pathElements: credProof.pathElements.map(String), pathIndices: credProof.pathIndices.map(String),
      transferNullifier: transferNullifierField.toString(),
    };
    const { proof: cProof, publicSignals: cSignals } = await snarkjs.groth16.fullProve(
      complianceInput,
      join(CIRCUITS_DIR, "build-compliance", "compliance_js", "compliance.wasm"),
      join(CIRCUITS_DIR, "build-compliance", "compliance_final.zkey"),
    );
    const complianceProofBytes = proofToSuiBytes(cProof);
    const complianceInputsBytes = publicInputsToSuiBytes(cSignals);

    // Auditor-encrypted amount (ECDH P-256 + AES-256-GCM, HKDF-derived key — same construction
    // as auditor-tool.ts / e2e-compliance-test.ts).
    const ephemeral = await crypto.webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const ephemeralPubRaw = new Uint8Array(await crypto.webcrypto.subtle.exportKey("raw", (ephemeral as CryptoKeyPair).publicKey));
    const sharedBits = await crypto.webcrypto.subtle.deriveBits(
      { name: "ECDH", public: (auditorKeyPair as CryptoKeyPair).publicKey }, (ephemeral as CryptoKeyPair).privateKey, 256,
    );
    const sharedKeyMaterial = await crypto.webcrypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
    const aesKey = await crypto.webcrypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: ephemeralPubRaw, info: new TextEncoder().encode("veil-auditor-v1") },
      sharedKeyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new Uint8Array(128);
    plaintext.set(new TextEncoder().encode(JSON.stringify({ txAmount: "100", salt: "99" })));
    const ciphertext = new Uint8Array(await crypto.webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));
    const encryptedAmount = new Uint8Array(ephemeralPubRaw.length + iv.length + ciphertext.length);
    encryptedAmount.set(ephemeralPubRaw, 0);
    encryptedAmount.set(iv, ephemeralPubRaw.length);
    encryptedAmount.set(ciphertext, ephemeralPubRaw.length + iv.length);

    await call(client, keypair, "compliance::compliant_transfer", (tx) => {
      tx.moveCall({
        target: `${packageId}::compliance::compliant_transfer`,
        arguments: [
          tx.object(poolId), tx.object(complianceConfigId),
          tx.pure.vector("u8", Array.from(freshLegProof.proofBytes)),
          tx.pure.vector("u8", Array.from(freshLegProof.publicInputsBytes)),
          tx.pure.vector("u8", Array.from(complianceProofBytes)),
          tx.pure.vector("u8", Array.from(complianceInputsBytes)),
          tx.pure.vector("u8", Array.from(encryptedAmount)),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
    }, { allowFailure: true }); // recorded either way — see report if this failed
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  console.log("\n=== PARTIAL RESULTS BEFORE FAILURE ===");
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
});
