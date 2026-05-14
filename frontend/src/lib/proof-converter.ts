/**
 * proof-converter.ts
 *
 * Converts snarkjs Groth16 proof JSON to Sui's expected byte format.
 * Adapted from scripts/src/proof-converter.ts for browser usage.
 *
 * Serialization: arkworks compressed serialization for BN254 curve points.
 * Key invariant: snarkjs stores G2 coordinates with swapped (x1, x0) / (y1, y0) ordering,
 * while arkworks expects (x0, x1) / (y0, y1). All G2 conversions apply this swap.
 */

const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const Q_HALF = (Q - 1n) / 2n;

/** Converts a bigint to a 32-byte little-endian Uint8Array. */
function bigintToLE32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

/** Compresses a G1 affine point (x, y) into 32 bytes. */
function compressG1(x: bigint, y: bigint): Uint8Array {
  const bytes = bigintToLE32(x);
  if (y > Q_HALF) {
    bytes[31] |= 0x80;
  }
  return bytes;
}

/**
 * Compresses a G2 affine point into 64 bytes.
 * Parameters use arkworks ordering: (x0, x1, y0, y1).
 */
function compressG2(x0: bigint, x1: bigint, y0: bigint, y1: bigint): Uint8Array {
  const result = new Uint8Array(64);
  result.set(bigintToLE32(x0), 0);
  result.set(bigintToLE32(x1), 32);

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
  readonly pi_a: [string, string, string];
  readonly pi_b: [[string, string], [string, string], [string, string]];
  readonly pi_c: [string, string, string];
}

// ---------------------------------------------------------------------------
// Main conversion functions
// ---------------------------------------------------------------------------

/**
 * Converts a snarkjs Groth16 proof to Sui-compatible bytes (128 bytes total).
 *
 * Layout:
 *   [0..31]   -- A (G1 compressed, 32 bytes)
 *   [32..95]  -- B (G2 compressed, 64 bytes)
 *   [96..127] -- C (G1 compressed, 32 bytes)
 *
 * CRITICAL: snarkjs pi_b = [[x1, x0], [y1, y0], [...]]
 * arkworks expects (x0, x1, y0, y1) -- indices are swapped.
 */
export function proofToSuiBytes(proof: SnarkjsProof): Uint8Array {
  const result = new Uint8Array(128);

  const a = compressG1(BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1]));
  result.set(a, 0);

  const b = compressG2(
    BigInt(proof.pi_b[0][1]),
    BigInt(proof.pi_b[0][0]),
    BigInt(proof.pi_b[1][1]),
    BigInt(proof.pi_b[1][0]),
  );
  result.set(b, 32);

  const c = compressG1(BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1]));
  result.set(c, 96);

  return result;
}

/**
 * Converts public input signals to Sui-compatible bytes.
 * Each signal is encoded as a 32-byte little-endian value.
 * Total output: signals.length * 32 bytes.
 */
export function publicInputsToSuiBytes(signals: readonly string[]): Uint8Array {
  const result = new Uint8Array(signals.length * 32);
  for (let i = 0; i < signals.length; i++) {
    const bytes = bigintToLE32(BigInt(signals[i]));
    result.set(bytes, i * 32);
  }
  return result;
}
