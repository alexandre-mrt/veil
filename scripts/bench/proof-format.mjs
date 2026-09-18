/**
 * proof-format.mjs — Groth16 proof / public-input / VK byte encoding for Sui.
 *
 * Mirrors scripts/src/proof-converter.ts exactly (arkworks compressed BN254 serialization).
 * Duplicated here (rather than imported) so scripts/bench/ stays a plain-Node package with no
 * bun/TS toolchain dependency, the same tradeoff witnesses.mjs already makes for circuit witnesses.
 */
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const Q_HALF = (Q - 1n) / 2n;

export function bigintToLE32(n) {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

export function compressG1(x, y) {
  const bytes = bigintToLE32(x);
  if (y > Q_HALF) bytes[31] |= 0x80;
  return bytes;
}

export function compressG2(x0, x1, y0, y1) {
  const result = new Uint8Array(64);
  result.set(bigintToLE32(x0), 0);
  result.set(bigintToLE32(x1), 32);
  let setSign = false;
  if (y1 > Q_HALF) setSign = true;
  else if (y1 === Q_HALF && y0 > Q_HALF) setSign = true;
  if (setSign) result[63] |= 0x80;
  return result;
}

export function proofToSuiBytes(proof) {
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

export function publicInputsToSuiBytes(signals) {
  const result = new Uint8Array(signals.length * 32);
  for (let i = 0; i < signals.length; i++) {
    result.set(bigintToLE32(BigInt(signals[i])), i * 32);
  }
  return result;
}

export function vkToSuiBytes(vk) {
  const parts = [];
  parts.push(compressG1(BigInt(vk.vk_alpha_1[0]), BigInt(vk.vk_alpha_1[1])));
  parts.push(
    compressG2(
      BigInt(vk.vk_beta_2[0][0]),
      BigInt(vk.vk_beta_2[0][1]),
      BigInt(vk.vk_beta_2[1][0]),
      BigInt(vk.vk_beta_2[1][1]),
    ),
  );
  parts.push(
    compressG2(
      BigInt(vk.vk_gamma_2[0][0]),
      BigInt(vk.vk_gamma_2[0][1]),
      BigInt(vk.vk_gamma_2[1][0]),
      BigInt(vk.vk_gamma_2[1][1]),
    ),
  );
  parts.push(
    compressG2(
      BigInt(vk.vk_delta_2[0][0]),
      BigInt(vk.vk_delta_2[0][1]),
      BigInt(vk.vk_delta_2[1][0]),
      BigInt(vk.vk_delta_2[1][1]),
    ),
  );
  const icLen = BigInt(vk.IC.length);
  const lenBytes = new Uint8Array(8);
  let v = icLen;
  for (let i = 0; i < 8; i++) {
    lenBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  parts.push(lenBytes);
  for (const ic of vk.IC) {
    parts.push(compressG1(BigInt(ic[0]), BigInt(ic[1])));
  }
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
