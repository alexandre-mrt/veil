#!/usr/bin/env bun
/**
 * gas-localnet.ts — on-chain gas per Veil entry point, measured on a local Sui network.
 *
 * Every number is the `effects.gasUsed` of a real transaction executed by `sui client` against
 * `sui start --force-regenesis --with-faucet`. Nothing is estimated.
 *
 * What it does NOT measure: successful proof verification. circom/ptau are not needed for
 * the "garbage-proof" rows — see the report. Those rows execute shielded_transfer / zk_withdraw
 * with a structurally valid (on-curve, canonical) but random VK + proof + public inputs. The
 * transaction aborts with E_INVALID_PROOF *after* the full prepare_verifying_key +
 * verify_groth16_proof pair has run, and Sui charges computation gas for aborted transactions,
 * so the computation component is the real cost of the verification path up to the abort.
 * It excludes the post-verify state writes (nullifier / commitment dynamic fields).
 *
 * Usage (from repo root):
 *   SUI_BIN=/path/to/sui bun run scripts/bench/gas-localnet.ts [--runs N]
 * Prereq: `sui start --force-regenesis --with-faucet` running, `sui client switch --env local`,
 *   and `sui client faucet` already called for the active address.
 */
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
// @ts-ignore — ffjavascript ships no types
import { getCurveFromName } from "ffjavascript";
import { compressG1, compressG2, bigintToLE32 } from "../src/proof-converter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SUI = process.env.SUI_BIN ?? "sui";
const RUNS = (() => {
  const i = process.argv.indexOf("--runs");
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 5;
})();
const BUDGET = "500000000";

function sui(args: string[], cwd = ROOT): any {
  let out: string;
  try {
    out = execFileSync(SUI, args, { cwd, encoding: "utf-8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    out = (e.stdout ?? "") as string;
    if (!out.includes("{")) throw new Error(`sui ${args.slice(0, 3).join(" ")} failed: ${(e.stderr ?? "").toString().slice(0, 600)}`);
  }
  try {
    return JSON.parse(out.slice(out.indexOf("{")));
  } catch {
    throw new Error(`non-JSON from sui ${args.slice(0, 5).join(" ")}:\n${out.slice(0, 1500)}`);
  }
}

interface Gas { computation: number; storage: number; rebate: number; net: number; status: string }
function gasOf(tx: any): Gas {
  const g = tx.effects.gasUsed;
  const computation = Number(g.computationCost), storage = Number(g.storageCost), rebate = Number(g.storageRebate);
  return { computation, storage, rebate, net: computation + storage - rebate, status: tx.effects.status.status };
}

const rows: { name: string; runs: Gas[] }[] = [];
function record(name: string, g: Gas) {
  let r = rows.find((x) => x.name === name);
  if (!r) rows.push((r = { name, runs: [] }));
  r.runs.push(g);
  console.log(`[gas] ${name} status=${g.status} computation=${g.computation} storage=${g.storage} rebate=${g.rebate} net=${g.net}`);
}

function call(pkg: string, mod: string, fn: string, args: string[], name: string): any {
  let tx: any;
  try {
    tx = sui(["client", "call", "--package", pkg, "--module", mod, "--function", fn,
      ...(args.length ? ["--args", ...args] : []), "--gas-budget", BUDGET, "--json"]);
  } catch (e: any) {
    // An aborted transaction is still executed and charged; the CLI prints only its digest.
    const m = /Error executing transaction '([A-Za-z0-9]+)'.*?(abort[^\n]*)/s.exec(String(e.message));
    if (!m) throw e;
    console.log(`[abort] ${m[2].slice(0, 160)}`);
    tx = sui(["client", "tx-block", m[1], "--json"]);
  }
  record(name, gasOf(tx));
  return tx;
}
const created = (tx: any, frag: string) =>
  tx.objectChanges.find((c: any) => c.type === "created" && c.objectType.includes(frag))?.objectId;
const vecArg = (b: Uint8Array) => `[${Array.from(b).join(",")}]`;

// ---- valid-but-random Groth16 material (on-curve points, canonical scalars) --------------
const curve = await getCurveFromName("bn128", true);
const { G1, G2, Fr } = curve;
const rnd = () => Fr.e(BigInt("0x" + randomBytes(32).toString("hex")));
const g1 = () => { const [x, y] = G1.toObject(G1.toAffine(G1.timesFr(G1.g, rnd()))); return compressG1(x, y); };
const g2 = () => {
  const [[x0, x1], [y0, y1]] = G2.toObject(G2.toAffine(G2.timesFr(G2.g, rnd())));
  return compressG2(x0, x1, y0, y1);
};
function fakeVk(nPublic: number): Uint8Array {
  const len = new Uint8Array(8); len[0] = nPublic + 1;
  return Buffer.concat([g1(), g2(), g2(), g2(), len, ...Array.from({ length: nPublic + 1 }, g1)]);
}
const fakeProof = () => Buffer.concat([g1(), g2(), g1()]);
const scalar = (v: bigint) => bigintToLE32(v);
const randScalar = () => scalar(BigInt("0x" + randomBytes(8).toString("hex")));

// ---- run ---------------------------------------------------------------------------------
console.log(`sui: ${execFileSync(SUI, ["--version"], { encoding: "utf-8" }).trim()}`);
const gp = sui(["client", "test-publish", "--build-env", "testnet", "--pubfile-path", join(mkdtempSync(join(tmpdir(), "veil-gas-")), "Pub.local.toml"), "--gas-budget", BUDGET, "--json"], join(ROOT, "contracts"));
record("publish (whole package)", gasOf(gp));
const pkg = gp.objectChanges.find((c: any) => c.type === "published").packageId;
const treasury = created(gp, "TreasuryCap");
console.log(`package=${pkg} treasury=${treasury}`);

const FAR = "1000000000000000"; // epoch length (ms) so large the pool stays in epoch 0
const THRESHOLD = 1_000_000_000;
const poolTx = call(pkg, "pool", "create_pool", [vecArg(fakeVk(7)), String(THRESHOLD), FAR], "create_pool");
const pool = created(poolTx, "::pool::Pool");
const cap = created(poolTx, "::pool::AdminCap");
// second pool with the minimum 60 s epoch, for the timelocked withdraw-VK path
const poolBTx = call(pkg, "pool", "create_pool", [vecArg(fakeVk(7)), String(THRESHOLD), "60000"], "create_pool");
const poolB = created(poolBTx, "::pool::Pool");
const capB = created(poolBTx, "::pool::AdminCap");

for (let i = 0; i < RUNS; i++) {
  const f = call(pkg, "token_faucet", "faucet", [treasury], "token_faucet::faucet");
  const coin = created(f, "::token::TOKEN");
  // split a 100-token standard denomination and deposit it (one PTB so we measure deposit alone is not
  // possible via `client call`; use `client ptb` for split + deposit).
  const ptb = sui(["client", "ptb",
    "--split-coins", `@${coin}`, "[100000000]", "--assign", "d",
    "--move-call", `${pkg}::pool::deposit_and_register`, `@${pool}`, "d", `vector[${Array.from(randomBytes(32)).join(",")}]`, "@0x6", "--gas-budget", BUDGET, "--json"]);
  record("deposit_and_register (split+deposit PTB; leaf #" + (i + 1) + ")", gasOf(ptb));
}

for (let i = 0; i < RUNS; i++) {
  call(pkg, "pool", "freeze_pool", [pool, cap, "0x6"], "freeze_pool");
  call(pkg, "pool", "unfreeze_pool", [pool, cap], "unfreeze_pool");
  call(pkg, "pool", "propose_withdrawal", [pool, cap, "100000000", "0x897b60717357df94a5e5ada4a2ae232caacdea7b86601c80b82afc966cf464a6", "0x6"], "propose_withdrawal");
  call(pkg, "pool", "cancel_withdrawal", [pool, cap], "cancel_withdrawal");
}

// shielded_transfer with garbage proof: layout old(0) new(32) threshold(64) epoch(96) nullifier(128) ?(160) root(192)
for (let i = 0; i < RUNS; i++) {
  const inputs = Buffer.concat([randScalar(), randScalar(), scalar(BigInt(THRESHOLD)), scalar(0n), randScalar(), randScalar(), randScalar()]);
  call(pkg, "pool", "shielded_transfer", [pool, vecArg(fakeProof()), vecArg(inputs), "0x6"],
    "shielded_transfer, garbage proof (aborts E_INVALID_PROOF after full verify)");
}

// zk_withdraw: needs a withdraw VK, which is timelocked one epoch (60 s) on poolB
call(pkg, "pool", "propose_withdraw_vk", [poolB, capB, vecArg(fakeVk(5)), "0x6"], "propose_withdraw_vk");
console.log("waiting 125 s for the withdraw-VK timelock (2 epochs of 60 s)…");
await new Promise((r) => setTimeout(r, 125_000));
for (let i = 0; i < RUNS; i++) {
  const inputs = Buffer.concat([randScalar(), scalar(100_000_000n), randScalar(), randScalar(), randScalar()]);
  call(pkg, "pool", "zk_withdraw",
    [poolB, vecArg(fakeProof()), vecArg(inputs), "0x897b60717357df94a5e5ada4a2ae232caacdea7b86601c80b82afc966cf464a6", "0x6"],
    "zk_withdraw, garbage proof (aborts E_INVALID_WITHDRAW_PROOF after full verify)");
}

curve.terminate?.();
// ---- summary -----------------------------------------------------------------------------
console.log("\n| Entry point | runs | status | computation (MIST) | storage (MIST) | rebate (MIST) | net (MIST) |\n|---|---|---|---|---|---|---|");
const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
for (const r of rows) {
  const s = [...new Set(r.runs.map((x) => x.status))].join("/");
  console.log(`| ${r.name} | ${r.runs.length} | ${s} | ${mean(r.runs.map((x) => x.computation))} | ${mean(r.runs.map((x) => x.storage))} | ${mean(r.runs.map((x) => x.rebate))} | ${mean(r.runs.map((x) => x.net))} |`);
}
