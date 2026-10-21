/**
 * gas.ts — On-chain gas benchmark for Veil's entry points, against a local Sui network.
 *
 * Publishes the real Move package, creates a pool with real Groth16 verification keys, then
 * submits real proofs (snarkjs, compiled circuits) through every proof-verifying entry point and
 * records effects.gasUsed for each transaction. Epoch is 60 s (the contract minimum), so the run
 * waits roughly one epoch for the commitment-maturity and VK timelocks. Takes ~3 minutes.
 *
 * Usage (from repo root):
 *   sui start --force-regenesis --with-faucet --epoch-duration-ms 3600000   # separate terminal
 *   bun run scripts/bench/gas.ts [--sui /path/to/sui] [--out gas-results.json]
 *
 * Prerequisites: circuit artifacts in circuits/build{,-withdraw,-compliance}/ (see
 * prove-latency.mjs header), `bun install` in scripts/.
 *
 * Gas is reported in MIST at the localnet reference gas price (printed). computationCost is
 * `gas units * reference price` (units bucketed by the protocol); storage numbers are
 * price-independent. net = computation + storage - rebate.
 */
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error snarkjs has no type declarations
import * as snarkjs from "snarkjs";
import { readFileSync } from "fs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes, bigintToLE32 } from "../src/proof-converter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : dflt;
};
const SUI = arg("--sui", "sui");
const OUT = arg("--out", join(ROOT, "scripts", "bench", "gas-results.json"));

const EPOCH_MS = 60_000;
const CLOCK = "0x6";
const THRESHOLD = 1_000_000_000n;
const DEPOSIT = 100_000_000n; // DENOM_SMALL
const DEPTH = 20;
const GAS_BUDGET = 500_000_000n;

const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("localnet"), network: "localnet" });
const kp = new Ed25519Keypair();
const me = kp.toSuiAddress();

interface Row { name: string; computation: number; storage: number; rebate: number; net: number; status: string }
const rows: Row[] = [];

async function exec(name: string, tx: Transaction) {
  tx.setGasBudget(GAS_BUDGET);
  const res = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const g = res.effects!.gasUsed;
  const row = {
    name,
    computation: Number(g.computationCost),
    storage: Number(g.storageCost),
    rebate: Number(g.storageRebate),
    net: Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate),
    status: res.effects!.status.status,
  };
  rows.push(row);
  console.log(`${name.padEnd(34)} ${row.status}  comp=${row.computation} storage=${row.storage} rebate=${row.rebate} net=${row.net}`);
  if (row.status !== "success") throw new Error(`${name} failed: ${JSON.stringify(res.effects!.status)}`);
  return res;
}

const created = (res: any, typeSub: string): string => {
  const c = res.objectChanges.find((o: any) => o.type === "created" && o.objectType?.includes(typeSub));
  if (!c) throw new Error(`no created object of type ${typeSub}`);
  return c.objectId;
};

const vec = (tx: Transaction, b: Uint8Array) => tx.pure.vector("u8", Array.from(b));
const epochNow = () => Math.floor(Date.now() / EPOCH_MS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (xs: bigint[]): bigint => F.toObject(poseidon(xs));

  console.log(`sui: ${execSync(`${SUI} --version`).toString().trim()}`);
  const rgp = await client.getReferenceGasPrice();
  console.log(`reference gas price: ${rgp} MIST/unit\n`);
  await requestSuiFromFaucetV2({ host: getFaucetHost("localnet"), recipient: me });
  await sleep(2000);

  // ---- artifacts / vks -------------------------------------------------------------------
  const art = (dir: string, n: string) => ({
    wasm: join(ROOT, "circuits", dir, `${n}_js`, `${n}.wasm`),
    zkey: join(ROOT, "circuits", dir, `${n}_final.zkey`),
    vk: vkToSuiBytes(JSON.parse(readFileSync(join(ROOT, "circuits", dir, `${n}_vk.json`), "utf-8"))),
  });
  const T = art("build", "transfer"), W = art("build-withdraw", "withdraw"), C = art("build-compliance", "compliance");

  // ---- witnesses -------------------------------------------------------------------------
  // Two genesis commitments in one real depth-20 tree so both transfers share the pool root.
  const secretA = 987654321n, secretB = 555555555n;
  const randOldA = 0n, randOldB = 0n; // genesis randomness
  const commit = (cum: bigint, rnd: bigint, sec: bigint) => H([1n, cum, rnd, sec]);
  const leafA = commit(0n, randOldA, secretA), leafB = commit(0n, randOldB, secretB);
  const zeros = [0n];
  for (let i = 0; i < DEPTH; i++) zeros.push(H([zeros[i], zeros[i]]));
  const pathFor = (idx: 0 | 1) => {
    const sib = [idx === 0 ? leafB : leafA, ...zeros.slice(1, DEPTH)];
    return { pathElements: sib, pathIndices: [idx, ...Array(DEPTH - 1).fill(0)] };
  };
  let node = H([leafA, leafB]);
  for (let i = 1; i < DEPTH; i++) node = H([node, zeros[i]]);
  const poolRoot = node;

  // withdraw witness (commitment not in tree — the withdraw circuit has no Merkle check)
  const wSecret = 424242n, wCum = 500n, wRandOld = 12345n, wAmt = 100n, wRandNew = 77777n;
  const wCommitment = commit(wCum, wRandOld, wSecret);

  // ---- publish ---------------------------------------------------------------------------
  const build = JSON.parse(
    execSync(`${SUI} move build --dump-bytecode-as-base64 --no-tree-shaking --path ${join(ROOT, "contracts")} 2>/dev/null`, { maxBuffer: 1 << 26 }).toString(),
  );
  const ptx = new Transaction();
  const upgradeCap = ptx.publish({ modules: build.modules, dependencies: build.dependencies });
  ptx.transferObjects([upgradeCap], me);
  const pubRes = await exec("publish (one-off)", ptx);
  const pkg = pubRes.objectChanges!.find((o: any) => o.type === "published")!.packageId;
  const treasury = created(pubRes, "::coin::TreasuryCap");
  console.log(`package ${pkg}\n`);

  // ---- create pool + admin timelocks -----------------------------------------------------
  const cp = new Transaction();
  cp.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [vec(cp, T.vk), cp.pure.u64(THRESHOLD), cp.pure.u64(EPOCH_MS)] });
  const cpRes = await exec("create_pool", cp);
  const pool = created(cpRes, "::pool::Pool");
  const cap = created(cpRes, "::pool::AdminCap");

  const mint = new Transaction();
  mint.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [mint.object(treasury)] });
  const mintRes = await exec("token_faucet::faucet (testnet only)", mint);
  const coin = created(mintRes, "::coin::Coin");

  // credential tree (compliance): leaf at index 0, zero siblings
  const userSecretC = secretB, kyc = 2n, expiry = 1_000_000_000n, issuer = 42n, reqKyc = 1n;
  const credLeaf = H([4n, userSecretC, kyc, expiry, issuer]);
  let credNode = credLeaf;
  for (let i = 0; i < DEPTH; i++) credNode = H([credNode, 0n]);
  const credRoot = credNode;

  const setup = async (name: string, f: (tx: Transaction) => void) => {
    const tx = new Transaction(); f(tx); return exec(name, tx);
  };
  const proposeEpoch = epochNow();
  await setup("propose commitment root", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [tx.object(pool), tx.object(cap), vec(tx, bigintToLE32(poolRoot)), tx.object(CLOCK)] }));
  await setup("propose_withdraw_vk", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [tx.object(pool), tx.object(cap), vec(tx, W.vk), tx.object(CLOCK)] }));
  const auditorKey = new Uint8Array(65).fill(4);
  const ccRes = await setup("create_compliance_config", (tx) =>
    tx.moveCall({ target: `${pkg}::compliance::create_compliance_config`, arguments: [tx.object(cap), tx.object(pool), vec(tx, C.vk), vec(tx, bigintToLE32(credRoot)), tx.pure.u64(reqKyc), vec(tx, auditorKey)] }));
  const config = created(ccRes, "::compliance::ComplianceConfig");

  // ---- deposits (3 samples) --------------------------------------------------------------
  for (const [label, c] of [["A", leafA], ["B", leafB], ["W", wCommitment]] as const) {
    await setup(`deposit_and_register (${label})`, (tx) => {
      const [d] = tx.splitCoins(tx.object(coin), [tx.pure.u64(DEPOSIT)]);
      tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [tx.object(pool), d, vec(tx, bigintToLE32(c)), tx.object(CLOCK)] });
    });
  }

  // ---- wait for next epoch (maturity + timelocks) ----------------------------------------
  const target = Math.max(proposeEpoch, epochNow()) + 1;
  const waitMs = target * EPOCH_MS - Date.now() + 2000;
  console.log(`\nwaiting ${(waitMs / 1000).toFixed(0)} s for epoch ${target} ...\n`);
  await sleep(waitMs);

  // ---- proofs ----------------------------------------------------------------------------
  const epochId = BigInt(epochNow());
  const prove = async (a: { wasm: string; zkey: string }, input: Record<string, any>) => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, a.wasm, a.zkey, undefined, undefined, { singleThread: true });
    return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals) };
  };
  const str = (o: Record<string, any>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

  const transferInput = (sec: bigint, leaf: bigint, rndNew: bigint, idx: 0 | 1, txAmount: bigint, salt: bigint) => {
    const cumNew = txAmount;
    return {
      oldCommitment: leaf, newCommitment: commit(cumNew, rndNew, sec), threshold: THRESHOLD, epochId,
      nullifier: H([2n, sec, epochId, 0n]), txAmountHash: H([3n, txAmount, salt]), merkleRoot: poolRoot,
      cumulativeOld: 0n, cumulativeNew: cumNew, txAmount, randomnessOld: 0n, randomnessNew: rndNew, userSecret: sec, salt,
      ...pathFor(idx),
    };
  };
  const tiA = transferInput(secretA, leafA, 12345n, 0, 100n, 99n);
  const tiB = transferInput(secretB, leafB, 67890n, 1, 100n, 98n);
  const pA = await prove(T, str(tiA));
  const pB = await prove(T, str(tiB));

  const contextId = H([6n, tiB.nullifier, userSecretC]);
  const pC = await prove(C, str({
    merkleRoot: credRoot, currentEpoch: epochId, contextId, requiredKycLevel: reqKyc,
    nullifier: H([5n, userSecretC, contextId]), validCredential: 1n,
    userSecret: userSecretC, kycLevel: kyc, expiryEpoch: expiry, issuerId: issuer,
    pathElements: Array(DEPTH).fill(0n), pathIndices: Array(DEPTH).fill(0n), transferNullifier: tiB.nullifier,
  }));

  const recipient = 0xabcdef123456n;
  const recipientAddr = "0x" + recipient.toString(16).padStart(64, "0");
  const pW = await prove(W, str({
    commitment: wCommitment, withdrawAmount: wAmt, nullifier: H([7n, wSecret, wRandOld, wCum]),
    recipientHash: H([8n, recipient]), newCommitment: commit(wCum - wAmt, wRandNew, wSecret),
    cumulativeOld: wCum, randomnessOld: wRandOld, userSecret: wSecret, recipient, randomnessNew: wRandNew,
  }));

  // ---- proof-verifying entry points ------------------------------------------------------
  await setup("shielded_transfer", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), vec(tx, pA.proof), vec(tx, pA.inputs), tx.object(CLOCK)] }));
  await setup("compliant_transfer (2 proofs)", (tx) =>
    tx.moveCall({ target: `${pkg}::compliance::compliant_transfer`, arguments: [
      tx.object(pool), tx.object(config), vec(tx, pB.proof), vec(tx, pB.inputs), vec(tx, pC.proof), vec(tx, pC.inputs),
      vec(tx, new Uint8Array(100).fill(1)), tx.object(CLOCK)] }));
  await setup("zk_withdraw", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(pool), vec(tx, pW.proof), vec(tx, pW.inputs), tx.pure.address(recipientAddr), tx.object(CLOCK)] }));

  console.log("\n| entry point | computation (MIST) | storage (MIST) | rebate (MIST) | net (MIST) |\n|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.name} | ${r.computation} | ${r.storage} | ${r.rebate} | ${r.net} |`);
  writeFileSync(OUT, JSON.stringify({ referenceGasPrice: String(rgp), rows }, null, 2));
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
