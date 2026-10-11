/**
 * gas-local.ts — on-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Publishes contracts/ to a fresh localnet, then drives the real entry points with REAL Groth16
 * proofs (transfer + withdraw circuits from circuits/build*) and records the gas summary of every
 * transaction from the effects the network returns. Nothing is estimated.
 *
 * Prerequisites:
 *   - `sui` CLI on PATH, a localnet running:  sui start --force-regenesis --with-faucet
 *   - compiled circuits + zkeys:  circuits/build/ and circuits/build-withdraw/ (circuits/scripts/compile*.sh)
 *   - cd scripts && bun install
 *
 * Usage (from repo root):
 *   cd scripts && bun run bench/gas-local.ts [--rpc http://127.0.0.1:9000] [--faucet http://127.0.0.1:9123] [--out gas.json]
 *
 * Epoch length is set to the 60 s contract minimum so the 1-epoch timelocks (commitment root,
 * withdraw VK) and commitment maturity can elapse inside one run (~3 min wall clock).
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : dflt;
};
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123");
const OUT = arg("--out", "");

const CLOCK = "0x6";
const EPOCH_MS = 60_000;
const THRESHOLD = 1_000_000_000n;
const DEPOSIT = 100_000_000; // DENOM_SMALL
const BUDGET = 500_000_000;

interface Row { op: string; computation: number; storage: number; rebate: number; nonRefundable: number; net: number; digest: string }
const rows: Row[] = [];

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" as never });
const kp = Ed25519Keypair.generate();
const me = kp.toSuiAddress();

async function run(op: string, tx: Transaction) {
  tx.setGasBudget(BUDGET);
  const r = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  const st = r.effects?.status;
  if (st?.status !== "success") throw new Error(`${op} failed: ${JSON.stringify(st)}`);
  const g = r.effects!.gasUsed;
  const row: Row = {
    op,
    computation: +g.computationCost, storage: +g.storageCost, rebate: +g.storageRebate,
    nonRefundable: +g.nonRefundableStorageFee,
    net: +g.computationCost + +g.storageCost - +g.storageRebate,
    digest: r.digest,
  };
  rows.push(row);
  console.log(`[gas] ${op.padEnd(34)} comp=${row.computation} storage=${row.storage} rebate=${row.rebate} net=${row.net}`);
  return r;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const created = (r: any, frag: string) =>
  r.objectChanges.find((c: any) => c.type === "created" && c.objectType?.includes(frag))?.objectId as string;

// Proving runs in Node (gas-proofs.mjs): snarkjs workers never resolve under Bun.
function proofs(epoch: bigint) {
  const o = JSON.parse(execSync(`node ${join(__dirname, "gas-proofs.mjs")} ${epoch}`, { encoding: "utf-8", maxBuffer: 64 << 20 }));
  const conv = (p: any) => ({
    proof: Array.from(proofToSuiBytes(p.proof)),
    inputs: Array.from(publicInputsToSuiBytes(p.publicSignals)),
    vk: Array.from(vkToSuiBytes(p.vk)),
  });
  return {
    transfer: { ...conv(o.transfer), oldCommitment: BigInt(o.transfer.oldCommitment), merkleRoot: BigInt(o.transfer.merkleRoot) },
    withdraw: { ...conv(o.withdraw), commitment: BigInt(o.withdraw.commitment), recipient: BigInt(o.withdraw.recipient) },
  };
}

async function main() {
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await sleep(2000);

  // ---- publish ------------------------------------------------------------------------------
  const built = JSON.parse(execSync("sui move build --dump-bytecode-as-base64 --no-tree-shaking", {
    cwd: join(ROOT, "contracts"), encoding: "utf-8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"],
  }).trim().split("\n").pop()!);
  let tx = new Transaction();
  const cap = tx.publish({ modules: built.modules, dependencies: built.dependencies });
  tx.transferObjects([cap], me);
  const pub = await run("publish (package)", tx);
  const pkg = pub.objectChanges!.find((c: any) => c.type === "published")!.packageId as string;
  const treasury = created(pub, "TreasuryCap");

  // First proof set: commitments, Merkle root and VKs (epoch is irrelevant here).
  const p0 = proofs(1n);
  const tw = p0.transfer, ww = p0.withdraw, wproof = p0.withdraw, tprobe = p0.transfer;

  // ---- create pool / mint / deposits --------------------------------------------------------
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [
    tx.pure.vector("u8", tprobe.vk), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
  const cp = await run("create_pool", tx);
  const pool = created(cp, "::pool::Pool");
  const adminCap = created(cp, "::pool::AdminCap");

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] });
  const mint = await run("token_faucet::faucet (mint 1000)", tx);
  const coin = created(mint, "::token::TOKEN");

  const le32 = (n: bigint) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return Array.from(b); };
  for (const [label, commitment] of [["deposit_and_register (1st)", tw.oldCommitment], ["deposit_and_register (2nd)", ww.commitment]] as const) {
    tx = new Transaction();
    const [c] = tx.splitCoins(tx.object(coin), [tx.pure.u64(DEPOSIT)]);
    tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [
      tx.object(pool), c, tx.pure.vector("u8", le32(commitment)), tx.object(CLOCK)] });
    await run(label, tx);
  }

  // ---- admin ops with 1-epoch timelock ------------------------------------------------------
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [
    tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", le32(tw.merkleRoot)), tx.object(CLOCK)] });
  await run("update_commitment_root (propose)", tx);

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [
    tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", wproof.vk), tx.object(CLOCK)] });
  await run("propose_withdraw_vk", tx);

  // Wait until the next epoch boundary + 1 full epoch so the timelocks and maturity have elapsed.
  const waitMs = EPOCH_MS - (Date.now() % EPOCH_MS) + EPOCH_MS + 3000;
  console.log(`[wait] ${Math.round(waitMs / 1000)} s for timelocks / maturity (epoch = ${EPOCH_MS} ms)`);
  await sleep(waitMs);

  // ---- shielded_transfer (epochId must match chain epoch) -----------------------------------
  const chainEpoch = BigInt(Math.floor(Date.now() / EPOCH_MS));
  const tproof = proofs(chainEpoch).transfer;
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [
    tx.object(pool), tx.pure.vector("u8", tproof.proof), tx.pure.vector("u8", tproof.inputs), tx.object(CLOCK)] });
  await run("shielded_transfer (Groth16, 7 inputs)", tx);

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [
    tx.object(pool), tx.pure.vector("u8", wproof.proof), tx.pure.vector("u8", wproof.inputs),
    tx.pure.address("0x" + ww.recipient.toString(16).padStart(64, "0")), tx.object(CLOCK)] });
  await run("zk_withdraw (Groth16, 5 inputs)", tx);

  // ---- computation bracket: N x Groth16 primitives in ONE transaction ------------------------
  // Every entry point above lands in the minimum computation bucket, so a single verify cannot be
  // resolved. Calling the same sui::groth16 sequence N times per PTB pushes the bill through the
  // bucket boundaries and brackets the per-call cost. (gas-probe/ is a bench-only wrapper package.)
  const pb = JSON.parse(execSync("sui move build --dump-bytecode-as-base64 --no-tree-shaking", {
    cwd: join(__dirname, "gas-probe"), encoding: "utf-8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"],
  }).trim().split("\n").pop()!);
  tx = new Transaction();
  const pcap = tx.publish({ modules: pb.modules, dependencies: pb.dependencies });
  tx.transferObjects([pcap], me);
  const ppub = await run("publish (gas-probe, bench only)", tx);
  const ppkg = ppub.objectChanges!.find((c: any) => c.type === "published")!.packageId as string;
  const probeRows: { fn: string; circuit: string; n: number; computation: number }[] = [];
  for (const [circuit, d] of [["transfer (7 inputs)", p0.transfer], ["withdraw (5 inputs)", p0.withdraw]] as const) {
    for (const fn of ["noop", "prepare_only", "verify_full"]) {
      for (const n of [1, 5, 10, 25, 50, 100]) {
        if (fn === "prepare_only" && circuit.startsWith("withdraw")) continue;
        tx = new Transaction();
        for (let i = 0; i < n; i++) {
          const args = fn === "prepare_only"
            ? [tx.pure.vector("u8", d.vk)]
            : [tx.pure.vector("u8", d.vk), tx.pure.vector("u8", d.proof), tx.pure.vector("u8", d.inputs)];
          tx.moveCall({ target: `${ppkg}::probe::${fn}`, arguments: args });
        }
        const before = rows.length;
        await run(`probe ${fn} x${n} [${circuit}]`, tx);
        probeRows.push({ fn, circuit, n, computation: rows[before].computation });
      }
    }
  }

  console.log("\n| Entry point | computation | storage | rebate | net (MIST) |\n|---|---|---|---|---|");
  for (const r of rows.filter((x) => !x.op.startsWith("probe "))) console.log(`| ${r.op} | ${r.computation} | ${r.storage} | ${r.rebate} | ${r.net} |`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ rows, probeRows }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

