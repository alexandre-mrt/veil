/**
 * onchain-gas.ts — Real on-chain gas measurement for every Veil entry point.
 *
 * Deploys the package to a *local* Sui network (genesis + validator + faucet, all running
 * on this machine — no testnet RPC involved) and drives the full protocol lifecycle with
 * real Groth16 proofs: publish, create_pool, propose_withdraw_vk, faucet mint,
 * deposit_and_register, update_commitment_root, shielded_transfer, zk_withdraw,
 * freeze_pool, unfreeze_pool. Gas is read directly from each transaction's on-chain
 * `effects.gasUsed` — never estimated.
 *
 * Local-network gas equals testnet/mainnet gas for the same bytecode and inputs: Sui's gas
 * metering is deterministic VM execution + a fixed storage-price schedule, not something a
 * validator or network guesses. It does NOT require the testnet RPC host that a prior run of
 * this loop found blocked from this sandbox (see docs/research/LEDGER.md, 2026-07-22).
 *
 * Two on-chain waits (~65s each) are required and are not simulated or skipped: the pool's
 * own 1-epoch timelocks (VK/root updates, UTXO commitment maturity) are consensus-timestamp
 * gated, and getting a real number means actually waiting for them like any other caller
 * would.
 *
 * Prerequisites (all local, no network egress required at run time):
 *   - A `sui` CLI on PATH, `sui client` configured with an active `localnet` environment
 *     pointing at a running local network + faucet (see docs/research/2026-09-11-*.md for
 *     the exact genesis/start commands used).
 *   - Compiled circuit artifacts: circuits/build/{transfer,withdraw}_*, i.e.
 *     `bash circuits/scripts/compile.sh --skip-ptau` and
 *     `bash circuits/scripts/compile-withdraw.sh --skip-ptau` already run (this script does
 *     not compile circuits itself — see circuits/scripts/*.sh for that, and
 *     scripts/bench/prove-latency.mjs for proving-time benchmarks).
 *
 * Usage: cd scripts && bun run bench/onchain-gas.ts
 * Output: docs/research/*.md tables + raw JSON at /tmp/onchain-gas-results.json
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { buildPoseidon } from "circomlibjs";
import type { PoseidonFunction } from "circomlibjs";

import { bigintToLE32, proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.js";
import type { SnarkjsProof, SnarkjsVK } from "../src/proof-converter.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const CONTRACTS_DIR = join(PROJECT_ROOT, "contracts");
const CIRCUITS_DIR = join(PROJECT_ROOT, "circuits");

const TRANSFER_WASM = join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm");
const TRANSFER_ZKEY = join(CIRCUITS_DIR, "build", "transfer_final.zkey");
const TRANSFER_VK = join(CIRCUITS_DIR, "build", "transfer_vk.json");
const WITHDRAW_WASM = join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm");
const WITHDRAW_ZKEY = join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey");
const WITHDRAW_VK = join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json");

const RPC_URL = process.env.VEIL_LOCALNET_RPC ?? "http://127.0.0.1:9000";
const FAUCET_URL = process.env.VEIL_LOCALNET_FAUCET ?? "http://127.0.0.1:9123";
const CLOCK_OBJECT_ID = "0x6";
const GAS_BUDGET = 500_000_000;
const THRESHOLD = 1_000_000_000n;
const EPOCH_DURATION_MS = 60_000; // minimum allowed by create_pool's own assert
const MERKLE_DEPTH = 20;
const DEPOSIT_AMOUNT = 100_000_000n; // DENOM_SMALL — the only amounts deposit_and_register accepts

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let poseidonF: PoseidonFunction["F"];
function toBI(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return poseidonF.toObject(v) as unknown as bigint;
  return BigInt(v as string);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function step(msg: string): void {
  console.log(`\n${"=".repeat(70)}\n${msg}\n${"=".repeat(70)}`);
}

// snarkjs.groth16.fullProve spawns worker_threads for the multiexp/FFT; Bun's worker_threads
// shim crashes on that path in this environment (see scripts/bench/prove-helper.mjs). Proving
// runs in a plain-Node subprocess instead — every other real-proving path in this repo does
// the same for the same reason.
function proveInNode(
  wasmPath: string,
  zkeyPath: string,
  vkPath: string,
  input: Record<string, unknown>,
): { proof: SnarkjsProof; publicSignals: string[]; verified: boolean } {
  const inPath = `/tmp/veil-bench-prove-input-${Date.now()}.json`;
  const outPath = `/tmp/veil-bench-prove-output-${Date.now()}.json`;
  writeFileSync(inPath, JSON.stringify(input));
  execSync(
    `node ${join(__dirname, "prove-helper.mjs")} ${wasmPath} ${zkeyPath} ${vkPath} ${inPath} ${outPath}`,
    { stdio: "inherit" },
  );
  return JSON.parse(readFileSync(outPath, "utf-8"));
}

interface GasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
  nonRefundableStorageFee: string;
}

interface Measurement {
  entryPoint: string;
  digest: string;
  status: string;
  gasUsed: GasUsed;
  netMist: string;
}

const results: Measurement[] = [];

function netMist(g: GasUsed): bigint {
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
}

function record(entryPoint: string, digest: string, effects: any): void {
  const status = effects?.status?.status ?? "unknown";
  const gasUsed: GasUsed = effects?.gasUsed;
  if (status !== "success") {
    console.error(`  [FAIL] ${entryPoint}: ${JSON.stringify(effects?.status)}`);
    throw new Error(`${entryPoint} failed on-chain: ${JSON.stringify(effects?.status)}`);
  }
  const net = netMist(gasUsed);
  results.push({ entryPoint, digest, status, gasUsed, netMist: net.toString() });
  console.log(
    `  [ok] ${entryPoint}: digest=${digest} computation=${gasUsed.computationCost} ` +
      `storage=${gasUsed.storageCost} rebate=${gasUsed.storageRebate} net=${net} MIST`,
  );
}

// ---------------------------------------------------------------------------
// Merkle helpers (mirrors circuits/test/transfer.test.mjs — single leaf at index 0,
// raw-zero siblings at every level, matching pool.move's zero-initialized commitment_root)
// ---------------------------------------------------------------------------

function merkleRootFromZeroPath(poseidon: PoseidonFunction, leaf: bigint): bigint {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    node = toBI(poseidon([node, 0n]));
  }
  return node;
}

// ---------------------------------------------------------------------------
// Sui keypair / client
// ---------------------------------------------------------------------------

function loadActiveKeypair(): Ed25519Keypair {
  const activeAddress = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const keystorePath = join(
    process.env.HOME ?? "/root",
    ".sui",
    "sui_config",
    "sui.keystore",
  );
  const keystore: string[] = JSON.parse(readFileSync(keystorePath, "utf-8"));
  for (const key of keystore) {
    const raw = fromBase64(key);
    if (raw[0] !== 0) continue;
    try {
      const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
      if (kp.toSuiAddress() === activeAddress) return kp;
    } catch {
      /* not an ed25519 key */
    }
  }
  throw new Error(`No Ed25519 key in keystore matching active address ${activeAddress}`);
}

async function ensureFunded(address: string): Promise<void> {
  const res = await fetch(`${FAUCET_URL}/gas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
  });
  if (!res.ok) throw new Error(`Faucet request failed: ${res.status} ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function publishPackage(): { packageId: string; treasuryCapId: string; digest: string; effects: any } {
  let out: string;
  try {
    out = execSync(`sui client test-publish --gas-budget ${GAS_BUDGET} --json --build-env localnet`, {
      cwd: CONTRACTS_DIR,
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err: any) {
    const combined = (err.stdout ?? "") + (err.stderr ?? "");
    if (!combined.includes('"objectChanges"')) throw err;
    out = combined;
  }
  const json = JSON.parse(out.slice(out.indexOf("{")));
  const changes = json.objectChanges ?? [];
  const published = changes.find((c: any) => c.type === "published");
  const treasuryCap = changes.find(
    (c: any) => c.type === "created" && c.objectType?.includes("::coin::TreasuryCap"),
  );
  if (!published || !treasuryCap) {
    throw new Error(`Publish did not produce expected objects: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return {
    packageId: published.packageId,
    treasuryCapId: treasuryCap.objectId,
    digest: json.digest,
    effects: json.effects,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  for (const p of [TRANSFER_WASM, TRANSFER_ZKEY, TRANSFER_VK, WITHDRAW_WASM, WITHDRAW_ZKEY, WITHDRAW_VK]) {
    if (!existsSync(p)) {
      throw new Error(`Missing circuit artifact: ${p} — compile circuits first (see file header).`);
    }
  }

  step("Setup: keypair, funding, Poseidon");
  const keypair = loadActiveKeypair();
  const address = keypair.toSuiAddress();
  console.log(`  address: ${address}`);
  await ensureFunded(address);
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;

  const userSecret = 424242424242n;

  step("1/10 sui client publish (package + TOKEN TreasuryCap)");
  const { packageId, treasuryCapId, digest: publishDigest, effects: publishEffects } = publishPackage();
  console.log(`  package: ${packageId}`);
  record("publish", publishDigest, publishEffects);

  const transferVkJson: SnarkjsVK = JSON.parse(readFileSync(TRANSFER_VK, "utf-8"));
  const withdrawVkJson: SnarkjsVK = JSON.parse(readFileSync(WITHDRAW_VK, "utf-8"));
  const transferVkBytes = vkToSuiBytes(transferVkJson);
  const withdrawVkBytes = vkToSuiBytes(withdrawVkJson);

  step("2/10 pool::create_pool");
  let poolId: string;
  let adminCapId: string;
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [
        tx.pure.vector("u8", Array.from(transferVkBytes)),
        tx.pure.u64(THRESHOLD),
        tx.pure.u64(EPOCH_DURATION_MS),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showObjectChanges: true, showEffects: true },
    });
    record("create_pool", result.digest, result.effects);
    poolId = result.objectChanges?.find(
      (c: any) => c.type === "created" && c.objectType?.includes("::pool::Pool"),
    )?.objectId as string;
    adminCapId = result.objectChanges?.find(
      (c: any) => c.type === "created" && c.objectType?.includes("::pool::AdminCap"),
    )?.objectId as string;
    console.log(`  pool: ${poolId}  adminCap: ${adminCapId}`);
    await client.waitForTransaction({ digest: result.digest });
  }

  step("3/10 pool::propose_withdraw_vk (admin, 1-epoch timelock)");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::propose_withdraw_vk`,
      arguments: [
        tx.object(poolId),
        tx.object(adminCapId),
        tx.pure.vector("u8", Array.from(withdrawVkBytes)),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    record("propose_withdraw_vk", result.digest, result.effects);
    await client.waitForTransaction({ digest: result.digest });
  }

  step("4/10 token_faucet::faucet (mint TOKEN)");
  let coinId: string;
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [tx.object(treasuryCapId)] });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showObjectChanges: true, showEffects: true },
    });
    record("token_faucet::faucet", result.digest, result.effects);
    coinId = result.objectChanges?.find(
      (c: any) => c.type === "created" && c.objectType?.includes("::token::TOKEN"),
    )?.objectId as string;
    await client.waitForTransaction({ digest: result.digest });
  }

  step("5/10 pool::deposit_and_register (genesis commitment)");
  const genesisCommitment = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, userSecret]));
  const genesisCommitmentBytes = bigintToLE32(genesisCommitment);
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    const [depositCoin] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(DEPOSIT_AMOUNT)]);
    tx.moveCall({
      target: `${packageId}::pool::deposit_and_register`,
      arguments: [
        tx.object(poolId),
        depositCoin,
        tx.pure.vector("u8", Array.from(genesisCommitmentBytes)),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    record("deposit_and_register", result.digest, result.effects);
    await client.waitForTransaction({ digest: result.digest });
  }

  step("6/10 pool::update_commitment_root (admin, 1-epoch timelock)");
  const merkleRoot = merkleRootFromZeroPath(poseidon, genesisCommitment);
  const merkleRootBytesLE = bigintToLE32(merkleRoot);
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [
        tx.object(poolId),
        tx.object(adminCapId),
        tx.pure.vector("u8", Array.from(merkleRootBytesLE)),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    record("update_commitment_root", result.digest, result.effects);
    await client.waitForTransaction({ digest: result.digest });
  }

  step(`Waiting ${EPOCH_DURATION_MS + 5000}ms for the epoch boundary (VK + root timelock, commitment maturity)`);
  await sleep(EPOCH_DURATION_MS + 5000);

  step("7/10 pool::shielded_transfer (real Groth16 transfer proof)");
  const txAmount = 100n;
  const cumulativeNew = txAmount;
  const randomnessNew = 13371337n;
  const epochIdNow = BigInt(Math.floor(Date.now() / EPOCH_DURATION_MS));
  const salt = 55555n;
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochIdNow, 0n]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));

  const transferInput = {
    oldCommitment: genesisCommitment.toString(),
    newCommitment: newCommitment.toString(),
    threshold: THRESHOLD.toString(),
    epochId: epochIdNow.toString(),
    nullifier: nullifier.toString(),
    txAmountHash: txAmountHash.toString(),
    merkleRoot: merkleRoot.toString(),
    cumulativeOld: "0",
    cumulativeNew: cumulativeNew.toString(),
    txAmount: txAmount.toString(),
    randomnessOld: "0",
    randomnessNew: randomnessNew.toString(),
    userSecret: userSecret.toString(),
    salt: salt.toString(),
    pathElements: Array.from({ length: MERKLE_DEPTH }, () => "0"),
    pathIndices: Array.from({ length: MERKLE_DEPTH }, () => "0"),
  };
  console.log("  generating transfer proof (snarkjs.groth16.fullProve, in a node subprocess)...");
  const { proof: transferProof, publicSignals: transferPublicSignals, verified: transferOk } = proveInNode(
    TRANSFER_WASM,
    TRANSFER_ZKEY,
    TRANSFER_VK,
    transferInput,
  );
  if (!transferOk) throw new Error("Local transfer proof verification failed");
  const transferProofBytes = proofToSuiBytes(transferProof as SnarkjsProof);
  const transferPublicInputsBytes = publicInputsToSuiBytes(transferPublicSignals as string[]);
  console.log(`  proof: ${transferProofBytes.length}B  public inputs: ${transferPublicInputsBytes.length}B`);

  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::shielded_transfer`,
      arguments: [
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(transferProofBytes)),
        tx.pure.vector("u8", Array.from(transferPublicInputsBytes)),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    record("shielded_transfer", result.digest, result.effects);
    await client.waitForTransaction({ digest: result.digest });
  }

  step("8/10 pool::freeze_pool / unfreeze_pool (admin)");
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::freeze_pool`,
      arguments: [tx.object(poolId), tx.object(adminCapId), tx.object(CLOCK_OBJECT_ID)],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    record("freeze_pool", result.digest, result.effects);
    await client.waitForTransaction({ digest: result.digest });
  }
  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::unfreeze_pool`,
      arguments: [tx.object(poolId), tx.object(adminCapId)],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    record("unfreeze_pool", result.digest, result.effects);
    await client.waitForTransaction({ digest: result.digest });
  }

  step(`Waiting ${EPOCH_DURATION_MS + 5000}ms for the new commitment to mature`);
  await sleep(EPOCH_DURATION_MS + 5000);

  step("9/10 pool::zk_withdraw (real Groth16 withdraw proof)");
  const withdrawAmount = 40n;
  const cumulativeOldW = cumulativeNew; // the commitment shielded_transfer just created
  const randomnessOldW = randomnessNew;
  const remainingBalance = cumulativeOldW - withdrawAmount;
  const randomnessNewW = 24681357n;
  const recipientAddress = keypair.toSuiAddress();
  // The withdraw circuit takes `recipient` as an opaque field element (see
  // circuits/test/withdraw.test.mjs, which uses an arbitrary constant for the same reason:
  // there is no canonical Sui-address-to-field-element mapping established elsewhere in this
  // repo, and — as this run discovered — zk_withdraw never checks recipientHash against the
  // on-chain `recipient: address` argument at all, so the two are unconstrained relative to
  // each other on-chain regardless of what's inside the proof. See Open questions.
  const recipientField = 0xABCDEF123456n;
  const newCommitmentW = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNewW, userSecret]));
  const nullifierW = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOldW, cumulativeOldW]));
  const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipientField]));

  const withdrawInput = {
    commitment: newCommitment.toString(),
    withdrawAmount: withdrawAmount.toString(),
    nullifier: nullifierW.toString(),
    recipientHash: recipientHash.toString(),
    newCommitment: newCommitmentW.toString(),
    cumulativeOld: cumulativeOldW.toString(),
    randomnessOld: randomnessOldW.toString(),
    userSecret: userSecret.toString(),
    recipient: recipientField.toString(),
    randomnessNew: randomnessNewW.toString(),
  };
  console.log("  generating withdraw proof (snarkjs.groth16.fullProve, in a node subprocess)...");
  const { proof: withdrawProof, publicSignals: withdrawPublicSignals, verified: withdrawOk } = proveInNode(
    WITHDRAW_WASM,
    WITHDRAW_ZKEY,
    WITHDRAW_VK,
    withdrawInput,
  );
  if (!withdrawOk) throw new Error("Local withdraw proof verification failed");
  const withdrawProofBytes = proofToSuiBytes(withdrawProof as SnarkjsProof);
  const withdrawPublicInputsBytes = publicInputsToSuiBytes(withdrawPublicSignals as string[]);

  {
    const tx = new Transaction();
    tx.setGasBudget(GAS_BUDGET);
    tx.moveCall({
      target: `${packageId}::pool::zk_withdraw`,
      arguments: [
        tx.object(poolId),
        tx.pure.vector("u8", Array.from(withdrawProofBytes)),
        tx.pure.vector("u8", Array.from(withdrawPublicInputsBytes)),
        tx.pure.address(recipientAddress),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });
    record("zk_withdraw", result.digest, result.effects);
    await client.waitForTransaction({ digest: result.digest });
  }

  step("10/10 Done — writing results");
  writeFileSync("/tmp/onchain-gas-results.json", JSON.stringify(results, null, 2));
  console.log("\nSummary (net MIST = computation + storage - rebate):\n");
  console.table(
    results.map((r) => ({
      entryPoint: r.entryPoint,
      computation: r.gasUsed.computationCost,
      storage: r.gasUsed.storageCost,
      rebate: r.gasUsed.storageRebate,
      net_MIST: r.netMist,
      net_SUI: (Number(r.netMist) / 1e9).toFixed(6),
    })),
  );
  console.log(`\nRaw JSON: /tmp/onchain-gas-results.json`);
  console.log(`packageId=${packageId} poolId=${poolId} adminCapId=${adminCapId}`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.stack ?? err.message : err);
  if (results.length > 0) {
    writeFileSync("/tmp/onchain-gas-results.json", JSON.stringify(results, null, 2));
    console.error(`Partial results (${results.length} entry points) written to /tmp/onchain-gas-results.json`);
  }
  process.exit(1);
});
