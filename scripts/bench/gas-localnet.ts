/**
 * gas-localnet.ts — On-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Every number comes from `effects.gasUsed` of a real, successfully executed transaction carrying a
 * real Groth16 proof (no mocks, no dev-inspect estimates). Output is a JSON array on stdout (one
 * row per transaction) plus a human-readable table on stderr.
 *
 * Prerequisites (see docs/research/2026-10-01-onchain-gas-baseline.md for the exact commands):
 *   - `sui start --force-regenesis --with-faucet` running (RPC :9000, faucet :9123)
 *   - circuits compiled: circuits/build, circuits/build-withdraw, circuits/build-compliance
 *   - `cd scripts && bun install`
 *
 * Usage: cd scripts && node --experimental-strip-types bench/gas-localnet.ts [--epoch-ms 60000] > gas.json
 *
 * Timing: the pool's timelocks (commitment root, withdraw VK) are one epoch long and commitments
 * must be a full epoch old before they can be spent, so the run sleeps through one epoch boundary
 * (<= epoch-ms + a few seconds).
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error snarkjs has no TypeScript declarations
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RPC = process.env.SUI_RPC ?? "http://127.0.0.1:9000";
const FAUCET = process.env.SUI_FAUCET ?? "http://127.0.0.1:9123";
const CLOCK = "0x6";
const GAS_BUDGET = 500_000_000;
const THRESHOLD = 1_000_000_000n;
const DEPTH = 20;
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const EPOCH_MS = Number(arg("--epoch-ms", "60000"));

const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RCPT: 8n };

const circ = (dir: string, name: string) => ({
  wasm: join(ROOT, "circuits", dir, `${name}_js`, `${name}.wasm`),
  zkey: join(ROOT, "circuits", dir, `${name}_final.zkey`),
  vk: JSON.parse(readFileSync(join(ROOT, "circuits", dir, `${name}_vk.json`), "utf-8")),
});
const C = {
  transfer: circ("build", "transfer"),
  withdraw: circ("build-withdraw", "withdraw"),
  compliance: circ("build-compliance", "compliance"),
};

const rows: Record<string, unknown>[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bytes = (u: Uint8Array) => Array.from(u);

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (xs: bigint[]): bigint => F.toObject(poseidon(xs));

  const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" as never });
  const kp = Ed25519Keypair.generate();
  const me = kp.toSuiAddress();
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await sleep(3000);

  const rgp = BigInt(await client.getReferenceGasPrice());
  const sysState: any = await (client as any).getLatestSuiSystemState?.();
  process.stderr.write(`RGP=${rgp} protocolVersion=${sysState?.protocolVersion ?? "?"}\n`);

  async function exec(label: string, tx: Transaction, note = "") {
    tx.setGasBudget(GAS_BUDGET);
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: kp,
      options: { showEffects: true, showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    const st = res.effects?.status;
    if (st?.status !== "success") throw new Error(`${label} failed: ${JSON.stringify(st)}`);
    const g = res.effects!.gasUsed;
    const comp = BigInt(g.computationCost), stor = BigInt(g.storageCost), reb = BigInt(g.storageRebate);
    rows.push({
      label, note, digest: res.digest,
      computationCostMist: comp.toString(),
      computationUnits: (comp / rgp).toString(),
      storageCostMist: stor.toString(),
      storageRebateMist: reb.toString(),
      netMist: (comp + stor - reb).toString(),
    });
    process.stderr.write(`${label.padEnd(34)} comp=${comp} (${comp / rgp} units) storage=${stor} rebate=${reb} net=${comp + stor - reb}\n`);
    return res;
  }

  // ---- publish --------------------------------------------------------------------------------
  const built = JSON.parse(
    execSync("sui move build -e testnet --no-tree-shaking --dump-bytecode-as-base64", {
      cwd: join(ROOT, "contracts"), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26,
    }).slice(/* skip any warning noise before the JSON */ 0),
  );
  const ptx = new Transaction();
  const [upgradeCap] = ptx.publish({ modules: built.modules, dependencies: built.dependencies });
  ptx.transferObjects([upgradeCap], me);
  const pub = await exec("publish", ptx, `${built.modules.reduce((n: number, m: string) => n + Buffer.from(m, "base64").length, 0)} bytecode bytes`);
  const changes: any[] = pub.objectChanges ?? [];
  const pkg = changes.find((c) => c.type === "published").packageId as string;
  const treasuryCap = changes.find((c) => c.type === "created" && c.objectType.includes("::coin::TreasuryCap")).objectId;

  // ---- pool + compliance config ----------------------------------------------------------------
  const vkT = vkToSuiBytes(C.transfer.vk);
  const poolTx = new Transaction();
  poolTx.moveCall({
    target: `${pkg}::pool::create_pool`,
    arguments: [poolTx.pure.vector("u8", bytes(vkT)), poolTx.pure.u64(THRESHOLD), poolTx.pure.u64(EPOCH_MS)],
  });
  const poolRes = await exec("create_pool", poolTx);
  const poolId = (poolRes.objectChanges as any[]).find((c) => c.type === "created" && c.objectType.endsWith("::pool::Pool")).objectId;
  const adminCap = (poolRes.objectChanges as any[]).find((c) => c.type === "created" && c.objectType.endsWith("::pool::AdminCap")).objectId;

  // ---- witness material that does not depend on the epoch ---------------------------------------
  const userSecret = (i: number) => 900_000_000n + BigInt(i);
  const kyc = { level: 2n, issuer: 42n };
  // transfer leaves A,B (plain), C (compliant); deposit-time commitments have cumulativeOld = 0
  // + NX extra leaves used only for the batched dry-runs (N transfers in one PTB)
  const NX = Number(arg("--extra-leaves", "24")), NW = Number(arg("--extra-withdraws", "8"));
  const secrets = [1, 2, 3, ...Array.from({ length: NX }, (_, i) => 100 + i)].map(userSecret);
  const oldComm = secrets.map((s) => H([D.COMMIT, 0n, 0n, s]));
  const leaves = oldComm;
  const merklePath = (idx: number) => {
    let nodes = leaves.slice();
    const pathElements: bigint[] = [], pathIndices: bigint[] = [];
    let i = idx;
    for (let lvl = 0; lvl < DEPTH; lvl++) {
      pathElements.push(nodes[i ^ 1] ?? 0n);
      pathIndices.push(BigInt(i & 1));
      const next: bigint[] = [];
      for (let j = 0; j < nodes.length; j += 2) next.push(H([nodes[j], nodes[j + 1] ?? 0n]));
      nodes = next; i >>= 1;
    }
    return { pathElements, pathIndices, root: nodes[0] };
  };
  const root32 = (x: bigint) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number((x >> BigInt(8 * i)) & 0xffn); } return b; };
  const commitmentRoot = merklePath(0).root;

  // credential tree for compliance (single credential at index 0, zero siblings)
  const credSecret = userSecret(3);
  const expiry = 1n << 40n;
  const credLeaf = H([D.CRED, credSecret, kyc.level, expiry, kyc.issuer]);
  let credNode = credLeaf;
  for (let i = 0; i < DEPTH; i++) credNode = H([credNode, 0n]);
  const credRoot = credNode;

  const vkC = vkToSuiBytes(C.compliance.vk);
  const ccTx = new Transaction();
  ccTx.moveCall({
    target: `${pkg}::compliance::create_compliance_config`,
    arguments: [
      ccTx.object(adminCap), ccTx.object(poolId),
      ccTx.pure.vector("u8", bytes(vkC)), ccTx.pure.vector("u8", bytes(root32(credRoot))),
      ccTx.pure.u64(1), ccTx.pure.vector("u8", Array(33).fill(7)),
    ],
  });
  const ccRes = await exec("create_compliance_config", ccTx);
  const configId = (ccRes.objectChanges as any[]).find((c) => c.type === "created" && c.objectType.endsWith("::ComplianceConfig")).objectId;

  // ---- faucet + deposits (3 transfer leaves, 2 withdraw leaves) ----------------------------------
  const withdrawSecret = (k: number) => 700_000_000n + BigInt(k);
  const wCumul = 500n, wRand = (k: number) => 12345n + BigInt(k);
  const wComm = Array.from({ length: 2 + NW }, (_, k) => k).map((k) => H([D.COMMIT, wCumul, wRand(k), withdrawSecret(k)]));
  const depositComms = [...oldComm.slice(0, 3), ...wComm.slice(0, 2), ...oldComm.slice(3), ...wComm.slice(2)];
  const labels = depositComms.map((_, k) => (k === 0 ? "deposit_and_register #1 (first)" : `deposit_and_register #${k + 1}`));
  for (let k = 0; k < depositComms.length; k++) {
    const m = new Transaction();
    m.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [m.object(treasuryCap)] });
    const mr = await exec("faucet (testnet-only)", m);
    const coinId = (mr.objectChanges as any[]).find((c) => c.type === "created" && c.objectType.includes("::token::TOKEN")).objectId;
    const d = new Transaction();
    d.moveCall({
      target: `${pkg}::pool::deposit_and_register`,
      arguments: [d.object(poolId), d.object(coinId), d.pure.vector("u8", bytes(root32(depositComms[k]))), d.object(CLOCK)],
    });
    if (k < 5) await exec(labels[k], d, `leaf ${k}`);
    else await exec("faucet+deposit (bulk, not reported)", d);
  }

  // ---- timelocked setup, then sleep past the epoch boundary --------------------------------------
  const r = new Transaction();
  r.moveCall({
    target: `${pkg}::pool::update_commitment_root`,
    arguments: [r.object(poolId), r.object(adminCap), r.pure.vector("u8", bytes(root32(commitmentRoot))), r.object(CLOCK)],
  });
  await exec("update_commitment_root (propose)", r);
  const wv = new Transaction();
  wv.moveCall({
    target: `${pkg}::pool::propose_withdraw_vk`,
    arguments: [wv.object(poolId), wv.object(adminCap), wv.pure.vector("u8", bytes(vkToSuiBytes(C.withdraw.vk))), wv.object(CLOCK)],
  });
  await exec("propose_withdraw_vk", wv);

  const wait = EPOCH_MS - (Date.now() % EPOCH_MS) + 3000;
  process.stderr.write(`sleeping ${wait} ms past the epoch boundary...\n`);
  await sleep(wait);
  const epoch = BigInt(Math.floor(Date.now() / EPOCH_MS));

  // ---- proofs ------------------------------------------------------------------------------------
  const transferProof = async (idx: number) => {
    const s = secrets[idx], txAmount = 100n, rOld = 0n, rNew = 5000n + BigInt(idx), salt = 99n;
    const p = merklePath(idx);
    const input = {
      oldCommitment: oldComm[idx], newCommitment: H([D.COMMIT, txAmount, rNew, s]), threshold: THRESHOLD, epochId: epoch,
      nullifier: H([D.NULL, s, epoch, rOld]), txAmountHash: H([D.TXAMT, txAmount, salt]), merkleRoot: p.root,
      cumulativeOld: 0n, cumulativeNew: txAmount, txAmount, randomnessOld: rOld, randomnessNew: rNew, userSecret: s, salt,
      pathElements: p.pathElements, pathIndices: p.pathIndices,
    };
    const str = JSON.parse(JSON.stringify(input, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(str, C.transfer.wasm, C.transfer.zkey);
    if (!(await snarkjs.groth16.verify(C.transfer.vk, publicSignals, proof))) throw new Error("local verify failed");
    return { proof: bytes(proofToSuiBytes(proof)), inputs: bytes(publicInputsToSuiBytes(publicSignals)), nullifier: input.nullifier };
  };
  const complianceProof = async (transferNullifier: bigint) => {
    const contextId = H([D.CTX, transferNullifier, credSecret]);
    const input = {
      merkleRoot: credRoot, currentEpoch: epoch, contextId, requiredKycLevel: 1n,
      nullifier: H([D.CNULL, credSecret, contextId]), validCredential: 1n,
      userSecret: credSecret, kycLevel: kyc.level, expiryEpoch: expiry, issuerId: kyc.issuer,
      pathElements: Array(DEPTH).fill(0n), pathIndices: Array(DEPTH).fill(0n), transferNullifier,
    };
    const str = JSON.parse(JSON.stringify(input, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(str, C.compliance.wasm, C.compliance.zkey);
    if (!(await snarkjs.groth16.verify(C.compliance.vk, publicSignals, proof))) throw new Error("local verify failed");
    return { proof: bytes(proofToSuiBytes(proof)), inputs: bytes(publicInputsToSuiBytes(publicSignals)) };
  };
  const withdrawProof = async (k: number) => {
    const recipientField = BigInt(me) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const input = {
      commitment: wComm[k], withdrawAmount: 100n, nullifier: H([D.WNULL, withdrawSecret(k), wRand(k), wCumul]),
      recipientHash: H([D.RCPT, recipientField]), newCommitment: H([D.COMMIT, wCumul - 100n, 77_000n + BigInt(k), withdrawSecret(k)]),
      cumulativeOld: wCumul, randomnessOld: wRand(k), userSecret: withdrawSecret(k), recipient: recipientField, randomnessNew: 77_000n + BigInt(k),
    };
    const str = JSON.parse(JSON.stringify(input, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(str, C.withdraw.wasm, C.withdraw.zkey);
    if (!(await snarkjs.groth16.verify(C.withdraw.vk, publicSignals, proof))) throw new Error("local verify failed");
    return { proof: bytes(proofToSuiBytes(proof)), inputs: bytes(publicInputsToSuiBytes(publicSignals)) };
  };

  const tA = await transferProof(0), tB = await transferProof(1), tC = await transferProof(2);
  const tX: Awaited<ReturnType<typeof transferProof>>[] = [];
  for (let i = 0; i < NX; i++) tX.push(await transferProof(3 + i));
  const cC = await complianceProof(tC.nullifier);
  const w0 = await withdrawProof(0), w1 = await withdrawProof(1);
  const wX: Awaited<ReturnType<typeof withdrawProof>>[] = [];
  for (let k = 0; k < NW; k++) wX.push(await withdrawProof(2 + k));

  // ---- measured entry points -----------------------------------------------------------------------
  const st = (p: { proof: number[]; inputs: number[] }, tx: Transaction) => [
    tx.object(poolId), tx.pure.vector("u8", p.proof), tx.pure.vector("u8", p.inputs), tx.object(CLOCK),
  ];
  let t = new Transaction();
  t.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: st(tA, t) });
  await exec("shielded_transfer #1", t, "also applies the pending commitment root (lazy apply)");
  t = new Transaction();
  t.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: st(tB, t) });
  await exec("shielded_transfer #2 (steady state)", t);
  t = new Transaction();
  t.moveCall({
    target: `${pkg}::compliance::compliant_transfer`,
    arguments: [
      t.object(poolId), t.object(configId),
      t.pure.vector("u8", tC.proof), t.pure.vector("u8", tC.inputs),
      t.pure.vector("u8", cC.proof), t.pure.vector("u8", cC.inputs),
      t.pure.vector("u8", Array(93).fill(1)), t.object(CLOCK),
    ],
  });
  await exec("compliant_transfer", t, "transfer proof + compliance proof, 93-byte encrypted_amount");
  for (const [k, w] of [w0, w1].entries()) {
    t = new Transaction();
    t.moveCall({
      target: `${pkg}::pool::zk_withdraw`,
      arguments: [t.object(poolId), t.pure.vector("u8", w.proof), t.pure.vector("u8", w.inputs), t.pure.address(me), t.object(CLOCK)],
    });
    await exec(k === 0 ? "zk_withdraw #1" : "zk_withdraw #2 (steady state)", t, k === 0 ? "also applies the pending withdraw VK" : "");
  }

  // ---- batched dry-runs: N proofs in ONE programmable transaction (state is not consumed) ----------------
  const dry = async (label: string, build: (t: Transaction) => void) => {
    const x = new Transaction();
    build(x);
    x.setSender(me);
    x.setGasBudget(5_000_000_000);
    const bytesTx = await x.build({ client });
    const res: any = await client.dryRunTransactionBlock({ transactionBlock: bytesTx });
    if (res.effects.status.status !== "success") throw new Error(`${label}: ${JSON.stringify(res.effects.status)}`);
    const g = res.effects.gasUsed;
    const comp = BigInt(g.computationCost), stor = BigInt(g.storageCost), reb = BigInt(g.storageRebate);
    rows.push({ label, note: "dry-run (not executed)", computationCostMist: comp.toString(), computationUnits: (comp / rgp).toString(),
      storageCostMist: stor.toString(), storageRebateMist: reb.toString(), netMist: (comp + stor - reb).toString() });
    process.stderr.write(`${label.padEnd(34)} comp=${comp} (${comp / rgp} units) storage=${stor} rebate=${reb} net=${comp + stor - reb}\n`);
  };
  for (const n of [1, 2, 4, 8, 16, NX].filter((v, i, a) => v <= NX && a.indexOf(v) === i)) {
    await dry(`dry-run ${n}x shielded_transfer in one PTB`, (x) => {
      for (const p of tX.slice(0, n)) x.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: st(p, x) });
    });
  }
  for (const n of [1, 2, 4, NW].filter((v, i, a) => v <= NW && a.indexOf(v) === i)) {
    await dry(`dry-run ${n}x zk_withdraw in one PTB`, (x) => {
      for (const w of wX.slice(0, n)) x.moveCall({
        target: `${pkg}::pool::zk_withdraw`,
        arguments: [x.object(poolId), x.pure.vector("u8", w.proof), x.pure.vector("u8", w.inputs), x.pure.address(me), x.object(CLOCK)],
      });
    });
  }

  // ---- admin operations --------------------------------------------------------------------------
  const admin = async (label: string, fn: string, args: (t: Transaction) => any[], mod = "pool") => {
    const x = new Transaction();
    x.moveCall({ target: `${pkg}::${mod}::${fn}`, arguments: args(x) });
    await exec(label, x);
  };
  await admin("freeze_pool", "freeze_pool", (x) => [x.object(poolId), x.object(adminCap), x.object(CLOCK)]);
  await admin("unfreeze_pool", "unfreeze_pool", (x) => [x.object(poolId), x.object(adminCap)]);
  await admin("propose_withdrawal", "propose_withdrawal", (x) => [x.object(poolId), x.object(adminCap), x.pure.u64(1000), x.pure.address(me), x.object(CLOCK)]);
  await admin("cancel_withdrawal", "cancel_withdrawal", (x) => [x.object(poolId), x.object(adminCap)]);
  await admin("update_credential_root (propose)", "update_credential_root", (x) => [x.object(configId), x.object(adminCap), x.object(poolId), x.pure.vector("u8", bytes(root32(credRoot + 1n))), x.object(CLOCK)], "compliance");

  console.log(JSON.stringify({ rgp: rgp.toString(), protocolVersion: sysState?.protocolVersion, epochMs: EPOCH_MS, rows }, null, 2));
  process.exit(0); // snarkjs worker threads keep the event loop alive otherwise
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
