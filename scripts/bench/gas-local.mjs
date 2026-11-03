#!/usr/bin/env node
/**
 * gas-local.mjs — On-chain gas per proof-free Veil entry point, measured on a LOCAL Sui network.
 *
 * Every number is `effects.gasUsed` from a real executed transaction (via `sui client ptb --json`).
 * Gas = computationCost + storageCost - storageRebate (MIST). Computation cost is
 * deterministic (bucketed units * reference gas price); storage cost is a function of bytes
 * written, so both transfer to testnet/mainnet except for the reference gas price (local: 1000
 * MIST/unit; compare in *units*, not MIST, across networks).
 *
 * NOT covered: shielded_transfer / zk_withdraw / compliant_transfer (need real Groth16 proofs, i.e.
 * compiled circuits -> circom). Those are reported as UNMEASURED in the experiment report.
 *
 * Prerequisites:
 *   - `sui` >= 1.83 in PATH (prebuilt release tarball is fine)
 *   - a local network:  sui start --force-regenesis --with-faucet     (leave running)
 *   - active env pointing at it:  sui client new-env --alias local --rpc http://127.0.0.1:9000
 *                                 sui client switch --env local && sui client faucet
 *
 * Usage:  node scripts/bench/gas-local.mjs [--deposits N]      (default N = 40)
 * Output: a markdown table on stdout, raw per-tx JSON in $GAS_BENCH_OUT (default ./gas-local.json)
 */
import { execFileSync } from "child_process";
import { writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(__dirname, "..", "..", "contracts");
const OUT = process.env.GAS_BENCH_OUT ?? "gas-local.json";
const N = (() => {
  const i = process.argv.indexOf("--deposits");
  return i > 0 ? parseInt(process.argv[i + 1], 10) : 40;
})();
const CLOCK = "0x6";
const BUDGET = "500000000";
// Dummy 232-byte VK: pool.move only length-checks it at create/propose time (MIN_VK_LENGTH = 232).
// Safe here because no proof-verifying entry point is called.
const DUMMY_VK = "0x" + "11".repeat(232);

const records = [];

function sui(args, opts = {}) {
  const out = execFileSync("sui", args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"], ...opts });
  return JSON.parse(out.slice(out.indexOf("{")));
}
function gas(g) {
  const c = +g.computationCost, s = +g.storageCost, r = +g.storageRebate;
  return { computation: c, storage: s, rebate: r, net: c + s - r };
}
function record(name, res) {
  if (res.effects.status.status !== "success") throw new Error(`${name} failed: ${JSON.stringify(res.effects.status)}`);
  const g = gas(res.effects.gasUsed);
  records.push({ name, digest: res.digest, ...g });
  return res;
}
function created(res, typeSuffix) {
  return res.objectChanges.find((c) => c.type === "created" && c.objectType?.endsWith(typeSuffix))?.objectId;
}
function ptb(name, ...cmds) {
  return record(name, sui(["client", "ptb", ...cmds, "--gas-budget", BUDGET, "--json"]));
}

// 1. publish
const pub = record("publish (whole package)", sui(["client", "test-publish", CONTRACTS, "--build-env", "testnet", "--gas-budget", BUDGET, "--json"]));
// test-publish drops an ephemeral-publication file in the cwd (and/or the package dir); not part of the repo.
for (const d of [CONTRACTS, process.cwd()]) rmSync(join(d, "Pub.local.toml"), { force: true });
const pkg = pub.objectChanges.find((c) => c.type === "published").packageId;
const treasury = created(pub, "::token::TOKEN>");
const me = execFileSync("sui", ["client", "active-address"], { encoding: "utf8" }).trim();
const T = `${pkg}::token::TOKEN`;

// 2. create_pool
const cp = ptb("create_pool", "--move-call", `${pkg}::pool::create_pool`, `vector[${[...DUMMY_VK.slice(2).matchAll(/../g)].map((m) => "0x" + m[0]).join(",")}]`, "1000000000", "3600000");
const pool = created(cp, "::pool::Pool");
const cap = created(cp, "::pool::AdminCap");

// 3. faucet (mint 1000 VEIL = DENOM_LARGE, a standard deposit amount) x N, then deposit each
const coins = [];
for (let i = 0; i < N; i++) {
  const r = ptb(i === 0 ? "faucet (token_faucet::faucet)" : "_faucet_extra", "--move-call", `${pkg}::token_faucet::faucet`, `@${treasury}`);
  if (i > 0) records.pop();
  coins.push(created(r, `::coin::Coin<${T}>`));
}
const commit = (i) => "0x" + i.toString(16).padStart(64, "0");
const deposits = [];
for (let i = 0; i < N; i++) {
  const bytes = `vector[${[...commit(i + 1).slice(2).matchAll(/../g)].map((m) => "0x" + m[0]).join(",")}]`;
  const r = ptb(`_deposit_${i}`, "--move-call", `${pkg}::pool::deposit_and_register`, `@${pool}`, `@${coins[i]}`, bytes, `@${CLOCK}`);
  deposits.push(records.pop());
}
records.push({ ...deposits[0], name: "deposit_and_register (leaf 0, empty pool)" });
const last = deposits[deposits.length - 1];
records.push({ ...last, name: `deposit_and_register (leaf ${N - 1})` });

// 4. admin / timelocked ops
ptb("propose_withdrawal", "--move-call", `${pkg}::pool::propose_withdrawal`, `@${pool}`, `@${cap}`, "1000000", `@${me}`, `@${CLOCK}`);
ptb("cancel_withdrawal", "--move-call", `${pkg}::pool::cancel_withdrawal`, `@${pool}`, `@${cap}`);
ptb("freeze_pool", "--move-call", `${pkg}::pool::freeze_pool`, `@${pool}`, `@${cap}`, `@${CLOCK}`);
ptb("unfreeze_pool", "--move-call", `${pkg}::pool::unfreeze_pool`, `@${pool}`, `@${cap}`);
const vkBytes = `vector[${[...DUMMY_VK.slice(2).matchAll(/../g)].map((m) => "0x" + m[0]).join(",")}]`;
ptb("propose_vk_update (232-byte vk)", "--move-call", `${pkg}::pool::propose_vk_update`, `@${pool}`, `@${cap}`, vkBytes, `@${CLOCK}`);
ptb("cancel_vk_update", "--move-call", `${pkg}::pool::cancel_vk_update`, `@${pool}`, `@${cap}`);

// report
const dep = deposits.map((d) => d.net), depC = deposits.map((d) => d.computation), depS = deposits.map((d) => d.storage);
const stat = (a) => `min ${Math.min(...a)} / max ${Math.max(...a)}`;
console.log("| Entry point | computation (MIST) | storage (MIST) | rebate (MIST) | net (MIST) |");
console.log("|---|---|---|---|---|");
for (const r of records) console.log(`| ${r.name} | ${r.computation} | ${r.storage} | ${r.rebate} | ${r.net} |`);
console.log(`\ndeposit_and_register over ${N} deposits: net ${stat(dep)}, computation ${stat(depC)}, storage ${stat(depS)}`);
writeFileSync(OUT, JSON.stringify({ records, deposits }, null, 2));
