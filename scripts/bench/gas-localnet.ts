/**
 * gas-localnet.ts — on-chain gas per Veil pool entry point, measured on a local Sui network.
 *
 * Usage (from scripts/): bun run bench/gas-localnet.ts [--rpc http://127.0.0.1:9000] [--faucet http://127.0.0.1:9123]
 * Requires: `sui` in PATH (same version as the framework rev pinned in contracts/Move.toml) and a
 * running `sui start --force-regenesis --with-faucet`.
 *
 * Proofs: circom is not required. Groth16 verification cost on-chain depends only on the VK/input
 * dimensions (pairings + an MSM over n public inputs), not on which circuit produced them, so we
 * build a SYNTHETIC verifying key of the real shape (n public inputs) from known scalars and solve
 * the Groth16 equation for C. The result is a genuinely valid proof for that VK — it passes the real
 * `sui::groth16` verifier. Absolute gas therefore matches a real proof of the same shape; the
 * circuits' constraint counts are irrelevant to on-chain cost.
 */
import { execSync } from "child_process";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { buildBn128 } from "ffjavascript";
import { compressG1, compressG2, bigintToLE32, R } from "../src/proof-converter.js";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const RPC = arg("--rpc", "http://127.0.0.1:9000");
const FAUCET = arg("--faucet", "http://127.0.0.1:9123");
const CLOCK = "0x6";
const EPOCH_MS = 60_000; // pool minimum
const THRESHOLD = 1_000_000_000n;
const DENOM = 1_000_000_000n; // DENOM_* constant used for deposits (see pool.move)

const mod = (a: bigint) => ((a % R) + R) % R;
function inv(a: bigint): bigint {
  let [r0, r1, s0, s1] = [R, mod(a), 0n, 1n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0);
}

async function main() {
  const curve = await buildBn128(true);
  const { G1, G2 } = curve;
  const g1 = (k: bigint) => G1.toObject(G1.toAffine(G1.timesScalar(G1.g, k)));
  const g2 = (k: bigint) => G2.toObject(G2.toAffine(G2.timesScalar(G2.g, k)));
  const rnd = () => mod(BigInt("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")));

  /** Synthetic VK with `n` public inputs + a function producing valid proof bytes for any inputs. */
  function makeVk(n: number) {
    const [alpha, beta, gamma, delta] = [rnd(), rnd(), rnd(), rnd()];
    const ic = Array.from({ length: n + 1 }, rnd);
    const vk = new Uint8Array(32 + 64 * 3 + 8 + 32 * (n + 1));
    let o = 0;
    const put = (b: Uint8Array) => { vk.set(b, o); o += b.length; };
    const [ax, ay] = g1(alpha);
    put(compressG1(ax, ay));
    for (const k of [beta, gamma, delta]) {
      const [[x0, x1], [y0, y1]] = g2(k);
      put(compressG2(x0, x1, y0, y1));
    }
    put(new Uint8Array(new BigUint64Array([BigInt(n + 1)]).buffer));
    for (const k of ic) { const [x, y] = g1(k); put(compressG1(x, y)); }
    function prove(inputs: bigint[]): Uint8Array {
      const a = rnd(), b = rnd();
      const l = ic.reduce((s, k, i) => s + (i === 0 ? k : k * inputs[i - 1]), 0n);
      const c = mod((a * b - alpha * beta - gamma * l) * inv(delta));
      const proof = new Uint8Array(128);
      const [pax, pay] = g1(a); proof.set(compressG1(pax, pay), 0);
      const [[bx0, bx1], [by0, by1]] = g2(b); proof.set(compressG2(bx0, bx1, by0, by1), 32);
      const [pcx, pcy] = g1(c); proof.set(compressG1(pcx, pcy), 96);
      return proof;
    }
    return { vk, prove };
  }
  const pack = (xs: bigint[]) => { const o = new Uint8Array(32 * xs.length); xs.forEach((x, i) => o.set(bigintToLE32(x), 32 * i)); return o; };

  const client = new SuiJsonRpcClient({ url: RPC, network: "localnet" as never });
  const kp = Ed25519Keypair.generate();
  const addr = kp.toSuiAddress();
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: addr });
  await new Promise((r) => setTimeout(r, 3000));

  const rows: { op: string; computation: number; storage: number; rebate: number; net: number; note?: string }[] = [];
  async function run(op: string, build: (tx: Transaction) => void, note?: string, expectFail = false, _unused = false) {
    const tx = new Transaction();
    tx.setGasBudget(500_000_000);
    build(tx);
    const res = await client.signAndExecuteTransaction({ transaction: tx, signer: kp, options: { showEffects: true, showObjectChanges: true } });
    await client.waitForTransaction({ digest: res.digest });
    const st = res.effects?.status;
    if ((st?.status === "success") === expectFail) throw new Error(`${op}: unexpected status ${JSON.stringify(st)}`);
    const g = res.effects!.gasUsed;
    const row = { op, computation: +g.computationCost, storage: +g.storageCost, rebate: +g.storageRebate, net: +g.computationCost + +g.storageCost - +g.storageRebate, note };
    rows.push(row);
    console.log(JSON.stringify({ ...row, digest: res.digest, status: st?.status, error: st?.error }));
    return res;
  }

  // publish
  const built = JSON.parse(execSync("sui move build --dump-bytecode-as-base64 --no-tree-shaking", { cwd: new URL("../../contracts", import.meta.url).pathname, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 }).trim().split("\n").pop()!);
  const pub = await run("publish (whole package)", (tx) => {
    const cap = tx.publish({ modules: built.modules, dependencies: built.dependencies });
    tx.transferObjects([cap], addr);
  });
  const ch = pub.objectChanges!;
  const pkg = (ch.find((c: any) => c.type === "published") as any).packageId as string;
  const treasury = (ch.find((c: any) => c.type === "created" && c.objectType.includes("::coin::TreasuryCap")) as any).objectId as string;

  const transfer = makeVk(7), withdraw = makeVk(5);
  const c = (n: bigint) => n;
  const create = await run("create_pool (transfer VK, 488 B)", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::create_pool`, arguments: [tx.pure.vector("u8", Array.from(transfer.vk)), tx.pure.u64(THRESHOLD), tx.pure.u64(EPOCH_MS)] }));
  const pool = (create.objectChanges!.find((x: any) => x.type === "created" && x.objectType.includes("::pool::Pool")) as any).objectId as string;
  const adminCap = (create.objectChanges!.find((x: any) => x.type === "created" && x.objectType.includes("::pool::AdminCap")) as any).objectId as string;

  await run("propose_withdraw_vk (VK 392 B)", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::propose_withdraw_vk`, arguments: [tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", Array.from(withdraw.vk)), tx.object(CLOCK)] }));

  // mint coins: faucet gives 1000 VEIL (1e9 base units) = exactly DENOM
  async function mintAndDeposit(label: string, commitment: bigint, measure: boolean) {
    const m = await run(`token_faucet::faucet${measure ? "" : " (setup)"}`, (tx) => tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] }));
    const coin = (m.objectChanges!.find((x: any) => x.type === "created" && x.objectType.includes("::token::TOKEN")) as any).objectId as string;
    return run(`deposit_and_register${measure ? "" : " (setup)"}`, (tx) =>
      tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [tx.object(pool), tx.object(coin), tx.pure.vector("u8", Array.from(bigintToLE32(commitment))), tx.object(CLOCK)] }),
      label);
  }
  await mintAndDeposit("first leaf (empty pool)", c(11n), true);
  for (let i = 0; i < 4; i++) await mintAndDeposit("", c(100n + BigInt(i)), false);
  const depositNth = await mintAndDeposit("6th deposit (pool already holds 5 commitments)", c(200n), true);
  void depositNth;

  // Scaling phase setup: 80 extra commitments, 10 deposits per PTB (one faucet coin split into 10 x DENOM_SMALL).
  const BATCH_BASE = 1000n;
  for (let b = 0; b < 8; b++) {
    const m = await run("token_faucet::faucet (setup)", (tx) => tx.moveCall({ target: `${pkg}::token_faucet::faucet`, arguments: [tx.object(treasury)] }));
    const coin = (m.objectChanges!.find((x: any) => x.type === "created" && x.objectType.includes("::token::TOKEN")) as any).objectId as string;
    await run("deposit_and_register x10 in one PTB", (tx) => {
      const parts = tx.splitCoins(tx.object(coin), Array.from({ length: 9 }, () => tx.pure.u64(100_000_000)));
      const all = [...Array.from({ length: 9 }, (_, i) => parts[i]), tx.object(coin)];
      all.forEach((cn, i) => tx.moveCall({ target: `${pkg}::pool::deposit_and_register`, arguments: [tx.object(pool), cn, tx.pure.vector("u8", Array.from(bigintToLE32(BATCH_BASE + BigInt(b * 10 + i)))), tx.object(CLOCK)] }));
    }, "10 deposits, 10 new dynamic fields", false, b === 0);
  }
  console.log(`waiting ${EPOCH_MS / 1000 + 3}s for commitments to mature (epoch boundary)...`);
  await new Promise((r) => setTimeout(r, EPOCH_MS + 3000));
  const epoch = BigInt(Math.floor(Date.now() / EPOCH_MS));
  const zeroRoot = 0n;

  // shielded_transfer — oldC=11 (matured), newC=300, nullifier=301, txAmountHash=302, root=0 (pool's initial root)
  const tIn = [11n, 300n, THRESHOLD, epoch, 301n, 302n, zeroRoot];
  await run("shielded_transfer (valid proof, 7 public inputs)", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), tx.pure.vector("u8", Array.from(transfer.prove(tIn))), tx.pure.vector("u8", Array.from(pack(tIn))), tx.object(CLOCK)] }),
    "Groth16 verify + VK prepare + 2 dynamic-field writes + 1 removal");

  // wait for the withdraw VK timelock (1 epoch) — already elapsed during the 63 s wait; zk_withdraw applies it lazily
  const recipient = addr;
  const wIn = [100n, 1_000n, 400n, 401n, 402n];
  await run("zk_withdraw (valid proof, 5 public inputs)", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(pool), tx.pure.vector("u8", Array.from(withdraw.prove(wIn))), tx.pure.vector("u8", Array.from(pack(wIn))), tx.pure.address(recipient), tx.object(CLOCK)] }),
    "first call also applies the pending withdraw VK (storage write of 392 B)");
  const wIn2 = [101n, 1_000n, 410n, 411n, 412n];
  await run("zk_withdraw (second call, VK already applied)", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::zk_withdraw`, arguments: [tx.object(pool), tx.pure.vector("u8", Array.from(withdraw.prove(wIn2))), tx.pure.vector("u8", Array.from(pack(wIn2))), tx.pure.address(recipient), tx.object(CLOCK)] }));

  // failure path: an attacker submitting a garbage proof still pays the verify cost
  const tBad = [102n, 500n, THRESHOLD, epoch, 501n, 502n, zeroRoot];
  const badProof = transfer.prove(tBad); badProof[5] ^= 1;
  await run("shielded_transfer (INVALID proof, aborts E_INVALID_PROOF)", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), tx.pure.vector("u8", Array.from(badProof)), tx.pure.vector("u8", Array.from(pack(tBad))), tx.object(CLOCK)] }),
    "gas charged for a rejected proof", true);

  await run("freeze_pool", (tx) => tx.moveCall({ target: `${pkg}::pool::freeze_pool`, arguments: [tx.object(pool), tx.object(adminCap), tx.object(CLOCK)] }));
  await run("unfreeze_pool", (tx) => tx.moveCall({ target: `${pkg}::pool::unfreeze_pool`, arguments: [tx.object(pool), tx.object(adminCap)] }));
  await run("propose_vk_update (VK 488 B)", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::propose_vk_update`, arguments: [tx.object(pool), tx.object(adminCap), tx.pure.vector("u8", Array.from(transfer.vk)), tx.object(CLOCK)] }));
  await run("cancel_vk_update", (tx) => tx.moveCall({ target: `${pkg}::pool::cancel_vk_update`, arguments: [tx.object(pool), tx.object(adminCap)] }));
  await run("propose_withdrawal", (tx) =>
    tx.moveCall({ target: `${pkg}::pool::propose_withdrawal`, arguments: [tx.object(pool), tx.object(adminCap), tx.pure.u64(1000), tx.pure.address(addr), tx.object(CLOCK)] }));
  await run("cancel_withdrawal", (tx) => tx.moveCall({ target: `${pkg}::pool::cancel_withdrawal`, arguments: [tx.object(pool), tx.object(adminCap)] }));

  // Scaling phase: N valid Groth16 verifications (shielded_transfer) inside ONE transaction. Computation cost is
  // bucketed by the protocol, so this brackets the per-verify cost between bucket boundaries.
  let cursor = 0n;
  for (const n of [1, 5, 10, 20, 40]) {
    const ins = Array.from({ length: n }, (_, i) => { const k = cursor + BigInt(i); return [BATCH_BASE + k, 5000n + 3n * k, THRESHOLD, epoch, 5001n + 3n * k, 5002n + 3n * k, zeroRoot]; });
    cursor += BigInt(n);
    await run(`${n} x shielded_transfer in one PTB`, (tx) => ins.forEach((inp) =>
      tx.moveCall({ target: `${pkg}::pool::shielded_transfer`, arguments: [tx.object(pool), tx.pure.vector("u8", Array.from(transfer.prove(inp))), tx.pure.vector("u8", Array.from(pack(inp))), tx.object(CLOCK)] })),
      `${n} Groth16 verifies`, false, true);
  }

  console.log("\n| Entry point | Computation (MIST) | Storage (MIST) | Rebate (MIST) | Net (MIST) | Note |\n|---|---:|---:|---:|---:|---|");
  for (const r of rows.filter((r) => !r.op.includes("(setup)"))) console.log(`| ${r.op} | ${r.computation} | ${r.storage} | ${r.rebate} | ${r.net} | ${r.note ?? ""} |`);
}
main().catch((e) => { console.error(e); process.exit(1); });
