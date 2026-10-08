/**
 * onchain-gas.ts — measures real on-chain gas per Veil entry point on a local Sui network.
 *
 * Flow: publish the package, create a pool, mint + deposit two genesis commitments, schedule the
 * commitment root and withdraw VK (1-epoch timelock), wait for the pool epoch to roll over, then
 * submit a REAL Groth16 shielded_transfer and zk_withdraw. Every transaction's gasUsed (computation,
 * storage, rebate) is printed raw and as a JSON summary.
 *
 * Usage (from repo root):
 *   sui start --force-regenesis --with-faucet &        # localnet on :9000, faucet on :9123
 *   (cd circuits && bash scripts/compile.sh && bash scripts/compile-withdraw.sh)   # artifacts
 *   bun run scripts/bench/onchain-gas.ts [--sui /path/to/sui]
 *
 * The package is built with `sui move build --dump-bytecode-as-base64` and published through the
 * SDK, so no `sui client` config is needed. Requires scripts/node_modules (bun install in scripts/).
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

import {
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "../src/proof-converter.ts";
import { buildTransferWitness, buildWithdrawWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");
const RPC = process.env.SUI_RPC ?? "http://127.0.0.1:9000";
const FAUCET = process.env.SUI_FAUCET ?? "http://127.0.0.1:9123";
const SUI_BIN = (() => {
  const i = process.argv.indexOf("--sui");
  return i !== -1 ? process.argv[i + 1] : "sui";
})();
const CLOCK = "0x6";
const EPOCH_MS = 60_000; // contract minimum
const THRESHOLD = 1_000_000_000n;
const DENOM_SMALL = 100_000_000n;
const BUDGET = 500_000_000;

type GasRow = { op: string; computation: number; storage: number; rebate: number; net: number; digest: string };
const rows: GasRow[] = [];

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" as never });
const kp = new Ed25519Keypair();
const me = kp.toSuiAddress();

async function run(op: string, tx: Transaction, opts: { expectFail?: boolean } = {}) {
  tx.setGasBudget(BUDGET);
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const eff = res.effects!;
  const ok = eff.status.status === "success";
  if (ok === !!opts.expectFail) throw new Error(`${op}: unexpected status ${JSON.stringify(eff.status)}`);
  const g = eff.gasUsed;
  const row = {
    op,
    computation: Number(g.computationCost),
    storage: Number(g.storageCost),
    rebate: Number(g.storageRebate),
    net: Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate),
    digest: res.digest,
  };
  rows.push(row);
  console.log(`[gas] ${op}: ${JSON.stringify(g)} status=${eff.status.status}`);
  return res;
}

const created = (res: any, frag: string) =>
  res.objectChanges.find((c: any) => c.type === "created" && c.objectType?.includes(frag))?.objectId as string;

function leBytes(n: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) { out.push(Number(n & 0xffn)); n >>= 8n; }
  return out;
}

async function main() {
  console.log(`=== Veil on-chain gas bench === rpc=${RPC} sui=${execFileSync(SUI_BIN, ["--version"]).toString().trim()}`);
  console.log(`reference gas price: ${await client.getReferenceGasPrice()}`);
  await requestSuiFromFaucetV2({ host: `${FAUCET}/v2/gas`, recipient: me });
  await requestSuiFromFaucetV2({ host: `${FAUCET}/v2/gas`, recipient: me });
  await new Promise((r) => setTimeout(r, 2000));

  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  // ---- publish
  const built = JSON.parse(
    execFileSync(SUI_BIN, ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", join(ROOT, "contracts")], {
      maxBuffer: 1 << 26,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString(),
  );
  const ptx = new Transaction();
  const [upg] = ptx.publish({ modules: built.modules, dependencies: built.dependencies });
  ptx.transferObjects([upg], me);
  const pub = await run("publish", ptx);
  const pkg = pub.objectChanges!.find((c: any) => c.type === "published")!.packageId;
  const treasury = created(pub, "TreasuryCap");

  // ---- create_pool (transfer VK)
  const tVk = vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, "build/transfer_vk.json"), "utf8")));
  const wVk = vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, "build-withdraw/withdraw_vk.json"), "utf8")));
  console.log(`transfer VK on-chain bytes: ${tVk.length}, withdraw VK bytes: ${wVk.length}`);
  const ctx = new Transaction();
  ctx.moveCall({
    target: `${pkg}::pool::create_pool`,
    arguments: [ctx.pure.vector("u8", Array.from(tVk)), ctx.pure.u64(THRESHOLD), ctx.pure.u64(EPOCH_MS)],
  });
  const cp = await run("create_pool", ctx);
  const pool = created(cp, "::pool::Pool");
  const cap = created(cp, "::pool::AdminCap");

  // ---- mint two denominations
  const mtx = new Transaction();
  mtx.moveCall({ target: `${pkg}::token::mint`, arguments: [mtx.object(treasury), mtx.pure.u64(DENOM_SMALL), mtx.pure.address(me)] });
  mtx.moveCall({ target: `${pkg}::token::mint`, arguments: [mtx.object(treasury), mtx.pure.u64(DENOM_SMALL), mtx.pure.address(me)] });
  const mint = await run("token::mint x2 (not a Veil entry point)", mtx);
  const coins = mint.objectChanges!.filter((c: any) => c.type === "created" && c.objectType?.includes("::token::TOKEN")).map((c: any) => c.objectId);

  // ---- witnesses use the pool epoch at proving time; commitments are epoch-independent
  const w0 = buildTransferWitness(poseidon);
  const ww = buildWithdrawWitness(poseidon);
  const deposit = async (label: string, coin: string, commitment: bigint) => {
    const t = new Transaction();
    t.moveCall({
      target: `${pkg}::pool::deposit_and_register`,
      arguments: [t.object(pool), t.object(coin), t.pure.vector("u8", leBytes(commitment)), t.object(CLOCK)],
    });
    return run(label, t);
  };
  await deposit("deposit_and_register (1st, 100 TOKEN)", coins[0], w0.oldCommitment);
  await deposit("deposit_and_register (2nd)", coins[1], ww.commitment);

  // ---- admin ops (timelocked)
  const rt = new Transaction();
  rt.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [rt.object(pool), rt.object(cap), rt.pure.vector("u8", leBytes(w0.merkleRoot)), rt.object(CLOCK)] });
  await run("update_commitment_root", rt);
  const vt = new Transaction();
  vt.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [vt.object(pool), vt.object(cap), vt.pure.vector("u8", Array.from(wVk)), vt.object(CLOCK)] });
  await run("propose_withdraw_vk", vt);

  // ---- wait for the next pool epoch boundary (+1.5s margin so chain clock has passed it)
  const waitMs = EPOCH_MS - (Date.now() % EPOCH_MS) + 1500;
  console.log(`waiting ${(waitMs / 1000).toFixed(1)}s for pool epoch rollover...`);
  await new Promise((r) => setTimeout(r, waitMs));
  const epoch = BigInt(Math.floor(Date.now() / EPOCH_MS));

  // ---- real shielded_transfer
  const tw = buildTransferWitness(poseidon, { epochId: epoch });
  const tp = await snarkjs.groth16.fullProve(
    stringifyInputs(tw), join(CIRCUITS, "build/transfer_js/transfer.wasm"), join(CIRCUITS, "build/transfer_final.zkey"));
  const tProof = proofToSuiBytes(tp.proof);
  const tPub = publicInputsToSuiBytes(tp.publicSignals);
  const st = new Transaction();
  st.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [st.object(pool), st.pure.vector("u8", Array.from(tProof)), st.pure.vector("u8", Array.from(tPub)), st.object(CLOCK)] });
  await run("shielded_transfer (1 Groth16 verify, 7 public inputs)", st);

  // ---- real zk_withdraw; recipient deliberately != the address baked into the witness
  const wp = await snarkjs.groth16.fullProve(
    stringifyInputs(ww), join(CIRCUITS, "build-withdraw/withdraw_js/withdraw.wasm"), join(CIRCUITS, "build-withdraw/withdraw_final.zkey"));
  const wProof = proofToSuiBytes(wp.proof);
  const wPub = publicInputsToSuiBytes(wp.publicSignals);
  const other = new Ed25519Keypair().toSuiAddress();
  const zw = new Transaction();
  zw.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [zw.object(pool), zw.pure.vector("u8", Array.from(wProof)), zw.pure.vector("u8", Array.from(wPub)), zw.pure.address(other), zw.object(CLOCK)] });
  await run("zk_withdraw (1 Groth16 verify, 5 public inputs)", zw);
  const bal = await client.getBalance({ owner: other, coinType: `${pkg}::token::TOKEN` });
  console.log(`[finding-check] zk_withdraw to an address NOT bound by the proof's recipientHash succeeded; recipient token balance = ${bal.totalBalance}`);

  // ---- failed-proof cost (what a spammer / honest-but-stale user pays): replay the spent transfer
  const rp = new Transaction();
  rp.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [rp.object(pool), rp.pure.vector("u8", Array.from(tProof)), rp.pure.vector("u8", Array.from(tPub)), rp.object(CLOCK)] });
  await run("shielded_transfer replay (aborts after proof verify)", rp, { expectFail: true });

  // ---- freeze / unfreeze
  const fz = new Transaction();
  fz.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [fz.object(pool), fz.object(cap), fz.object(CLOCK)] });
  await run("freeze_pool", fz);
  const uf = new Transaction();
  uf.moveCall({ target: `${pkg}::pool::unfreeze_pool`, arguments: [uf.object(pool), uf.object(cap)] });
  await run("unfreeze_pool", uf);

  console.log("\n=== SUMMARY (MIST) ===");
  console.table(rows.map(({ digest, ...r }) => r));
  console.log("JSON:" + JSON.stringify(rows));
}

main().then(() => process.exit(0), (e) => { console.error("[FATAL]", e); process.exit(1); });
