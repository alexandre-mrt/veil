#!/usr/bin/env node
/**
 * recipient-binding-fixture.mjs
 *
 * Regenerates the real Groth16 withdraw-circuit fixture embedded in
 * contracts/tests/pool_withdraw_recipient_binding_tests.move — the regression test for the
 * recipient-binding vulnerability (docs/threat-model.md RR10 / E7, docs/research/
 * 2026-09-24-recipient-binding-fix.md).
 *
 * It does NOT reproduce byte-identical output on every run: Groth16 proofs are randomized
 * (fresh blinding factors r, s each time) and this script also runs a fresh single-contributor
 * trusted setup, so re-running produces a different, equally-valid proof over the SAME public
 * inputs (the witness is fixed below). That's why the fixture is embedded as a frozen snapshot
 * in the Move test rather than regenerated on every CI run — this script documents and
 * reproduces the *method*, not a fixed byte string.
 *
 * Prereqs (none vendored — see docs/research/2026-09-24-recipient-binding-fix.md for exact
 * download commands used the night this was written):
 *   - circom 2.2.x on PATH
 *   - circuits/build-withdraw/{withdraw.r1cs,withdraw_js/withdraw.wasm} (bash
 *     circuits/scripts/compile-withdraw.sh --skip-ptau, then generate a local ptau — see below)
 *   - circuits/build-withdraw/withdraw_final.zkey + withdraw_vk.json (local trusted setup;
 *     storage.googleapis.com's published ptau is blocked in some CI/sandbox networks, so this
 *     assumes a LOCAL powers-of-tau: `snarkjs powersoftau new bn128 13 pot13_0000.ptau` ->
 *     `contribute` -> `prepare phase2` is enough for withdraw.circom's 3,058 constraints)
 *
 * Run: node scripts/bench/recipient-binding-fixture.mjs
 * Prints the witness, the recipient/attacker field elements, the public signals, and the
 * Sui-encoded (proof_bytes, public_inputs_bytes, vk_bytes) as Move `vector[...]` literals.
 */
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

// Inlined from scripts/src/proof-converter.ts (kept in sync by hand — this package runs under
// plain `node`, not bun/ts-node, so it can't import that .ts module directly). Same constants,
// same encoding, same ordering; see that file's own tests (109 pass) for the authoritative copy.
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
  let setSign = y1 > Q_HALF || (y1 === Q_HALF && y0 > Q_HALF);
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
  const parts = [
    compressG1(BigInt(vk.vk_alpha_1[0]), BigInt(vk.vk_alpha_1[1])),
    compressG2(
      BigInt(vk.vk_beta_2[0][0]),
      BigInt(vk.vk_beta_2[0][1]),
      BigInt(vk.vk_beta_2[1][0]),
      BigInt(vk.vk_beta_2[1][1]),
    ),
    compressG2(
      BigInt(vk.vk_gamma_2[0][0]),
      BigInt(vk.vk_gamma_2[0][1]),
      BigInt(vk.vk_gamma_2[1][0]),
      BigInt(vk.vk_gamma_2[1][1]),
    ),
    compressG2(
      BigInt(vk.vk_delta_2[0][0]),
      BigInt(vk.vk_delta_2[0][1]),
      BigInt(vk.vk_delta_2[1][0]),
      BigInt(vk.vk_delta_2[1][1]),
    ),
  ];
  const lenBytes = new Uint8Array(8);
  let v = BigInt(vk.IC.length);
  for (let i = 0; i < 8; i++) {
    lenBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  parts.push(lenBytes);
  for (const ic of vk.IC) parts.push(compressG1(BigInt(ic[0]), BigInt(ic[1])));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build-withdraw");

// BN254 scalar field (Fr) — matches sui::poseidon's BN254_MAX and address::to_u256's target field.
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Matches sui::address::to_u256: the 32-byte address interpreted as a big-endian integer,
 *  reduced mod R because addresses are 256-bit and the field is ~254-bit (see
 *  verifier::recipient_to_field's doc comment for the soundness argument). */
function addressToRecipientField(addressHex32Bytes) {
  return BigInt("0x" + addressHex32Bytes) % R;
}

function toMoveVec(bytes) {
  return "vector[" + Array.from(bytes).map((b) => `${b}u8`).join(", ") + "]";
}

async function main() {
  const poseidon = await buildPoseidon();
  const toBI = (x) => poseidon.F.toObject(x);

  const RECIPIENT_ADDR = "D".padStart(64, "0"); // @0xD
  const ATTACKER_ADDR = "C".padStart(64, "0"); // @0xC
  const recipientField = addressToRecipientField(RECIPIENT_ADDR);
  const attackerField = addressToRecipientField(ATTACKER_ADDR);

  const userSecret = 0x1234567890abcdefn;
  const cumulativeOld = 500_000_000n; // 500 TOKEN — a standard deposit denomination
  const randomnessOld = 111n;
  const withdrawAmount = 200_000_000n;
  const randomnessNew = 222n;
  const remainingBalance = cumulativeOld - withdrawAmount;

  const input = {
    commitment: toBI(poseidon([1n, cumulativeOld, randomnessOld, userSecret])).toString(),
    withdrawAmount: withdrawAmount.toString(),
    nullifier: toBI(poseidon([7n, userSecret, randomnessOld, cumulativeOld])).toString(),
    recipientHash: toBI(poseidon([8n, recipientField])).toString(),
    newCommitment: toBI(
      poseidon([1n, remainingBalance, randomnessNew, userSecret]),
    ).toString(),
    cumulativeOld: cumulativeOld.toString(),
    randomnessOld: randomnessOld.toString(),
    userSecret: userSecret.toString(),
    recipient: recipientField.toString(),
    randomnessNew: randomnessNew.toString(),
  };

  console.log("Witness (recipient bound to @0xD, field element", recipientField.toString() + "):");
  console.log(input);
  console.log("Attacker field element (@0xC):", attackerField.toString());

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    join(BUILD_DIR, "withdraw_js", "withdraw.wasm"),
    join(BUILD_DIR, "withdraw_final.zkey"),
  );

  const vkey = JSON.parse(fs.readFileSync(join(BUILD_DIR, "withdraw_vk.json"), "utf8"));
  const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("\nsnarkjs.groth16.verify:", verified);
  if (!verified) throw new Error("Generated proof does not verify — refusing to emit a fixture.");

  console.log("\npublicSignals:", publicSignals);
  console.log("\n--- Move vector[] literals for pool_withdraw_recipient_binding_tests.move ---\n");
  console.log("proof_bytes (128 bytes):\n" + toMoveVec(proofToSuiBytes(proof)));
  console.log("\npublic_inputs_bytes (160 bytes):\n" + toMoveVec(publicInputsToSuiBytes(publicSignals)));
  console.log("\nwithdraw_vk_bytes (" + vkToSuiBytes(vkey).length + " bytes):\n" + toMoveVec(vkToSuiBytes(vkey)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
