/**
 * gas-bench.mjs — On-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Every number printed here comes from `effects.gasUsed` of a transaction that was actually
 * executed (or dry-run) against a real Sui validator started with `sui start --force-regenesis`.
 * Nothing is estimated.
 *
 * Prerequisites (see docs/research/2026-10-14-onchain-gas-baseline.md for the exact setup):
 *   - `sui` CLI whose version matches the framework rev pinned in contracts/Move.toml (1.72.1)
 *   - a local network:  SUI_CONFIG_DIR=<dir> sui start --force-regenesis --with-faucet
 *   - compiled circuits in circuits/build, build-withdraw (see circuits/scripts/compile*.sh)
 *   - `npm install` in scripts/bench
 *
 * Usage:  node scripts/bench/gas-bench.mjs [--sui <path-to-sui>] [--rpc http://127.0.0.1:9000]
 *                                          [--faucet http://127.0.0.1:9123/v2/gas] [--json out.json]
 *
 * Takes ~2.5 minutes: the pool's minimum epoch is 60 s and two timelocks (commitment-root update,
 * withdraw-VK update) each need one full epoch to elapse before the contract accepts them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";
import { buildTransferWitness, buildWithdrawWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SUI = arg("sui", "sui");
const RPC = arg("rpc", "http://127.0.0.1:9000");
const FAUCET = arg("faucet", "http://127.0.0.1:9123/v2/gas");
const JSON_OUT = arg("json", null);

const EPOCH_MS = 60_000; // pool minimum (create_pool asserts >= 60_000)
const THRESHOLD = 1_000_000_000n;
const CLOCK = "0x6";
const DENOM_LARGE = 1_000_000_000n;
const BUDGET = 500_000_000n;

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const kp = new Ed25519Keypair();
const me = kp.toSuiAddress();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];

function gasRow(label, effects, extra = {}) {
  const g = effects.gasUsed;
  const row = {
    label,
    status: effects.status.status + (effects.status.error ? ` (${effects.status.error.slice(0, 60)})` : ""),
    computationCost: Number(g.computationCost),
    storageCost: Number(g.storageCost),
    storageRebate: Number(g.storageRebate),
    nonRefundableStorageFee: Number(g.nonRefundableStorageFee),
    net: Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate),
    ...extra,
  };
  rows.push(row);
  console.log(`[gas] ${label.padEnd(52)} comp=${row.computationCost} stor=${row.storageCost} rebate=${row.storageRebate} net=${row.net}  ${row.status}`);
  return row;
}

async function exec(label, tx, opts = {}) {
  tx.setSender(me);
  tx.setGasBudget(BUDGET);
  const res = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  gasRow(label, res.effects, { digest: res.digest, ...opts });
  return res;
}

/** Dry-run (no state change) — used for aborting variants so we can repeat them freely. */
async function dry(label, tx, opts = {}) {
  tx.setSender(me);
  tx.setGasBudget(BUDGET);
  const bytes = await tx.build({ client });
  const res = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  gasRow(label, res.effects, { dryRun: true, ...opts });
  return res;
}

const created = (res, frag) => res.objectChanges.find((c) => c.type === "created" && c.objectType?.includes(frag));
const bytesArg = (tx, u8) => tx.pure.vector("u8", Array.from(u8));

async function faucet() {
  const r = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ FixedAmountRequest: { recipient: me } }) });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${await r.text()}`);
  for (let i = 0; i < 20; i++) {
    const b = await client.getBalance({ owner: me });
    if (BigInt(b.totalBalance) > 0n) return;
    await sleep(500);
  }
  throw new Error("faucet funds never arrived");
}

async function proveWith(circuit, buildDir, witness) {
  const input = stringifyInputs(witness);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input, join(ROOT, "circuits", buildDir, `${circuit}_js`, `${circuit}.wasm`),
    join(ROOT, "circuits", buildDir, `${circuit}_final.zkey`));
  const vk = JSON.parse(readFileSync(join(ROOT, "circuits", buildDir, `${circuit}_vk.json`), "utf8"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("local verify failed");
  return { proofBytes: proofToSuiBytes(proof), inputsBytes: publicInputsToSuiBytes(publicSignals), vkBytes: vkToSuiBytes(vk) };
}

async function chainEpoch() {
  const o = await client.getObject({ id: CLOCK, options: { showContent: true } });
  return Math.floor(Number(o.data.content.fields.timestamp_ms) / EPOCH_MS);
}
async function waitForEpochAfter(e) {
  while ((await chainEpoch()) <= e) await sleep(2000);
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  console.log(`sui CLI: ${execFileSync(SUI, ["--version"], { encoding: "utf8" }).trim()}`);
  const rgp = BigInt(await client.getReferenceGasPrice());
  console.log(`reference gas price: ${rgp} MIST/unit  (computation units = computationCost / ${rgp})`);

  await faucet();

  // ── publish ──────────────────────────────────────────────────────────────
  const built = JSON.parse(execFileSync(SUI, ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", join(ROOT, "contracts")],
    { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }));
  const pubTx = new Transaction();
  const [upg] = pubTx.publish({ modules: built.modules, dependencies: built.dependencies });
  pubTx.transferObjects([upg], me);
  const pub = await exec("publish (6 modules)", pubTx);
  const pkg = pub.objectChanges.find((c) => c.type === "published").packageId;
  const treasury = created(pub, "::coin::TreasuryCap").objectId;

  // ── witnesses + proofs (artifacts for the pool VKs) ──────────────────────
  // Real witnesses are built after the timelock waits (epoch input); VKs are needed now.
  const vkTransfer = vkToSuiBytes(JSON.parse(readFileSync(join(ROOT, "circuits/build/transfer_vk.json"), "utf8")));
  const vkWithdraw = vkToSuiBytes(JSON.parse(readFileSync(join(ROOT, "circuits/build-withdraw/withdraw_vk.json"), "utf8")));
  console.log(`transfer VK: ${vkTransfer.length} B, withdraw VK: ${vkWithdraw.length} B`);

  // Transfer witness (also gives us the commitments to deposit and the Merkle root to publish)
  const tw0 = buildTransferWitness(poseidon);
  const ww0 = buildWithdrawWitness(poseidon);
  const le32 = (n) => { const b = new Uint8Array(32); let v = BigInt(n); for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };

  // ── create_pool ──────────────────────────────────────────────────────────
  let tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [bytesArg(tx, vkTransfer), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
  const cp = await exec(`create_pool (transfer VK ${vkTransfer.length} B)`, tx);
  const pool = created(cp, "::pool::Pool").objectId;
  const adminCap = created(cp, "::pool::AdminCap").objectId;

  // ── mint + deposits (2 commitments: transfer-old, withdraw-old; a 3rd is added for the recipient probe) ─
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] });
  const mint = await exec("token_faucet::faucet (mint 1000 VEIL)", tx);
  let coin = created(mint, "::token::TOKEN").objectId;

  const commitments = [tw0.oldCommitment, ww0.commitment];
  for (let i = 0; i < commitments.length; i++) {
    tx = new Transaction();
    // split a standard 1000-VEIL denomination out of a freshly minted coin each time
    if (i > 0) {
      const m = new Transaction();
      m.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [m.object(treasury)] });
      const r = await exec(`token_faucet::faucet #${i + 1}`, m);
      coin = created(r, "::token::TOKEN").objectId;
      tx = new Transaction();
    }
    tx.moveCall({ target: `${pkg}::pool::deposit_and_register`,
      arguments: [tx.object(pool), tx.object(coin), bytesArg(tx, le32(commitments[i])), tx.object(CLOCK)] });
    await exec(`deposit_and_register #${i + 1} (pool has ${i} commitments)`, tx);
  }
  const depositEpoch = await chainEpoch();

  // ── timelocked setup: commitment root + withdraw VK ──────────────────────
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::update_commitment_root`,
    arguments: [tx.object(pool), tx.object(adminCap), bytesArg(tx, le32(tw0.merkleRoot)), tx.object(CLOCK)] });
  await exec("update_commitment_root (propose, 32 B)", tx);
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`,
    arguments: [tx.object(pool), tx.object(adminCap), bytesArg(tx, vkWithdraw), tx.object(CLOCK)] });
  await exec(`propose_withdraw_vk (${vkWithdraw.length} B)`, tx);

  console.log(`waiting for epoch > ${depositEpoch} (epoch = ${EPOCH_MS / 1000}s) so the timelocks and commitment maturity elapse...`);
  await waitForEpochAfter(depositEpoch);
  // The root becomes effective lazily inside the next transfer; make sure we're past it.
  const epochNow = await chainEpoch();

  // ── proofs for the live epoch ────────────────────────────────────────────
  const tw = { ...tw0, epochId: BigInt(epochNow) };
  // nullifier depends on epochId — recompute
  const DOMAIN_NULLIFIER = 2n;
  const toBI = (v) => (typeof v === "bigint" ? v : poseidon.F.toObject(v));
  tw.nullifier = toBI(poseidon([DOMAIN_NULLIFIER, tw.userSecret, tw.epochId, tw.randomnessOld]));
  const tProof = await proveWith("transfer", "build", tw);
  const wProof = await proveWith("withdraw", "build-withdraw", ww0);

  const withdrawTarget = Ed25519Keypair.generate().toSuiAddress();

  // ── aborting variants (dry-run, repeatable) to isolate the verification cost ──
  const mkTransfer = (proofBytes, inputsBytes) => {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::shielded_transfer`,
      arguments: [t.object(pool), bytesArg(t, proofBytes), bytesArg(t, inputsBytes), t.object(CLOCK)] });
    return t;
  };
  // (a) abort BEFORE the pairing check: threshold public input != pool threshold
  const badThreshold = Uint8Array.from(tProof.inputsBytes); badThreshold[64] ^= 1;
  await dry("shielded_transfer abort: threshold mismatch (pre-verify)", mkTransfer(tProof.proofBytes, badThreshold));
  // (b) abort AFTER the full prepare_vk + pairing check: valid-length inputs, tampered txAmountHash
  const badHash = Uint8Array.from(tProof.inputsBytes); badHash[160] ^= 1;
  await dry("shielded_transfer abort: bad proof (post-verify)", mkTransfer(tProof.proofBytes, badHash));
  // (c) success path, dry-run
  await dry("shielded_transfer SUCCESS (dry-run)", mkTransfer(tProof.proofBytes, tProof.inputsBytes));

  // ── real executions ──────────────────────────────────────────────────────
  const tr = await exec("shielded_transfer SUCCESS", mkTransfer(tProof.proofBytes, tProof.inputsBytes));
  if (tr.effects.status.status !== "success") throw new Error("shielded_transfer failed: " + JSON.stringify(tr.effects.status));
  // replay is rejected (sanity): old commitment consumed
  await dry("shielded_transfer replay (rejected)", mkTransfer(tProof.proofBytes, tProof.inputsBytes));

  const mkWithdraw = (proofBytes, inputsBytes, recipient) => {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::zk_withdraw`,
      arguments: [t.object(pool), bytesArg(t, proofBytes), bytesArg(t, inputsBytes), t.pure.address(recipient), t.object(CLOCK)] });
    return t;
  };
  const badW = Uint8Array.from(wProof.inputsBytes); badW[32] ^= 1; // withdrawAmount tampered → proof invalid
  await dry("zk_withdraw abort: bad proof (post-verify)", mkWithdraw(wProof.proofBytes, badW, withdrawTarget));
  const wr = await exec("zk_withdraw SUCCESS", mkWithdraw(wProof.proofBytes, wProof.inputsBytes, withdrawTarget));
  if (wr.effects.status.status !== "success") throw new Error("zk_withdraw failed: " + JSON.stringify(wr.effects.status));

  // ── side probe: is the withdraw recipient actually bound to the proof? ──────
  // Proof for a fresh 3rd commitment is generated for recipient field element R_proof; we submit it
  // with an UNRELATED on-chain address. If the call succeeds, the contract does not check
  // recipientHash == Poseidon(8, recipient), so a mempool observer can redirect the funds.
  const DOMAIN_COMMITMENT = 1n, DOMAIN_WITHDRAW_NULLIFIER = 7n, DOMAIN_RECIPIENT_HASH = 8n;
  const cumulativeOld = 500n, randomnessOld = 424242n, userSecret = 1357911n, amount = 100n, randomnessNew = 5555n;
  const recipientProof = 0x1111111111n; // what the prover committed to
  const c3 = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] });
  const m4 = await exec("token_faucet::faucet #4 (probe)", tx);
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::deposit_and_register`,
    arguments: [tx.object(pool), tx.object(created(m4, "::token::TOKEN").objectId), bytesArg(tx, le32(c3)), tx.object(CLOCK)] });
  const probeDepEpoch = await chainEpoch();
  await exec("deposit_and_register (probe commitment)", tx);
  await waitForEpochAfter(probeDepEpoch);
  const pw = {
    commitment: c3, withdrawAmount: amount,
    nullifier: toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld])),
    recipientHash: toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipientProof])),
    newCommitment: toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld - amount, randomnessNew, userSecret])),
    cumulativeOld, randomnessOld, userSecret, recipient: recipientProof, randomnessNew,
  };
  const pProof = await proveWith("withdraw", "build-withdraw", pw);
  const attacker = Ed25519Keypair.generate().toSuiAddress();
  const probe = await exec("zk_withdraw with ATTACKER recipient (proof bound to other recipient)", mkWithdraw(pProof.proofBytes, pProof.inputsBytes, attacker));
  const attackerCoins = await client.getCoins({ owner: attacker, coinType: `${pkg}::token::TOKEN` });
  console.log(`[probe] tx status = ${probe.effects.status.status}; attacker-address token coins = ${attackerCoins.data.length} (balance ${attackerCoins.data.map((c) => c.balance).join(",") || "0"})`);

  const out = { sui: execFileSync(SUI, ["--version"], { encoding: "utf8" }).trim(), referenceGasPrice: Number(rgp), rows,
    recipientBindingProbe: { txStatus: probe.effects.status.status, attackerCoins: attackerCoins.data.map((c) => c.balance) } };
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log("\n=== SUMMARY (gas units = cost / RGP) ===");
  for (const r of rows) console.log(`${r.label.padEnd(66)} comp_units=${(r.computationCost / Number(rgp)).toFixed(0).padStart(6)}  storage=${String(r.storageCost).padStart(9)}  rebate=${String(r.storageRebate).padStart(9)}  net_MIST=${String(r.net).padStart(10)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
