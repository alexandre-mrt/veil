#!/usr/bin/env node
/**
 * prove-cli.mjs — groth16.fullProve + local verify as a subprocess.
 * Exists because snarkjs 0.7.6 crashes under Bun (FileHandle GC error), so Bun-based harnesses
 * (gas-localnet.ts) shell out to Node for proving.
 * Usage: node prove-cli.mjs <wasm> <zkey> <vk.json>  (circuit input JSON on stdin, result JSON on stdout)
 */
import { readFileSync } from "fs";
import * as snarkjs from "snarkjs";
const [wasm, zkey, vkPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf-8"));
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
const ok = await snarkjs.groth16.verify(JSON.parse(readFileSync(vkPath, "utf-8")), publicSignals, proof);
process.stdout.write(JSON.stringify({ ok, proof, publicSignals }));
process.exit(ok ? 0 : 1);
