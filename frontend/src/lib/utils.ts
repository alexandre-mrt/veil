/**
 * Parses a decimal string amount into a bigint with the given number of decimals.
 * Avoids floating-point precision issues by operating on string parts directly.
 *
 * @example parseAmountToBigInt("1.5", 6) => 1_500_000n
 */
export function parseAmountToBigInt(amount: string, decimals: number): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const paddedFrac = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + paddedFrac);
}
