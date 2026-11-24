/**
 * gas-localnet.ts — Real on-chain gas for every Veil entry point, measured on a local Sui network
 * with real Groth16 proofs (no mocks, no estimates).
 *
 * Every number this prints comes from `effects.gasUsed` of a transaction that was actually
 * executed (or dry-run, where marked) against a `sui start` localnet.
 *
 * Prerequisites (see docs/research/2026-11-24-onchain-gas-baseline.md for the exact versions):
 *   1. circuit artifacts:  cd circuits && bash scripts/compile.sh && bash scripts/compile-withdraw.sh \
 *                          && bash scripts/compile-compliance.sh
 *   2. a localnet:         sui start --with-faucet --force-regenesis   (RPC :9000, faucet :9123)
 *   3. deps:               cd scripts && bun install
 *
 * Usage:   cd scripts && node bench/gas-localnet.ts [--transfers 3] [--json out.json]
 *
 * Besides gas, it records three security probes whose outcome is a protocol fact, not a number:
 *   - NEG  tampered public input on shielded_transfer must abort with E_INVALID_PROOF (3)
 *   - E7   zk_withdraw with a proof bound to recipient A, submitted with recipient B
 *   - E4   zk_withdraw of 3x the deposit backing the note (commitment value is self-declared)
 *   - BIND compliant_transfer whose compliance proof uses a different userSecret and a
 *          transferNullifier unrelated to the transfer proof's nullifier
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
import * as snarkjs from "snarkjs";

import {
  bigintToLE32,
  proofToSuiBytes,
  publicInputsToSuiBytes,
  vkToSuiBytes,
} from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const C = join(ROOT, "circuits");
const ART = {
  transfer: { wasm: join(C, "build/transfer_js/transfer.wasm"), zkey: join(C, "build/transfer_final.zkey"), vk: join(C, "build/transfer_vk.json") },
  withdraw: { wasm: join(C, "build-withdraw/withdraw_js/withdraw.wasm"), zkey: join(C, "build-withdraw/withdraw_final.zkey"), vk: join(C, "build-withdraw/withdraw_vk.json") },
  compliance: { wasm: join(C, "build-compliance/compliance_js/compliance.wasm"), zkey: join(C, "build-compliance/compliance_final.zkey"), vk: join(C, "build-compliance/compliance_vk.json") },
};

const RPC = process.env.SUI_RPC ?? "http://127.0.0.1:9000";
const FAUCET = process.env.SUI_FAUCET ?? "http://127.0.0.1:9123";
const EPOCH_MS = 60_000; // pool.move minimum; shortest epoch we can wait out
const THRESHOLD = 1_000_000_000n;
const DENOM = 100_000_000n; // DENOM_SMALL
const DEPTH = 20;
const CLOCK = "0x6";

const args = process.argv.slice(2);
const argVal = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N_TRANSFERS = Number(argVal("--transfers", "3"));
const JSON_OUT = argVal("--json", "");

// ---------------------------------------------------------------------------
type Gas = { label: string; status: string; error?: string; computationCost: number; storageCost: number; storageRebate: number; nonRefundableStorageFee: number; net: number; mode: "exec" | "dry-run"; digest?: string };
const rows: Gas[] = [];
const probes: Record<string, string> = {};

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const kp = new Ed25519Keypair();
const me = kp.toSuiAddress();
let gasPrice = 0n;

function gasRow(label: string, effects: any, mode: "exec" | "dry-run", digest?: string): Gas {
  const g = effects.gasUsed;
  const r: Gas = {
    label, mode, digest,
    status: effects.status.status,
    error: effects.status.error,
    computationCost: Number(g.computationCost),
    storageCost: Number(g.storageCost),
    storageRebate: Number(g.storageRebate),
    nonRefundableStorageFee: Number(g.nonRefundableStorageFee),
    net: Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate),
  };
  rows.push(r);
  const cu = Number(g.computationCost) / Number(gasPrice);
  console.log(`  [gas] ${label.padEnd(44)} ${r.status.padEnd(8)} comp=${r.computationCost} (${cu} units) storage=${r.storageCost} rebate=${r.storageRebate} net=${r.net}${r.error ? "  err=" + r.error : ""}`);
  return r;
}

async function exec(label: string, tx: Transaction, opts: { expectFail?: boolean } = {}) {
  tx.setSender(me);
  tx.setGasBudget(2_000_000_000);
  const res = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const row = gasRow(label, res.effects, "exec", res.digest);
  if (row.status !== "success" && !opts.expectFail) throw new Error(`${label} failed: ${row.error}`);
  return res;
}

async function dryRun(label: string, tx: Transaction) {
  tx.setSender(me);
  tx.setGasBudget(2_000_000_000);
  const bytes = await tx.build({ client });
  const res = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  return gasRow(label, res.effects, "dry-run");
}

const created = (res: any, typeFrag: string): string => {
  const c = res.objectChanges.find((o: any) => o.type === "created" && o.objectType.includes(typeFrag));
  if (!c) throw new Error(`no created object matching ${typeFrag}`);
  return c.objectId;
};

async function clockMs(): Promise<number> {
  const o: any = await client.getObject({ id: CLOCK, options: { showContent: true } });
  return Number(o.data.content.fields.timestamp_ms);
}
const epochOf = (ms: number) => Math.floor(ms / EPOCH_MS);
async function waitForEpochAfter(e: number) {
  process.stdout.write(`  [wait] for pool epoch > ${e} `);
  for (;;) {
    const now = epochOf(await clockMs());
    if (now > e) { console.log(`→ ${now}`); return now; }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------------------
let poseidon: any;
const H = (xs: bigint[]): bigint => poseidon.F.toObject(poseidon(xs));
const s = (x: bigint) => x.toString();
const bytes32 = (x: bigint) => Array.from(bigintToLE32(x));
const vec = (tx: Transaction, b: Uint8Array | number[]) => tx.pure.vector("u8", Array.from(b));

/** Sparse depth-20 Poseidon Merkle tree, empty leaf = 0. Matches templates/merkle_proof.circom. */
function merkle(leaves: bigint[]) {
  const zeros = [0n];
  for (let i = 0; i < DEPTH; i++) zeros.push(H([zeros[i], zeros[i]]));
  const layers: bigint[][] = [leaves.slice()];
  for (let d = 0; d < DEPTH; d++) {
    const cur = layers[d], next: bigint[] = [];
    for (let i = 0; i < Math.ceil(cur.length / 2); i++) next.push(H([cur[2 * i] ?? zeros[d], cur[2 * i + 1] ?? zeros[d]]));
    if (next.length === 0) next.push(zeros[d + 1]);
    layers.push(next);
  }
  const root = layers[DEPTH][0];
  const path = (idx: number) => {
    const els: bigint[] = [], ind: bigint[] = [];
    let i = idx;
    for (let d = 0; d < DEPTH; d++) {
      const sib = i ^ 1;
      els.push(layers[d][sib] ?? zeros[d]);
      ind.push(BigInt(i & 1));
      i >>= 1;
    }
    return { els, ind };
  };
  return { root, path };
}

async function prove(kind: keyof typeof ART, input: Record<string, any>) {
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, ART[kind].wasm, ART[kind].zkey);
  const vk = JSON.parse(readFileSync(ART[kind].vk, "utf-8"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${kind}: local verify failed`);
  console.log(`  [prove] ${kind} ${(performance.now() - t0).toFixed(0)} ms (local verify ok)`);
  return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals), signals: publicSignals as string[] };
}

// ---------------------------------------------------------------------------
async function main() {
  poseidon = await buildPoseidon();
  gasPrice = BigInt(await client.getReferenceGasPrice());
  const sv = execSync("sui --version", { encoding: "utf-8" }).trim();
  console.log(`== Veil localnet gas bench  (${sv}, RPC ${RPC}, reference gas price ${gasPrice} MIST)`);
  console.log(`   sender ${me}`);

  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await new Promise((r) => setTimeout(r, 1500));

  const vk = {
    transfer: vkToSuiBytes(JSON.parse(readFileSync(ART.transfer.vk, "utf-8"))),
    withdraw: vkToSuiBytes(JSON.parse(readFileSync(ART.withdraw.vk, "utf-8"))),
    compliance: vkToSuiBytes(JSON.parse(readFileSync(ART.compliance.vk, "utf-8"))),
  };
  console.log(`   on-chain VK bytes: transfer=${vk.transfer.length} withdraw=${vk.withdraw.length} compliance=${vk.compliance.length}`);

  // ---- publish ----------------------------------------------------------------
  console.log("\n-- setup / admin");
  const built = JSON.parse(execSync("sui move build --dump-bytecode-as-base64 --build-env testnet", { cwd: join(ROOT, "contracts"), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
  let tx = new Transaction();
  const [upCap] = tx.publish({ modules: built.modules, dependencies: built.dependencies });
  tx.transferObjects([upCap], me);
  let res = await exec("publish (veil package)", tx);
  const pkg = (res.objectChanges as any[]).find((o) => o.type === "published").packageId;
  const treasury = created(res, "TreasuryCap");

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] });
  res = await exec("token_faucet::faucet", tx);
  const coin = created(res, "::token::TOKEN>");

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [vec(tx, vk.transfer), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] });
  res = await exec("pool::create_pool", tx);
  const pool = created(res, "::pool::Pool");
  const cap = created(res, "::pool::AdminCap");

  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [tx.object(pool), tx.object(cap), vec(tx, vk.withdraw), tx.object(CLOCK)] });
  await exec("pool::propose_withdraw_vk", tx);

  // credential tree for compliance (KYC user — deliberately a DIFFERENT secret than any transferor)
  const kycSecret = 555_000_111n, kycLevel = 2n, expiry = 10n ** 12n, issuer = 42n;
  const credLeaf = H([4n, kycSecret, kycLevel, expiry, issuer]);
  const credTree = merkle([credLeaf]);
  const auditorKey = new Uint8Array(65).fill(4);
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::compliance::create_compliance_config`, arguments: [tx.object(cap), tx.object(pool), vec(tx, vk.compliance), vec(tx, bytes32(credTree.root)), tx.pure.u64(1), vec(tx, auditorKey)] });
  res = await exec("compliance::create_compliance_config", tx);
  const config = created(res, "::compliance::ComplianceConfig");

  // ---- notes & deposits -------------------------------------------------------
  console.log("\n-- deposits");
  type Note = { secret: bigint; cum: bigint; r: bigint; c: bigint };
  const mk = (secret: bigint, cum: bigint, r: bigint): Note => ({ secret, cum, r, c: H([1n, cum, r, secret]) });
  const tNotes = Array.from({ length: N_TRANSFERS }, (_, i) => mk(1000n + BigInt(i), 0n, 0n));
  const cNote = mk(2000n, 0n, 0n);
  const wHonest = mk(3000n, 500n, 31n);
  const wVictim = mk(3001n, 500n, 32n);
  // E4 probe: deposits DENOM (100 TOKEN) but its commitment claims cumulativeOld = 3*DENOM
  const wOver = mk(3002n, 3n * DENOM, 33n);
  const notes = [...tNotes, cNote, wHonest, wVictim, wOver];
  for (let i = 0; i < notes.length; i++) {
    tx = new Transaction();
    const [d] = tx.splitCoins(tx.object(coin), [tx.pure.u64(DENOM)]);
    tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [tx.object(pool), d, vec(tx, bytes32(notes[i].c)), tx.object(CLOCK)] });
    await exec(`pool::deposit_and_register #${i + 1}`, tx);
  }
  const tree = merkle(notes.map((n) => n.c));
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pool::update_commitment_root`, arguments: [tx.object(pool), tx.object(cap), vec(tx, bytes32(tree.root)), tx.object(CLOCK)] });
  await exec("pool::update_commitment_root", tx);

  // ---- microbench: framework groth16 primitives (transfer VK / proof) ----------
  console.log("\n-- groth16 primitive cost (sui::groth16, transfer circuit, 7 public inputs)");
  tx = new Transaction();
  tx.moveCall({ target: "0x2::groth16::bn254" });
  await exec("ptb: groth16::bn254() only (floor)", tx);
  tx = new Transaction();
  {
    const curve = tx.moveCall({ target: "0x2::groth16::bn254" });
    tx.moveCall({ target: "0x2::groth16::prepare_verifying_key", arguments: [curve, vec(tx, vk.transfer)] });
  }
  await exec("ptb: prepare_verifying_key(transfer)", tx);

  // ---- wait one epoch: root applies, commitments mature ------------------------
  const depEpoch = epochOf(await clockMs());
  const epoch = await waitForEpochAfter(depEpoch);

  // ---- shielded_transfer ×N ---------------------------------------------------
  console.log("\n-- shielded_transfer");
  const transferInput = (n: Note, idx: number, ep: number, salt: bigint) => {
    const amt = 100n, rNew = 777n + BigInt(idx);
    const { els, ind } = tree.path(idx);
    return {
      oldCommitment: s(n.c), newCommitment: s(H([1n, n.cum + amt, rNew, n.secret])), threshold: s(THRESHOLD), epochId: s(BigInt(ep)),
      nullifier: s(H([2n, n.secret, BigInt(ep), n.r])), txAmountHash: s(H([3n, amt, salt])), merkleRoot: s(tree.root),
      cumulativeOld: s(n.cum), cumulativeNew: s(n.cum + amt), txAmount: s(amt), randomnessOld: s(n.r), randomnessNew: s(rNew),
      userSecret: s(n.secret), salt: s(salt), pathElements: els.map(s), pathIndices: ind.map(s),
    };
  };
  let firstTransfer: { proof: Uint8Array; inputs: Uint8Array } | null = null;
  for (let i = 0; i < N_TRANSFERS; i++) {
    const p = await prove("transfer", transferInput(tNotes[i], i, epoch, 99n));
    firstTransfer ??= p;
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), vec(tx, p.proof), vec(tx, p.inputs), tx.object(CLOCK)] });
    await exec(`pool::shielded_transfer #${i + 1}`, tx);
  }

  // full verify via framework only (no Veil logic) — isolates the pairing cost
  tx = new Transaction();
  {
    const curve = tx.moveCall({ target: "0x2::groth16::bn254" });
    const pvk = tx.moveCall({ target: "0x2::groth16::prepare_verifying_key", arguments: [curve, vec(tx, vk.transfer)] });
    const pr = tx.moveCall({ target: "0x2::groth16::proof_points_from_bytes", arguments: [vec(tx, firstTransfer!.proof)] });
    const pi = tx.moveCall({ target: "0x2::groth16::public_proof_inputs_from_bytes", arguments: [vec(tx, firstTransfer!.inputs)] });
    tx.moveCall({ target: "0x2::groth16::verify_groth16_proof", arguments: [curve, pvk, pi, pr] });
  }
  await exec("ptb: prepare + verify_groth16_proof(transfer)", tx);

  // verify scaling: k full prepare+verify calls in one PTB (dry-run) — where does the
  // computation-bucket floor break? Answers how much headroom on-chain batching actually has.
  for (const k of [2, 4, 8, 16, 32, 64]) {
    const t = new Transaction();
    for (let j = 0; j < k; j++) {
      const curve = t.moveCall({ target: "0x2::groth16::bn254" });
      const pvk = t.moveCall({ target: "0x2::groth16::prepare_verifying_key", arguments: [curve, vec(t, vk.transfer)] });
      const pr = t.moveCall({ target: "0x2::groth16::proof_points_from_bytes", arguments: [vec(t, firstTransfer!.proof)] });
      const pi = t.moveCall({ target: "0x2::groth16::public_proof_inputs_from_bytes", arguments: [vec(t, firstTransfer!.inputs)] });
      t.moveCall({ target: "0x2::groth16::verify_groth16_proof", arguments: [curve, pvk, pi, pr] });
    }
    await dryRun(`ptb: ${k}x prepare+verify (dry-run)`, t);
  }
  // isolate VK preparation: 64x prepare_verifying_key alone (what storing a
  // PreparedVerifyingKey on the Pool — verifier.move's OPTIMIZATION NOTE — would save)
  {
    const t = new Transaction();
    for (let j = 0; j < 64; j++) {
      const curve = t.moveCall({ target: "0x2::groth16::bn254" });
      t.moveCall({ target: "0x2::groth16::prepare_verifying_key", arguments: [curve, vec(t, vk.transfer)] });
    }
    await dryRun("ptb: 64x prepare_verifying_key only (dry-run)", t);
  }

  // NEG: tampered txAmountHash (bytes 160..192) must abort E_INVALID_PROOF (3) before any state change
  {
    const bad = Uint8Array.from(firstTransfer!.inputs); bad[160] ^= 1;
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), vec(tx, firstTransfer!.proof), vec(tx, bad), tx.object(CLOCK)] });
    const r = await dryRun("NEG shielded_transfer tampered input (dry-run)", tx);
    probes.NEG = r.status === "failure" && /, 3\)/.test(r.error ?? "") ? `rejected as expected: ${r.error}` : `UNEXPECTED: ${r.status} ${r.error ?? ""}`;
  }

  // ---- compliant_transfer (BIND probe) ----------------------------------------
  console.log("\n-- compliant_transfer");
  {
    const tp = await prove("transfer", transferInput(cNote, N_TRANSFERS, epoch, 98n));
    const realTransferNullifier = BigInt(tp.signals[4]);
    const unrelatedNullifier = 424242n; // NOT the transfer proof's nullifier
    const ctx = H([6n, unrelatedNullifier, kycSecret]);
    const { els, ind } = credTree.path(0);
    const cp = await prove("compliance", {
      merkleRoot: s(credTree.root), currentEpoch: s(BigInt(epoch)), contextId: s(ctx), requiredKycLevel: "1",
      nullifier: s(H([5n, kycSecret, ctx])), validCredential: "1",
      userSecret: s(kycSecret), kycLevel: s(kycLevel), expiryEpoch: s(expiry), issuerId: s(issuer),
      pathElements: els.map(s), pathIndices: ind.map(s), transferNullifier: s(unrelatedNullifier),
    });
    const enc = new Uint8Array(93).fill(7);
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::compliance::compliant_transfer`, arguments: [tx.object(pool), tx.object(config), vec(tx, tp.proof), vec(tx, tp.inputs), vec(tx, cp.proof), vec(tx, cp.inputs), vec(tx, enc), tx.object(CLOCK)] });
    const r = await exec("compliance::compliant_transfer", tx, { expectFail: true });
    probes.BIND = r.effects?.status.status === "success"
      ? `ACCEPTED: transfer by secret=${cNote.secret} (nullifier ${realTransferNullifier}) carried a compliance proof from a different credential holder (secret=${kycSecret}) bound to unrelated transferNullifier=${unrelatedNullifier}. Tx ${r.digest}`
      : `rejected: ${r.effects?.status.error}`;
  }

  // ---- zk_withdraw (honest, then E7 probe) ------------------------------------
  console.log("\n-- zk_withdraw");
  const withdrawInput = (n: Note, recipient: bigint, amt = 100n) => {
    const rNew = 8888n + n.r;
    return {
      commitment: s(n.c), withdrawAmount: s(amt), nullifier: s(H([7n, n.secret, n.r, n.cum])), recipientHash: s(H([8n, recipient])),
      newCommitment: s(H([1n, n.cum - amt, rNew, n.secret])), cumulativeOld: s(n.cum), randomnessOld: s(n.r), userSecret: s(n.secret),
      recipient: s(recipient), randomnessNew: s(rNew),
    };
  };
  // recipient field element: the circuit takes it as a single field element; no address→field
  // encoding is specified anywhere in the repo, so we use a small stand-in value. The probe does
  // not depend on the encoding: the contract never recomputes recipientHash from `recipient`.
  {
    const p = await prove("withdraw", withdrawInput(wHonest, 0xABCDEFn));
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(pool), vec(tx, p.proof), vec(tx, p.inputs), tx.pure.address(me), tx.object(CLOCK)] });
    await exec("pool::zk_withdraw", tx);
  }
  {
    const victimRecipient = 0x1234n;
    const attacker = new Ed25519Keypair().toSuiAddress();
    const p = await prove("withdraw", withdrawInput(wVictim, victimRecipient));
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(pool), vec(tx, p.proof), vec(tx, p.inputs), tx.pure.address(attacker), tx.object(CLOCK)] });
    const r = await exec("E7 zk_withdraw proof(recipient=A) → pays B", tx, { expectFail: true });
    let got = "0";
    if (r.effects?.status.status === "success") {
      const bal = await client.getBalance({ owner: attacker, coinType: `${pkg}::token::TOKEN` });
      got = bal.totalBalance;
    }
    probes.E7 = r.effects?.status.status === "success"
      ? `ACCEPTED: proof bound to recipientHash=Poseidon(8, ${victimRecipient}) paid ${got} base units to unrelated address ${attacker}. Tx ${r.digest}`
      : `rejected: ${r.effects?.status.error}`;
  }

  // E4: withdraw 3x what this note deposited (pool holds other users' deposits)
  {
    const before = BigInt((await client.getBalance({ owner: me, coinType: `${pkg}::token::TOKEN` })).totalBalance);
    const p = await prove("withdraw", withdrawInput(wOver, 0xABCDEFn, 3n * DENOM));
    tx = new Transaction();
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(pool), vec(tx, p.proof), vec(tx, p.inputs), tx.pure.address(me), tx.object(CLOCK)] });
    const r = await exec("E4 zk_withdraw 3x the note's deposit", tx, { expectFail: true });
    const after = BigInt((await client.getBalance({ owner: me, coinType: `${pkg}::token::TOKEN` })).totalBalance);
    probes.E4 = r.effects?.status.status === "success"
      ? `ACCEPTED: note deposited ${DENOM} base units, withdrew ${after - before} (commitment claimed cumulativeOld=${3n * DENOM}; nothing on-chain ties it to the deposit). Tx ${r.digest}`
      : `rejected: ${r.effects?.status.error}`;
  }

  // ---- remaining admin ops ----------------------------------------------------
  console.log("\n-- admin ops");
  const adm = async (label: string, fn: string, extra: (t: Transaction) => any[]) => {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::pool::${fn}`, arguments: [t.object(pool), t.object(cap), ...extra(t)] });
    await exec(label, t);
  };
  await adm("pool::propose_vk_update", "propose_vk_update", (t) => [vec(t, vk.transfer), t.object(CLOCK)]);
  await adm("pool::cancel_vk_update", "cancel_vk_update", () => []);
  await adm("pool::propose_withdrawal", "propose_withdrawal", (t) => [t.pure.u64(1000), t.pure.address(me), t.object(CLOCK)]);
  await adm("pool::cancel_withdrawal", "cancel_withdrawal", () => []);
  await adm("pool::propose_compliance_toggle", "propose_compliance_toggle", (t) => [t.pure.bool(true), t.object(CLOCK)]);
  await adm("pool::cancel_compliance_toggle", "cancel_compliance_toggle", () => []);
  await adm("pool::freeze_pool", "freeze_pool", (t) => [t.object(CLOCK)]);
  await adm("pool::unfreeze_pool", "unfreeze_pool", () => []);
  {
    const t = new Transaction();
    t.moveCall({ target: `${pkg}::compliance::update_credential_root`, arguments: [t.object(config), t.object(cap), t.object(pool), vec(t, bytes32(credTree.root + 1n)), t.object(CLOCK)] });
    await exec("compliance::update_credential_root", t);
  }

  console.log("\n== probes");
  for (const [k, v] of Object.entries(probes)) console.log(`  ${k}: ${v}`);
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ sui: sv, gasPrice: Number(gasPrice), vkBytes: { transfer: vk.transfer.length, withdraw: vk.withdraw.length, compliance: vk.compliance.length }, rows, probes }, null, 2));
    console.log(`  wrote ${JSON_OUT}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
