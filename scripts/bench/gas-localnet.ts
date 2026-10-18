/**
 * gas-localnet.ts — Real on-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Publishes contracts/, then drives deposit -> shielded_transfer -> zk_withdraw ->
 * compliant_transfer with REAL Groth16 proofs (circuits/build artifacts) and records
 * effects.gasUsed for every transaction. Also runs a recipient-substitution probe on zk_withdraw
 * (proof for recipient A, submitted with recipient B).
 *
 * Prerequisites:
 *   - sui CLI on PATH or SUI_BIN set (framework rev in contracts/Move.toml needs sui >= 1.72.1)
 *   - local network:  sui start --force-regenesis --with-faucet   (RPC :9000, faucet :9123)
 *   - circuits compiled: circuits/scripts/compile{,-withdraw,-compliance}.sh  (build/*.zkey etc.)
 *   - cd scripts && npm install
 *
 * Run (takes ~4 min: it waits out 60 s on-chain epochs for the timelocks):
 *   cd scripts && bun run bench/gas-localnet.ts           # from repo: bun run scripts/bench/gas-localnet.ts
 *
 * Output: raw per-tx gas table on stdout, plus JSON to $GAS_OUT (default ./gas-localnet.json).
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const buildDir = (n: string) => join(ROOT, "circuits", n === "transfer" ? "build" : `build-${n}`);
const SUI_BIN = process.env.SUI_BIN ?? "sui";
const RPC = process.env.SUI_RPC ?? getJsonRpcFullnodeUrl("localnet");
const FAUCET = process.env.SUI_FAUCET ?? "http://127.0.0.1:9123";
const OUT = process.env.GAS_OUT ?? "gas-localnet.json";
const CLOCK = "0x6";
const EPOCH_MS = 60_000; // pool.move minimum
const DENOM = 100_000_000n; // DENOM_SMALL
const GAS_BUDGET = 500_000_000;
const DEPTH = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const signer = Ed25519Keypair.generate();
const me = signer.toSuiAddress();

interface GasRow {
  label: string;
  computationCost: number;
  storageCost: number;
  storageRebate: number;
  nonRefundableStorageFee: number;
  net: number;
  status: string;
  digest: string;
}
const rows: GasRow[] = [];

async function run(label: string, tx: Transaction, expectFail = false) {
  tx.setGasBudget(GAS_BUDGET);
  const r = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: r.digest });
  const g = r.effects!.gasUsed;
  const status = r.effects!.status.status;
  if (status !== "success") console.log(`# ${label} aborted: ${JSON.stringify(r.effects!.status)}`);
  const row: GasRow = {
    label,
    computationCost: Number(g.computationCost),
    storageCost: Number(g.storageCost),
    storageRebate: Number(g.storageRebate),
    nonRefundableStorageFee: Number(g.nonRefundableStorageFee),
    net: Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate),
    status,
    digest: r.digest,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (!expectFail && status !== "success") {
    throw new Error(`${label} failed: ${JSON.stringify(r.effects!.status)}`);
  }
  return r;
}

const bytes = (u: Uint8Array) => Array.from(u);
const toLE32 = (n: bigint) => publicInputsToSuiBytes([n.toString()]);
const epochNow = () => BigInt(Math.floor(Date.now() / EPOCH_MS));

async function waitNextEpoch() {
  const ms = EPOCH_MS - (Date.now() % EPOCH_MS) + 1500;
  console.log(`# waiting ${Math.round(ms / 1000)} s for next on-chain epoch`);
  await sleep(ms);
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (xs: bigint[]): bigint => F.toObject(poseidon(xs));

  // ---- keys & artifacts ------------------------------------------------------------------
  const vk = (n: string) => vkToSuiBytes(JSON.parse(readFileSync(join(buildDir(n), `${n}_vk.json`), "utf8")));
  const vkTransfer = vk("transfer"), vkWithdraw = vk("withdraw"), vkCompliance = vk("compliance");
  const prove = async (name: string, input: Record<string, unknown>) => {
    console.log(`# proving ${name}`);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      join(buildDir(name), `${name}_js`, `${name}.wasm`),
      join(buildDir(name), `${name}_final.zkey`),
    );
    return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals) };
  };

  // ---- fund ------------------------------------------------------------------------------
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await sleep(3000);

  // ---- publish ---------------------------------------------------------------------------
  const built = JSON.parse(
    execFileSync(SUI_BIN, ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", join(ROOT, "contracts")], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/^[^{]*/, ""),
  );
  const pubTx = new Transaction();
  const [upgradeCap] = pubTx.publish({ modules: built.modules, dependencies: built.dependencies });
  pubTx.transferObjects([upgradeCap], me);
  const pub = await run("publish", pubTx);
  const pkg = (pub.objectChanges!.find((c) => c.type === "published") as { packageId: string }).packageId;
  const treasury = (pub.objectChanges!.find(
    (c) => c.type === "created" && (c as { objectType: string }).objectType.includes("TreasuryCap"),
  ) as { objectId: string }).objectId;

  // ---- witness material ------------------------------------------------------------------
  // Transfer UTXOs: C_t for shielded_transfer, C_c for compliant_transfer. Both live in one
  // depth-20 tree at leaf 0 / leaf 1 (siblings above level 0 are 0, as in the repo's test witnesses).
  const secret = 987654321n;
  const comm = (cum: bigint, r: bigint, s = secret) => H([1n, cum, r, s]);
  const Ct = comm(0n, 0n), Cc = comm(0n, 1n);
  const rootFor = (leaf: bigint, sib0: bigint, idx0: number) => {
    let node = idx0 === 0 ? H([leaf, sib0]) : H([sib0, leaf]);
    for (let i = 1; i < DEPTH; i++) node = H([node, 0n]);
    return node;
  };
  const treeRoot = rootFor(Ct, Cc, 0);
  const path = (sib0: bigint, idx0: bigint) => ({
    pathElements: [sib0, ...Array(DEPTH - 1).fill(0n)],
    pathIndices: [idx0, ...Array(DEPTH - 1).fill(0n)],
  });
  // Withdraw UTXOs (500 cumulative, as in witnesses.mjs): two, one honest + one for the substitution probe.
  const Cw1 = comm(500n, 12345n), Cw2 = comm(500n, 12346n);

  // ---- pool setup ------------------------------------------------------------------------
  const createPool = new Transaction();
  createPool.moveCall({
    target: `${pkg}::pool::create_pool`,
    arguments: [
      createPool.pure.vector("u8", bytes(vkTransfer)),
      createPool.pure.u64(1_000_000_000n),
      createPool.pure.u64(EPOCH_MS),
    ],
  });
  const cp = await run("create_pool", createPool);
  const pool = (cp.objectChanges!.find(
    (c) => c.type === "created" && (c as { objectType: string }).objectType.endsWith("::pool::Pool"),
  ) as { objectId: string }).objectId;
  const adminCap = (cp.objectChanges!.find(
    (c) => c.type === "created" && (c as { objectType: string }).objectType.endsWith("::pool::AdminCap"),
  ) as { objectId: string }).objectId;

  const deposit = async (label: string, commitment: bigint) => {
    const t = new Transaction();
    t.moveCall({
      target: `${pkg}::token::mint`,
      arguments: [t.object(treasury), t.pure.u64(DENOM), t.pure.address(me)],
    });
    const m = await run(`token_mint (${label})`, t);
    const coin = (m.objectChanges!.find(
      (c) => c.type === "created" && (c as { objectType: string }).objectType.includes("::coin::Coin<"),
    ) as { objectId: string }).objectId;
    const d = new Transaction();
    d.moveCall({
      target: `${pkg}::pool::deposit_and_register`,
      arguments: [d.object(pool), d.object(coin), d.pure.vector("u8", bytes(toLE32(commitment))), d.object(CLOCK)],
    });
    await run(`deposit_and_register (${label})`, d);
  };
  await deposit("first", Ct); // first deposit into an empty pool
  await deposit("second", Cc);
  await deposit("withdraw-1", Cw1);
  await deposit("withdraw-2", Cw2);

  const admin = async (label: string, fn: string, extra: (t: Transaction) => unknown[], withClock = true) => {
    const t = new Transaction();
    t.moveCall({
      target: `${pkg}::pool::${fn}`,
      arguments: [t.object(pool), t.object(adminCap), ...(extra(t) as never[]), ...(withClock ? [t.object(CLOCK)] : [])],
    });
    await run(label, t);
  };
  await admin("update_commitment_root (propose)", "update_commitment_root", (t) => [
    t.pure.vector("u8", bytes(toLE32(treeRoot))),
  ]);
  await admin("propose_withdraw_vk", "propose_withdraw_vk", (t) => [t.pure.vector("u8", bytes(vkWithdraw))]);

  // Compliance config (VK + credential root). Credential tree: one leaf at index 0.
  const kyc = 2n, issuer = 42n;
  const expiry = epochNow() + 100_000n;
  const credLeaf = H([4n, secret, kyc, expiry, issuer]);
  let credRoot = credLeaf;
  for (let i = 0; i < DEPTH; i++) credRoot = H([credRoot, 0n]);
  const auditorKey = new Uint8Array(65).fill(4);
  const cc = new Transaction();
  cc.moveCall({
    target: `${pkg}::compliance::create_compliance_config`,
    arguments: [
      cc.object(adminCap),
      cc.object(pool),
      cc.pure.vector("u8", bytes(vkCompliance)),
      cc.pure.vector("u8", bytes(toLE32(credRoot))),
      cc.pure.u64(1n),
      cc.pure.vector("u8", bytes(auditorKey)),
    ],
  });
  const ccr = await run("create_compliance_config", cc);
  const config = (ccr.objectChanges!.find(
    (c) => c.type === "created" && (c as { objectType: string }).objectType.endsWith("::compliance::ComplianceConfig"),
  ) as { objectId: string }).objectId;

  await waitNextEpoch(); // maturity of deposits + timelocks (root, withdraw VK)

  // ---- shielded_transfer -----------------------------------------------------------------
  const transferWitness = (oldC: bigint, rOld: bigint, rNew: bigint, p: ReturnType<typeof path>, epoch: bigint) => {
    const txAmount = 100n, salt = 99n;
    return {
      oldCommitment: oldC,
      newCommitment: comm(txAmount, rNew),
      threshold: 1_000_000_000n,
      epochId: epoch,
      nullifier: H([2n, secret, epoch, rOld]),
      txAmountHash: H([3n, txAmount, salt]),
      merkleRoot: treeRoot,
      cumulativeOld: 0n, cumulativeNew: txAmount, txAmount,
      randomnessOld: rOld, randomnessNew: rNew, userSecret: secret, salt,
      ...p,
    };
  };
  const str = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

  {
    const e = epochNow();
    const tw = transferWitness(Ct, 0n, 12345n, path(Cc, 0n), e);
    const t0 = Date.now();
    const pr = await prove("transfer", str(tw));
    console.log(`# transfer proof generated in ${Date.now() - t0} ms`);
    const t = new Transaction();
    t.moveCall({
      target: `${pkg}::pool::shielded_transfer`,
      arguments: [t.object(pool), t.pure.vector("u8", bytes(pr.proof)), t.pure.vector("u8", bytes(pr.inputs)), t.object(CLOCK)],
    });
    await run("shielded_transfer", t);
  }

  // ---- zk_withdraw: honest, then recipient-substitution probe ----------------------------
  const withdrawProof = async (cOld: bigint, rOld: bigint, recipient: bigint, rNew = 77777n) => {
    const cumOld = 500n, amt = 100n;
    return prove("withdraw", str({
      commitment: cOld,
      withdrawAmount: amt,
      nullifier: H([7n, secret, rOld, cumOld]),
      recipientHash: H([8n, recipient]),
      newCommitment: comm(cumOld - amt, rNew),
      cumulativeOld: cumOld, randomnessOld: rOld, userSecret: secret, recipient, randomnessNew: rNew,
    }));
  };
  const addr = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  const zkw = (pr: { proof: Uint8Array; inputs: Uint8Array }, to: string) => {
    const t = new Transaction();
    t.moveCall({
      target: `${pkg}::pool::zk_withdraw`,
      arguments: [t.object(pool), t.pure.vector("u8", bytes(pr.proof)), t.pure.vector("u8", bytes(pr.inputs)), t.pure.address(to), t.object(CLOCK)],
    });
    return t;
  };
  const alice = 0xabcdef123456n, mallory = 0xbadbadbad000n;
  await run("zk_withdraw (honest recipient)", zkw(await withdrawProof(Cw1, 12345n, alice), addr(alice)));
  const probe = await run(
    "zk_withdraw (PROBE: proof bound to A, submitted with recipient B)",
    zkw(await withdrawProof(Cw2, 12346n, alice, 88888n), addr(mallory)),
    true,
  );
  const probeAccepted = probe.effects!.status.status === "success";
  console.log(`# recipient-substitution probe accepted on-chain: ${probeAccepted}`);

  // ---- compliant_transfer ----------------------------------------------------------------
  await admin("propose_compliance_toggle", "propose_compliance_toggle", (t) => [t.pure.bool(true)]);
  await waitNextEpoch();
  {
    const e = epochNow();
    const tw = transferWitness(Cc, 1n, 22222n, path(Ct, 1n), e);
    const tp = await prove("transfer", str(tw));
    const ctx = H([6n, tw.nullifier, secret]);
    const cw = {
      merkleRoot: credRoot, currentEpoch: e, contextId: ctx, requiredKycLevel: 1n,
      nullifier: H([5n, secret, ctx]), validCredential: 1n,
      userSecret: secret, kycLevel: kyc, expiryEpoch: expiry, issuerId: issuer,
      ...path(0n, 0n), transferNullifier: tw.nullifier,
    };
    const cpf = await prove("compliance", str(cw));
    const t = new Transaction();
    t.moveCall({
      target: `${pkg}::compliance::compliant_transfer`,
      arguments: [
        t.object(pool), t.object(config),
        t.pure.vector("u8", bytes(tp.proof)), t.pure.vector("u8", bytes(tp.inputs)),
        t.pure.vector("u8", bytes(cpf.proof)), t.pure.vector("u8", bytes(cpf.inputs)),
        t.pure.vector("u8", bytes(new Uint8Array(93).fill(7))),
        t.object(CLOCK),
      ],
    });
    await run("compliant_transfer", t);
  }

  // ---- admin ops -------------------------------------------------------------------------
  await admin("freeze_pool", "freeze_pool", () => []);
  await admin("unfreeze_pool", "unfreeze_pool", () => [], false);

  const rgp = await client.getReferenceGasPrice();
  writeFileSync(OUT, JSON.stringify({ referenceGasPrice: String(rgp), probeAccepted, rows }, null, 2));
  console.log(`# reference gas price: ${rgp} MIST/unit; wrote ${OUT}`);
  console.table(rows.map((r) => ({ label: r.label, comp: r.computationCost, storage: r.storageCost, rebate: r.storageRebate, net: r.net, status: r.status })));
}

process.on("exit", (c) => console.log(`# process exit ${c}`));
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
