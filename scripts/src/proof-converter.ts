/**
 * proof-converter.ts
 *
 * Converts snarkjs Groth16 proof JSON to Sui's expected byte format.
 * Serialization: arkworks compressed serialization for BN254 curve points.
 *
 * Key invariant: snarkjs stores G2 coordinates with swapped (x1, x0) / (y1, y0) ordering,
 * while arkworks expects (x0, x1) / (y0, y1). All G2 conversions apply this swap.
 */

// BN254 field modulus (Fq) and scalar field modulus (Fr)
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const Q_HALF = (Q - 1n) / 2n;

// Export constants for external use / verification
export { Q, R, Q_HALF };

/**
 * Converts a bigint to a 32-byte little-endian Uint8Array.
 * Assumes n fits in 32 bytes (< 2^256).
 */
export function bigintToLE32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

/**
 * Compresses a G1 affine point (x, y) into 32 bytes.
 * Encoding: x coordinate in LE, sign bit (MSB of last byte) set if y > (q-1)/2.
 */
export function compressG1(x: bigint, y: bigint): Uint8Array {
  const bytes = bigintToLE32(x);
  if (y > Q_HALF) {
    bytes[31] |= 0x80;
  }
  return bytes;
}

/**
 * Compresses a G2 affine point into 64 bytes.
 *
 * Parameters use arkworks ordering: (x0, x1, y0, y1).
 * Note: callers receiving snarkjs data MUST swap coordinates before calling this.
 *
 * Layout: [x0 LE 32 bytes | x1 LE 32 bytes], sign bit in byte[63].
 * Sign rule: lexicographic comparison of (y1, y0) against Q_HALF.
 */
export function compressG2(x0: bigint, x1: bigint, y0: bigint, y1: bigint): Uint8Array {
  const result = new Uint8Array(64);
  result.set(bigintToLE32(x0), 0);
  result.set(bigintToLE32(x1), 32);

  // Sign bit: lexicographic comparison of (y1, y0)
  let setSign = false;
  if (y1 > Q_HALF) {
    setSign = true;
  } else if (y1 === Q_HALF && y0 > Q_HALF) {
    setSign = true;
  }
  if (setSign) {
    result[63] |= 0x80;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SnarkjsProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
}

export interface SnarkjsVK {
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}

// ---------------------------------------------------------------------------
// Main conversion functions
// ---------------------------------------------------------------------------

/**
 * Converts a snarkjs Groth16 proof to Sui-compatible bytes (128 bytes total).
 *
 * Layout:
 *   [0..31]   — A (G1 compressed, 32 bytes)
 *   [32..95]  — B (G2 compressed, 64 bytes)
 *   [96..127] — C (G1 compressed, 32 bytes)
 *
 * CRITICAL: snarkjs pi_b = [[x1, x0], [y1, y0], [...]]
 * arkworks expects (x0, x1, y0, y1) — indices are swapped.
 */
export function proofToSuiBytes(proof: SnarkjsProof): Uint8Array {
  const result = new Uint8Array(128);

  // G1 point A (bytes 0..31)
  const a = compressG1(BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1]));
  result.set(a, 0);

  // G2 point B (bytes 32..95) — apply snarkjs coordinate swap
  const b = compressG2(
    BigInt(proof.pi_b[0][1]), // x0 (snarkjs stores as [1])
    BigInt(proof.pi_b[0][0]), // x1 (snarkjs stores as [0])
    BigInt(proof.pi_b[1][1]), // y0 (snarkjs stores as [1])
    BigInt(proof.pi_b[1][0]), // y1 (snarkjs stores as [0])
  );
  result.set(b, 32);

  // G1 point C (bytes 96..127)
  const c = compressG1(BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1]));
  result.set(c, 96);

  return result;
}

/**
 * Converts public input signals to Sui-compatible bytes.
 * Each signal is encoded as a 32-byte little-endian value.
 * Total output: signals.length * 32 bytes.
 */
export function publicInputsToSuiBytes(signals: string[]): Uint8Array {
  const result = new Uint8Array(signals.length * 32);
  for (let i = 0; i < signals.length; i++) {
    const bytes = bigintToLE32(BigInt(signals[i]));
    result.set(bytes, i * 32);
  }
  return result;
}

/**
 * Converts a snarkjs verification key to Sui-compatible bytes.
 *
 * Layout (arkworks PreparedVK format):
 *   alpha_g1   — 32 bytes  (G1 compressed)
 *   beta_g2    — 64 bytes  (G2 compressed)
 *   gamma_g2   — 64 bytes  (G2 compressed)
 *   delta_g2   — 64 bytes  (G2 compressed)
 *   ic_len     — 8 bytes   (u64 little-endian, number of IC points)
 *   IC[0..n]   — 32 bytes each (G1 compressed)
 *
 * Total: 32 + 64 + 64 + 64 + 8 + IC.length * 32 bytes.
 * All G2 points apply the snarkjs coordinate swap.
 */
export function vkToSuiBytes(vk: SnarkjsVK): Uint8Array {
  const parts: Uint8Array[] = [];

  // alpha_g1 (32 bytes)
  parts.push(compressG1(BigInt(vk.vk_alpha_1[0]), BigInt(vk.vk_alpha_1[1])));

  // beta_g2 (64 bytes) — snarkjs swap applied
  parts.push(
    compressG2(
      BigInt(vk.vk_beta_2[0][1]),
      BigInt(vk.vk_beta_2[0][0]),
      BigInt(vk.vk_beta_2[1][1]),
      BigInt(vk.vk_beta_2[1][0]),
    ),
  );

  // gamma_g2 (64 bytes) — snarkjs swap applied
  parts.push(
    compressG2(
      BigInt(vk.vk_gamma_2[0][1]),
      BigInt(vk.vk_gamma_2[0][0]),
      BigInt(vk.vk_gamma_2[1][1]),
      BigInt(vk.vk_gamma_2[1][0]),
    ),
  );

  // delta_g2 (64 bytes) — snarkjs swap applied
  parts.push(
    compressG2(
      BigInt(vk.vk_delta_2[0][1]),
      BigInt(vk.vk_delta_2[0][0]),
      BigInt(vk.vk_delta_2[1][1]),
      BigInt(vk.vk_delta_2[1][0]),
    ),
  );

  // gamma_abc_len as u64 little-endian (8 bytes)
  const icLen = BigInt(vk.IC.length);
  const lenBytes = new Uint8Array(8);
  let v = icLen;
  for (let i = 0; i < 8; i++) {
    lenBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  parts.push(lenBytes);

  // IC points (32 bytes each, G1 compressed)
  for (const ic of vk.IC) {
    parts.push(compressG1(BigInt(ic[0]), BigInt(ic[1])));
  }

  // Concatenate all parts
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Converts a Uint8Array to a lowercase hex string.
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
