#!/usr/bin/env bun
/**
 * gas-localnet.ts — Measure real on-chain gas for every Veil entry point against a local Sui
 * network, using real Groth16 proofs from the compiled circuits.
 *
 * Every number this prints comes from `effects.gasUsed` of a transaction that actually executed
 * on the local validator — nothing is estimated. Each verify-path transaction is executed
 * `--rounds` times on independent pools so run-to-run variance is visible.
 *
 * Usage (from repo root):
 *   sui start --with-faucet --force-regenesis &           # localnet RPC :9000, faucet :9123
 *   (cd scripts && bun install)
 *   bun run scripts/bench/gas-localnet.ts [--rounds 3] [--rpc http://127.0.0.1:9000] \
 *       [--faucet http://127.0.0.1:9123] [--json out.json]
 *
 * Prerequisites:
 *   - `sui` on PATH (used only for `sui move build --dump-bytecode-as-base64`).
 *   - circuits/build{,-withdraw,-compliance}/ artifacts (see circuits/scripts/compile*.sh).
 *
 * Besides the happy path it also measures what a REJECTED transaction costs its sender
 * (replayed proof, corrupted proof) and runs one binding probe: a `compliant_transfer` whose
 * compliance proof was produced by a *different* user, for an unrelated `transferNullifier`.
 * The probe's on-chain outcome is printed as-is (ACCEPTED / REJECTED).
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error snarkjs ships no types
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes } from "../src/proof-converter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const ROUNDS = Number(arg("rounds", "3"));
const RPC = arg("rpc", "http://127.0.0.1:9000");
const FAUCET = arg("faucet", "http://127.0.0.1:9123");
const JSON_OUT = arg("json", "");

const EPOCH_MS = 60_000; // pool.move minimum; keeps the timelock waits to ~1 minute
const THRESHOLD = 1_000_000_000n;
const DENOM_SMALL = 100_000_000n;
const GAS_BUDGET = 500_000_000;
const DEPTH = 20;
const CLOCK = "0x6";

// Domain tags — must match circuits/*.circom and scripts/bench/witnesses.mjs
const D_COMMIT = 1n, D_NULL = 2n, D_AMT = 3n, D_CRED = 4n, D_CNULL = 5n, D_CTX = 6n,
  D_WNULL = 7n, D_RCPT = 8n;

// ---------------------------------------------------------------------------
let H: (xs: bigint[]) => bigint;

function merkle(leaves: bigint[]) {
  // Sparse tree: empty node = 0 at every level, matching the zero-path witnesses the circuit
  // tests use. Only the root and per-leaf paths matter; the admin publishes the root.
  const levels: bigint[][] = [leaves.slice()];
  for (let d = 0; d < DEPTH; d++) {
    const cur = levels[d];
    const next: bigint[] = [];
    for (let i = 0; i < Math.max(1, Math.ceil(cur.length / 2)); i++) {
      next.push(H([cur[2 * i] ?? 0n, cur[2 * i + 1] ?? 0n]));
    }
    levels.push(next);
  }
  const root = levels[DEPTH][0];
  const path = (idx: number) => {
    const pathElements: bigint[] = [], pathIndices: bigint[] = [];
    let i = idx;
    for (let d = 0; d < DEPTH; d++) {
      pathElements.push(levels[d][i ^ 1] ?? 0n);
      pathIndices.push(BigInt(i & 1));
      i >>= 1;
    }
    return { pathElements, pathIndices };
  };
  return { root, path };
}

interface Note { secret: bigint; cum: bigint; rnd: bigint; commitment: bigint }
function note(secret: bigint, cum: bigint, rnd: bigint): Note {
  return { secret, cum, rnd, commitment: H([D_COMMIT, cum, rnd, secret]) };
}

const ART = {
  transfer: { wasm: "build/transfer_js/transfer.wasm", zkey: "build/transfer_final.zkey", vk: "build/transfer_vk.json" },
  withdraw: { wasm: "build-withdraw/withdraw_js/withdraw.wasm", zkey: "build-withdraw/withdraw_final.zkey", vk: "build-withdraw/withdraw_vk.json" },
  compliance: { wasm: "build-compliance/compliance_js/compliance.wasm", zkey: "build-compliance/compliance_final.zkey", vk: "build-compliance/compliance_vk.json" },
} as const;

async function prove(kind: keyof typeof ART, input: Record<string, unknown>) {
  const a = ART[kind];
  const str = JSON.parse(JSON.stringify(input, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(str, join(CIRCUITS, a.wasm), join(CIRCUITS, a.zkey), undefined, undefined, { singleThread: true });
  // No local snarkjs verify: under bun its multi-threaded curve never resolves. The on-chain
  // sui::groth16 verifier is the authoritative check — any happy-path abort throws in exec().
  return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals), signals: publicSignals as string[] };
}
const vkBytes = (k: keyof typeof ART) => vkToSuiBytes(JSON.parse(readFileSync(join(CIRCUITS, ART[k].vk), "utf-8")));

function transferInput(n: Note, txAmount: bigint, rndNew: bigint, salt: bigint, epoch: bigint,
  tree: ReturnType<typeof merkle>, idx: number) {
  const cumNew = n.cum + txAmount;
  return {
    oldCommitment: n.commitment,
    newCommitment: H([D_COMMIT, cumNew, rndNew, n.secret]),
    threshold: THRESHOLD, epochId: epoch,
    nullifier: H([D_NULL, n.secret, epoch, n.rnd]),
    txAmountHash: H([D_AMT, txAmount, salt]),
    merkleRoot: tree.root,
    cumulativeOld: n.cum, cumulativeNew: cumNew, txAmount, randomnessOld: n.rnd, randomnessNew: rndNew,
    userSecret: n.secret, salt, ...tree.path(idx),
  };
}

function complianceInput(secret: bigint, transferNullifier: bigint, epoch: bigint,
  credTree: ReturnType<typeof merkle>, idx: number, cred: { kyc: bigint; expiry: bigint; issuer: bigint }) {
  const contextId = H([D_CTX, transferNullifier, secret]);
  return {
    merkleRoot: credTree.root, currentEpoch: epoch, contextId, requiredKycLevel: 1n,
    nullifier: H([D_CNULL, secret, contextId]), validCredential: 1n,
    userSecret: secret, kycLevel: cred.kyc, expiryEpoch: cred.expiry, issuerId: cred.issuer,
    ...credTree.path(idx), transferNullifier,
  };
}

// ---------------------------------------------------------------------------
type Gas = { computationCost: string; storageCost: string; storageRebate: string; nonRefundableStorageFee: string };
interface Row { op: string; round: number; status: string; gasPrice: number; gas: Gas; digest: string }
const rows: Row[] = [];

let client: SuiGrpcClient;
let GAS_PRICE = 0;
let kp: Ed25519Keypair;

async function exec(op: string, round: number, build: (tx: Transaction) => void, expectFail = false) {
  const tx = new Transaction();
  tx.setGasBudget(GAS_BUDGET);
  build(tx);
  tx.setGasPrice(GAS_PRICE);
  let submit = tx;
  if (expectFail) {
    // The SDK's gRPC resolver dry-runs the full transaction and throws on abort before anything
    // reaches the chain. To measure what a rejected transaction really costs its sender, resolve
    // only the transaction kind, then attach gas data explicitly so no simulation runs.
    tx.setSender(kp.toSuiAddress());
    const kind = await tx.build({ client, onlyTransactionKind: true });
    submit = Transaction.fromKind(kind);
    submit.setSender(kp.toSuiAddress());
    submit.setGasBudget(GAS_BUDGET);
    submit.setGasPrice(GAS_PRICE);
    const coins: any = await client.listCoins({ owner: kp.toSuiAddress(), coinType: "0x2::sui::SUI" });
    const gasCoin = coins.objects.reduce((m: any, c: any) => (BigInt(c.balance) > BigInt(m.balance) ? c : m));
    submit.setGasPayment([{ objectId: gasCoin.objectId, version: gasCoin.version, digest: gasCoin.digest }]);
  }
  const out = await client.signAndExecuteTransaction({
    transaction: submit, signer: kp, include: { effects: true, objectTypes: true },
  });
  const res: any = out.Transaction ?? out.FailedTransaction;
  await client.waitForTransaction({ digest: res.digest });
  const ok = res.status.success === true;
  const err = ok ? "" : (res.status.error?.message ?? JSON.stringify(res.status.error));
  rows.push({ op, round, status: ok ? "success" : `failure: ${err}`, gasPrice: GAS_PRICE, gas: res.effects.gasUsed as Gas, digest: res.digest });
  if (!ok && !expectFail) throw new Error(`${op} failed: ${err}`);
  if (ok && expectFail) console.log(`  !! ${op}: expected failure but SUCCEEDED`);
  return { ...res, ok, err };
}
const created = (res: any, typeFrag: string) => {
  const c = res.effects.changedObjects.find((o: any) => o.idOperation === "Created" && (res.objectTypes[o.objectId] ?? "").includes(typeFrag));
  if (!c) throw new Error(`no created object matching ${typeFrag}`);
  return c.objectId as string;
};

async function chainEpoch(): Promise<bigint> {
  const o: any = await client.getObject({ objectId: CLOCK, include: { content: true } });
  const b: Uint8Array = o.object.content; // Clock { id: UID (32 bytes), timestamp_ms: u64 LE }
  let ms = 0n;
  for (let i = 7; i >= 0; i--) ms = (ms << 8n) | BigInt(b[32 + i]);
  return ms / BigInt(EPOCH_MS);
}
async function waitForEpoch(target: bigint) {
  for (;;) {
    const e = await chainEpoch();
    if (e >= target) return e;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const poseidon = await buildPoseidon();
  H = (xs) => poseidon.F.toObject(poseidon(xs)) as bigint;
  client = new SuiGrpcClient({ baseUrl: RPC, network: "localnet" });
  GAS_PRICE = Number((await client.getReferenceGasPrice()).referenceGasPrice);
  kp = new Ed25519Keypair();
  const me = kp.toSuiAddress();
  for (let i = 0; i < 4; i++) await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`sender ${me}, reference gas price ${GAS_PRICE} MIST/unit`);

  // --- publish ---------------------------------------------------------------------------
  const dump = JSON.parse(execFileSync("sui", ["move", "build", "--dump-bytecode-as-base64", "--no-tree-shaking", "--path", join(ROOT, "contracts")],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
  const pub = await exec("publish (package)", 0, (tx) => {
    const cap = tx.publish({ modules: dump.modules, dependencies: dump.dependencies });
    tx.transferObjects([cap], me);
  });
  const pkg = pub.effects.changedObjects.find((o: any) => o.outputState === "PackageWrite").objectId as string;
  const treasury = created(pub, "TreasuryCap");
  const T = (f: string) => `${pkg}::${f}` as `${string}::${string}::${string}`;
  const auditorKey = new Uint8Array(33).fill(2);
  const tvk = vkBytes("transfer"), wvk = vkBytes("withdraw"), cvk = vkBytes("compliance");
  console.log(`vk bytes: transfer ${tvk.length}, withdraw ${wvk.length}, compliance ${cvk.length}`);

  // --- per-round setup (independent pools so every round is a fresh, comparable state) ----
  interface R { pool: string; cap: string; cfg: string; notes: Note[]; tree: ReturnType<typeof merkle>; wNote: Note; wNote2: Note;
    credTree: ReturnType<typeof merkle>; creds: { kyc: bigint; expiry: bigint; issuer: bigint }[]; secrets: bigint[] }
  const rs: R[] = [];
  let minEpoch = 0n;
  for (let r = 0; r < ROUNDS; r++) {
    const mint = await exec("token_faucet::faucet", r, (tx) => tx.moveCall({ target: T("token_faucet::faucet"), arguments: [tx.object(treasury)] }));
    const coin = created(mint, "::token::TOKEN");
    const cp = await exec("pool::create_pool", r, (tx) => tx.moveCall({ target: T("pool::create_pool"),
      arguments: [tx.pure.vector("u8", Array.from(tvk)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] }));
    const pool = created(cp, "::pool::Pool"), cap = created(cp, "::pool::AdminCap");

    const base = BigInt(1000 * (r + 1));
    const A = 987654321n + base, B = 123456789n + base, W = 555555555n + base;
    // notes[0]: shielded_transfer, [1]: honest compliant_transfer (owner A), [2]: probe transfer (owner A),
    // [3]: replay target spends notes[0] again (no new note needed)
    const notes = [note(A, 0n, 11n + base), note(A, 0n, 22n + base), note(A, 0n, 33n + base)];
    const wNote = note(W, 500n, 44n + base), wNote2 = note(W, 500n, 55n + base);
    for (const [i, n] of [...notes, wNote, wNote2].entries()) {
      await exec("pool::deposit_and_register", r, (tx) => {
        const [c] = tx.splitCoins(tx.object(coin), [tx.pure.u64(DENOM_SMALL)]);
        tx.moveCall({ target: T("pool::deposit_and_register"), arguments: [tx.object(pool), c,
          tx.pure.vector("u8", Array.from(publicInputsToSuiBytes([n.commitment.toString()]))), tx.object(CLOCK)] });
      });
      void i;
    }
    const tree = merkle(notes.map((n) => n.commitment));
    await exec("pool::update_commitment_root", r, (tx) => tx.moveCall({ target: T("pool::update_commitment_root"),
      arguments: [tx.object(pool), tx.object(cap), tx.pure.vector("u8", Array.from(publicInputsToSuiBytes([tree.root.toString()]))), tx.object(CLOCK)] }));
    await exec("pool::propose_withdraw_vk", r, (tx) => tx.moveCall({ target: T("pool::propose_withdraw_vk"),
      arguments: [tx.object(pool), tx.object(cap), tx.pure.vector("u8", Array.from(wvk)), tx.object(CLOCK)] }));

    const e0 = await chainEpoch();
    const creds = [{ kyc: 2n, expiry: e0 + 10_000n, issuer: 42n }, { kyc: 2n, expiry: e0 + 10_000n, issuer: 42n }];
    const secrets = [A, B]; // credential 0 belongs to A (the transfer owner), credential 1 to B (a stranger)
    const credTree = merkle(secrets.map((s, i) => H([D_CRED, s, creds[i].kyc, creds[i].expiry, creds[i].issuer])));
    const cc = await exec("compliance::create_compliance_config", r, (tx) => tx.moveCall({ target: T("compliance::create_compliance_config"),
      arguments: [tx.object(cap), tx.object(pool), tx.pure.vector("u8", Array.from(cvk)),
        tx.pure.vector("u8", Array.from(publicInputsToSuiBytes([credTree.root.toString()]))), tx.pure.u64(1), tx.pure.vector("u8", Array.from(auditorKey))] }));
    const cfg = created(cc, "::compliance::ComplianceConfig");
    rs.push({ pool, cap, cfg, notes, tree, wNote, wNote2, credTree, creds, secrets });
    minEpoch = (await chainEpoch()) + 1n;
  }

  // --- wait out the 1-epoch timelocks + commitment maturity --------------------------------
  console.log(`waiting for pool epoch ${minEpoch} (timelocks, note maturity)...`);
  const epoch = await waitForEpoch(minEpoch);
  console.log(`epoch ${epoch} reached`);

  for (let r = 0; r < ROUNDS; r++) {
    const s = rs[r];
    const ep = await chainEpoch();
    // 1. shielded_transfer
    const t0 = await prove("transfer", transferInput(s.notes[0], 100n, 7001n + BigInt(r), 99n, ep, s.tree, 0));
    await exec("pool::shielded_transfer", r, (tx) => tx.moveCall({ target: T("pool::shielded_transfer"),
      arguments: [tx.object(s.pool), tx.pure.vector("u8", Array.from(t0.proof)), tx.pure.vector("u8", Array.from(t0.inputs)), tx.object(CLOCK)] }));
    // 2. replay of the same proof -> must abort
    await exec("REJECTED replay shielded_transfer", r, (tx) => tx.moveCall({ target: T("pool::shielded_transfer"),
      arguments: [tx.object(s.pool), tx.pure.vector("u8", Array.from(t0.proof)), tx.pure.vector("u8", Array.from(t0.inputs)), tx.object(CLOCK)] }), true);

    // 3. honest compliant_transfer: compliance proof by A, bound to A's real transfer nullifier
    const ep2 = await chainEpoch();
    const tin1 = transferInput(s.notes[1], 100n, 7101n + BigInt(r), 98n, ep2, s.tree, 1);
    const t1 = await prove("transfer", tin1);
    const c1 = await prove("compliance", complianceInput(s.secrets[0], tin1.nullifier, ep2, s.credTree, 0, s.creds[0]));
    const enc = new Uint8Array(65 + 12 + 8 + 16).fill(7); // ephemeral pubkey + IV + 8-byte ciphertext + GCM tag
    await exec("compliance::compliant_transfer", r, (tx) => tx.moveCall({ target: T("compliance::compliant_transfer"),
      arguments: [tx.object(s.pool), tx.object(s.cfg), tx.pure.vector("u8", Array.from(t1.proof)), tx.pure.vector("u8", Array.from(t1.inputs)),
        tx.pure.vector("u8", Array.from(c1.proof)), tx.pure.vector("u8", Array.from(c1.inputs)), tx.pure.vector("u8", Array.from(enc)), tx.object(CLOCK)] }));

    // 4. BINDING PROBE: A's transfer + a compliance proof made by stranger B for an unrelated nullifier
    const ep3 = await chainEpoch();
    const tin2 = transferInput(s.notes[2], 100n, 7201n + BigInt(r), 97n, ep3, s.tree, 2);
    const t2 = await prove("transfer", tin2);
    const unrelated = 31337n + BigInt(r);
    const c2 = await prove("compliance", complianceInput(s.secrets[1], unrelated, ep3, s.credTree, 1, s.creds[1]));
    const probe = await exec("PROBE compliant_transfer (foreign compliance proof)", r, (tx) => tx.moveCall({ target: T("compliance::compliant_transfer"),
      arguments: [tx.object(s.pool), tx.object(s.cfg), tx.pure.vector("u8", Array.from(t2.proof)), tx.pure.vector("u8", Array.from(t2.inputs)),
        tx.pure.vector("u8", Array.from(c2.proof)), tx.pure.vector("u8", Array.from(c2.inputs)), tx.pure.vector("u8", Array.from(enc)), tx.object(CLOCK)] }), true);
    console.log(`  round ${r} binding probe: ${probe.ok ? "ACCEPTED (compliance proof not bound to transfer)" : "REJECTED " + probe.err}`);

    // 5. zk_withdraw (partial: 100 out of 500, change note back to the pool)
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const recipient = BigInt(me) % P; // Sui addresses are 256-bit; the circuit sees them mod p
    const wInput = (w: Note, rndNew: bigint) => ({ commitment: w.commitment, withdrawAmount: 100n, nullifier: H([D_WNULL, w.secret, w.rnd, w.cum]),
      recipientHash: H([D_RCPT, recipient]), newCommitment: H([D_COMMIT, w.cum - 100n, rndNew, w.secret]),
      cumulativeOld: w.cum, randomnessOld: w.rnd, userSecret: w.secret, recipient, randomnessNew: rndNew });
    const wp = await prove("withdraw", wInput(s.wNote, 8001n + BigInt(r)));
    await exec("pool::zk_withdraw", r, (tx) => tx.moveCall({ target: T("pool::zk_withdraw"),
      arguments: [tx.object(s.pool), tx.pure.vector("u8", Array.from(wp.proof)), tx.pure.vector("u8", Array.from(wp.inputs)), tx.pure.address(me), tx.object(CLOCK)] }));

    // 6. corrupted proof (valid-looking points, wrong statement): pays full pairing cost then aborts
    const bad = wp.inputs.slice(); bad[32] ^= 1; // withdrawAmount 100 -> 101: proof no longer matches
    await exec("REJECTED zk_withdraw (proof/inputs mismatch)", r, (tx) => tx.moveCall({ target: T("pool::zk_withdraw"),
      arguments: [tx.object(s.pool), tx.pure.vector("u8", Array.from(wp.proof)), tx.pure.vector("u8", Array.from(bad)), tx.pure.address(me), tx.object(CLOCK)] }), true);

    // 6b. RECIPIENT PROBE: proof made for recipient = sender, submitted with a different address
    //     (what a mempool front-runner / colluding relayer would do)
    const wp2 = await prove("withdraw", wInput(s.wNote2, 8101n + BigInt(r)));
    const thief = new Ed25519Keypair().toSuiAddress();
    const wprobe = await exec("PROBE zk_withdraw (recipient swapped)", r, (tx) => tx.moveCall({ target: T("pool::zk_withdraw"),
      arguments: [tx.object(s.pool), tx.pure.vector("u8", Array.from(wp2.proof)), tx.pure.vector("u8", Array.from(wp2.inputs)), tx.pure.address(thief), tx.object(CLOCK)] }), true);
    console.log(`  round ${r} recipient probe: ${wprobe.ok ? `ACCEPTED (100 units paid to ${thief}, not to the proven recipient)` : "REJECTED " + wprobe.err}`);

    // 7. admin ops
    await exec("pool::freeze_pool", r, (tx) => tx.moveCall({ target: T("pool::freeze_pool"), arguments: [tx.object(s.pool), tx.object(s.cap), tx.object(CLOCK)] }));
    await exec("pool::unfreeze_pool", r, (tx) => tx.moveCall({ target: T("pool::unfreeze_pool"), arguments: [tx.object(s.pool), tx.object(s.cap)] }));
    await exec("pool::propose_vk_update", r, (tx) => tx.moveCall({ target: T("pool::propose_vk_update"),
      arguments: [tx.object(s.pool), tx.object(s.cap), tx.pure.vector("u8", Array.from(tvk)), tx.object(CLOCK)] }));
  }

  // --- report ---------------------------------------------------------------------------
  const by = new Map<string, Row[]>();
  for (const row of rows) by.set(row.op, [...(by.get(row.op) ?? []), row]);
  const n = (s: string) => Number(s);
  console.log("\n| op | n | status | gas price | computation (MIST) | comp. units | storage (MIST) | rebate (MIST) | net (MIST) |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const [op, rr] of by) {
    const fmt = (f: (x: Row) => number) => {
      const v = rr.map(f); const lo = Math.min(...v), hi = Math.max(...v);
      return lo === hi ? `${lo}` : `${lo}–${hi}`;
    };
    const statuses = [...new Set(rr.map((x) => x.status.startsWith("success") ? "success" : x.status.replace(/^failure: /, "abort: ").slice(0, 80)))].join("; ");
    console.log(`| ${op} | ${rr.length} | ${statuses} | ${fmt((x) => x.gasPrice)} | ${fmt((x) => n(x.gas.computationCost))} | ${fmt((x) => n(x.gas.computationCost) / x.gasPrice)} | ${fmt((x) => n(x.gas.storageCost))} | ${fmt((x) => n(x.gas.storageRebate))} | ${fmt((x) => n(x.gas.computationCost) + n(x.gas.storageCost) - n(x.gas.storageRebate))} |`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
