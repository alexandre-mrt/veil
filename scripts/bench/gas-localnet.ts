/**
 * gas-localnet.ts — Measure real on-chain gas for every Veil entry point on a local Sui network.
 *
 * Publishes the package, then drives the full protocol with REAL Groth16 proofs
 * (transfer / withdraw / compliance) through `sui::groth16` verification and prints
 * computationCost / storageCost / storageRebate / net for each transaction.
 *
 * Prerequisites (see docs/research/2026-10-13-onchain-gas-baseline.md):
 *   - `sui` CLI >= 1.81 on PATH, and a running localnet:
 *       sui start --force-regenesis --with-faucet
 *   - compiled circuits: circuits/build/{transfer_js,transfer_final.zkey,transfer_vk.json},
 *     circuits/build-withdraw/..., circuits/build-compliance/... (see circuits/scripts/compile*.sh)
 *   - `cd scripts && bun install`
 *
 * Usage:  cd scripts && node bench/gas-localnet.ts [--json out.json]
 *
 * Epochs are 60 s (the pool minimum), so the run takes ~3-4 min of wall-clock waiting on the
 * timelocks (commitment root, withdraw VK, compliance toggle) and commitment maturity.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error snarkjs has no types
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RPC = "http://127.0.0.1:9000";
const FAUCET = "http://127.0.0.1:9123";
const CLOCK = "0x6";
const EPOCH_MS = 60_000;
const THRESHOLD = 1_000_000_000n;
const DEPOSIT_AMOUNT = 1_000_000_000n; // DENOM_LARGE == one faucet mint
const BUDGET = 500_000_000n;
const DEPTH = 20;

const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RECIP: 8n };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (a: Uint8Array) => Array.from(a);

interface Row { name: string; computation: bigint; storage: bigint; rebate: bigint; net: bigint; digest: string }
const rows: Row[] = [];

async function main() {
  const poseidon = await buildPoseidon();
  const H = (xs: bigint[]): bigint => poseidon.F.toObject(poseidon(xs)) as bigint;

  const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
  const kp = Ed25519Keypair.generate();
  const me = kp.toSuiAddress();
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await sleep(2000);
  const rgp = await client.getReferenceGasPrice();
  console.log(`reference gas price: ${rgp} MIST/unit`);

  async function run(name: string, tx: Transaction, measure = true) {
    tx.setGasBudget(BUDGET);
    const res = await client.signAndExecuteTransaction({
      transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status?.status !== "success") {
      throw new Error(`${name} failed: ${JSON.stringify(res.effects?.status)}`);
    }
    const g = res.effects!.gasUsed;
    const computation = BigInt(g.computationCost), storage = BigInt(g.storageCost), rebate = BigInt(g.storageRebate);
    const net = computation + storage - rebate;
    if (measure) rows.push({ name, computation, storage, rebate, net, digest: res.digest });
    console.log(`  ${name.padEnd(34)} comp=${computation} storage=${storage} rebate=${rebate} net=${net}`);
    return res;
  }

  // ---- publish ------------------------------------------------------------
  console.log("== publish");
  const built = JSON.parse(
    execSync("sui move build --dump-bytecode-as-base64 --no-tree-shaking", { cwd: join(ROOT, "contracts"), encoding: "utf-8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }),
  ) as { modules: string[]; dependencies: string[] };
  const ptx = new Transaction();
  const [upgradeCap] = ptx.publish({ modules: built.modules, dependencies: built.dependencies });
  ptx.transferObjects([upgradeCap], me);
  const pub = await run("publish", ptx);
  const changes = pub.objectChanges!;
  const pkg = (changes.find((c) => c.type === "published") as { packageId: string }).packageId;
  const findObj = (res: typeof pub, frag: string) =>
    (res.objectChanges!.find((c) => c.type === "created" && "objectType" in c && c.objectType.includes(frag)) as { objectId: string }).objectId;
  const treasury = findObj(pub, "::coin::TreasuryCap");

  // ---- artifacts ----------------------------------------------------------
  const art = (dir: string, name: string) => ({
    wasm: join(ROOT, "circuits", dir, `${name}_js`, `${name}.wasm`),
    zkey: join(ROOT, "circuits", dir, `${name}_final.zkey`),
    vk: JSON.parse(readFileSync(join(ROOT, "circuits", dir, `${name}_vk.json`), "utf-8")),
  });
  const T = art("build", "transfer"), W = art("build-withdraw", "withdraw"), C = art("build-compliance", "compliance");
  const prove = async (a: typeof T, input: Record<string, unknown>) => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, a.wasm, a.zkey);
    return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals), signals: publicSignals as string[] };
  };
  const strs = (o: Record<string, bigint | bigint[]>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

  // ---- commitments and a shared 2-leaf tree -------------------------------
  const secretA = 987654321n, secretB = 555000111n, secretW = 424242n;
  const mkTransfer = (secret: bigint, rOld: bigint, rNew: bigint, amt: bigint) => {
    const old = H([D.COMMIT, 0n, rOld, secret]);
    return { secret, rOld, rNew, amt, old, next: H([D.COMMIT, amt, rNew, secret]) };
  };
  const t1 = mkTransfer(secretA, 11n, 12n, 100n);
  const t2 = mkTransfer(secretB, 21n, 22n, 100n);
  const path = (sibling: bigint, idx: bigint) => ({
    pathElements: [sibling, ...Array(DEPTH - 1).fill(0n)] as bigint[],
    pathIndices: [idx, ...Array(DEPTH - 1).fill(0n)] as bigint[],
  });
  const rootOf = (leaf: bigint, p: { pathElements: bigint[]; pathIndices: bigint[] }) => {
    let n = leaf;
    for (let i = 0; i < DEPTH; i++) n = p.pathIndices[i] === 0n ? H([n, p.pathElements[i]]) : H([p.pathElements[i], n]);
    return n;
  };
  const p1 = path(t2.old, 0n), p2 = path(t1.old, 1n);
  const treeRoot = rootOf(t1.old, p1);
  if (treeRoot !== rootOf(t2.old, p2)) throw new Error("tree roots disagree");
  const le32 = (n: bigint) => { const b = new Uint8Array(32); let x = n; for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

  // withdraw leaf
  const wCum = 500n, wRold = 12345n, wAmt = 100n, wRnew = 77777n, wRecipient = 0xABCDEF123456n; // proof binds THIS address; the tx below sends to `me` instead (see E7 finding)
  const wOld = H([D.COMMIT, wCum, wRold, secretW]);
  const wNew = H([D.COMMIT, wCum - wAmt, wRnew, secretW]);

  // ---- pool setup ---------------------------------------------------------
  console.log("== setup");
  const transferVk = vkToSuiBytes(T.vk), withdrawVk = vkToSuiBytes(W.vk), complianceVk = vkToSuiBytes(C.vk);
  let tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [tx.pure.vector("u8", arg(transferVk)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
  const cp = await run("create_pool", tx);
  const pool = findObj(cp, "::pool::Pool"), adminCap = findObj(cp, "::pool::AdminCap");

  const deposit = async (label: string, commitment: bigint) => {
    const f = new Transaction();
    f.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [f.object(treasury)] });
    const fr = await run("faucet", f, false);
    const coin = findObj(fr, "::token::TOKEN");
    const d = new Transaction();
    d.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [d.object(pool), d.object(coin), d.pure.vector("u8", arg(le32(commitment))), d.object(CLOCK)] });
    await run(label, d);
  };
  await deposit("deposit_and_register #1", t1.old);
  await deposit("deposit_and_register #2", t2.old);
  await deposit("deposit_and_register #3", wOld);

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", arg(le32(treeRoot))), tx.object(CLOCK)] });
  await run("update_commitment_root (propose)", tx);

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", arg(withdrawVk)), tx.object(CLOCK)] });
  await run("propose_withdraw_vk", tx);

  // compliance config + credential tree (single credential at index 0, zero siblings)
  const credSecret = secretA, kyc = 2n, expiry = 100_000_000n, issuer = 42n;
  let cur = H([D.CRED, credSecret, kyc, expiry, issuer]);
  for (let i = 0; i < DEPTH; i++) cur = H([cur, 0n]);
  const credRoot = cur;
  const auditorKey = new Uint8Array(33).fill(2);
  tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::compliance::create_compliance_config`,
    arguments: [tx.object(adminCap), tx.object(pool), tx.pure.vector("u8", arg(complianceVk)), tx.pure.vector("u8", arg(le32(credRoot))), tx.pure.u64(1), tx.pure.vector("u8", arg(auditorKey))],
  });
  const cc = await run("create_compliance_config", tx);
  const config = findObj(cc, "::compliance::ComplianceConfig");

  const epochNow = async () => {
    const o = await client.getObject({ id: CLOCK, options: { showContent: true } });
    const ms = BigInt((o.data!.content as { fields: { timestamp_ms: string } }).fields.timestamp_ms);
    return ms / BigInt(EPOCH_MS);
  };
  const waitEpochs = async (target: bigint) => {
    while ((await epochNow()) < target) await sleep(3000);
  };

  // ---- epoch E+1: shielded_transfer + zk_withdraw -------------------------
  const e0 = await epochNow();
  console.log(`== waiting for epoch ${e0 + 1n} (timelocks + maturity)`);
  await waitEpochs(e0 + 1n);

  const transferInput = (t: ReturnType<typeof mkTransfer>, p: ReturnType<typeof path>, epoch: bigint) => strs({
    oldCommitment: t.old, newCommitment: t.next, threshold: THRESHOLD, epochId: epoch,
    nullifier: H([D.NULL, t.secret, epoch, t.rOld]), txAmountHash: H([D.TXAMT, t.amt, 99n]), merkleRoot: treeRoot,
    cumulativeOld: 0n, cumulativeNew: t.amt, txAmount: t.amt, randomnessOld: t.rOld, randomnessNew: t.rNew,
    userSecret: t.secret, salt: 99n, pathElements: p.pathElements, pathIndices: p.pathIndices,
  });

  console.log("== shielded_transfer");
  let ep = await epochNow();
  const pr1 = await prove(T, transferInput(t1, p1, ep));
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), tx.pure.vector("u8", arg(pr1.proof)), tx.pure.vector("u8", arg(pr1.inputs)), tx.object(CLOCK)] });
  await run("shielded_transfer", tx);

  console.log("== zk_withdraw");
  const wNullifier = H([D.WNULL, secretW, wRold, wCum]);
  const wp = await prove(W, strs({
    commitment: wOld, withdrawAmount: wAmt, nullifier: wNullifier, recipientHash: H([D.RECIP, wRecipient]), newCommitment: wNew,
    cumulativeOld: wCum, randomnessOld: wRold, userSecret: secretW, recipient: wRecipient, randomnessNew: wRnew,
  }));
  const tokenType = `${pkg}::token::TOKEN`;
  const balBefore = BigInt((await client.getBalance({ owner: me, coinType: tokenType })).totalBalance);
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(pool), tx.pure.vector("u8", arg(wp.proof)), tx.pure.vector("u8", arg(wp.inputs)), tx.pure.address(me), tx.object(CLOCK)] });
  await run("zk_withdraw", tx);
  const balAfter = BigInt((await client.getBalance({ owner: me, coinType: tokenType })).totalBalance);
  console.log(`  E7 check: proof bound recipientHash to ${wRecipient.toString(16)}, tx paid ${me}; TOKEN balance ${balBefore} -> ${balAfter} (delta ${balAfter - balBefore})`);

  // ---- compliance toggle (1-epoch timelock) -------------------------------
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::propose_compliance_toggle`, arguments: [tx.object(pool), tx.object(adminCap), tx.pure.bool(true), tx.object(CLOCK)] });
  await run("propose_compliance_toggle", tx);
  const e1 = await epochNow();
  console.log(`== waiting for epoch ${e1 + 1n}`);
  await waitEpochs(e1 + 1n);

  console.log("== compliant_transfer");
  ep = await epochNow();
  const pr2 = await prove(T, transferInput(t2, p2, ep));
  const tNull2 = H([D.NULL, t2.secret, ep, t2.rOld]);
  const contextId = H([D.CTX, tNull2, credSecret]);
  const cp2 = await prove(C, strs({
    merkleRoot: credRoot, currentEpoch: ep, contextId, requiredKycLevel: 1n,
    nullifier: H([D.CNULL, credSecret, contextId]), validCredential: 1n,
    userSecret: credSecret, kycLevel: kyc, expiryEpoch: expiry, issuerId: issuer,
    pathElements: Array(DEPTH).fill(0n), pathIndices: Array(DEPTH).fill(0n), transferNullifier: tNull2,
  }));
  tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::compliance::compliant_transfer`,
    arguments: [
      tx.object(pool), tx.object(config),
      tx.pure.vector("u8", arg(pr2.proof)), tx.pure.vector("u8", arg(pr2.inputs)),
      tx.pure.vector("u8", arg(cp2.proof)), tx.pure.vector("u8", arg(cp2.inputs)),
      tx.pure.vector("u8", arg(new Uint8Array(93).fill(7))), tx.object(CLOCK),
    ],
  });
  await run("compliant_transfer", tx);

  // ---- report -------------------------------------------------------------
  console.log(`\n| Entry point | computation (MIST) | computation units | storage (MIST) | rebate (MIST) | net (MIST) | net (SUI) |\n|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    console.log(`| ${r.name} | ${r.computation} | ${r.computation / BigInt(rgp)} | ${r.storage} | ${r.rebate} | ${r.net} | ${(Number(r.net) / 1e9).toFixed(6)} |`);
  }
  const i = process.argv.indexOf("--json");
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify({ rgp: String(rgp), rows }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
