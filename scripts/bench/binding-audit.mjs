#!/usr/bin/env node
/**
 * binding-audit.mjs — real-proof fixtures for the 2026-11-16 public-input binding audit.
 *
 * Generates REAL Groth16 withdraw proofs (snarkjs, the repo's own withdraw.circom + a dev zkey)
 * for the attack witnesses below, checks them with snarkjs, and writes them as a Move test-only
 * fixture module so `sui move test` replays them through `sui::groth16` on the real pool code:
 *
 *   A. forged-deposit  — commitment opens to cumulativeOld = 1000 TOKEN, but is registered with a
 *                        100 TOKEN deposit. zk_withdraw(1000 TOKEN) — does the pool pay?
 *   B. redirect        — a second valid proof committing to recipient VICTIM; submitted with
 *                        recipient = FRONT_RUNNER. Does the pool pay the front-runner? (E7)
 *   D. transfer-inflate — the frontend's own genesis commitment (cumulative = 0) + ONE valid
 *                        shielded_transfer of 1000 TOKEN (cumulative spending 0 -> 1000), then
 *                        zk_withdraw(1000 TOKEN) against a 100 TOKEN deposit. No forged commitment.
 *   C. honest-exit     — the frontend's genesis commitment Poseidon(1, 0, 0, s) after a 100 TOKEN
 *                        deposit: can an honest depositor withdraw their own 100 TOKEN? (witness only)
 *
 * Usage (from repo root, after `bash scripts/bench/build-circuit.sh withdraw.circom circuits/build-withdraw`
 * and `npm ci` in scripts/bench):
 *   node --experimental-strip-types --no-warnings scripts/bench/binding-audit.mjs \
 *     --move-out contracts/tests/binding_audit_fixtures.move
 *
 * The VK is dev-only (single local contribution) — it proves nothing about the deployed VK, only
 * that the on-chain checks accept any proof valid under whatever VK the pool holds.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { proofToSuiBytes, publicInputsToSuiBytes, vkToSuiBytes, toHex } from "../src/proof-converter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const BUILD = join(ROOT, "circuits", "build-withdraw");
const WASM = join(BUILD, "withdraw_js", "withdraw.wasm");
const ZKEY = join(BUILD, "withdraw_final.zkey");
const TBUILD = join(ROOT, "circuits", "build");
const TWASM = join(TBUILD, "transfer_js", "transfer.wasm");
const TZKEY = join(TBUILD, "transfer_final.zkey");
const TVK = JSON.parse(readFileSync(join(TBUILD, "transfer_vk.json"), "utf8"));
const VK = JSON.parse(readFileSync(join(BUILD, "withdraw_vk.json"), "utf8"));
const args = process.argv.slice(2);
const moveOut = args.includes("--move-out") ? args[args.indexOf("--move-out") + 1] : null;

const TOKEN = 1_000_000n; // 6 decimals: DENOM_SMALL = 100 TOKEN = 100_000_000
const poseidon = await buildPoseidon();
const H = (xs) => poseidon.F.toObject(poseidon(xs.map(BigInt)));

function witness({ s, r, cum, amt, recipient, rNew }) {
  return {
    commitment: H([1, cum, r, s]).toString(),
    withdrawAmount: amt.toString(),
    nullifier: H([7, s, r, cum]).toString(),
    recipientHash: H([8, recipient]).toString(),
    newCommitment: H([1, cum - amt, rNew, s]).toString(),
    cumulativeOld: cum.toString(),
    randomnessOld: r.toString(),
    userSecret: s.toString(),
    recipient: recipient.toString(),
    randomnessNew: rNew.toString(),
  };
}

async function prove(name, w, wasm = WASM, zkey = ZKEY, vk = VK) {
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(w, wasm, zkey);
  const ms = performance.now() - t0;
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  console.log(`[${name}] fullProve ${ms.toFixed(1)} ms, snarkjs verify = ${ok}`);
  console.log(`[${name}] publicSignals = ${JSON.stringify(publicSignals)}`);
  if (!ok) throw new Error(`${name}: proof did not verify`);
  return {
    proof: toHex(proofToSuiBytes(proof)),
    inputs: toHex(publicInputsToSuiBytes(publicSignals)),
    commitment: toHex(publicInputsToSuiBytes([publicSignals[0]])),
  };
}

// A. forged deposit: 100 TOKEN in, commitment claims 1000 TOKEN.
const A = await prove("A forged-deposit", witness({
  s: 0xA77AC3n, r: 7n, cum: 1000n * TOKEN, amt: 1000n * TOKEN, recipient: 0xC0FFEEn, rNew: 9n,
}));
// B. victim proof bound to recipient 0xD (as a field element), replayed by a front-runner.
const B = await prove("B redirect", witness({
  s: 0xB0Bn, r: 11n, cum: 100n * TOKEN, amt: 100n * TOKEN, recipient: 0xDn, rNew: 13n,
}));
// D. transfer-inflate: genesis commitment exactly as useDepositAndRegister.ts computes it.
const sD = 0xD0D0n, THRESH = 1000n * TOKEN, EPOCH = 1n, txAmt = 1000n * TOKEN, rNewD = 21n, saltD = 5n;
const genesis = H([1, 0, 0, sD]);
let root = genesis; // leaf 0 of a depth-20 tree whose other leaves are 0
for (let i = 0; i < 20; i++) root = H([root, 0]);
const T = await prove("D transfer", {
  oldCommitment: genesis.toString(),
  newCommitment: H([1, txAmt, rNewD, sD]).toString(),
  threshold: THRESH.toString(),
  epochId: EPOCH.toString(),
  nullifier: H([2, sD, EPOCH, 0]).toString(),
  txAmountHash: H([3, txAmt, saltD]).toString(),
  merkleRoot: root.toString(),
  cumulativeOld: "0", cumulativeNew: txAmt.toString(), txAmount: txAmt.toString(),
  randomnessOld: "0", randomnessNew: rNewD.toString(), userSecret: sD.toString(), salt: saltD.toString(),
  pathElements: Array(20).fill("0"), pathIndices: Array(20).fill("0"),
}, TWASM, TZKEY, TVK);
const D = await prove("D withdraw-after-transfer", witness({
  s: sD, r: rNewD, cum: txAmt, amt: txAmt, recipient: 0xD0Dn, rNew: 22n,
}));

// C. honest exit from the frontend's genesis commitment (cumulative = 0, randomness = 0).
let honestOk;
try {
  await snarkjs.groth16.fullProve(
    witness({ s: 0x5EC12E7n, r: 0n, cum: 0n, amt: 100n * TOKEN, recipient: 0xB0Bn, rNew: 1n }),
    WASM, ZKEY,
  );
  honestOk = true;
} catch (e) {
  honestOk = false;
  console.log(`[C honest-exit] witness generation REJECTED: ${String(e.message).split("\n")[0]}`);
}
console.log(`[C honest-exit] honest depositor can withdraw own 100 TOKEN from genesis commitment: ${honestOk}`);

if (moveOut) {
  const hex = (h) => `x"${h.replace(/^0x/, "")}"`;
  writeFileSync(moveOut, `// GENERATED by scripts/bench/binding-audit.mjs — do not edit by hand.
// Real Groth16 (BN254) withdraw proofs under a dev-only withdraw VK. See
// docs/research/2026-11-16-public-input-binding-audit.md.
#[test_only]
module veil::binding_audit_fixtures;

public fun withdraw_vk(): vector<u8> { ${hex(toHex(vkToSuiBytes(VK)))} }

/// A: commitment opens to cumulativeOld = 1000 TOKEN; withdrawAmount = 1000 TOKEN.
public fun forged_commitment(): vector<u8> { ${hex(A.commitment)} }
public fun forged_proof(): vector<u8> { ${hex(A.proof)} }
public fun forged_inputs(): vector<u8> { ${hex(A.inputs)} }

/// D: genesis commitment Poseidon(1,0,0,s) (frontend format), a depth-20 root containing it as
/// leaf 0, a valid transfer of 1000 TOKEN from it, then a 1000 TOKEN withdraw of the result.
public fun transfer_vk(): vector<u8> { ${hex(toHex(vkToSuiBytes(TVK)))} }
public fun genesis_commitment(): vector<u8> { ${hex(toHex(publicInputsToSuiBytes([genesis.toString()])))} }
public fun genesis_root(): vector<u8> { ${hex(toHex(publicInputsToSuiBytes([root.toString()])))} }
public fun inflate_transfer_proof(): vector<u8> { ${hex(T.proof)} }
public fun inflate_transfer_inputs(): vector<u8> { ${hex(T.inputs)} }
public fun inflate_withdraw_proof(): vector<u8> { ${hex(D.proof)} }
public fun inflate_withdraw_inputs(): vector<u8> { ${hex(D.inputs)} }

/// B: valid proof whose recipientHash = Poseidon(8, 0xD); withdrawAmount = 100 TOKEN.
public fun victim_commitment(): vector<u8> { ${hex(B.commitment)} }
public fun victim_proof(): vector<u8> { ${hex(B.proof)} }
public fun victim_inputs(): vector<u8> { ${hex(B.inputs)} }
`);
  console.log(`wrote ${moveOut}`);
}
process.exit(0);
