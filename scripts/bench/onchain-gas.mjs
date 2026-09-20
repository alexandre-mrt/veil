#!/usr/bin/env node
/**
 * onchain-gas.mjs — Real on-chain gas measurement for every Veil entry point.
 *
 * Deploys the actual `contracts/` package to a local Sui network (`sui start
 * --force-regenesis --with-faucet`), generates REAL Groth16 proofs for the
 * transfer/withdraw/compliance circuits (same witness builders as
 * prove-latency.mjs), and calls every pool/compliance entry point with those
 * proofs. Gas is read from each transaction's real `effects.gasUsed` — nothing
 * here is estimated.
 *
 * Why a local network instead of testnet: this session's egress policy blocks
 * every Sui JSON-RPC host (fullnode.testnet.sui.io and public mirrors alike —
 * see docs/research/2026-09-20-onchain-gas-localnet.md for the exact denials).
 * `sui start` needs no network access at all, and Sui's gas schedule is a
 * function of the protocol version, not the network: computation units and
 * storage bytes for a given transaction are identical on localnet, devnet,
 * testnet and mainnet at the same protocol version. The `sui` CLI/node binary
 * used here (fetched from a GitHub release — see prerequisites) is pinned to
 * the exact commit `contracts/Move.toml` builds against, so this is the
 * correct protocol version for this codebase, not an approximation of one.
 *
 * Prerequisites (see the report for exact commands):
 *   1. A `sui` CLI + `sui-node`/`sui-test-validator` matching the git rev in
 *      contracts/Move.toml's Sui dependency (testnet-v1.72.1 for rev
 *      94ad8ccd0ed6c089a9fe072ff80c918b5ab44943 as of this run).
 *   2. `sui start --force-regenesis --with-faucet` running, with a funded
 *      client config (the ephemeral wallet `sui start` itself creates works).
 *   3. contracts/Move.toml needs a `[environments] localnet = "<chain-id>"`
 *      entry matching `sui client chain-identifier` for that local network,
 *      and `sui move build --build-env testnet` run once to pin dependencies
 *      (see script header comment in the report for why `testnet`, not a
 *      `localnet`-flavored dependency set that doesn't exist upstream).
 *   4. circuits/build{,-withdraw,-compliance} compiled + a dev Groth16 setup
 *      (circom + snarkjs; see circuits/scripts/compile*.sh — this run used a
 *      locally-generated powers-of-tau instead of the Hermez CDN download,
 *      which is also blocked; see the report for the exact commands).
 *
 * Usage:
 *   SUI_BIN=/path/to/sui SUI_CLIENT_CONFIG=/path/to/client.yaml \
 *     node scripts/bench/onchain-gas.mjs
 *
 * Output: prints every transaction's raw gasUsed JSON as it runs, then a
 * markdown summary table, then writes the full JSON results to
 * scripts/bench/onchain-gas-results.json.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const CONTRACTS_DIR = join(__dirname, "..", "..", "contracts");

const SUI_BIN = process.env.SUI_BIN || "sui";
const CLIENT_CONFIG = process.env.SUI_CLIENT_CONFIG;
if (!CLIENT_CONFIG || !existsSync(CLIENT_CONFIG)) {
  console.error("SUI_CLIENT_CONFIG must point at a funded localnet client.yaml (see file header).");
  process.exit(1);
}

const GAS_BUDGET = "500000000";

// ---------------------------------------------------------------------------
// arkworks byte conversion (mirrors scripts/src/proof-converter.ts exactly —
// duplicated here in plain JS so this script has no TS build step).
// ---------------------------------------------------------------------------
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const Q_HALF = (Q - 1n) / 2n;

function bigintToLE32(n) {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}
function compressG1(x, y) {
  const bytes = bigintToLE32(x);
  if (y > Q_HALF) bytes[31] |= 0x80;
  return bytes;
}
function compressG2(x0, x1, y0, y1) {
  const result = new Uint8Array(64);
  result.set(bigintToLE32(x0), 0);
  result.set(bigintToLE32(x1), 32);
  let setSign = false;
  if (y1 > Q_HALF) setSign = true;
  else if (y1 === Q_HALF && y0 > Q_HALF) setSign = true;
  if (setSign) result[63] |= 0x80;
  return result;
}
function proofToSuiBytes(proof) {
  const result = new Uint8Array(128);
  result.set(compressG1(BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])), 0);
  result.set(
    compressG2(
      BigInt(proof.pi_b[0][0]),
      BigInt(proof.pi_b[0][1]),
      BigInt(proof.pi_b[1][0]),
      BigInt(proof.pi_b[1][1]),
    ),
    32,
  );
  result.set(compressG1(BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])), 96);
  return result;
}
function publicInputsToSuiBytes(signals) {
  const result = new Uint8Array(signals.length * 32);
  for (let i = 0; i < signals.length; i++) result.set(bigintToLE32(BigInt(signals[i])), i * 32);
  return result;
}
function vkToSuiBytes(vk) {
  const parts = [];
  parts.push(compressG1(BigInt(vk.vk_alpha_1[0]), BigInt(vk.vk_alpha_1[1])));
  parts.push(compressG2(BigInt(vk.vk_beta_2[0][0]), BigInt(vk.vk_beta_2[0][1]), BigInt(vk.vk_beta_2[1][0]), BigInt(vk.vk_beta_2[1][1])));
  parts.push(compressG2(BigInt(vk.vk_gamma_2[0][0]), BigInt(vk.vk_gamma_2[0][1]), BigInt(vk.vk_gamma_2[1][0]), BigInt(vk.vk_gamma_2[1][1])));
  parts.push(compressG2(BigInt(vk.vk_delta_2[0][0]), BigInt(vk.vk_delta_2[0][1]), BigInt(vk.vk_delta_2[1][0]), BigInt(vk.vk_delta_2[1][1])));
  const lenBytes = new Uint8Array(8);
  let v = BigInt(vk.IC.length);
  for (let i = 0; i < 8; i++) { lenBytes[i] = Number(v & 0xffn); v >>= 8n; }
  parts.push(lenBytes);
  for (const ic of vk.IC) parts.push(compressG1(BigInt(ic[0]), BigInt(ic[1])));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function toHex(bytes) {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bigHex(n) { return toHex(bigintToLE32(n)); }

// ---------------------------------------------------------------------------
// sui CLI helpers
// ---------------------------------------------------------------------------
const results = [];

// `--client.config` is a flag on the `client`/`move` subcommands, not on the
// top-level `sui` binary (e.g. `sui --version` doesn't take it), so it's
// injected right after the subcommand rather than prepended unconditionally.
function sui(args, { cwd } = {}) {
  const needsConfig = args[0] === "client" || args[0] === "move";
  const fullArgs = needsConfig
    ? [args[0], "--client.config", CLIENT_CONFIG, ...args.slice(1)]
    : args;
  const out = execFileSync(SUI_BIN, fullArgs, {
    cwd: cwd || CONTRACTS_DIR,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

function call(label, { pkg, module, fn, args, gasBudget = GAS_BUDGET }) {
  console.log(`\n--- ${label} ---`);
  console.log(`sui client call --package ${pkg} --module ${module} --function ${fn} --gas-budget ${gasBudget}`);
  const raw = sui([
    "client", "call",
    "--package", pkg,
    "--module", module,
    "--function", fn,
    "--gas-budget", gasBudget,
    "--json",
    "--args", ...args,
  ]);
  const parsed = JSON.parse(raw);
  const status = parsed.effects?.status;
  const gasUsed = parsed.effects?.gasUsed;
  console.log(`status: ${JSON.stringify(status)}`);
  console.log(`gasUsed (raw): ${JSON.stringify(gasUsed)}`);
  if (status?.status !== "success") {
    throw new Error(`${label} failed: ${JSON.stringify(status)}`);
  }
  const net =
    Number(gasUsed.computationCost) + Number(gasUsed.storageCost) -
    Number(gasUsed.storageRebate);
  console.log(`net gas (computation + storage - rebate): ${net} MIST`);
  results.push({ label, module, fn, gasUsed, netMist: net, digest: parsed.digest });
  return parsed;
}

function findCreated(parsed, typeSuffix) {
  const oc = parsed.objectChanges.find(
    (o) => o.type === "created" && o.objectType.includes(typeSuffix),
  );
  if (!oc) throw new Error(`no created object matching ${typeSuffix}`);
  return oc.objectId;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  console.log("=== Veil on-chain gas benchmark ===");
  console.log(`sui: ${sui(["--version"]).trim()}`);

  // -- publish -----------------------------------------------------------
  console.log("\n--- publish (test-publish, ephemeral dep resolution) ---");
  const pubRaw = sui([
    "client", "test-publish", "--build-env", "testnet",
    "--gas-budget", GAS_BUDGET, "--json", ".",
  ]);
  const pub = JSON.parse(pubRaw);
  if (pub.effects.status.status !== "success") throw new Error("publish failed");
  const pkg = pub.objectChanges.find((o) => o.type === "published").packageId;
  const treasuryCapId = findCreated(pub, "TreasuryCap");
  console.log(`package: ${pkg}`);
  console.log(`gasUsed (raw): ${JSON.stringify(pub.effects.gasUsed)}`);
  results.push({ label: "publish package", module: "-", fn: "publish", gasUsed: pub.effects.gasUsed,
    netMist: Number(pub.effects.gasUsed.computationCost) + Number(pub.effects.gasUsed.storageCost) - Number(pub.effects.gasUsed.storageRebate),
    digest: pub.digest });

  // -- circuit artifacts ---------------------------------------------------
  const CIRCUITS = {
    transfer: { dir: "build" },
    withdraw: { dir: "build-withdraw" },
    compliance: { dir: "build-compliance" },
  };
  const artifactPaths = {};
  for (const [name, { dir }] of Object.entries(CIRCUITS)) {
    artifactPaths[name] = {
      wasmPath: join(CIRCUITS_DIR, dir, `${name}_js`, `${name}.wasm`),
      zkeyPath: join(CIRCUITS_DIR, dir, `${name}_final.zkey`),
      vkPath: join(CIRCUITS_DIR, dir, `${name}_vk.json`),
    };
  }
  const vks = {};
  for (const [name, { vkPath }] of Object.entries(artifactPaths)) {
    vks[name] = JSON.parse(readFileSync(vkPath, "utf-8"));
  }

  // `transfer` and `compliance` public inputs bind an on-chain epoch number
  // (epochId / currentEpoch) that the contract checks against
  // `clock.timestamp_ms() / epoch_duration_ms` at call time (with a 1-epoch
  // grace period). Since Clock on a real Sui node — local or not — tracks
  // real wall-clock time, not a small test counter, these two proofs must be
  // generated with the REAL current epoch baked in, close to when they're
  // submitted. `withdraw` has no epoch input, so it's proved once up front.
  async function proveCircuit(name, inputsObj) {
    const { wasmPath, zkeyPath, vkPath } = artifactPaths[name];
    const inputs = stringifyInputs(inputsObj);
    console.log(`\n--- generating real Groth16 proof: ${name} ---`);
    const t0 = Date.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    console.log(`fullProve(${name}) took ${Date.now() - t0} ms, ${publicSignals.length} public signals`);
    const vk = JSON.parse(readFileSync(vkPath, "utf-8"));
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log(`snarkjs local verify: ${ok}`);
    if (!ok) throw new Error(`${name} proof failed local verification`);
    return { proof, publicSignals };
  }

  function currentOnChainEpoch() {
    const raw = sui(["client", "object", "0x6", "--json"]);
    const ts = BigInt(JSON.parse(raw).content.timestamp_ms);
    return ts / 60000n;
  }

  // Structural witnesses (commitment / merkle-root values) don't depend on
  // epochId or currentEpoch, so these can be built once, up front, to derive
  // the byte values deposits and admin calls need.
  const wTransferStructural = WITNESS_BUILDERS.transfer(poseidon);
  const wComplianceStructural = WITNESS_BUILDERS.compliance(poseidon);
  const witnesses = { transfer: wTransferStructural, compliance: wComplianceStructural, withdraw: WITNESS_BUILDERS.withdraw(poseidon) };
  const proofs = {};
  proofs.withdraw = await proveCircuit("withdraw", witnesses.withdraw);

  const transferVkHex = toHex(vkToSuiBytes(vks.transfer));
  const withdrawVkHex = toHex(vkToSuiBytes(vks.withdraw));
  const complianceVkHex = toHex(vkToSuiBytes(vks.compliance));
  console.log(`\nVK sizes (bytes): transfer=${transferVkHex.length / 2 - 1} withdraw=${withdrawVkHex.length / 2 - 1} compliance=${complianceVkHex.length / 2 - 1}`);

  const EPOCH_MS = "60000"; // minimum allowed by pool::E_INVALID_EPOCH_DURATION
  const CLOCK = "0x6";

  // -- Pool A: shielded_transfer (below-threshold path) --------------------
  const poolACreate = call("create_pool (pool A, for shielded_transfer)", {
    pkg, module: "pool", fn: "create_pool",
    args: [transferVkHex, "1000000000", EPOCH_MS],
  });
  const poolA = findCreated(poolACreate, "pool::Pool");
  const adminCapA = findCreated(poolACreate, "pool::AdminCap");

  const faucetA = call("token_faucet::faucet (fund pool A depositor)", {
    pkg, module: "token_faucet", fn: "faucet", args: [treasuryCapId],
  });
  const coinA = findCreated(faucetA, "coin::Coin");

  const wA = witnesses.transfer;
  const commitmentAHex = bigHex(wA.oldCommitment);
  call("deposit_and_register (pool A)", {
    pkg, module: "pool", fn: "deposit_and_register",
    args: [poolA, coinA, commitmentAHex, CLOCK],
  });
  const rootAHex = bigHex(wA.merkleRoot);
  call("update_commitment_root (pool A, admin op)", {
    pkg, module: "pool", fn: "update_commitment_root",
    args: [poolA, adminCapA, rootAHex, CLOCK],
  });

  // -- Pool B: compliant_transfer (dual-proof path) -------------------------
  const poolBCreate = call("create_pool (pool B, for compliant_transfer)", {
    pkg, module: "pool", fn: "create_pool",
    args: [transferVkHex, "1000000000", EPOCH_MS],
  });
  const poolB = findCreated(poolBCreate, "pool::Pool");
  const adminCapB = findCreated(poolBCreate, "pool::AdminCap");

  const faucetB = call("token_faucet::faucet (fund pool B depositor)", {
    pkg, module: "token_faucet", fn: "faucet", args: [treasuryCapId],
  });
  const coinB = findCreated(faucetB, "coin::Coin");

  // Reuse the already-proven transfer proof/witness (wA) for pool B too —
  // nullifiers and commitments are scoped per-pool (separate dynamic-field
  // sets per Pool object), so reusing the same proof bytes across two
  // different Pool objects is safe and saves a second fullProve call.
  const commitmentBHex = commitmentAHex;
  call("deposit_and_register (pool B)", {
    pkg, module: "pool", fn: "deposit_and_register",
    args: [poolB, coinB, commitmentBHex, CLOCK],
  });
  call("update_commitment_root (pool B, admin op)", {
    pkg, module: "pool", fn: "update_commitment_root",
    args: [poolB, adminCapB, rootAHex, CLOCK],
  });

  const wComp = witnesses.compliance;
  const credentialRootHex = bigHex(wComp.merkleRoot);
  const auditorKeyHex = toHex(new Uint8Array(33).fill(0xab));
  const configCreate = call("create_compliance_config (pool B, admin op)", {
    pkg, module: "compliance", fn: "create_compliance_config",
    args: [adminCapB, poolB, complianceVkHex, credentialRootHex, "1", auditorKeyHex],
  });
  const configB = findCreated(configCreate, "compliance::ComplianceConfig");

  // -- Pool C: zk_withdraw ---------------------------------------------------
  const poolCCreate = call("create_pool (pool C, for zk_withdraw)", {
    pkg, module: "pool", fn: "create_pool",
    args: [transferVkHex, "1000000000", EPOCH_MS],
  });
  const poolC = findCreated(poolCCreate, "pool::Pool");
  const adminCapC = findCreated(poolCCreate, "pool::AdminCap");

  const faucetC = call("token_faucet::faucet (fund pool C depositor)", {
    pkg, module: "token_faucet", fn: "faucet", args: [treasuryCapId],
  });
  const coinC = findCreated(faucetC, "coin::Coin");

  const wC = witnesses.withdraw;
  const commitmentCHex = bigHex(wC.commitment);
  call("deposit_and_register (pool C)", {
    pkg, module: "pool", fn: "deposit_and_register",
    args: [poolC, coinC, commitmentCHex, CLOCK],
  });
  call("propose_withdraw_vk (pool C, admin op)", {
    pkg, module: "pool", fn: "propose_withdraw_vk",
    args: [poolC, adminCapC, withdrawVkHex, CLOCK],
  });

  // -- wait for the 60s epoch to roll over so the timelocked root/VK apply --
  const epochAtSetup = currentOnChainEpoch();
  console.log(`\n--- on-chain epoch at setup: ${epochAtSetup}. Waiting for it to advance (epoch_duration_ms=60000) ---`);
  await new Promise((r) => setTimeout(r, 65000));
  const epochNow = currentOnChainEpoch();
  console.log(`on-chain epoch after wait: ${epochNow}`);
  if (epochNow <= epochAtSetup) throw new Error("epoch did not advance — increase the wait");

  // Generate the epoch-sensitive proofs now, immediately before submitting
  // them, so the baked-in epoch matches (within the contract's 1-epoch grace
  // window) the epoch the chain will see at call time.
  const wTransferFinal = WITNESS_BUILDERS.transfer(poseidon, { epochId: epochNow });
  proofs.transfer = await proveCircuit("transfer", wTransferFinal);
  // expiryEpoch is left at its (large, fixed) default — it's baked into
  // credentialLeaf/merkleRoot, which must stay identical to the structural
  // witness used to register credential_root in create_compliance_config
  // above. Only currentEpoch (a bare public input, not hashed into anything)
  // needs to track the real on-chain epoch.
  const wComplianceFinal = WITNESS_BUILDERS.compliance(poseidon, { currentEpoch: epochNow });
  proofs.compliance = await proveCircuit("compliance", wComplianceFinal);

  // -- measured calls --------------------------------------------------------
  const transferProofHex = toHex(proofToSuiBytes(proofs.transfer.proof));
  const transferInputsHex = toHex(publicInputsToSuiBytes(proofs.transfer.publicSignals));
  call("shielded_transfer (pool A, real transfer proof)", {
    pkg, module: "pool", fn: "shielded_transfer",
    args: [poolA, transferProofHex, transferInputsHex, CLOCK],
  });

  const complianceProofHex = toHex(proofToSuiBytes(proofs.compliance.proof));
  const complianceInputsHex = toHex(publicInputsToSuiBytes(proofs.compliance.publicSignals));
  const encryptedAmountHex = toHex(new Uint8Array(93).fill(0xcd));
  call("compliant_transfer (pool B, dual proof: transfer + compliance)", {
    pkg, module: "compliance", fn: "compliant_transfer",
    args: [poolB, configB, transferProofHex, transferInputsHex, complianceProofHex, complianceInputsHex, encryptedAmountHex, CLOCK],
  });

  const withdrawProofHex = toHex(proofToSuiBytes(proofs.withdraw.proof));
  const withdrawInputsHex = toHex(publicInputsToSuiBytes(proofs.withdraw.publicSignals));
  const activeAddress = sui(["client", "active-address"]).trim();
  call("zk_withdraw (pool C, real withdraw proof)", {
    pkg, module: "pool", fn: "zk_withdraw",
    args: [poolC, withdrawProofHex, withdrawInputsHex, activeAddress, CLOCK],
  });

  // -- cheap admin ops (no timelock) -----------------------------------------
  call("freeze_pool (pool A, admin op)", {
    pkg, module: "pool", fn: "freeze_pool", args: [poolA, adminCapA, CLOCK],
  });
  call("unfreeze_pool (pool A, admin op)", {
    pkg, module: "pool", fn: "unfreeze_pool", args: [poolA, adminCapA],
  });

  // -- summary -----------------------------------------------------------
  console.log("\n=== Summary (net MIST = computation + storage - rebate) ===");
  console.log("| Entry point | Computation | Storage | Rebate | Net MIST | Net SUI |");
  console.log("|---|---|---|---|---|---|");
  for (const r of results) {
    const g = r.gasUsed;
    console.log(
      `| ${r.label} | ${g.computationCost} | ${g.storageCost} | ${g.storageRebate} | ${r.netMist} | ${(r.netMist / 1e9).toFixed(6)} |`,
    );
  }

  const outPath = join(__dirname, "onchain-gas-results.json");
  writeFileSync(outPath, JSON.stringify({ package: pkg, results }, null, 2));
  console.log(`\nFull results written to ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
