#!/usr/bin/env bun
/**
 * gas-localnet.ts — On-chain gas per Veil entry point, measured with REAL Groth16 proofs on a
 * local Sui network (`sui start --force-regenesis --with-faucet`).
 *
 * Usage (from repo root, after compiling circuits/build + circuits/build-withdraw):
 *   sui start --force-regenesis --with-faucet &        # same CLI version as the Move framework rev
 *   cd scripts && bun run bench/gas-localnet.ts [--rpc http://127.0.0.1:9000] [--out gas.json]
 *
 * Publishes the contracts with a throwaway key, runs each entry point, and prints
 * computationCost / storageCost / storageRebate (MIST) from the transaction effects.
 * Takes ~3 minutes: the pool epoch is 60 s (the contract minimum) and commitment maturity,
 * the root update and the withdraw-VK update each wait one epoch.
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
// @ts-expect-error plain JS
import { buildTransferWitness, buildWithdrawWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123/v2/gas");
const OUT = arg("--out", "");
const EPOCH_MS = 60_000;
const CLOCK = "0x6";
const THRESHOLD = 1_000_000_000n;
const DENOM_SMALL = 100_000_000n;

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" } as any);
const kp = Ed25519Keypair.generate();
const me = kp.toSuiAddress();
const rows: any[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(label: string, tx: Transaction, extra: Record<string, unknown> = {}) {
  tx.setGasBudget(500_000_000);
  const r = await client.signAndExecuteTransaction({ transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true } });
  await client.waitForTransaction({ digest: r.digest });
  const status = r.effects!.status.status;
  const g = r.effects!.gasUsed;
  const row = {
    label, status, computationCost: +g.computationCost, storageCost: +g.storageCost,
    storageRebate: +g.storageRebate, net: +g.computationCost + +g.storageCost - +g.storageRebate,
    digest: r.digest, ...extra,
  };
  rows.push(row);
  console.log(`${label.padEnd(34)} ${status.padEnd(8)} comp=${g.computationCost} stor=${g.storageCost} rebate=${g.storageRebate} net=${row.net}`);
  if (status !== "success") console.log("   ", JSON.stringify(r.effects!.status));
  return r;
}

function hex32(n: bigint): Uint8Array {
  const b = new Uint8Array(32); let x = n; for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b;
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await sleep(3000);

  // ---- publish
  const build = JSON.parse(execSync(`sui move build --build-env testnet --dump-bytecode-as-base64 --path ${ROOT}/contracts 2>/dev/null`, { encoding: "utf-8", maxBuffer: 1 << 26 }));
  const ptx = new Transaction();
  const cap = ptx.publish({ modules: build.modules, dependencies: build.dependencies });
  ptx.transferObjects([cap], me);
  const pub = await run("publish (package + token init)", ptx, { moduleBytes: build.modules.reduce((a: number, m: string) => a + Buffer.from(m, "base64").length, 0) });
  const pkg = pub.objectChanges!.find((c: any) => c.type === "published")!.packageId;
  const treasury = pub.objectChanges!.find((c: any) => c.type === "created" && c.objectType.includes("TreasuryCap"))!.objectId;

  // ---- circuit artifacts
  const tVk = JSON.parse(readFileSync(`${ROOT}/circuits/build/transfer_vk.json`, "utf-8"));
  const wVk = JSON.parse(readFileSync(`${ROOT}/circuits/build-withdraw/withdraw_vk.json`, "utf-8"));

  // ---- create_pool
  const ctx = new Transaction();
  ctx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [ctx.pure.vector("u8", Array.from(vkToSuiBytes(tVk))), ctx.pure.u64(THRESHOLD), ctx.pure.u64(EPOCH_MS)] });
  const cp = await run("create_pool", ctx, { vkBytes: vkToSuiBytes(tVk).length });
  const pool = cp.objectChanges!.find((c: any) => c.type === "created" && c.objectType.endsWith("::pool::Pool"))!.objectId;
  const adminCap = cp.objectChanges!.find((c: any) => c.type === "created" && c.objectType.endsWith("::pool::AdminCap"))!.objectId;

  // ---- mint + split two standard-denomination coins
  const mtx = new Transaction();
  mtx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [mtx.object(treasury)] });
  const mint = await run("token_faucet::faucet (mint 1000)", mtx);
  const bigCoin = mint.objectChanges!.find((c: any) => c.type === "created" && c.objectType.includes("::token::TOKEN"))!.objectId;
  const stx = new Transaction();
  const parts = [1, 2, 3, 4, 5].map(() => 0);
  const coins = stx.splitCoins(stx.object(bigCoin), parts.map(() => stx.pure.u64(DENOM_SMALL)));
  stx.transferObjects(parts.map((_, i) => coins[i]), me);
  const split = await run("splitCoins x5 (setup, not Veil)", stx);
  const coinIds: string[] = split.objectChanges!.filter((c: any) => c.type === "created" && c.objectType.includes("::token::TOKEN")).map((c: any) => c.objectId);

  // ---- witnesses (epoch is only known now; proofs are generated after the maturity wait)
  const deposit = async (coinId: string, commitment: bigint, label: string) => {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [t.object(pool), t.object(coinId), t.pure.vector("u8", Array.from(hex32(commitment))), t.object(CLOCK)] });
    return run(label, t);
  };
  const probe = buildTransferWitness(poseidon, { epochId: 0n });
  const wd = buildWithdrawWitness(poseidon);
  await deposit(coinIds[0], probe.oldCommitment, "deposit_and_register #1 (first leaf)");
  await deposit(coinIds[1], wd.commitment, "deposit_and_register #2");
  await deposit(coinIds[2], 0xdead01n, "deposit_and_register #3");
  await deposit(coinIds[3], 0xdead02n, "deposit_and_register #4");

  // ---- timelocked admin ops (1 epoch)
  const rtx = new Transaction();
  rtx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [rtx.object(pool), rtx.object(adminCap), rtx.pure.vector("u8", Array.from(hex32(probe.merkleRoot))), rtx.object(CLOCK)] });
  await run("update_commitment_root (propose)", rtx);
  const vtx = new Transaction();
  vtx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [vtx.object(pool), vtx.object(adminCap), vtx.pure.vector("u8", Array.from(vkToSuiBytes(wVk))), vtx.object(CLOCK)] });
  await run("propose_withdraw_vk", vtx, { vkBytes: vkToSuiBytes(wVk).length });
  const ftx = new Transaction();
  ftx.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [ftx.object(pool), ftx.object(adminCap), ftx.object(CLOCK)] });
  await run("freeze_pool", ftx);
  const utx = new Transaction();
  utx.moveCall({ target: `${pkg}::pool::unfreeze_pool`, arguments: [utx.object(pool), utx.object(adminCap)] });
  await run("unfreeze_pool", utx);

  // ---- wait for the next epoch boundary
  const wait = EPOCH_MS - (Date.now() % EPOCH_MS) + 2000;
  console.log(`-- waiting ${Math.round(wait / 1000)}s for epoch boundary (commitment maturity + timelocks)`);
  await sleep(wait);
  const epoch = BigInt(Math.floor(Date.now() / EPOCH_MS));

  // ---- real proofs
    const prove = (kind: string, e: bigint) => JSON.parse(execSync(`node ${join(ROOT, "scripts", "bench", "prove-for-gas.mjs")} ${kind} ${e}`, { encoding: "utf-8", cwd: join(ROOT, "scripts"), maxBuffer: 1 << 24 }));
  const tp = prove("transfer", epoch);
  const wp = prove("withdraw", 0n);
  const tProof = proofToSuiBytes(tp.proof), tPub = publicInputsToSuiBytes(tp.publicSignals);
  const wProof = proofToSuiBytes(wp.proof), wPub = publicInputsToSuiBytes(wp.publicSignals);

  const st = new Transaction();
  st.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [st.object(pool), st.pure.vector("u8", Array.from(tProof)), st.pure.vector("u8", Array.from(tPub)), st.object(CLOCK)] });
  await run("shielded_transfer (real proof, 7 pub)", st, { proofBytes: tProof.length, publicInputBytes: tPub.length });

  const zt = new Transaction();
  zt.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [zt.object(pool), zt.pure.vector("u8", Array.from(wProof)), zt.pure.vector("u8", Array.from(wPub)), zt.pure.address(me), zt.object(CLOCK)] });
  await run("zk_withdraw (real proof, 5 pub)", zt, { proofBytes: wProof.length, publicInputBytes: wPub.length });

  // replay must be rejected (negative control; failed tx still pays computation gas)
  try {
    const rp = new Transaction();
    rp.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [rp.object(pool), rp.pure.vector("u8", Array.from(tProof)), rp.pure.vector("u8", Array.from(tPub)), rp.object(CLOCK)] });
    await run("shielded_transfer REPLAY (must fail)", rp);
  } catch (e) { console.log("replay rejected at dry-run:", String(e).slice(0, 160)); }

  const { rgp } = { rgp: await client.getReferenceGasPrice() };
  console.log(`\nreference gas price: ${rgp} MIST/unit`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ rgp: String(rgp), rows }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
