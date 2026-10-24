/**
 * gas-localnet.ts — measure real on-chain gas for each Veil entry point on a Sui localnet.
 *
 * Every figure printed here comes straight from `effects.gasUsed` of a transaction that was
 * actually executed against a real validator (`sui start --force-regenesis`), with real Groth16
 * proofs for the three verifying entry points. Nothing is estimated.
 *
 * Prerequisites (see docs/research/2026-10-24-onchain-gas-baseline.md for the exact commands):
 *   - `sui` CLI >= 1.68 on PATH, localnet running (`sui start --force-regenesis --with-faucet`),
 *     `sui client` switched to the `local` env and funded (`sui client faucet`)
 *   - circuits compiled: circuits/build, circuits/build-withdraw, circuits/build-compliance
 *     (bash circuits/scripts/compile.sh && compile-withdraw.sh && compile-compliance.sh)
 *
 * Usage (run from scripts/; bun hangs silently inside snarkjs proving, use node >= 22.6):
 *   node --experimental-strip-types --no-warnings bench/gas-localnet.ts [--json out.json]
 *
 * Timing: Pool epochs are >= 60 s (create_pool enforces it), and the commitment root / withdraw
 * VK are timelocked by one epoch, so the script stages all setup in epoch E and waits for E+1
 * before proving and executing — expect a run of roughly 1.5-2 minutes.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";

import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");
const RPC_URL = process.env.SUI_RPC_URL ?? "http://127.0.0.1:9000";
const CLOCK = "0x6";
const EPOCH_MS = 60_000; // create_pool minimum
const THRESHOLD = 1_000_000_000n;
const DEPOSIT = 100_000_000; // DENOM_SMALL
const DEPTH = 20;

const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RCPT: 8n };

// ── helpers ────────────────────────────────────────────────────────────────

const rows: Array<Record<string, string | number>> = [];

function loadKeypair(): Ed25519Keypair {
  const addr = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const ks: string[] = JSON.parse(readFileSync(join(homedir(), ".sui/sui_config/sui.keystore"), "utf-8"));
  for (const k of ks) {
    const raw = fromBase64(k);
    if (raw[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (kp.toSuiAddress() === addr) return kp;
  }
  throw new Error("active key not found in keystore");
}

function record(label: string, g: any, digest: string, note = "") {
  const comp = Number(g.computationCost), stor = Number(g.storageCost), reb = Number(g.storageRebate);
  rows.push({ entry: label, computation: comp, storage: stor, rebate: reb, net: comp + stor - reb, digest });
  console.log(`[gas] ${label.padEnd(36)} computation=${comp} storage=${stor} rebate=${reb} net=${comp + stor - reb} MIST ${note}`);
}

async function run(
  client: SuiJsonRpcClient,
  kp: Ed25519Keypair,
  label: string,
  build: (tx: Transaction) => void,
) {
  const tx = new Transaction();
  tx.setGasBudget(500_000_000);
  build(tx);
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status?.status !== "success") {
    throw new Error(`${label}: ${JSON.stringify(res.effects?.status)}`);
  }
  record(label, res.effects.gasUsed, res.digest);
  return res;
}

const objId = (res: any, needle: string): string => {
  const c = res.objectChanges.find((x: any) => x.type === "created" && x.objectType?.includes(needle));
  if (!c) throw new Error(`no created object matching ${needle}`);
  return c.objectId;
};

async function chainEpoch(client: SuiJsonRpcClient): Promise<bigint> {
  const o = await client.getObject({ id: CLOCK, options: { showContent: true } });
  const ts = (o.data!.content as any).fields.timestamp_ms;
  return BigInt(ts) / BigInt(EPOCH_MS);
}

async function main() {
  const poseidon = await buildPoseidon();
  const H = (xs: bigint[]): bigint => poseidon.F.toObject(poseidon(xs));
  // @ts-expect-error snarkjs has no types
  const snarkjs = await import("snarkjs");
  const kp = loadKeypair();
  const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" as any });

  // ── 1. publish ───────────────────────────────────────────────────────────
  const pubOut = execSync("sui client test-publish --build-env testnet --pubfile-path /tmp/veil-localnet-pub.toml --gas-budget 1000000000 --json", {
    cwd: join(ROOT, "contracts"), encoding: "utf-8", maxBuffer: 50 << 20,
  });
  const pub = JSON.parse(pubOut.slice(pubOut.indexOf("{")));
  if (pub.effects.status.status !== "success") throw new Error("publish failed");
  record("publish (whole package)", pub.effects.gasUsed, pub.digest);
  const packageId: string = pub.objectChanges.find((c: any) => c.type === "published").packageId;
  const treasuryCap: string = pub.objectChanges.find((c: any) => c.objectType?.includes("::coin::TreasuryCap")).objectId;
  await client.waitForTransaction({ digest: pub.digest });

  // ── 2. witnesses (deterministic secrets) ─────────────────────────────────
  const commit = (cum: bigint, r: bigint, s: bigint) => H([D.COMMIT, cum, r, s]);
  const secretA = 111111111n, secretB = 222222222n, secretW = 333333333n;
  const leafA = commit(0n, 5n, secretA);
  const leafB = commit(0n, 6n, secretB);
  // Two-leaf commitment tree (leafA @ idx0, leafB @ idx1), zero siblings above level 0 —
  // the same convention the circuits' own tests use.
  let root = H([leafA, leafB]);
  for (let i = 1; i < DEPTH; i++) root = H([root, 0n]);
  const zeros = () => Array.from({ length: DEPTH }, () => 0n);
  const pathA = zeros(); pathA[0] = leafB;
  const pathB = zeros(); pathB[0] = leafA;
  const idxA = zeros();
  const idxB = zeros(); idxB[0] = 1n;
  const withdrawLeaf = commit(500n, 12345n, secretW);

  const toBytes32 = (x: bigint) => {
    const b = new Uint8Array(32);
    let v = x;
    for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
    return b;
  };
  const strs = (o: Record<string, any>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

  async function prove(name: string, dir: string, input: Record<string, any>) {
    const wasm = join(CIRCUITS, dir, `${name}_js`, `${name}.wasm`);
    const zkey = join(CIRCUITS, dir, `${name}_final.zkey`);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(strs(input), wasm, zkey);
    const vk = JSON.parse(readFileSync(join(CIRCUITS, dir, `${name}_vk.json`), "utf-8"));
    if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${name}: local verify failed`);
    return { proofBytes: proofToSuiBytes(proof), inputsBytes: publicInputsToSuiBytes(publicSignals) };
  }
  const vkBytes = (dir: string, name: string) =>
    vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, dir, `${name}_vk.json`), "utf-8")));
  const vec = (tx: Transaction, b: Uint8Array) => tx.pure.vector("u8", Array.from(b));

  // ── 3. epoch-E setup ─────────────────────────────────────────────────────
  const epochAtSetup = await chainEpoch(client);
  console.log(`[info] setup epoch E = ${epochAtSetup}`);

  const created = await run(client, kp, "create_pool", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::create_pool`,
      arguments: [vec(tx, vkBytes("build", "transfer")), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)],
    });
  });
  const poolId = objId(created, "::pool::Pool");
  const adminCap = objId(created, "::pool::AdminCap");

  const minted = await run(client, kp, "token_faucet::faucet (test mint)", (tx) => {
    tx.moveCall({ target: `${packageId}::token_faucet::faucet`, arguments: [tx.object(treasuryCap)] });
  });
  const coinId = objId(minted, "::token::TOKEN");

  for (const [label, leaf] of [
    ["deposit_and_register #1 (empty pool)", leafA],
    ["deposit_and_register #2", leafB],
    ["deposit_and_register #3", withdrawLeaf],
  ] as const) {
    await run(client, kp, label, (tx) => {
      const [c] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(DEPOSIT)]);
      tx.moveCall({
        target: `${packageId}::pool::deposit_and_register`,
        arguments: [tx.object(poolId), c, vec(tx, toBytes32(leaf)), tx.object(CLOCK)],
      });
    });
  }

  await run(client, kp, "update_commitment_root (propose)", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::update_commitment_root`,
      arguments: [tx.object(poolId), tx.object(adminCap), vec(tx, toBytes32(root)), tx.object(CLOCK)],
    });
  });
  await run(client, kp, "propose_withdraw_vk", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::propose_withdraw_vk`,
      arguments: [tx.object(poolId), tx.object(adminCap), vec(tx, vkBytes("build-withdraw", "withdraw")), tx.object(CLOCK)],
    });
  });

  // compliance config: credential tree with one leaf, zero siblings
  const issuerId = 42n, kycLevel = 2n, expiry = 1n << 40n;
  const credLeaf = H([D.CRED, secretB, kycLevel, expiry, issuerId]);
  let credRoot = credLeaf;
  for (let i = 0; i < DEPTH; i++) credRoot = H([credRoot, 0n]);
  const cfg = await run(client, kp, "create_compliance_config", (tx) => {
    tx.moveCall({
      target: `${packageId}::compliance::create_compliance_config`,
      arguments: [
        tx.object(adminCap), tx.object(poolId), vec(tx, vkBytes("build-compliance", "compliance")),
        vec(tx, toBytes32(credRoot)), tx.pure.u64(1), vec(tx, new Uint8Array(33).fill(2)),
      ],
    });
  });
  const configId = objId(cfg, "::compliance::ComplianceConfig");

  // ── 4. wait for epoch E+1 ────────────────────────────────────────────────
  console.log("[info] waiting for the next epoch (timelocks + commitment maturity)...");
  // Wait relative to the epoch observed *after* the last setup tx (setup can straddle a boundary,
  // and the timelocked updates take effect at tx-epoch + 1 <= setupEnd + 1).
  const setupEnd = await chainEpoch(client);
  let E = setupEnd;
  while (E <= setupEnd) { await new Promise((r) => setTimeout(r, 2000)); E = await chainEpoch(client); }
  console.log(`[info] now epoch ${E}; proving`);

  // ── 5. proofs (each ~1 s; the contract also accepts the previous epoch) ──
  const transferInput = (secret: bigint, rOld: bigint, rNew: bigint, path: bigint[], idx: bigint[]) => {
    const amt = 100n, salt = 7n;
    return {
      oldCommitment: commit(0n, rOld, secret), newCommitment: commit(amt, rNew, secret),
      threshold: THRESHOLD, epochId: E, nullifier: H([D.NULL, secret, E, rOld]),
      txAmountHash: H([D.TXAMT, amt, salt]), merkleRoot: root,
      cumulativeOld: 0n, cumulativeNew: amt, txAmount: amt, randomnessOld: rOld, randomnessNew: rNew,
      userSecret: secret, salt, pathElements: path, pathIndices: idx,
    };
  };
  const tA = await prove("transfer", "build", transferInput(secretA, 5n, 55n, pathA, idxA));
  const inB = transferInput(secretB, 6n, 66n, pathB, idxB);
  const tB = await prove("transfer", "build", inB);

  const ctxId = H([D.CTX, inB.nullifier, secretB]);
  const cred = await prove("compliance", "build-compliance", {
    merkleRoot: credRoot, currentEpoch: E, contextId: ctxId, requiredKycLevel: 1n,
    nullifier: H([D.CNULL, secretB, ctxId]), validCredential: 1n,
    userSecret: secretB, kycLevel, expiryEpoch: expiry, issuerId,
    pathElements: zeros(), pathIndices: zeros(), transferNullifier: inB.nullifier,
  });

  const recipient = 0xabcdef123456n; // < BN254 r, so it is a valid field element
  const recipientAddr = "0x" + recipient.toString(16).padStart(64, "0");
  const wAmt = 100n, wRNew = 77777n;
  const w = await prove("withdraw", "build-withdraw", {
    commitment: withdrawLeaf, withdrawAmount: wAmt, nullifier: H([D.WNULL, secretW, 12345n, 500n]),
    recipientHash: H([D.RCPT, recipient]), newCommitment: commit(500n - wAmt, wRNew, secretW),
    cumulativeOld: 500n, randomnessOld: 12345n, userSecret: secretW, recipient, randomnessNew: wRNew,
  });

  // ── 6. verifying entry points ────────────────────────────────────────────
  // DECOUPLE=1: soundness probe, not a gas measurement. Pair the compliance proof of credential
  // holder B with the *transfer* of A, who holds no credential. If compliant_transfer accepts, the
  // compliance proof is not bound to the transfer it accompanies.
  const decouple = process.env.DECOUPLE === "1";
  if (!decouple) await run(client, kp, "shielded_transfer", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::shielded_transfer`,
      arguments: [tx.object(poolId), vec(tx, tA.proofBytes), vec(tx, tA.inputsBytes), tx.object(CLOCK)],
    });
  });
  await run(client, kp, decouple ? "compliant_transfer (A's transfer + B's credential proof)" : "compliant_transfer (2 proofs)", (tx) => {
    tx.moveCall({
      target: `${packageId}::compliance::compliant_transfer`,
      arguments: [
        tx.object(poolId), tx.object(configId), vec(tx, (decouple ? tA : tB).proofBytes), vec(tx, (decouple ? tA : tB).inputsBytes),
        vec(tx, cred.proofBytes), vec(tx, cred.inputsBytes), vec(tx, new Uint8Array(93).fill(1)), tx.object(CLOCK),
      ],
    });
  });
  await run(client, kp, "zk_withdraw", (tx) => {
    tx.moveCall({
      target: `${packageId}::pool::zk_withdraw`,
      arguments: [tx.object(poolId), vec(tx, w.proofBytes), vec(tx, w.inputsBytes), tx.pure.address(recipientAddr), tx.object(CLOCK)],
    });
  });

  const out = process.argv.indexOf("--json");
  if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(rows, null, 2));
  console.log("\n| entry | computation | storage | rebate | net (MIST) |\n|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.entry} | ${r.computation} | ${r.storage} | ${r.rebate} | ${r.net} |`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[FATAL]", e); process.exit(1); }); // snarkjs leaves worker threads alive
