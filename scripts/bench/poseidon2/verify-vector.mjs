#!/usr/bin/env node
// Checks the JS Poseidon2 permutation against the HorizenLabs reference (zkhash crate,
// POSEIDON2_BN256_PARAMS, permutation([0,1,2])) — expected values produced by running that crate.
import { permute } from "./poseidon2.mjs";
const REF = [
  "5297208644449048816064511434384511824916970985131888684874823260532015509555",
  "21816030159894113985964609355246484851575571273661473159848781012394295965040",
  "13940986381491601233448981668101586453321811870310341844570924906201623195336",
];
const got = permute([0n, 1n, 2n]).map(String);
if (got.join() !== REF.join()) { console.error("MISMATCH", got); process.exit(1); }
console.log("poseidon2 JS == HorizenLabs reference vector: OK");
