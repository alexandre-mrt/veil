/**
 * gas.ts — Measure real on-chain gas for every Veil entry point on a local Sui network.
 *
 * Executes (not dry-runs) real transactions with real Groth16 proofs against a freshly
 * published copy of `contracts/`, and records `effects.gasUsed` for each call. Also runs one
 * adversarial check: replaying a valid zk_withdraw proof with a *different* `recipient`
 * argument than the one the proof's recipientHash commits to (threat-model.md E7).
 *
 * Prerequisites
 *   - `sui` CLI on PATH (or SUI_BIN=/path/to/sui), same framework rev as contracts/Move.toml
 *   - a running localnet:  sui start --with-faucet --force-regenesis
 *   - circuits compiled:   circuits/build, circuits/build-withdraw, circuits/build-compliance
 *   - deps:                (cd scripts && bun install)
 *   - a client env for the CLI's package resolver: sui client new-env --alias local
 *                          --rpc http://127.0.0.1:9000 && sui client switch --env local
 *
 * Usage (Node >= 22.18 — runs the .ts directly via type stripping; do NOT use `bun run`:
 * under bun, snarkjs.groth16.fullProve never settles and the process exits 0 silently)
 *   cd scripts && node bench/gas.ts [--rpc http://127.0.0.1:9000] [--faucet http://127.0.0.1:9123]
 *                                   [--runs 3] [--json out.json]
 *
 * Pool epochs are set to the contract minimum (60 s) so the 1-epoch maturity / timelock rules
 * can be satisfied in ~2 minutes of wall-clock. Gas does not depend on epoch length.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildPoseidon } from "circomlibjs";
// @ts-expect-error snarkjs has no TypeScript declarations
import * as snarkjs from "snarkjs";

import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes, bigintToLE32, R } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const C = join(ROOT, "circuits");
const ART = {
  transfer: { wasm: join(C, "build/transfer_js/transfer.wasm"), zkey: join(C, "build/transfer_final.zkey"), vk: join(C, "build/transfer_vk.json") },
  withdraw: { wasm: join(C, "build-withdraw/withdraw_js/withdraw.wasm"), zkey: join(C, "build-withdraw/withdraw_final.zkey"), vk: join(C, "build-withdraw/withdraw_vk.json") },
  compliance: { wasm: join(C, "build-compliance/compliance_js/compliance.wasm"), zkey: join(C, "build-compliance/compliance_final.zkey"), vk: join(C, "build-compliance/compliance_vk.json") },
};

const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123");
const RUNS = Number(arg("--runs", "3"));
const JSON_OUT = arg("--json", "");
const SUI = process.env.SUI_BIN ?? "sui";

const EPOCH_MS = 60_000;
const THRESHOLD = 1_000_000_000n;
const DENOM = 100_000_000n; // DENOM_SMALL
const DEPTH = 20;
const CLOCK = "0x6";
const D = { COMMIT: 1n, NULL: 2n, TXAMT: 3n, CRED: 4n, CNULL: 5n, CTX: 6n, WNULL: 7n, RECIP: 8n };

const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" });
const kp = new Ed25519Keypair();
const me = kp.toSuiAddress();
let poseidon: any;
const H = (xs: bigint[]): bigint => poseidon.F.toObject(poseidon(xs));

type Gas = { computationCost: string; storageCost: string; storageRebate: string; nonRefundableStorageFee: string };
const rows: { op: string; run: number; gas: Gas; digest: string; status: string }[] = [];
let rgp = 1000n;

async function exec(op: string, run: number, build: (tx: Transaction) => void, expectFail = false) {
  const tx = new Transaction();
  tx.setGasBudget(2_000_000_000);
  build(tx);
  const res = await client.signAndExecuteTransaction({
    transaction: tx, signer: kp,
    options: { showEffects: true, showObjectChanges: true, showBalanceChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const status = res.effects!.status.status;
  const g = res.effects!.gasUsed as Gas;
  rows.push({ op, run, gas: g, digest: res.digest, status });
  const total = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
  console.log(`[gas] ${op.padEnd(32)} run=${run} status=${status} computation=${g.computationCost} storage=${g.storageCost} rebate=${g.storageRebate} net=${total}${status !== "success" ? " err=" + res.effects!.status.error : ""}`);
  if (status !== "success" && !expectFail) throw new Error(`${op} failed: ${res.effects!.status.error}`);
  return res;
}

const created = (res: any, frag: string): string =>
  res.objectChanges.find((c: any) => c.type === "created" && c.objectType.includes(frag)).objectId;

async function prove(kind: keyof typeof ART, input: Record<string, any>) {
  const s: Record<string, any> = {};
  for (const [k, v] of Object.entries(input)) s[k] = Array.isArray(v) ? v.map(String) : String(v);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(s, ART[kind].wasm, ART[kind].zkey);
  const vk = JSON.parse(readFileSync(ART[kind].vk, "utf-8"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${kind}: local verify failed`);
  return { proof: proofToSuiBytes(proof), inputs: publicInputsToSuiBytes(publicSignals), signals: publicSignals as string[] };
}

/** Sparse depth-20 tree: leaves at indices 0..n-1, every other node treated as 0 (matches the
 *  0-sibling convention used by the circuit test witnesses). Returns root + per-leaf paths. */
function tree(leaves: bigint[]) {
  let level = [...leaves];
  const paths = leaves.map(() => ({ el: [] as bigint[], ix: [] as bigint[] }));
  const pos = leaves.map((_, i) => i);
  for (let d = 0; d < DEPTH; d++) {
    if (level.length % 2) level.push(0n);
    leaves.forEach((_, li) => {
      const p = pos[li];
      paths[li].el.push(level[p ^ 1]);
      paths[li].ix.push(BigInt(p & 1));
      pos[li] = p >> 1;
    });
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(H([level[i], level[i + 1]]));
    level = next;
  }
  return { root: level[0], paths };
}

const nowEpoch = async () => BigInt(Math.floor(Number((await client.getObject({ id: CLOCK, options: { showContent: true } })).data!.content!.fields.timestamp_ms) / EPOCH_MS));
async function waitEpoch(target: bigint) {
  for (;;) {
    const e = await nowEpoch();
    if (e >= target) return e;
    console.log(`[wait] pool epoch ${e} < ${target} …`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function main() {
  poseidon = await buildPoseidon();
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: me });
  rgp = BigInt(await client.getReferenceGasPrice());
  console.log(`[env] rpc=${RPC} sender=${me} reference_gas_price=${rgp} runs=${RUNS}`);
  console.log(`[env] sui: ${execFileSync(SUI, ["--version"], { encoding: "utf-8" }).trim()}`);

  // ── publish ────────────────────────────────────────────────────────────────
  const built = JSON.parse(execFileSync(SUI, ["move", "build", "--dump-bytecode-as-base64", "--build-env", "testnet", "--path", join(ROOT, "contracts")], { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] }));
  const pub = await exec("publish", 0, (tx) => {
    const cap = tx.publish({ modules: built.modules, dependencies: built.dependencies });
    tx.transferObjects([cap], me);
  });
  const pkg = (pub.objectChanges as any[]).find((c) => c.type === "published").packageId;
  const treasury = created(pub, "TreasuryCap");
  const T = (m: string) => `${pkg}::${m}`;

  const vkT = vkToSuiBytes(JSON.parse(readFileSync(ART.transfer.vk, "utf-8")));
  const vkW = vkToSuiBytes(JSON.parse(readFileSync(ART.withdraw.vk, "utf-8")));
  const vkC = vkToSuiBytes(JSON.parse(readFileSync(ART.compliance.vk, "utf-8")));
  console.log(`[env] vk bytes: transfer=${vkT.length} withdraw=${vkW.length} compliance=${vkC.length}`);

  const cp = await exec("create_pool", 0, (tx) => tx.moveCall({ target: T("pool::create_pool"), arguments: [tx.pure.vector("u8", [...vkT]), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] }));
  const pool = created(cp, "::pool::Pool");
  const admin = created(cp, "::pool::AdminCap");

  // ── per-run secrets: 2 transfer UTXOs (plain + compliant), 2 withdraw UTXOs (honest + redirected)
  type U = { secret: bigint; cum: bigint; r: bigint; c: bigint };
  const mk = (secret: bigint, cum: bigint, r: bigint): U => ({ secret, cum, r, c: H([D.COMMIT, cum, r, secret]) });
  const runs = Array.from({ length: RUNS }, (_, i) => {
    const b = BigInt(1000 * (i + 1));
    return { t: mk(b + 1n, 0n, 0n), ct: mk(b + 2n, 0n, 0n), w: mk(b + 3n, DENOM, b + 30n), wa: mk(b + 4n, DENOM, b + 40n) };
  });

  // mint once per 10 deposits (faucet mints 1000 TOKEN = 10 × DENOM_SMALL)
  const deposits = runs.flatMap((r) => [r.t, r.ct, r.w, r.wa]);
  let coins: string[] = [];
  for (let i = 0; i < Math.ceil(deposits.length / 10); i++) {
    const m = await exec("token_faucet::faucet", i, (tx) => tx.moveCall({ target: T("token_faucet::faucet"), arguments: [tx.object(treasury)] }));
    coins.push(created(m, "::token::TOKEN"));
  }
  for (let i = 0; i < deposits.length; i++) {
    const coin = coins[Math.floor(i / 10)];
    await exec("deposit_and_register", i, (tx) => {
      const [c] = tx.splitCoins(tx.object(coin), [tx.pure.u64(DENOM)]);
      tx.moveCall({ target: T("pool::deposit_and_register"), arguments: [tx.object(pool), c, tx.pure.vector("u8", [...bigintToLE32(deposits[i].c)]), tx.object(CLOCK)] });
    });
  }

  // ── admin setup (all 1-epoch timelocked) ────────────────────────────────────
  const leaves = runs.flatMap((r) => [r.t.c, r.ct.c]);
  const tr = tree(leaves);
  await exec("update_commitment_root", 0, (tx) => tx.moveCall({ target: T("pool::update_commitment_root"), arguments: [tx.object(pool), tx.object(admin), tx.pure.vector("u8", [...bigintToLE32(tr.root)]), tx.object(CLOCK)] }));
  await exec("propose_withdraw_vk", 0, (tx) => tx.moveCall({ target: T("pool::propose_withdraw_vk"), arguments: [tx.object(pool), tx.object(admin), tx.pure.vector("u8", [...vkW]), tx.object(CLOCK)] }));

  // credential tree: one leaf per run (each compliant transfer needs its own credential nullifier)
  const KYC = 2n, ISSUER = 42n;
  const e0 = await nowEpoch();
  const EXPIRY = e0 + 10_000n;
  const credLeaves = runs.map((r) => H([D.CRED, r.ct.secret, KYC, EXPIRY, ISSUER]));
  const ctree = tree(credLeaves);
  const auditorKey = new Uint8Array(33).fill(2);
  const cc = await exec("create_compliance_config", 0, (tx) => tx.moveCall({ target: T("compliance::create_compliance_config"), arguments: [tx.object(admin), tx.object(pool), tx.pure.vector("u8", [...vkC]), tx.pure.vector("u8", [...bigintToLE32(ctree.root)]), tx.pure.u64(1), tx.pure.vector("u8", [...auditorKey])] }));
  const config = created(cc, "::compliance::ComplianceConfig");

  // cheap admin ops, measured in a self-cancelling pair so they leave no pending state behind
  await exec("propose_vk_update", 0, (tx) => tx.moveCall({ target: T("pool::propose_vk_update"), arguments: [tx.object(pool), tx.object(admin), tx.pure.vector("u8", [...vkT]), tx.object(CLOCK)] }));
  await exec("cancel_vk_update", 0, (tx) => tx.moveCall({ target: T("pool::cancel_vk_update"), arguments: [tx.object(pool), tx.object(admin)] }));

  // ── wait one pool epoch: deposits mature, root + withdraw VK become active ───
  const epoch = await waitEpoch(e0 + 1n);
  // stay clear of an epoch boundary while proving (proof epoch may be current or previous)
  console.log(`[env] executing proofs in pool epoch ${epoch}`);

  const attacker = new Ed25519Keypair().toSuiAddress();
  const recipientField = (a: string) => BigInt(a) % R;

  for (let i = 0; i < RUNS; i++) {
    const r = runs[i];
    const ep = await nowEpoch();

    // shielded_transfer
    {
      const u = r.t, amt = 100n, rNew = u.secret * 7n, salt = 99n;
      const li = 2 * i;
      const inp = {
        oldCommitment: u.c, newCommitment: H([D.COMMIT, u.cum + amt, rNew, u.secret]), threshold: THRESHOLD, epochId: ep,
        nullifier: H([D.NULL, u.secret, ep, u.r]), txAmountHash: H([D.TXAMT, amt, salt]), merkleRoot: tr.root,
        cumulativeOld: u.cum, cumulativeNew: u.cum + amt, txAmount: amt, randomnessOld: u.r, randomnessNew: rNew, userSecret: u.secret, salt,
        pathElements: tr.paths[li].el, pathIndices: tr.paths[li].ix,
      };
      const p = await prove("transfer", inp);
      await exec("shielded_transfer", i, (tx) => tx.moveCall({ target: T("pool::shielded_transfer"), arguments: [tx.object(pool), tx.pure.vector("u8", [...p.proof]), tx.pure.vector("u8", [...p.inputs]), tx.object(CLOCK)] }));
    }

    // compliance::compliant_transfer (transfer proof + compliance proof)
    {
      const u = r.ct, amt = 100n, rNew = u.secret * 7n, salt = 77n;
      const li = 2 * i + 1;
      const transferNullifier = H([D.NULL, u.secret, ep, u.r]);
      const tp = await prove("transfer", {
        oldCommitment: u.c, newCommitment: H([D.COMMIT, u.cum + amt, rNew, u.secret]), threshold: THRESHOLD, epochId: ep,
        nullifier: transferNullifier, txAmountHash: H([D.TXAMT, amt, salt]), merkleRoot: tr.root,
        cumulativeOld: u.cum, cumulativeNew: u.cum + amt, txAmount: amt, randomnessOld: u.r, randomnessNew: rNew, userSecret: u.secret, salt,
        pathElements: tr.paths[li].el, pathIndices: tr.paths[li].ix,
      });
      const contextId = H([D.CTX, transferNullifier, u.secret]);
      const cp2 = await prove("compliance", {
        merkleRoot: ctree.root, currentEpoch: ep, contextId, requiredKycLevel: 1n,
        nullifier: H([D.CNULL, u.secret, contextId]), validCredential: 1n,
        userSecret: u.secret, kycLevel: KYC, expiryEpoch: EXPIRY, issuerId: ISSUER,
        pathElements: ctree.paths[i].el, pathIndices: ctree.paths[i].ix, transferNullifier,
      });
      const enc = new Uint8Array(93).fill(0xab); // ECIES envelope stand-in: contract only checks length ≥ 93
      await exec("compliant_transfer", i, (tx) => tx.moveCall({ target: T("compliance::compliant_transfer"), arguments: [tx.object(pool), tx.object(config), tx.pure.vector("u8", [...tp.proof]), tx.pure.vector("u8", [...tp.inputs]), tx.pure.vector("u8", [...cp2.proof]), tx.pure.vector("u8", [...cp2.inputs]), tx.pure.vector("u8", [...enc]), tx.object(CLOCK)] }));
    }

    // zk_withdraw — honest: proof's recipient = the address we pass
    const withdrawInput = (u: U, recipient: string) => {
      const amt = 40_000_000n, rNew = u.secret * 11n, rf = recipientField(recipient);
      return {
        commitment: u.c, withdrawAmount: amt, nullifier: H([D.WNULL, u.secret, u.r, u.cum]), recipientHash: H([D.RECIP, rf]),
        newCommitment: H([D.COMMIT, u.cum - amt, rNew, u.secret]),
        cumulativeOld: u.cum, randomnessOld: u.r, userSecret: u.secret, recipient: rf, randomnessNew: rNew,
      };
    };
    {
      const p = await prove("withdraw", withdrawInput(r.w, me));
      await exec("zk_withdraw", i, (tx) => tx.moveCall({ target: T("pool::zk_withdraw"), arguments: [tx.object(pool), tx.pure.vector("u8", [...p.proof]), tx.pure.vector("u8", [...p.inputs]), tx.pure.address(me), tx.object(CLOCK)] }));
    }
    // zk_withdraw — E7 check: proof commits to `me`, transaction pays `attacker`
    {
      const p = await prove("withdraw", withdrawInput(r.wa, me));
      const res = await exec("zk_withdraw[recipient≠proof]", i, (tx) => tx.moveCall({ target: T("pool::zk_withdraw"), arguments: [tx.object(pool), tx.pure.vector("u8", [...p.proof]), tx.pure.vector("u8", [...p.inputs]), tx.pure.address(attacker), tx.object(CLOCK)] }), true);
      const bc = (res.balanceChanges ?? []).filter((b: any) => b.coinType.includes("::token::TOKEN"));
      const ok = res.effects!.status.status === "success";
      console.log(`[E7] ${ok ? "VIOLATED — redirected withdrawal ACCEPTED" : "holds — redirected withdrawal rejected"} ; proof recipientHash=Poseidon(8, ${me.slice(0, 10)}…) ; tx recipient=${attacker.slice(0, 10)}… ; status=${res.effects!.status.status} ; TOKEN balance changes=${JSON.stringify(bc.map((b: any) => ({ owner: b.owner, amount: b.amount })))}`);
    }
  }

  // ── groth16 cost decomposition (scripts/bench/groth16-gas fixture package) ──
  {
    const b = JSON.parse(execFileSync(SUI, ["move", "build", "--dump-bytecode-as-base64", "--build-env", "testnet", "--path", join(__dirname, "groth16-gas")], { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] }));
    const pr = await exec("groth16-gas: publish", 0, (tx) => { const cap = tx.publish({ modules: b.modules, dependencies: b.dependencies }); tx.transferObjects([cap], me); });
    const gp = (pr.objectChanges as any[]).find((c) => c.type === "published").packageId;
    const ep = await nowEpoch();
    const u = mk(999_999n, 0n, 0n), amt = 100n, rNew = 5n, salt = 1n;
    const one = tree([u.c]);
    const p = await prove("transfer", {
      oldCommitment: u.c, newCommitment: H([D.COMMIT, amt, rNew, u.secret]), threshold: THRESHOLD, epochId: ep,
      nullifier: H([D.NULL, u.secret, ep, u.r]), txAmountHash: H([D.TXAMT, amt, salt]), merkleRoot: one.root,
      cumulativeOld: 0n, cumulativeNew: amt, txAmount: amt, randomnessOld: 0n, randomnessNew: rNew, userSecret: u.secret, salt,
      pathElements: one.paths[0].el, pathIndices: one.paths[0].ix,
    });
    const A = (tx: Transaction) => [tx.pure.vector("u8", [...vkT]), tx.pure.vector("u8", [...p.proof]), tx.pure.vector("u8", [...p.inputs])];
    const sp = await exec("groth16-gas: store_prepared", 0, (tx) => tx.moveCall({ target: `${gp}::bench::store_prepared`, arguments: [tx.pure.vector("u8", [...vkT])] }));
    const prepObj = created(sp, "::bench::Prepared");
    for (let i = 0; i < RUNS; i++) {
      for (const fn of ["noop", "prepare_only", "prepare_and_verify"]) await exec(`groth16-gas: ${fn}`, i, (tx) => tx.moveCall({ target: `${gp}::bench::${fn}`, arguments: A(tx) }));
      for (const fn of ["noop_shared", "verify_prepared"]) await exec(`groth16-gas: ${fn}`, i, (tx) => tx.moveCall({ target: `${gp}::bench::${fn}`, arguments: [tx.object(prepObj), ...A(tx)] }));
    }
    // Sweep: n repetitions in one tx, to see where each step crosses a computation bucket.
    for (const n of [1, 2, 4, 8, 16, 32, 64, 128]) {
      for (const fn of ["noop_n", "prepare_only_n", "prepare_and_verify_n"]) await exec(`sweep: ${fn}(n=${n})`, 0, (tx) => tx.moveCall({ target: `${gp}::bench::${fn}`, arguments: [...A(tx), tx.pure.u64(n)] }));
      await exec(`sweep: verify_prepared_n(n=${n})`, 0, (tx) => tx.moveCall({ target: `${gp}::bench::verify_prepared_n`, arguments: [tx.object(prepObj), tx.pure.vector("u8", [...p.proof]), tx.pure.vector("u8", [...p.inputs]), tx.pure.u64(n)] }));
    }
  }

  // ── summary ────────────────────────────────────────────────────────────────
  console.log(`\n[summary] reference gas price = ${rgp} MIST/unit; costs below in MIST (1 SUI = 1e9 MIST)`);
  console.log(`| entry point | n | computation (MIST) | computation units | storage cost | storage rebate | net (MIST) |`);
  console.log(`|---|---|---|---|---|---|---|`);
  const ops = [...new Set(rows.map((r) => r.op))];
  for (const op of ops) {
    const rs = rows.filter((r) => r.op === op && r.status === "success");
    if (!rs.length) continue;
    const uniq = (f: (g: Gas) => bigint) => [...new Set(rs.map((r) => f(r.gas).toString()))].join(" / ");
    console.log(`| ${op} | ${rs.length} | ${uniq((g) => BigInt(g.computationCost))} | ${uniq((g) => BigInt(g.computationCost) / rgp)} | ${uniq((g) => BigInt(g.storageCost))} | ${uniq((g) => BigInt(g.storageRebate))} | ${uniq((g) => BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate))} |`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ rpc: RPC, rgp: rgp.toString(), rows }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error("[FATAL]", e); process.exit(1); });
