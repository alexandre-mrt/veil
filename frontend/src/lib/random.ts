/**
 * Cryptographically secure random bigint generation.
 * Uses 31 bytes (248 bits) to stay within the BN254 scalar field.
 */
export function generateRandomBigInt(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return bytes.reduce(
    (acc, byte, i) => acc | (BigInt(byte) << BigInt(i * 8)),
    0n,
  );
}
