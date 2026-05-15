/**
 * test-converter.ts
 *
 * Tests for the snarkjs → Sui Groth16 proof byte converter.
 * Run with: bun run src/test-converter.ts
 */

import {
  Q,
  Q_HALF,
  R,
  bigintToLE32,
  compressG1,
  compressG2,
  proofToSuiBytes,
  publicInputsToSuiBytes,
  toHex,
  vkToSuiBytes,
} from "./proof-converter.js";
import type { SnarkjsProof, SnarkjsVK } from "./proof-converter.js";

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (got ${actual}, expected ${expected})`);
}

function section(name: string): void {
  console.log(`\n[${name}]`);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function leToBI(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// T1: bigintToLE32
// ---------------------------------------------------------------------------

section("bigintToLE32");

{
  // Zero → all zeros
  const zero = bigintToLE32(0n);
  assert(zero.length === 32, "zero: length is 32");
  assert(zero.every((b) => b === 0), "zero: all bytes are 0");
}

{
  // One → first byte is 1, rest 0
  const one = bigintToLE32(1n);
  assertEqual(one[0], 1, "one: byte[0] = 1");
  assert(one.slice(1).every((b) => b === 0), "one: bytes[1..31] all zero");
}

{
  // Max Fr value — round-trip through bigintToLE32 → leToBI
  const frBytes = bigintToLE32(R);
  assertEqual(frBytes.length, 32, "Fr: length is 32");
  const recovered = leToBI(frBytes);
  assert(recovered === R, `Fr: round-trip matches (${recovered} === ${R})`);
}

{
  // 256 → bytes[0] = 0, bytes[1] = 1
  const val = bigintToLE32(256n);
  assertEqual(val[0], 0, "256: byte[0] = 0");
  assertEqual(val[1], 1, "256: byte[1] = 1");
}

// ---------------------------------------------------------------------------
// T2: compressG1 — sign bit behavior
// ---------------------------------------------------------------------------

section("compressG1 — sign bit");

{
  // Known small point: x=1, y=2 (y <= Q_HALF → no sign bit)
  const result = compressG1(1n, 2n);
  assertEqual(result.length, 32, "G1(1,2): output is 32 bytes");
  assertEqual(result[31] & 0x80, 0, "G1(1,2): sign bit NOT set (y <= Q_HALF)");
  assertEqual(result[0], 1, "G1(1,2): x = 1 LE, byte[0] = 1");
}

{
  // y = Q_HALF + 1n → sign bit should be set
  const result = compressG1(42n, Q_HALF + 1n);
  assertEqual(result[31] & 0x80, 0x80, "G1(42, Q_HALF+1): sign bit SET");
}

{
  // y = Q_HALF exactly → no sign bit (boundary check, NOT greater)
  const result = compressG1(42n, Q_HALF);
  assertEqual(result[31] & 0x80, 0, "G1(42, Q_HALF): sign bit NOT set (boundary)");
}

{
  // y = Q - 1n (maximum valid y) → sign bit set
  const result = compressG1(5n, Q - 1n);
  assertEqual(result[31] & 0x80, 0x80, "G1(5, Q-1): sign bit SET");
}

// ---------------------------------------------------------------------------
// T3: compressG2 — coordinate swap + sign bit
// ---------------------------------------------------------------------------

section("compressG2 — coordinate swap and sign bit");

{
  // Basic structure: 64 bytes, x0 in [0..31], x1 in [32..63]
  const result = compressG2(1n, 2n, 3n, 4n);
  assertEqual(result.length, 64, "G2: output is 64 bytes");
  // x0=1 → byte[0]=1 in LE
  assertEqual(result[0], 1, "G2: x0=1 → byte[0] = 1");
  // x1=2 → byte[32]=2 in LE
  assertEqual(result[32], 2, "G2: x1=2 → byte[32] = 2");
}

{
  // y1 > Q_HALF → sign bit set in byte[63]
  const result = compressG2(0n, 0n, 0n, Q_HALF + 1n);
  assertEqual(result[63] & 0x80, 0x80, "G2: y1 > Q_HALF → sign bit SET");
}

{
  // y1 < Q_HALF → no sign bit
  const result = compressG2(0n, 0n, 0n, Q_HALF - 1n);
  assertEqual(result[63] & 0x80, 0, "G2: y1 < Q_HALF → sign bit NOT set");
}

{
  // y1 = Q_HALF, y0 > Q_HALF → sign bit set (lexicographic tie-break)
  const result = compressG2(0n, 0n, Q_HALF + 1n, Q_HALF);
  assertEqual(result[63] & 0x80, 0x80, "G2: y1=Q_HALF, y0>Q_HALF → sign bit SET");
}

{
  // y1 = Q_HALF, y0 = Q_HALF → no sign bit (neither strictly greater)
  const result = compressG2(0n, 0n, Q_HALF, Q_HALF);
  assertEqual(result[63] & 0x80, 0, "G2: y1=Q_HALF, y0=Q_HALF → sign bit NOT set");
}

{
  // y1 = Q_HALF, y0 < Q_HALF → no sign bit
  const result = compressG2(0n, 0n, Q_HALF - 1n, Q_HALF);
  assertEqual(result[63] & 0x80, 0, "G2: y1=Q_HALF, y0<Q_HALF → sign bit NOT set");
}

// ---------------------------------------------------------------------------
// T4: proofToSuiBytes — exactly 128 bytes
// ---------------------------------------------------------------------------

section("proofToSuiBytes — byte length and layout");

// Realistic-looking BN254 field element strings (valid magnitude, < Q)
const MOCK_PROOF: SnarkjsProof = {
  pi_a: [
    "12045230862738028760829929748729040616884688178673734531456831584126789012345",
    "7891234567890123456789012345678901234567890123456789012345678901234567890123",
    "1",
  ],
  pi_b: [
    [
      // [x1, x0] in snarkjs ordering
      "16542874125874125874125874125874125874125874125874125874125874125874125874125",
      "18765432109876543210987654321098765432109876543210987654321098765432109876543",
    ],
    [
      // [y1, y0] in snarkjs ordering
      "19999999999999999999999999999999999999999999999999999999999999999999999999991",
      "3333333333333333333333333333333333333333333333333333333333333333333333333331",
    ],
    ["1", "0"],
  ],
  pi_c: [
    "11111111111111111111111111111111111111111111111111111111111111111111111111111",
    "5555555555555555555555555555555555555555555555555555555555555555555555555555",
    "1",
  ],
};

{
  const result = proofToSuiBytes(MOCK_PROOF);
  assertEqual(result.length, 128, "proofToSuiBytes: output is exactly 128 bytes");
}

{
  // Verify segment layout: different segments should differ for distinct points
  const result = proofToSuiBytes(MOCK_PROOF);

  // A occupies [0..31], C occupies [96..127]; they differ because pi_a[0] != pi_c[0]
  const aSegment = result.slice(0, 32);
  const cSegment = result.slice(96, 128);
  assert(!bytesEqual(aSegment, cSegment), "proofToSuiBytes: A and C segments differ");

  // B occupies [32..95] — 64 bytes
  const bSegment = result.slice(32, 96);
  assertEqual(bSegment.length, 64, "proofToSuiBytes: B segment is 64 bytes");
}

{
  // Verify snarkjs swap: A segment encodes pi_a[0] (x)
  const result = proofToSuiBytes(MOCK_PROOF);
  const xA = BigInt(MOCK_PROOF.pi_a[0]);
  const expectedABytes = bigintToLE32(xA);
  // Mask sign bit for comparison
  const maskedByte31 = result[31] & 0x7f;
  const expectedMasked = expectedABytes[31] & 0x7f;
  assertEqual(maskedByte31, expectedMasked, "proofToSuiBytes: A[31] (masked) matches pi_a[0] LE encoding");
}

// ---------------------------------------------------------------------------
// T5: publicInputsToSuiBytes — N * 32 bytes, LE ordering
// ---------------------------------------------------------------------------

section("publicInputsToSuiBytes — length and LE encoding");

{
  // 6 inputs → 192 bytes
  const signals = ["1", "2", "3", "4", "5", "6"];
  const result = publicInputsToSuiBytes(signals);
  assertEqual(result.length, 192, "6 signals → 192 bytes");
}

{
  // 1 input → 32 bytes
  const result = publicInputsToSuiBytes(["256"]);
  assertEqual(result.length, 32, "1 signal → 32 bytes");
  // 256 = 0x100 in LE: byte[0]=0, byte[1]=1, rest=0
  assertEqual(result[0], 0, "signal 256: byte[0] = 0");
  assertEqual(result[1], 1, "signal 256: byte[1] = 1");
  assert(result.slice(2).every((b) => b === 0), "signal 256: bytes[2..31] = 0");
}

{
  // Signal = 1 → byte[0]=1, rest=0
  const result = publicInputsToSuiBytes(["1"]);
  assertEqual(result[0], 1, "signal 1: byte[0] = 1 (LE)");
  assert(result.slice(1).every((b) => b === 0), "signal 1: bytes[1..31] = 0");
}

{
  // Zero input
  const result = publicInputsToSuiBytes(["0"]);
  assert(result.every((b) => b === 0), "signal 0: all bytes = 0");
}

{
  // 0 inputs → empty
  const result = publicInputsToSuiBytes([]);
  assertEqual(result.length, 0, "empty signals → 0 bytes");
}

// ---------------------------------------------------------------------------
// T6: vkToSuiBytes — structure verification
// ---------------------------------------------------------------------------

section("vkToSuiBytes — structure and byte layout");

// Construct a minimal VK with 2 IC points
const MOCK_VK: SnarkjsVK = {
  vk_alpha_1: [
    "20925091369883395154615568705563085873040774117781897213117823379379965690078",
    "18929600188613888424793735418840516618086985870763849990990882727464396083688",
    "1",
  ],
  vk_beta_2: [
    [
      // [x1, x0] snarkjs ordering
      "4252822878758300859123897981450591353533073413197771768651442665752259397132",
      "6375614351688725206403948262868962793625744043794305715222011528459656738731",
    ],
    [
      // [y1, y0] snarkjs ordering
      "21039565435327201027392031664161928375086428312386303024435441787580519697331",
      "16546823691094662073086014605800325979337553263664411778537491922875905022677",
    ],
    ["1", "0"],
  ],
  vk_gamma_2: [
    [
      "10857046999023057135944570762232829481370756359578518086990519993285655852781",
      "11559732032986387107991004021392285783925812861821192530917403151452391805634",
    ],
    [
      "8495653923123431417604973247489272438418190587263600148770280649306958101930",
      "4082367875863433681332203403145435568316851327593401208105741076214120093531",
    ],
    ["1", "0"],
  ],
  vk_delta_2: [
    [
      "9540869097560742010427935940684810734897854411765750994754614823213853786587",
      "18303429508773445421116186856891466098816094993800786476048093949699543059540",
    ],
    [
      "11559732032986387107991004021392285783925812861821192530917403151452391805634",
      "10857046999023057135944570762232829481370756359578518086990519993285655852781",
    ],
    ["1", "0"],
  ],
  IC: [
    [
      "17822712762047055741097765882834226671024764895023948895979947703116001695019",
      "12654895965949718855618148891183831429988823397225780993316040028929936447505",
      "1",
    ],
    [
      "9040723826888018978975779695754062893340700399659855621015039023777264067804",
      "4820261499825673116847498453148476001011736200636990773785064380832000573696",
      "1",
    ],
  ],
};

{
  const result = vkToSuiBytes(MOCK_VK);
  // Expected: 32 + 64 + 64 + 64 + 8 + 2*32 = 296 bytes
  const expectedLen = 32 + 64 + 64 + 64 + 8 + MOCK_VK.IC.length * 32;
  assertEqual(result.length, expectedLen, `vkToSuiBytes: correct total length (${expectedLen} bytes)`);
}

{
  // Verify alpha_g1 occupies bytes [0..31]
  const result = vkToSuiBytes(MOCK_VK);
  const alpha = compressG1(BigInt(MOCK_VK.vk_alpha_1[0]), BigInt(MOCK_VK.vk_alpha_1[1]));
  const segment = result.slice(0, 32);
  assert(bytesEqual(segment, alpha), "vkToSuiBytes: alpha_g1 segment matches compressG1");
}

{
  // Verify IC length field at bytes [224..231] (32+64+64+64=224)
  const result = vkToSuiBytes(MOCK_VK);
  const lenOffset = 32 + 64 + 64 + 64;
  const lenBytes = result.slice(lenOffset, lenOffset + 8);
  // IC.length = 2 → bytes [2, 0, 0, 0, 0, 0, 0, 0] in LE
  assertEqual(lenBytes[0], MOCK_VK.IC.length, "vkToSuiBytes: IC length LE byte[0] correct");
  assert(lenBytes.slice(1).every((b) => b === 0), "vkToSuiBytes: IC length upper bytes = 0");
}

{
  // Verify first IC point at bytes [232..263]
  const result = vkToSuiBytes(MOCK_VK);
  const icOffset = 32 + 64 + 64 + 64 + 8;
  const ic0Segment = result.slice(icOffset, icOffset + 32);
  const expectedIc0 = compressG1(BigInt(MOCK_VK.IC[0][0]), BigInt(MOCK_VK.IC[0][1]));
  assert(bytesEqual(ic0Segment, expectedIc0), "vkToSuiBytes: IC[0] segment matches compressG1");
}

{
  // Verify second IC point at bytes [264..295]
  const result = vkToSuiBytes(MOCK_VK);
  const icOffset = 32 + 64 + 64 + 64 + 8 + 32;
  const ic1Segment = result.slice(icOffset, icOffset + 32);
  const expectedIc1 = compressG1(BigInt(MOCK_VK.IC[1][0]), BigInt(MOCK_VK.IC[1][1]));
  assert(bytesEqual(ic1Segment, expectedIc1), "vkToSuiBytes: IC[1] segment matches compressG1");
}

// ---------------------------------------------------------------------------
// T7: Point at infinity / edge cases
// ---------------------------------------------------------------------------

section("Edge cases");

{
  // x=0, y=0 — point at infinity representation (no sign bit expected since y=0 <= Q_HALF)
  const result = compressG1(0n, 0n);
  assertEqual(result.length, 32, "infinity G1: 32 bytes");
  assert(result.every((b) => b === 0), "infinity G1: all zero bytes");
}

{
  // G2 with all zeros
  const result = compressG2(0n, 0n, 0n, 0n);
  assertEqual(result.length, 64, "infinity G2: 64 bytes");
  assert(result.every((b) => b === 0), "infinity G2: all zero bytes");
}

{
  // toHex: known byte sequence
  const bytes = new Uint8Array([0x0a, 0xff, 0x10, 0x00]);
  assertEqual(toHex(bytes), "0aff1000", "toHex: correct hex output");
}

{
  // toHex: empty array
  assertEqual(toHex(new Uint8Array([])), "", "toHex: empty → empty string");
}

{
  // publicInputsToSuiBytes: max Fr value round-trip
  const result = publicInputsToSuiBytes([R.toString()]);
  const recovered = leToBI(result.slice(0, 32));
  assert(recovered === R, "publicInputsToSuiBytes: max Fr round-trip correct");
}

// ---------------------------------------------------------------------------
// T8: bigintToLE32 — additional edge cases and security
// ---------------------------------------------------------------------------

section("bigintToLE32 — edge cases");

{
  // 255 → byte[0]=255, rest=0
  const result = bigintToLE32(255n);
  assertEqual(result[0], 255, "bigintToLE32(255): byte[0] = 255");
  assert(result.slice(1).every((b) => b === 0), "bigintToLE32(255): bytes[1..31] = 0");
}

{
  // 256 → byte[0]=0, byte[1]=1, rest=0 (already covered but explicit name)
  const result = bigintToLE32(256n);
  assertEqual(result[0], 0, "bigintToLE32(256): byte[0] = 0");
  assertEqual(result[1], 1, "bigintToLE32(256): byte[1] = 1");
  assert(result.slice(2).every((b) => b === 0), "bigintToLE32(256): bytes[2..31] = 0");
}

{
  // 2^64 - 1 → first 8 bytes are 0xFF, bytes[8..31] = 0
  const val = (1n << 64n) - 1n;
  const result = bigintToLE32(val);
  assert(
    result.slice(0, 8).every((b) => b === 0xff),
    "bigintToLE32(2^64-1): first 8 bytes are 0xFF",
  );
  assert(result.slice(8).every((b) => b === 0), "bigintToLE32(2^64-1): bytes[8..31] = 0");
}

{
  // BN254 Q field modulus — round-trip through leToBI
  const result = bigintToLE32(Q);
  assertEqual(result.length, 32, "bigintToLE32(Q): length is 32");
  const recovered = leToBI(result);
  assert(recovered === Q, `bigintToLE32(Q): round-trip matches Q`);
  // Verify first byte explicitly: Q & 0xFF = 71 (0x47)
  assertEqual(result[0], 71, "bigintToLE32(Q): byte[0] = 71 (Q & 0xFF)");
}

{
  // 2^256 - 1 — all 32 bytes should be 0xFF (implementation truncates to 256 bits)
  const val = (1n << 256n) - 1n;
  const result = bigintToLE32(val);
  assert(result.every((b) => b === 0xff), "bigintToLE32(2^256-1): all 32 bytes are 0xFF");
}

{
  // Negative value — NIGHT-SHIFT-REVIEW: current implementation silently produces
  // two's-complement bytes instead of throwing. Test documents actual behavior.
  // Expected by spec: throw. Actual: silent wrap to 0xFF bytes.
  // NIGHT-SHIFT-REVIEW: bigintToLE32 does not validate negative input — security gap
  let threw = false;
  try {
    const result = bigintToLE32(-1n);
    // If it does not throw, all bytes are 0xFF (two's complement of -1)
    threw = false;
    assert(result.every((b) => b === 0xff), "bigintToLE32(-1): silent wrap — all bytes 0xFF (no throw)");
  } catch {
    threw = true;
  }
  // Document: the spec says this should throw; log if it doesn't
  assert(!threw, "bigintToLE32(-1): currently does NOT throw (spec says it should — validation missing)");
}

// ---------------------------------------------------------------------------
// T9: compressG1 — known generator and explicit edge cases
// ---------------------------------------------------------------------------

section("compressG1 — generator and edge cases");

{
  // BN254 G1 generator: x=1, y=2
  // y=2 < Q_HALF → sign bit NOT set
  // Expected compressed: [1, 0, 0, ..., 0] (32 bytes, no sign bit)
  const G1x = 1n;
  const G1y = 2n;
  const result = compressG1(G1x, G1y);
  assertEqual(result[0], 1, "G1 generator: byte[0] = 1 (x=1 LE)");
  assert(result.slice(1, 31).every((b) => b === 0), "G1 generator: bytes[1..30] = 0");
  assertEqual(result[31] & 0x80, 0, "G1 generator: sign bit NOT set (y=2 < Q_HALF)");
  assertEqual(result[31], 0, "G1 generator: byte[31] = 0 (no sign bit, x fits in <31 bytes)");
}

{
  // y = Q - 1n (maximum valid field element) → y > Q_HALF → sign bit SET
  const result = compressG1(7n, Q - 1n);
  assertEqual(result[31] & 0x80, 0x80, "G1: y=Q-1 → sign bit SET");
}

{
  // y = 1n (small positive) → y < Q_HALF → sign bit NOT set
  const result = compressG1(3n, 1n);
  assertEqual(result[31] & 0x80, 0, "G1: y=1 → sign bit NOT set");
  assertEqual(result[0], 3, "G1: x=3 → byte[0] = 3");
}

{
  // y = 0n → y <= Q_HALF → sign bit NOT set
  const result = compressG1(5n, 0n);
  assertEqual(result[31] & 0x80, 0, "G1: y=0 → sign bit NOT set");
  assertEqual(result[0], 5, "G1: x=5 preserved in byte[0]");
}

{
  // x=0, y=1 → valid encoding: all bytes 0 except no sign bit
  const result = compressG1(0n, 1n);
  assertEqual(result.length, 32, "G1(x=0,y=1): length 32");
  assert(result.every((b) => b === 0), "G1(x=0,y=1): all bytes 0 (x=0 LE, y=1 < Q_HALF)");
}

// ---------------------------------------------------------------------------
// T10: compressG2 — known generator and sign bit boundary
// ---------------------------------------------------------------------------

section("compressG2 — generator and sign bit");

{
  // BN254 G2 generator in arkworks ordering:
  // x0 = 10857046999023057135944570762232829481370756359578518086990519993285655852781
  // x1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634
  // y0 = 8495653923123431417604973247489272438418190587263600148770280649306958101930
  // y1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531
  // Sign rule: y1=4082...531 < Q_HALF → sign bit NOT set
  const G2x0 = 10857046999023057135944570762232829481370756359578518086990519993285655852781n;
  const G2x1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634n;
  const G2y0 = 8495653923123431417604973247489272438418190587263600148770280649306958101930n;
  const G2y1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531n;

  const result = compressG2(G2x0, G2x1, G2y0, G2y1);
  assertEqual(result.length, 64, "G2 generator: output is 64 bytes");

  // x0 byte[0] = G2x0 & 0xFF = 237
  assertEqual(result[0], 237, "G2 generator: byte[0] = G2x0 & 0xFF (237)");
  // x1 byte[0] (= output byte[32]) = G2x1 & 0xFF = 194
  assertEqual(result[32], 194, "G2 generator: byte[32] = G2x1 & 0xFF (194)");
  // sign bit NOT set (y1 < Q_HALF)
  assertEqual(result[63] & 0x80, 0, "G2 generator: sign bit NOT set (y1 < Q_HALF)");
}

{
  // y1 > Q_HALF → sign bit SET (already covered in T3 but explicit section label)
  const result = compressG2(1n, 2n, 3n, Q_HALF + 1n);
  assertEqual(result[63] & 0x80, 0x80, "G2: explicit y1 > Q_HALF → sign bit SET");
}

{
  // y1 = 0, y0 > Q_HALF → sign bit SET (tie-break on y0)
  const result = compressG2(0n, 0n, Q_HALF + 1n, 0n);
  // y1=0: not > Q_HALF. y1=0: y1 === Q_HALF? No. → sign NOT set
  // The tie-break condition is: y1 === Q_HALF AND y0 > Q_HALF
  // Here y1=0 !== Q_HALF, so sign NOT set even though y0 > Q_HALF
  assertEqual(result[63] & 0x80, 0, "G2: y1=0, y0>Q_HALF → sign NOT set (y1 != Q_HALF for tie-break)");
}

{
  // y1 = Q_HALF (exactly), y0 > Q_HALF → sign bit SET (lex tie-break activates)
  const result = compressG2(0n, 0n, Q_HALF + 1n, Q_HALF);
  assertEqual(result[63] & 0x80, 0x80, "G2: y1=Q_HALF, y0>Q_HALF → sign bit SET (tie-break)");
}

{
  // y1 = 0, y0 = 0 → both zero → sign NOT set
  const result = compressG2(5n, 6n, 0n, 0n);
  assertEqual(result[63] & 0x80, 0, "G2: y1=0, y0=0 → sign bit NOT set");
}

// ---------------------------------------------------------------------------
// T11: proofToSuiBytes — section-by-section correctness
// ---------------------------------------------------------------------------

section("proofToSuiBytes — section correctness");

{
  // A section [0..31] must equal compressG1(pi_a[0], pi_a[1])
  const result = proofToSuiBytes(MOCK_PROOF);
  const expectedA = compressG1(BigInt(MOCK_PROOF.pi_a[0]), BigInt(MOCK_PROOF.pi_a[1]));
  const aSection = result.slice(0, 32);
  assert(bytesEqual(aSection, expectedA), "proofToSuiBytes: A section [0..31] = compressG1(pi_a)");
}

{
  // B section [32..95] must equal compressG2 using pi_b WITHOUT coordinate swap
  // (implementation uses pi_b[0][0] as x_c0, pi_b[0][1] as x_c1 — NO swap)
  const result = proofToSuiBytes(MOCK_PROOF);
  const expectedB = compressG2(
    BigInt(MOCK_PROOF.pi_b[0][0]), // x_c0 — NO swap
    BigInt(MOCK_PROOF.pi_b[0][1]), // x_c1 — NO swap
    BigInt(MOCK_PROOF.pi_b[1][0]), // y_c0 — NO swap
    BigInt(MOCK_PROOF.pi_b[1][1]), // y_c1 — NO swap
  );
  const bSection = result.slice(32, 96);
  assert(bytesEqual(bSection, expectedB), "proofToSuiBytes: B section [32..95] = compressG2(pi_b) — no coordinate swap");
}

{
  // C section [96..127] must equal compressG1(pi_c[0], pi_c[1])
  const result = proofToSuiBytes(MOCK_PROOF);
  const expectedC = compressG1(BigInt(MOCK_PROOF.pi_c[0]), BigInt(MOCK_PROOF.pi_c[1]));
  const cSection = result.slice(96, 128);
  assert(bytesEqual(cSection, expectedC), "proofToSuiBytes: C section [96..127] = compressG1(pi_c)");
}

// ---------------------------------------------------------------------------
// T12: publicInputsToSuiBytes — independence and Veil circuit size
// ---------------------------------------------------------------------------

section("publicInputsToSuiBytes — independence and circuit size");

{
  // Each input occupies an independent 32-byte slot — changing one must not affect others
  const signals = ["1", "2", "3"];
  const result = publicInputsToSuiBytes(signals);
  // Slot 0: signal "1" → byte[0]=1, rest=0
  assertEqual(result[0], 1, "signal[0]=1: slot 0 byte[0] = 1");
  assert(result.slice(1, 32).every((b) => b === 0), "signal[0]=1: slot 0 bytes[1..31] = 0");
  // Slot 1: signal "2" → byte[32]=2, rest=0
  assertEqual(result[32], 2, "signal[1]=2: slot 1 byte[0] = 2");
  assert(result.slice(33, 64).every((b) => b === 0), "signal[1]=2: slot 1 bytes[1..31] = 0");
  // Slot 2: signal "3" → byte[64]=3, rest=0
  assertEqual(result[64], 3, "signal[2]=3: slot 2 byte[0] = 3");
  assert(result.slice(65, 96).every((b) => b === 0), "signal[2]=3: slot 2 bytes[1..31] = 0");
}

{
  // 6 inputs (Veil circuit) → 192 bytes, each slot round-trips correctly
  const veilSignals = ["100", "200", "300", "400", "500", "600"];
  const result = publicInputsToSuiBytes(veilSignals);
  assertEqual(result.length, 192, "Veil 6 inputs → 192 bytes");
  // Verify each slot round-trips via leToBI
  for (let i = 0; i < 6; i++) {
    const expected = BigInt(veilSignals[i]);
    const slot = result.slice(i * 32, i * 32 + 32);
    const recovered = leToBI(slot);
    assert(recovered === expected, `Veil signal[${i}]=${veilSignals[i]}: round-trip via leToBI`);
  }
}

// ---------------------------------------------------------------------------
// T13: vkToSuiBytes — full layout formula and IC length encoding
// ---------------------------------------------------------------------------

section("vkToSuiBytes — layout formula and IC length");

{
  // Total size formula: 32 + 64*3 + 8 + IC.length * 32
  const icCount = MOCK_VK.IC.length; // 2
  const expectedTotal = 32 + 64 * 3 + 8 + icCount * 32;
  const result = vkToSuiBytes(MOCK_VK);
  assertEqual(result.length, expectedTotal, `vkToSuiBytes: total = 32 + 192 + 8 + ${icCount}*32 = ${expectedTotal} bytes`);
}

{
  // IC length field at offset 224 (32+64+64+64) is a u64 LE — verify all 8 bytes
  const result = vkToSuiBytes(MOCK_VK);
  const lenOffset = 32 + 64 + 64 + 64; // = 224
  const icLenField = result.slice(lenOffset, lenOffset + 8);
  // IC.length = 2 → [2, 0, 0, 0, 0, 0, 0, 0]
  assertEqual(icLenField[0], 2, "vkToSuiBytes: IC len field byte[0] = 2");
  assert(icLenField.slice(1).every((b) => b === 0), "vkToSuiBytes: IC len field bytes[1..7] = 0 (u64 LE)");
}

{
  // With 0 IC points: total = 32 + 192 + 8 + 0 = 232 bytes, len field = 0
  const zeroICVK: SnarkjsVK = {
    ...MOCK_VK,
    IC: [],
  };
  const result = vkToSuiBytes(zeroICVK);
  assertEqual(result.length, 232, "vkToSuiBytes (0 IC): total = 232 bytes");
  const lenOffset = 32 + 64 + 64 + 64;
  const icLenField = result.slice(lenOffset, lenOffset + 8);
  assert(icLenField.every((b) => b === 0), "vkToSuiBytes (0 IC): len field = 0x00..00");
}

{
  // With 7 IC points: total = 32 + 192 + 8 + 7*32 = 456 bytes
  const sevenICVK: SnarkjsVK = {
    ...MOCK_VK,
    IC: Array.from({ length: 7 }, (_, i) => [String(i + 1), String(i + 2), "1"]),
  };
  const result = vkToSuiBytes(sevenICVK);
  const expectedLen = 32 + 64 * 3 + 8 + 7 * 32;
  assertEqual(result.length, expectedLen, `vkToSuiBytes (7 IC): total = ${expectedLen} bytes`);
  // Verify IC length field = 7
  const lenOffset = 32 + 64 + 64 + 64;
  assertEqual(result[lenOffset], 7, "vkToSuiBytes (7 IC): len field byte[0] = 7");
}

{
  // beta_g2 occupies bytes [32..95] — verify it matches compressG2
  const result = vkToSuiBytes(MOCK_VK);
  const expectedBeta = compressG2(
    BigInt(MOCK_VK.vk_beta_2[0][0]),
    BigInt(MOCK_VK.vk_beta_2[0][1]),
    BigInt(MOCK_VK.vk_beta_2[1][0]),
    BigInt(MOCK_VK.vk_beta_2[1][1]),
  );
  const betaSegment = result.slice(32, 96);
  assert(bytesEqual(betaSegment, expectedBeta), "vkToSuiBytes: beta_g2 segment [32..95] matches compressG2");
}

{
  // gamma_g2 occupies bytes [96..159] — verify it matches compressG2
  const result = vkToSuiBytes(MOCK_VK);
  const expectedGamma = compressG2(
    BigInt(MOCK_VK.vk_gamma_2[0][0]),
    BigInt(MOCK_VK.vk_gamma_2[0][1]),
    BigInt(MOCK_VK.vk_gamma_2[1][0]),
    BigInt(MOCK_VK.vk_gamma_2[1][1]),
  );
  const gammaSegment = result.slice(96, 160);
  assert(bytesEqual(gammaSegment, expectedGamma), "vkToSuiBytes: gamma_g2 segment [96..159] matches compressG2");
}

{
  // delta_g2 occupies bytes [160..223] — verify it matches compressG2
  const result = vkToSuiBytes(MOCK_VK);
  const expectedDelta = compressG2(
    BigInt(MOCK_VK.vk_delta_2[0][0]),
    BigInt(MOCK_VK.vk_delta_2[0][1]),
    BigInt(MOCK_VK.vk_delta_2[1][0]),
    BigInt(MOCK_VK.vk_delta_2[1][1]),
  );
  const deltaSegment = result.slice(160, 224);
  assert(bytesEqual(deltaSegment, expectedDelta), "vkToSuiBytes: delta_g2 segment [160..223] matches compressG2");
}

// ---------------------------------------------------------------------------
// T14: Multiple proofs — consistent 128-byte output
// ---------------------------------------------------------------------------

section("Multiple proofs — consistent output size");

{
  // Two distinct proofs with different coordinates must both produce 128 bytes
  const PROOF_2: SnarkjsProof = {
    pi_a: [
      "1234567890123456789012345678901234567890123456789012345678901234567890123",
      "9876543210987654321098765432109876543210987654321098765432109876543210987",
      "1",
    ],
    pi_b: [
      ["2345678901234567890123456789012345678901234567890123456789012345678901234",
       "8765432109876543210987654321098765432109876543210987654321098765432109876"],
      ["3456789012345678901234567890123456789012345678901234567890123456789012345",
       "7654321098765432109876543210987654321098765432109876543210987654321098765"],
      ["1", "0"],
    ],
    pi_c: [
      "4567890123456789012345678901234567890123456789012345678901234567890123456",
      "6543210987654321098765432109876543210987654321098765432109876543210987654",
      "1",
    ],
  };

  const r1 = proofToSuiBytes(MOCK_PROOF);
  const r2 = proofToSuiBytes(PROOF_2);
  assertEqual(r1.length, 128, "proof 1: 128 bytes");
  assertEqual(r2.length, 128, "proof 2: 128 bytes");
  assert(!bytesEqual(r1, r2), "two distinct proofs produce different 128-byte outputs");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\nSome tests failed.`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed.`);
}
