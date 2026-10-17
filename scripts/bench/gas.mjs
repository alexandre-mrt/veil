#!/usr/bin/env node
/**
 * gas.mjs — On-chain gas per Veil entry point, measured on a local Sui network with REAL Groth16
 * proofs (not mocks): publish, create_pool, deposit_and_register, admin timelock proposals,
 * shielded_transfer, compliant_transfer, zk_withdraw, plus the gas burned by a rejected proof.
 *
 * Usage:
 *   sui start --force-regenesis --with-faucet &        # local network, RPC :9000, faucet :9123
 *   node scripts/bench/gas.mjs [--rpc http://127.0.0.1:9000] [--faucet http://127.0.0.1:9123]
 *
 * Prerequisites: `bash scripts/bench/build-circuits.sh` (circuits/build*), `sui` CLI on PATH
 * (used only for `sui move build --dump-bytecode-as-base64`), `npm install` in scripts/bench.
 *
 * Gas is reported as the raw `effects.gasUsed` fields (MIST) plus computation *units*
 * (computationCost / reference gas price). Sui buckets computation into units; the floor is
 * 1000 units. net = computation + storage - storageRebate.
 *
 * Output: a human table on stdout and the raw per-tx records in scripts/bench/gas-results.json.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes, bigintToLE32 } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i === -1 ? d : process.argv[i + 1]; };
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123");
const EPOCH_MS = 60_000;               // pool epoch duration (contract minimum)
const THRESHOLD = 1_000_000_000n;
const CLOCK = "0x6";
const DEPOSIT = 100_000_000;           // DENOM_SMALL
const DEPTH = 20;

const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RCPT: 8n };

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const kp = new Ed25519Keypair();
const me = kp.toSuiAddress();
const records = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exec(label, tx, { expectFail = false } = {}) {
  tx.setSender(me);
  tx.setGasBudget(500_000_000);
  const r = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  const ok = r.effects.status.status === "success";
  if (ok === expectFail) throw new Error(`${label}: unexpected status ${JSON.stringify(r.effects.status)}`);
  const g = r.effects.gasUsed;
  const comp = Number(g.computationCost), sto = Number(g.storageCost), reb = Number(g.storageRebate);
  records.push({
    label, digest: r.digest, status: r.effects.status.status,
    computationCost: comp, storageCost: sto, storageRebate: reb,
    computationUnits: comp / 1000, net: comp + sto - reb,
    error: ok ? undefined : r.effects.status.error,
  });
  console.log(`${label.padEnd(44)} ${r.effects.status.status.padEnd(8)} comp=${comp} (${comp / 1000} units) storage=${sto} rebate=${reb} net=${comp + sto - reb}`);
  return r;
}

const findCreated = (r, frag) =>
  r.objectChanges.find((c) => c.type === "created" && c.objectType.includes(frag))?.objectId;

async function prove(circuit, dir, input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input, join(ROOT, "circuits", dir, `${circuit}_js`, `${circuit}.wasm`),
    join(ROOT, "circuits", dir, `${circuit}_final.zkey`));
  return { proofBytes: proofToSuiBytes(proof), inputBytes: publicInputsToSuiBytes(publicSignals) };
}
const vkBytes = (dir, c) => vkToSuiBytes(JSON.parse(readFileSync(join(ROOT, "circuits", dir, `${c}_vk.json`), "utf8")));
const vec = (tx, b) => tx.pure.vector("u8", Array.from(b));
const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (xs) => F.toObject(poseidon(xs));

  console.log(`sui ${execSync("sui --version").toString().trim()}  rpc=${RPC}  node ${process.version}`);
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await sleep(2000);

  // ---- publish ------------------------------------------------------------------------------
  const out = execSync("sui move build --dump-bytecode-as-base64 --no-tree-shaking", {
    cwd: join(ROOT, "contracts"), maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString();
  const built = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop());
  {
    const tx = new Transaction();
    const [cap] = tx.publish({ modules: built.modules, dependencies: built.dependencies });
    tx.transferObjects([cap], me);
    var pub = await exec("publish (veil package, 6 modules)", tx);
  }
  const pkg = pub.objectChanges.find((c) => c.type === "published").packageId;
  const treasury = findCreated(pub, "TreasuryCap");

  // ---- create_pool --------------------------------------------------------------------------
  const tvk = vkBytes("build", "transfer");
  let r;
  { const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [vec(tx, tvk), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
    r = await exec("pool::create_pool", tx); }
  const pool = findCreated(r, "::pool::Pool");
  const adminCap = findCreated(r, "::pool::AdminCap");

  // ---- tokens -------------------------------------------------------------------------------
  { const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] });
    r = await exec("token_faucet::faucet (mint 1000 VEIL)", tx); }
  const bigCoin = findCreated(r, "::token::TOKEN");

  // ---- three notes: two transfer leaves (same tree), one withdraw note ----------------------
  const secretA = 111111n, secretB = 222222n, secretW = 333333n;
  const commit = (cum, rnd, sec) => H([D.COMMIT, cum, rnd, sec]);
  const noteA = { cum: 0n, rnd: 1n, sec: secretA }, noteB = { cum: 0n, rnd: 2n, sec: secretB };
  const noteW = { cum: 500n, rnd: 3n, sec: secretW };
  const cA = commit(noteA.cum, noteA.rnd, noteA.sec), cB = commit(noteB.cum, noteB.rnd, noteB.sec);
  const cW = commit(noteW.cum, noteW.rnd, noteW.sec);
  // Merkle tree: leaves A (idx 0) and B (idx 1) are siblings; every other sibling is 0.
  let root = H([cA, cB]);
  for (let i = 1; i < DEPTH; i++) root = H([root, 0n]);
  const pathFor = (sib, idx) => ({ pathElements: [sib, ...Array(DEPTH - 1).fill(0n)], pathIndices: [idx, ...Array(DEPTH - 1).fill(0n)] });

  for (const [name, c] of [["A", cA], ["B", cB], ["W", cW]]) {
    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.object(bigCoin), [tx.pure.u64(DEPOSIT)]);
    tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [tx.object(pool), coin, vec(tx, bigintToLE32(c)), tx.object(CLOCK)] });
    await exec(`pool::deposit_and_register (note ${name}) [+splitCoins]`, tx);
  }

  // ---- admin: timelocked proposals + compliance config ------------------------------------
  { const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [tx.object(pool), tx.object(adminCap), vec(tx, bigintToLE32(root)), tx.object(CLOCK)] });
    await exec("pool::update_commitment_root (propose)", tx); }
  { const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [tx.object(pool), tx.object(adminCap), vec(tx, vkBytes("build-withdraw", "withdraw")), tx.object(CLOCK)] });
    await exec("pool::propose_withdraw_vk (propose)", tx); }

  // credential tree for the compliance proof: one leaf, zero siblings (mirrors witnesses.mjs)
  const credSecret = secretB, kyc = 2n, expiry = 4_000_000_000n, issuer = 42n;
  let credRoot = H([D.CRED, credSecret, kyc, expiry, issuer]);
  for (let i = 0; i < DEPTH; i++) credRoot = H([credRoot, 0n]);
  { const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::compliance::create_compliance_config`, arguments: [
      tx.object(adminCap), tx.object(pool), vec(tx, vkBytes("build-compliance", "compliance")),
      vec(tx, bigintToLE32(credRoot)), tx.pure.u64(1), vec(tx, new Uint8Array(33).fill(2))] });
    r = await exec("compliance::create_compliance_config", tx); }
  const config = findCreated(r, "::compliance::ComplianceConfig");

  // ---- wait for the epoch to roll (timelocks + commitment maturity) -----------------------
  const wait = EPOCH_MS - (Date.now() % EPOCH_MS) + 3000;
  console.log(`\nwaiting ${Math.round(wait / 1000)}s for the next ${EPOCH_MS / 1000}s epoch boundary...\n`);
  await sleep(wait);
  const epoch = BigInt(Math.floor(Date.now() / EPOCH_MS));

  // ---- proofs -------------------------------------------------------------------------------
  const transferInput = (note, cNote, cumNew, rndNew, path) => {
    const tx = 100n, salt = 99n;
    const newC = commit(cumNew, rndNew, note.sec);
    return { newC, nullifier: H([D.NULL, note.sec, epoch, note.rnd]), input: str({
      oldCommitment: cNote, newCommitment: newC, threshold: THRESHOLD, epochId: epoch,
      nullifier: H([D.NULL, note.sec, epoch, note.rnd]), txAmountHash: H([D.TXAMT, tx, salt]), merkleRoot: root,
      cumulativeOld: note.cum, cumulativeNew: cumNew, txAmount: tx, randomnessOld: note.rnd, randomnessNew: rndNew,
      userSecret: note.sec, salt, ...path }) };
  };
  const tA = transferInput(noteA, cA, 100n, 1001n, pathFor(cB, 0n));
  const tB = transferInput(noteB, cB, 100n, 1002n, pathFor(cA, 1n));
  const pA = await prove("transfer", "build", tA.input);
  const pB = await prove("transfer", "build", tB.input);

  const ctxId = H([D.CTX, tB.nullifier, credSecret]);
  const cpath = { pathElements: Array(DEPTH).fill(0n), pathIndices: Array(DEPTH).fill(0n) };
  const pC = await prove("compliance", "build-compliance", str({
    merkleRoot: credRoot, currentEpoch: epoch, contextId: ctxId, requiredKycLevel: 1n,
    nullifier: H([D.CNULL, credSecret, ctxId]), validCredential: 1n,
    userSecret: credSecret, kycLevel: kyc, expiryEpoch: expiry, issuerId: issuer, transferNullifier: tB.nullifier, ...cpath }));

  // withdraw: recipient field element bound into the proof is `hashedRecipient`; the tx sends
  // to `me`. (zk_withdraw does not compare the two — see the report.)
  const hashedRecipient = BigInt(me) % (2n ** 253n);
  const wNew = commit(noteW.cum - 100n, 3001n, noteW.sec);
  const pW = await prove("withdraw", "build-withdraw", str({
    commitment: cW, withdrawAmount: 100n, nullifier: H([D.WNULL, noteW.sec, noteW.rnd, noteW.cum]),
    recipientHash: H([D.RCPT, hashedRecipient]), newCommitment: wNew,
    cumulativeOld: noteW.cum, randomnessOld: noteW.rnd, userSecret: noteW.sec,
    recipient: hashedRecipient, randomnessNew: 3001n }));

  // ---- rejected proof: flip one public-input byte (nullifier) -----------------------------
  { const bad = Uint8Array.from(pA.inputBytes); bad[128] ^= 1;
    const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), vec(tx, pA.proofBytes), vec(tx, bad), tx.object(CLOCK)] });
    await exec("shielded_transfer (REJECTED: bad proof)", tx, { expectFail: true }); }

  // ---- the real thing ---------------------------------------------------------------------
  { const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), vec(tx, pA.proofBytes), vec(tx, pA.inputBytes), tx.object(CLOCK)] });
    await exec("pool::shielded_transfer", tx); }

  { const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::compliance::compliant_transfer`, arguments: [
      tx.object(pool), tx.object(config), vec(tx, pB.proofBytes), vec(tx, pB.inputBytes),
      vec(tx, pC.proofBytes), vec(tx, pC.inputBytes), vec(tx, new Uint8Array(93).fill(7)), tx.object(CLOCK)] });
    await exec("compliance::compliant_transfer (2 proofs)", tx); }

  { const tx = new Transaction();
    // Deliberately NOT the address hashed into the proof: tests whether the contract binds them.
    const thief = new Ed25519Keypair().toSuiAddress();
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [
      tx.object(pool), vec(tx, pW.proofBytes), vec(tx, pW.inputBytes), tx.pure.address(thief), tx.object(CLOCK)] });
    r = await exec("pool::zk_withdraw (recipient != proven one)", tx);
    const got = await client.getBalance({ owner: thief, coinType: `${pkg}::token::TOKEN` });
    console.log(`  -> unrelated address ${thief} received ${got.totalBalance} TOKEN units; tx status ${r.effects.status.status}`); }

  { const tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [tx.object(pool), tx.object(adminCap), tx.object(CLOCK)] });
    await exec("pool::freeze_pool", tx); }

  // ---- Groth16 marginal cost: N verifies of the same proof in ONE PTB ---------------------
  // Calls the framework's 0x2::groth16 directly (no Veil code, no state), so the slope of
  // computation units vs N is the cost of prepare_verifying_key / verify_groth16_proof alone.
  console.log("\n--- groth16 sweep (framework calls only) ---");
  const sweeps = [["transfer-vk(7 inputs)", tvk, pA], ["withdraw-vk(5 inputs)", vkBytes("build-withdraw", "withdraw"), pW]];
  for (const [vname, vk, pr] of sweeps) {
    for (const mode of ["prepare-each", "prepare-once"]) {
      for (const n of [1, 2, 4, 8, 16, 32, 64]) {
        const tx = new Transaction();
        const curve = tx.moveCall({ target: "0x2::groth16::bn254", arguments: [] });
        const proof = tx.moveCall({ target: "0x2::groth16::proof_points_from_bytes", arguments: [vec(tx, pr.proofBytes)] });
        const inputs = tx.moveCall({ target: "0x2::groth16::public_proof_inputs_from_bytes", arguments: [vec(tx, pr.inputBytes)] });
        const prep = () => tx.moveCall({ target: "0x2::groth16::prepare_verifying_key", arguments: [curve, vec(tx, vk)] });
        let pvk = mode === "prepare-once" ? prep() : null;
        for (let i = 0; i < n; i++) {
          tx.moveCall({ target: "0x2::groth16::verify_groth16_proof", arguments: [curve, pvk ?? prep(), inputs, proof] });
        }
        try { await exec(`groth16 ${vname} ${mode} N=${n}`, tx); }
        catch (e) { console.log(`groth16 ${vname} ${mode} N=${n}: ${String(e.message).slice(0, 160)}`); break; }
      }
    }
  }

  writeFileSync(join(__dirname, "gas-results.json"), JSON.stringify({ rpc: RPC, referenceGasPrice: 1000, records }, null, 2));
  console.log("\nraw records -> scripts/bench/gas-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
