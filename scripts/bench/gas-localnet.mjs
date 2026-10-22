#!/usr/bin/env node
/**
 * gas-localnet.mjs — On-chain gas per Veil entry point, measured on a local Sui network with
 * REAL Groth16 proofs (no mocked verifier).
 *
 * Usage:
 *   sui start --force-regenesis --with-faucet &        # in another shell (CLI >= the framework rev in contracts/Move.lock)
 *   node scripts/bench/gas-localnet.mjs [--out gas-results.json]
 *
 * Env: SUI_BIN (default "sui"), RPC_URL (default http://127.0.0.1:9000),
 *      FAUCET_URL (default http://127.0.0.1:9123).
 * Prerequisite: circuits built per prove-latency.mjs's header (wasm + zkey + vk for all three circuits).
 *
 * Gas fields are straight from effects.gasUsed. "net" = computation + storage - rebate (MIST).
 * Reference gas price on localnet is 1000 MIST/unit, so computation MIST / 1000 = computation units.
 * Epoch length is the pool minimum (60 s), so the script spends ~2 minutes waiting for epochs
 * (timelocks + commitment maturity are enforced by the contract and are not bypassed).
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes, bigintToLE32 } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");
const SUI = process.env.SUI_BIN || "sui";
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:9000";
const FAUCET_URL = process.env.FAUCET_URL || "http://127.0.0.1:9123";
const OUT = (() => { const i = process.argv.indexOf("--out"); return i !== -1 ? process.argv[i + 1] : null; })();
const EPOCH_MS = 60_000;
const CLOCK = "0x6";
const GAS_BUDGET = 2_000_000_000n;
const DENOM_SMALL = 100_000_000n;

const client = new SuiJsonRpcClient({ url: RPC_URL, network: "localnet" });
const kp = Ed25519Keypair.generate();
const me = kp.toSuiAddress();
const rows = [];

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exec(label, build, { expectFail = false } = {}) {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);
  const r = await client.signAndExecuteTransaction({ transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true } });
  await client.waitForTransaction({ digest: r.digest });
  const ok = r.effects.status.status === "success";
  if (ok === expectFail) throw new Error(`${label}: unexpected status ${JSON.stringify(r.effects.status)}`);
  const g = r.effects.gasUsed;
  const comp = BigInt(g.computationCost), stor = BigInt(g.storageCost), reb = BigInt(g.storageRebate);
  rows.push({ label, computation: comp.toString(), storage: stor.toString(), rebate: reb.toString(), net: (comp + stor - reb).toString(), computationUnits: Number(comp / 1000n) });
  console.log(`${label.padEnd(34)} computation=${comp} storage=${stor} rebate=${reb} net=${comp + stor - reb}`);
  return r;
}

async function chainEpoch() {
  const o = await client.getObject({ id: CLOCK, options: { showContent: true } });
  return Math.floor(Number(o.data.content.fields.timestamp_ms) / EPOCH_MS);
}
async function waitForEpoch(target) {
  for (;;) {
    const e = await chainEpoch();
    if (e >= target) return e;
    await sleep(2000);
  }
}
const created = (r, frag) => r.objectChanges.find((c) => c.type === "created" && c.objectType.includes(frag))?.objectId;

async function loadCircuit(name, dir) {
  const b = join(CIRCUITS, dir);
  return { wasm: join(b, `${name}_js`, `${name}.wasm`), zkey: join(b, `${name}_final.zkey`), vk: JSON.parse(readFileSync(join(b, `${name}_vk.json`), "utf8")) };
}
async function prove(c, inputs) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInputs(inputs), c.wasm, c.zkey);
  if (!(await snarkjs.groth16.verify(c.vk, publicSignals, proof))) throw new Error("local verify failed");
  return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals) };
}
const vec = (tx, b) => tx.pure.vector("u8", Array.from(b));

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const C = { transfer: await loadCircuit("transfer", "build"), withdraw: await loadCircuit("withdraw", "build-withdraw"), compliance: await loadCircuit("compliance", "build-compliance") };
  const vkT = vkToSuiBytes(C.transfer.vk), vkW = vkToSuiBytes(C.withdraw.vk), vkC = vkToSuiBytes(C.compliance.vk);

  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: me });
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: me });
  await sleep(3000);

  // --- publish ---
  const built = JSON.parse(execFileSync(SUI, ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", join(ROOT, "contracts")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const pub = await exec("publish (package)", (tx) => {
    const [cap] = tx.publish({ modules: built.modules, dependencies: built.dependencies });
    tx.transferObjects([cap], me);
  });
  const pkg = pub.objectChanges.find((c) => c.type === "published").packageId;
  const treasury = created(pub, "::coin::TreasuryCap");

  // Witness material is built once up-front so commitment bytes can be registered by deposits.
  const epoch0 = await chainEpoch();
  const tw = WITNESS_BUILDERS.transfer(poseidon, { epochId: BigInt(epoch0) });
  const ww = WITNESS_BUILDERS.withdraw(poseidon);
  const cwDefault = WITNESS_BUILDERS.compliance(poseidon, { currentEpoch: BigInt(epoch0), expiryEpoch: 100_000_000n });

  async function mint() {
    const r = await exec("token_faucet::faucet", (tx) => tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] }));
    return created(r, "::token::TOKEN");
  }
  async function mkPool(tag) {
    const r = await exec(`create_pool (${tag})`, (tx) => tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [vec(tx, vkT), tx.pure.u64(1_000_000_000n), tx.pure.u64(EPOCH_MS)] }));
    return { pool: created(r, "::pool::Pool"), cap: created(r, "::pool::AdminCap") };
  }
  async function deposit(pool, coinId, commitment, split) {
    return exec(`deposit_and_register${split ? " (100-unit denom)" : ""}`, (tx) => {
      const coin = split ? tx.splitCoins(tx.object(coinId), [tx.pure.u64(DENOM_SMALL)])[0] : tx.object(coinId);
      tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [tx.object(pool), coin, vec(tx, commitment), tx.object(CLOCK)] });
    });
  }

  // --- Pool A: shielded_transfer + zk_withdraw ---
  const A = await mkPool("A");
  await deposit(A.pool, await mint(), bigintToLE32(tw.oldCommitment), false);
  await deposit(A.pool, await mint(), bigintToLE32(ww.commitment), true);
  await exec("update_commitment_root (propose)", (tx) => tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [tx.object(A.pool), tx.object(A.cap), vec(tx, bigintToLE32(tw.merkleRoot)), tx.object(CLOCK)] }));
  await exec("propose_withdraw_vk", (tx) => tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [tx.object(A.pool), tx.object(A.cap), vec(tx, vkW), tx.object(CLOCK)] }));

  // --- Pool B: compliant_transfer ---
  const B = await mkPool("B");
  await deposit(B.pool, await mint(), bigintToLE32(tw.oldCommitment), false);
  await exec("update_commitment_root (propose)", (tx) => tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [tx.object(B.pool), tx.object(B.cap), vec(tx, bigintToLE32(tw.merkleRoot)), tx.object(CLOCK)] }));
  const cfgTx = await exec("create_compliance_config", (tx) => tx.moveCall({ target: `${pkg}::compliance::create_compliance_config`, arguments: [tx.object(B.cap), tx.object(B.pool), vec(tx, vkC), vec(tx, bigintToLE32(cwDefault.merkleRoot)), tx.pure.u64(1n), vec(tx, new Uint8Array(33).fill(2))] }));
  const cfg = created(cfgTx, "::compliance::ComplianceConfig");

  // Cheap admin ops that don't need to wait
  await exec("freeze_pool", (tx) => tx.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [tx.object(B.pool), tx.object(B.cap), tx.object(CLOCK)] }));
  await exec("unfreeze_pool", (tx) => tx.moveCall({ target: `${pkg}::pool::unfreeze_pool`, arguments: [tx.object(B.pool), tx.object(B.cap)] }));

  // Wait out the 1-epoch timelocks + commitment maturity.
  const target = (await chainEpoch()) + 1;
  console.log(`\nwaiting for epoch ${target} (timelocks + maturity)...`);
  const ep = await waitForEpoch(target);
  await sleep(1500);
  console.log(`epoch now ${ep}\n`);

  // Proofs are generated for the *current* epoch (contract accepts current or previous).
  const tw2 = WITNESS_BUILDERS.transfer(poseidon, { epochId: BigInt(ep) });
  const cw2 = WITNESS_BUILDERS.compliance(poseidon, { currentEpoch: BigInt(ep), expiryEpoch: 100_000_000n });
  const pT = await prove(C.transfer, tw2);
  const pW = await prove(C.withdraw, ww);
  const pC = await prove(C.compliance, cw2);
  const pT2 = pT; // same witness shape; pools are independent so the nullifier does not collide

  await exec("shielded_transfer", (tx) => tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(A.pool), vec(tx, pT.proof), vec(tx, pT.inputs), tx.object(CLOCK)] }));
  const recip = "0x" + ww.recipient.toString(16).padStart(64, "0");
  await exec("zk_withdraw", (tx) => tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(A.pool), vec(tx, pW.proof), vec(tx, pW.inputs), tx.pure.address(recip), tx.object(CLOCK)] }));
  await exec("compliant_transfer (2 proofs)", (tx) => tx.moveCall({ target: `${pkg}::compliance::compliant_transfer`, arguments: [tx.object(B.pool), tx.object(cfg), vec(tx, pT2.proof), vec(tx, pT2.inputs), vec(tx, pC.proof), vec(tx, pC.inputs), vec(tx, new Uint8Array(110).fill(7)), tx.object(CLOCK)] }));

  // Negative control: replay must be rejected (gas still charged — informative for DoS cost).
  try {
    await exec("shielded_transfer REPLAY (aborts)", (tx) => tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(A.pool), vec(tx, pT.proof), vec(tx, pT.inputs), tx.object(CLOCK)] }), { expectFail: true });
  } catch (e) {
    console.log("replay:", String(e.message).slice(0, 160));
  }

  console.log("\n| Entry point | computation (MIST) | computation units | storage | rebate | net (MIST) |\n|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.label} | ${r.computation} | ${r.computationUnits} | ${r.storage} | ${r.rebate} | ${r.net} |`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ sui: execFileSync(SUI, ["--version"], { encoding: "utf8" }).trim(), rows }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
