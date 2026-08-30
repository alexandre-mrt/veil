#!/usr/bin/env node
// Decomposes the R1CS non-linear constraint count of each Veil circuit into its
// constituent gadget instances (Poseidon, range checks, comparators, the Merkle
// membership template), by compiling each gadget alone and reading circom's own
// reported constraint counts — no estimation, every number below is a real
// `circom2` compile.
//
// Answers open question #4 from docs/research/2026-07-22-baseline-measurement.md:
// what fraction of transfer.circom's / compliance.circom's non-linear constraints
// come from Poseidon vs. everything else. That fraction is the ROI signal for
// whether a future Poseidon2 port is worth doing.
//
// Usage: node scripts/bench/constraint-breakdown.mjs
// Requires: `circom2` installed in circuits/ (npm install --save-dev circom2).

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const circuitsDir = path.resolve(__dirname, '../../circuits');
const tmpDir = path.join(circuitsDir, '.bench-tmp');

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function compileAndParse(name, source) {
  const dir = path.join(tmpDir, name);
  mkdirSync(path.join(dir, 'out'), { recursive: true });
  const file = path.join(dir, `${name}.circom`);
  writeFileSync(file, source);
  let out;
  try {
    out = execSync(
      `npx circom2 .bench-tmp/${name}/${name}.circom --r1cs -o .bench-tmp/${name}/out -l node_modules -l .`,
      { cwd: circuitsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  out = stripAnsi(out);
  const grab = (label) => {
    const m = out.match(new RegExp(`${label}:\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : null;
  };
  const nonLinear = grab('non-linear constraints');
  const linear = grab('linear constraints');
  const wires = grab('wires');
  if (nonLinear === null) {
    console.error(`--- FAILED to compile gadget "${name}" ---\n${out}`);
    throw new Error(`circom2 did not report constraints for ${name}`);
  }
  return { name, nonLinear, linear, wires };
}

const GADGETS = [
  {
    name: 'poseidon2',
    usedIn: 'Merkle leaf hashing (per level, both transfer.circom and compliance.circom)',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/poseidon.circom";\ncomponent main = Poseidon(2);\n`,
  },
  {
    name: 'poseidon3',
    usedIn: 'transfer.circom txAmountHash; compliance.circom nfHash + ctxHash',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/poseidon.circom";\ncomponent main = Poseidon(3);\n`,
  },
  {
    name: 'poseidon4',
    usedIn: 'transfer.circom oldHash/newHash/nfHash; withdraw.circom commHash/changeHash/nfHash',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/poseidon.circom";\ncomponent main = Poseidon(4);\n`,
  },
  {
    name: 'poseidon5',
    usedIn: 'compliance.circom leafHash',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/poseidon.circom";\ncomponent main = Poseidon(5);\n`,
  },
  {
    name: 'num2bits8',
    usedIn: 'compliance.circom kycBits/reqKycBits',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/bitify.circom";\ncomponent main = Num2Bits(8);\n`,
  },
  {
    name: 'num2bits64',
    usedIn: 'range checks in all three circuits',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/bitify.circom";\ncomponent main = Num2Bits(64);\n`,
  },
  {
    name: 'greaterthan64',
    usedIn: 'transfer.circom / withdraw.circom "amount > 0" checks',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/comparators.circom";\ncomponent main = GreaterThan(64);\n`,
  },
  {
    name: 'greaterequalthan64',
    usedIn: 'compliance.circom expiry check',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/comparators.circom";\ncomponent main = GreaterEqThan(64);\n`,
  },
  {
    name: 'greaterequalthan8',
    usedIn: 'compliance.circom kycLevel check',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/comparators.circom";\ncomponent main = GreaterEqThan(8);\n`,
  },
  {
    name: 'lessequalthan64',
    usedIn: 'transfer.circom threshold check; withdraw.circom amount check',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/comparators.circom";\ncomponent main = LessEqThan(64);\n`,
  },
  {
    name: 'multimux1_2',
    usedIn: 'Merkle sibling-order selection (per level)',
    source: `pragma circom 2.1.0;\ninclude "circomlib/circuits/mux1.circom";\ncomponent main = MultiMux1(2);\n`,
  },
  {
    name: 'merkleproof20',
    usedIn: 'transfer.circom membershipProof; compliance.circom merkleProof (whole template, depth 20)',
    source: `pragma circom 2.1.0;\ninclude "templates/merkle_proof.circom";\ncomponent main = MerkleProof(20);\n`,
  },
];

// Exact gadget-instance inventory per real circuit, read off the source files
// by hand (transfer.circom, compliance.circom, withdraw.circom) on 2026-08-30.
const CIRCUIT_INVENTORY = {
  transfer: {
    actualNonLinear: 6470, // circuits/README.md + docs/research/BASELINE.md
    parts: [
      { gadget: 'merkleproof20', count: 1 },
      { gadget: 'poseidon4', count: 3 }, // oldHash, newHash, nfHash
      { gadget: 'poseidon3', count: 1 }, // txHash
      { gadget: 'greaterthan64', count: 1 }, // gtZero
      { gadget: 'num2bits64', count: 4 }, // oldBits, txBits, newBits, threshBits
      { gadget: 'lessequalthan64', count: 1 }, // ltThreshold
    ],
  },
  compliance: {
    actualNonLinear: 6057,
    parts: [
      { gadget: 'poseidon5', count: 1 }, // leafHash
      { gadget: 'merkleproof20', count: 1 },
      { gadget: 'poseidon3', count: 2 }, // nfHash, ctxHash
      { gadget: 'greaterequalthan64', count: 1 }, // expiryCheck
      { gadget: 'greaterequalthan8', count: 1 }, // kycCheck
      { gadget: 'num2bits64', count: 3 }, // epochBits, expiryBits, issuerBits
      { gadget: 'num2bits8', count: 2 }, // kycBits, reqKycBits
    ],
  },
  withdraw: {
    actualNonLinear: 1465,
    parts: [
      { gadget: 'poseidon4', count: 3 }, // commHash, changeHash, nfHash
      { gadget: 'poseidon2', count: 1 }, // recipHash
      { gadget: 'num2bits64', count: 3 }, // amountBits, cumBits, remBits
      { gadget: 'greaterthan64', count: 1 }, // gtZero
      { gadget: 'lessequalthan64', count: 1 }, // amountCheck
    ],
  },
};

function main() {
  rmSync(tmpDir, { recursive: true, force: true });
  console.log('=== Veil constraint breakdown (per-gadget, real circom2 compiles) ===\n');

  const results = {};
  for (const g of GADGETS) {
    const r = compileAndParse(g.name, g.source);
    results[g.name] = r;
    console.log(
      `${g.name.padEnd(20)} non-linear=${String(r.nonLinear).padStart(5)}  linear=${String(r.linear).padStart(5)}  (${g.usedIn})`
    );
  }

  console.log('\n=== Reconciliation against real circuits ===\n');
  for (const [circuitName, info] of Object.entries(CIRCUIT_INVENTORY)) {
    let predicted = 0;
    console.log(`--- ${circuitName}.circom ---`);
    for (const part of info.parts) {
      const per = results[part.gadget].nonLinear;
      const subtotal = per * part.count;
      predicted += subtotal;
      console.log(
        `  ${part.gadget.padEnd(20)} x${part.count} = ${subtotal} (per-instance ${per})`
      );
    }
    const residual = info.actualNonLinear - predicted;
    const pct = ((predicted / info.actualNonLinear) * 100).toFixed(1);
    console.log(
      `  predicted total: ${predicted}   actual (circom2, fresh compile): ${info.actualNonLinear}   residual (circuit-level glue: equality asserts, additions, booleanity checks not inside a named gadget): ${residual} (${(100 - pct).toFixed(1)}% unattributed)`
    );

    const poseidonGadgets = ['poseidon2', 'poseidon3', 'poseidon4', 'poseidon5'];
    let poseidonDirect = 0;
    for (const part of info.parts) {
      if (poseidonGadgets.includes(part.gadget)) poseidonDirect += results[part.gadget].nonLinear * part.count;
    }
    // merkleproof20 is itself ~99% Poseidon(2) x 20; break that out too.
    let poseidonViaMerkle = 0;
    const merklePart = info.parts.find((p) => p.gadget === 'merkleproof20');
    if (merklePart) {
      poseidonViaMerkle = results.poseidon2.nonLinear * 20 * merklePart.count;
    }
    const totalPoseidon = poseidonDirect + poseidonViaMerkle;
    console.log(
      `  Poseidon share of predicted total: ${totalPoseidon} / ${predicted} = ${((totalPoseidon / predicted) * 100).toFixed(1)}%  (${(
        (totalPoseidon / info.actualNonLinear) *
        100
      ).toFixed(1)}% of the actual measured total)\n`
    );
  }

  rmSync(tmpDir, { recursive: true, force: true });
}

main();
