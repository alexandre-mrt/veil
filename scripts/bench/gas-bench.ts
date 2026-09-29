/**
 * gas-bench.ts — On-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Publishes the real package, creates a pool, and drives every proof-bearing entry point
 * (shielded_transfer, compliant_transfer, zk_withdraw) with real Groth16 proofs, plus the main
 * admin ops. Records effects.gasUsed for every transaction and writes gas-bench-results.json.
 *
 * Usage (from scripts/):
 *   bun run bench/gas-bench.ts [--out bench/gas-bench-results.json]
 *
 * Prerequisites:
 *   - `sui` CLI (>= 1.80) with the `local` env active, and a local network + faucet running:
 *       sui start --force-regenesis --with-faucet &   ;   sui client switch --env local
 *       sui client faucet                                (gives the active address gas)
 *   - Compiled circuits (circuits/build, build-withdraw, build-compliance) — circuits/scripts/compile*.sh
 *   - `bun install` in scripts/
 *
 * Wall-clock: the pool uses the minimum 60 s epoch and the protocol needs two epoch boundaries
 * (commitment maturity + timelocked root/VK), so a run takes ~3 minutes.
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";
// @ts-ignore snarkjs has no types
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const C = join(ROOT, "circuits");
const RPC = process.env.SUI_RPC ?? "http://127.0.0.1:9000";
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i !== -1 ? process.argv[i + 1] : join(__dirname, "gas-bench-results.json");
})();

const EPOCH_MS = 60_000; // minimum allowed by create_pool
const THRESHOLD = 1_000_000_000n;
const DENOM = 100_000_000; // DENOM_SMALL
const CLOCK = "0x6";
const BUDGET = 500_000_000;
const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RHASH: 8n };

// ---------------------------------------------------------------------------
const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" as any });

function loadKeypair(): Ed25519Keypair {
  const active = execSync("sui client active-address", { encoding: "utf-8" }).trim();
  const ks: string[] = JSON.parse(readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf-8"));
  for (const k of ks) {
    const raw = fromBase64(k);
    if (raw[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(raw.slice(1));
    if (kp.toSuiAddress() === active) return kp;
  }
  throw new Error("active address key not found in keystore");
}

const results: any[] = [];
let refGasPrice = 0n;

async function run(label: string, tx: Transaction, kp: Ed25519Keypair, opts: { expectFail?: boolean } = {}) {
  tx.setGasBudget(BUDGET);
  const r = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  const g = r.effects!.gasUsed;
  const ok = r.effects!.status.status === "success";
  const comp = BigInt(g.computationCost), stor = BigInt(g.storageCost), reb = BigInt(g.storageRebate);
  const row = {
    label,
    status: ok ? "success" : `abort: ${r.effects!.status.error}`,
    computationCost: comp.toString(),
    computationUnits: (comp / refGasPrice).toString(),
    storageCost: stor.toString(),
    storageRebate: reb.toString(),
    netMist: (comp + stor - reb).toString(),
    digest: r.digest,
  };
  results.push(row);
  console.log(`${label.padEnd(44)} ${row.status.slice(0, 30).padEnd(30)} comp=${comp} (${row.computationUnits}u) stor=${stor} reb=${reb} net=${row.netMist}`);
  if (ok === !!opts.expectFail) throw new Error(`${label}: unexpected ${ok ? "success" : "failure"}: ${row.status}`);
  return r;
}

const bytes = (a: Uint8Array) => Array.from(a);
const vec = (tx: Transaction, a: Uint8Array) => tx.pure.vector("u8", bytes(a));
const epochNow = () => BigInt(Math.floor(Date.now() / EPOCH_MS));
async function waitPastEpoch(e: bigint) {
  while (epochNow() <= e) await new Promise((r) => setTimeout(r, 1000));
  await new Promise((r) => setTimeout(r, 2500)); // let the chain clock catch up
}

// ---------------------------------------------------------------------------
async function main() {
  const kp = loadKeypair();
  const me = kp.toSuiAddress();
  refGasPrice = BigInt(await client.getReferenceGasPrice());
  console.log(`address ${me}  referenceGasPrice ${refGasPrice}\n`);

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (xs: bigint[]): bigint => F.toObject(poseidon(xs));
  const commitBytes = (c: bigint) => publicInputsToSuiBytes([c.toString()]).slice(0, 32);

  // --- witnesses (transfer leaves A and B share one 2-leaf Merkle tree) -----------------------
  const uS_A = 987654321n, rOld_A = 111n, uS_B = 555555555n, rOld_B = 222n;
  const leafA = H([D.COMMIT, 0n, rOld_A, uS_A]);
  const leafB = H([D.COMMIT, 0n, rOld_B, uS_B]);
  const rootAB = (() => {
    let n = H([leafA, leafB]);
    for (let i = 1; i < 20; i++) n = H([n, 0n]);
    return n;
  })();
  const path = (sib0: bigint) => ({
    pathElements: [sib0, ...Array(19).fill(0n)],
  });

  // withdraw witness (its own commitment W; upfront values, epoch-independent)
  const wCum = 500n, wRand = 12345n, wSecret = 424242n, wAmt = 100n, wRecipient = 0xABCDEF123456n, wRandNew = 77777n;
  const leafW = H([D.COMMIT, wCum, wRand, wSecret]);

  // compliance credential tree (single leaf, zero siblings), expiry far in the future
  const ceNow = epochNow();
  const cUS = uS_B, kyc = 2n, expiry = ceNow + 100_000n, issuer = 42n;
  const credLeaf = H([D.CRED, cUS, kyc, expiry, issuer]);
  let credRoot = credLeaf;
  for (let i = 0; i < 20; i++) credRoot = H([credRoot, 0n]);

  // --- 1. publish -----------------------------------------------------------------------------
  const pub = await (async () => {
    // `sui client test-publish` publishes to the active (local) env with ephemeral dep addresses.
    const contracts = join(ROOT, "contracts");
    const pubFile = join(contracts, "Pub.local.toml");
    if (existsSync(pubFile)) execSync(`rm ${pubFile}`);
    const out = execSync(`sui client test-publish --build-env testnet --gas-budget ${BUDGET} --json`, {
      cwd: contracts, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    const res = JSON.parse(out.slice(out.indexOf("{")));
    if (res.effects?.status?.status !== "success") throw new Error("publish failed");
    const g = res.effects.gasUsed;
    const comp = BigInt(g.computationCost), stor = BigInt(g.storageCost), reb = BigInt(g.storageRebate);
    results.push({
      label: "publish (whole package)", status: "success", computationCost: comp.toString(),
      computationUnits: (comp / refGasPrice).toString(), storageCost: stor.toString(),
      storageRebate: reb.toString(), netMist: (comp + stor - reb).toString(), digest: res.digest,
    });
    console.log(`${"publish (whole package)".padEnd(44)} success                        comp=${comp} stor=${stor} reb=${reb} net=${comp + stor - reb}`);
    const ch = res.objectChanges as any[];
    return {
      packageId: ch.find((c) => c.type === "published").packageId as string,
      treasuryCapId: ch.find((c) => c.type === "created" && c.objectType.includes("::coin::TreasuryCap"))?.objectId as string,
    };
  })();
  const pkg = pub.packageId;
  const treasury = pub.treasuryCapId!;

  // --- 2. create_pool ------------------------------------------------------------------------
  const tvk = vkToSuiBytes(JSON.parse(readFileSync(join(C, "build", "transfer_vk.json"), "utf-8")));
  let tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [vec(tx, tvk), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
  let r = await run("create_pool", tx, kp);
  const poolId = (r.objectChanges as any[]).find((c) => c.type === "created" && c.objectType.endsWith("::pool::Pool")).objectId;
  const capId = (r.objectChanges as any[]).find((c) => c.type === "created" && c.objectType.endsWith("::pool::AdminCap")).objectId;
  const e0 = epochNow();

  // --- 3. mint + deposits (A, B, W) ----------------------------------------------------------
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] });
  r = await run("token_faucet::faucet (mint 1000 VEIL)", tx, kp);
  const coinId = (r.objectChanges as any[]).find((c) => c.type === "created" && c.objectType.includes("::coin::Coin<")).objectId;

  const deposit = async (label: string, c: bigint) => {
    const t = new Transaction();
    const [coin] = t.splitCoins(t.object(coinId), [t.pure.u64(DENOM)]);
    t.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [t.object(poolId), coin, vec(t, commitBytes(c)), t.object(CLOCK)] });
    return run(label, t, kp);
  };
  await deposit("deposit_and_register (1st commitment)", leafA);
  await deposit("deposit_and_register (2nd commitment)", leafB);
  await deposit("deposit_and_register (3rd commitment)", leafW);

  // --- 4. admin ops in epoch e0 ---------------------------------------------------------------
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [tx.object(poolId), tx.object(capId), vec(tx, commitBytes(rootAB)), tx.object(CLOCK)] });
  await run("update_commitment_root (propose)", tx, kp);

  const wvk = vkToSuiBytes(JSON.parse(readFileSync(join(C, "build-withdraw", "withdraw_vk.json"), "utf-8")));
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [tx.object(poolId), tx.object(capId), vec(tx, wvk), tx.object(CLOCK)] });
  await run("propose_withdraw_vk", tx, kp);

  const cvk = vkToSuiBytes(JSON.parse(readFileSync(join(C, "build-compliance", "compliance_vk.json"), "utf-8")));
  tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::compliance::create_compliance_config`,
    arguments: [tx.object(capId), tx.object(poolId), vec(tx, cvk), vec(tx, commitBytes(credRoot)), tx.pure.u64(1), vec(tx, new Uint8Array(33).fill(2))],
  });
  r = await run("create_compliance_config", tx, kp);
  const cfgId = (r.objectChanges as any[]).find((c) => c.type === "created" && c.objectType.endsWith("::compliance::ComplianceConfig")).objectId;

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::propose_withdrawal`, arguments: [tx.object(poolId), tx.object(capId), tx.pure.u64(1000), tx.pure.address(me), tx.object(CLOCK)] });
  await run("propose_withdrawal", tx, kp);
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::cancel_withdrawal`, arguments: [tx.object(poolId), tx.object(capId)] });
  await run("cancel_withdrawal", tx, kp);
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [tx.object(poolId), tx.object(capId), tx.object(CLOCK)] });
  await run("freeze_pool", tx, kp);
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::unfreeze_pool`, arguments: [tx.object(poolId), tx.object(capId)] });
  await run("unfreeze_pool", tx, kp);

  // --- 5. wait for the next epoch (root + VK apply lazily, commitments mature) ----------------
  console.log(`\nwaiting for epoch > ${e0} (up to 60 s)...`);
  await waitPastEpoch(e0);
  const ep = epochNow();
  console.log(`epoch now ${ep}\n`);

  // --- 6. real proofs -----------------------------------------------------------------------
  const prove = async (wasm: string, zkey: string, input: Record<string, any>) => {
    const s = (v: any): any => (Array.isArray(v) ? v.map(s) : v.toString());
    const inp = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, s(v)]));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(inp, wasm, zkey, undefined, undefined, { singleThread: true });
    return { proofBytes: proofToSuiBytes(proof), inputsBytes: publicInputsToSuiBytes(publicSignals), publicSignals };
  };
  const tW = join(C, "build", "transfer_js", "transfer.wasm"), tZ = join(C, "build", "transfer_final.zkey");

  const transferInput = (uS: bigint, rOld: bigint, rNew: bigint, sib0: bigint, idx0: bigint, leaf: bigint) => {
    const txAmount = 100n, salt = 99n, cumNew = txAmount;
    return {
      oldCommitment: leaf, newCommitment: H([D.COMMIT, cumNew, rNew, uS]), threshold: THRESHOLD, epochId: ep,
      nullifier: H([D.NULL, uS, ep, rOld]), txAmountHash: H([D.TXAMT, txAmount, salt]), merkleRoot: rootAB,
      cumulativeOld: 0n, cumulativeNew: cumNew, txAmount, randomnessOld: rOld, randomnessNew: rNew, userSecret: uS, salt,
      ...path(sib0), pathIndices: [idx0, ...Array(19).fill(0n)],
    };
  };

  // shielded_transfer (leaf A)
  const tA = await prove(tW, tZ, transferInput(uS_A, rOld_A, 12345n, leafB, 0n, leafA));
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(poolId), vec(tx, tA.proofBytes), vec(tx, tA.inputsBytes), tx.object(CLOCK)] });
  await run("shielded_transfer (real Groth16 proof)", tx, kp);

  // negative: replay is rejected on-chain (gas of a failed tx is still charged)
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(poolId), vec(tx, tA.proofBytes), vec(tx, tA.inputsBytes), tx.object(CLOCK)] });
  try { await run("shielded_transfer replay (expect abort)", tx, kp, { expectFail: true }); }
  catch (e: any) { if (!/Dry run failed|MoveAbort|abort/i.test(String(e.message))) throw e; console.log(`replay rejected at dry-run/execution: ${String(e.message).slice(0, 160)}`); }

  // compliant_transfer (leaf B + compliance proof)
  const tB_in = transferInput(uS_B, rOld_B, 54321n, leafA, 1n, leafB);
  const tB = await prove(tW, tZ, tB_in);
  const ctxId = H([D.CTX, tB_in.nullifier, cUS]);
  const cIn = {
    merkleRoot: credRoot, currentEpoch: ep, contextId: ctxId, requiredKycLevel: 1n,
    nullifier: H([D.CNULL, cUS, ctxId]), validCredential: 1n,
    userSecret: cUS, kycLevel: kyc, expiryEpoch: expiry, issuerId: issuer,
    pathElements: Array(20).fill(0n), pathIndices: Array(20).fill(0n), transferNullifier: tB_in.nullifier,
  };
  const cP = await prove(join(C, "build-compliance", "compliance_js", "compliance.wasm"), join(C, "build-compliance", "compliance_final.zkey"), cIn);
  tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::compliance::compliant_transfer`,
    arguments: [tx.object(poolId), tx.object(cfgId), vec(tx, tB.proofBytes), vec(tx, tB.inputsBytes), vec(tx, cP.proofBytes), vec(tx, cP.inputsBytes), vec(tx, new Uint8Array(93).fill(7)), tx.object(CLOCK)],
  });
  await run("compliant_transfer (transfer + compliance proofs)", tx, kp);

  // zk_withdraw (leaf W)
  const wIn = {
    commitment: leafW, withdrawAmount: wAmt, nullifier: H([D.WNULL, wSecret, wRand, wCum]),
    recipientHash: H([D.RHASH, wRecipient]), newCommitment: H([D.COMMIT, wCum - wAmt, wRandNew, wSecret]),
    cumulativeOld: wCum, randomnessOld: wRand, userSecret: wSecret, recipient: wRecipient, randomnessNew: wRandNew,
  };
  const wP = await prove(join(C, "build-withdraw", "withdraw_js", "withdraw.wasm"), join(C, "build-withdraw", "withdraw_final.zkey"), wIn);
  const recipientAddr = "0x" + wRecipient.toString(16).padStart(64, "0");
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(poolId), vec(tx, wP.proofBytes), vec(tx, wP.inputsBytes), tx.pure.address(recipientAddr), tx.object(CLOCK)] });
  await run("zk_withdraw (real Groth16 proof)", tx, kp);

  writeFileSync(OUT, JSON.stringify({ rpc: RPC, referenceGasPrice: refGasPrice.toString(), epochMs: EPOCH_MS, results }, null, 2));
  console.log(`\nwrote ${OUT}`);
  process.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
