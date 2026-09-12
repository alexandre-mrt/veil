/**
 * poseidon2.mjs — Poseidon2 permutation (t=3, d=5, R_F=8, R_P=56) over the BN254 scalar
 * field, in plain JS. Used as the oracle for cross-validating
 * `circuits/templates/poseidon2/poseidon2_t3.circom` and for building witnesses for the
 * research/2026-09-09-poseidon2-merkle-hasher experiment's benchmark circuits.
 *
 * Parameters transcribed from HorizenLabs/poseidon2
 * (plain_implementations/src/poseidon2/poseidon2_instance_bn256.rs) into
 * ../../circuits/templates/poseidon2/params.json. Algorithm transcribed from that repo's
 * plain_implementations/src/poseidon2/poseidon2.rs `permutation`. See KAT below and
 * docs/research/2026-09-09-poseidon2-merkle-hasher.md for the full provenance chain.
 */
import fs from "fs";
import { buildBn128 } from "ffjavascript";

const paramsPath = new URL("../../circuits/templates/poseidon2/params.json", import.meta.url);
const params = JSON.parse(fs.readFileSync(paramsPath));

const RF_HALF = 4;
const RP = 56;

export async function makePoseidon2() {
  const bn128 = await buildBn128();
  const F = bn128.Fr;
  const rc = params.rc.map((row) => row.map((h) => F.e(BigInt(h))));

  function sbox(x) {
    const x2 = F.mul(x, x);
    const x4 = F.mul(x2, x2);
    return F.mul(x4, x);
  }

  function extLayer(state) {
    const sum = F.add(F.add(state[0], state[1]), state[2]);
    return [F.add(state[0], sum), F.add(state[1], sum), F.add(state[2], sum)];
  }

  function intLayer(state) {
    // M_I = J + diag(1, 1, 2) for t=3 (matches MAT_DIAG3_M_1 in the reference).
    const sum = F.add(F.add(state[0], state[1]), state[2]);
    return [F.add(state[0], sum), F.add(state[1], sum), F.add(F.mul(state[2], F.e(2n)), sum)];
  }

  function permutation(input) {
    let state = input.slice();
    state = extLayer(state);
    let r = 0;
    for (let i = 0; i < RF_HALF; i++, r++) {
      state = [F.add(state[0], rc[r][0]), F.add(state[1], rc[r][1]), F.add(state[2], rc[r][2])];
      state = state.map(sbox);
      state = extLayer(state);
    }
    for (let i = 0; i < RP; i++, r++) {
      state[0] = F.add(state[0], rc[r][0]);
      state[0] = sbox(state[0]);
      state = intLayer(state);
    }
    for (let i = 0; i < RF_HALF; i++, r++) {
      state = [F.add(state[0], rc[r][0]), F.add(state[1], rc[r][1]), F.add(state[2], rc[r][2])];
      state = state.map(sbox);
      state = extLayer(state);
    }
    return state;
  }

  // 2-to-1 Merkle node compression, matching HorizenLabs's `MerkleTreeHash::compress`
  // and circuits/templates/poseidon2/poseidon2_t3.circom's `Poseidon2Hash2`:
  // permutation([left, right, 0])[0].
  function compress(left, right) {
    const l = typeof left === "bigint" ? left : BigInt(left);
    const r = typeof right === "bigint" ? right : BigInt(right);
    return F.toObject(permutation([F.e(l), F.e(r), F.e(0n)])[0]);
  }

  return { F, permutation, compress };
}

// Official known-answer test from HorizenLabs/poseidon2's own
// `poseidon2_tests_bn256::kats` (permutation([0, 1, 2])).
export const OFFICIAL_KAT = {
  input: [0n, 1n, 2n],
  output: [
    "0x0bb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033",
    "0x303b6f7c86d043bfcbcc80214f26a30277a15d3f74ca654992defe7ff8d03570",
    "0x1ed25194542b12eef8617361c3ba7c52e660b145994427cc86296242cf766ec8",
  ],
};

export async function selfTestAgainstKat() {
  const { F, permutation } = await makePoseidon2();
  const out = permutation(OFFICIAL_KAT.input.map((x) => F.e(x)));
  const hex = out.map((x) => "0x" + F.toObject(x).toString(16).padStart(64, "0"));
  const expected = OFFICIAL_KAT.output.map((h) => "0x" + BigInt(h).toString(16).padStart(64, "0"));
  return hex.every((h, i) => h === expected[i]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ok = await selfTestAgainstKat();
  console.log(ok ? "PASS: matches HorizenLabs/poseidon2 official KAT for BN254 t=3" : "FAIL: KAT mismatch");
  process.exit(ok ? 0 : 1);
}
