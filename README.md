# Veil — confidential compliance proofs on Sui

Veil lets a user prove, in zero-knowledge, that their **cumulative spending over a period stays below a regulatory threshold** — without revealing any individual amount, and without disclosing identity below that threshold.

It is **not an anonymity system.** Amounts are hidden; the sender is not. That distinction is the whole point of the design, and it is documented honestly below and in [`docs/privacy-red-team-report.md`](docs/privacy-red-team-report.md).

The threshold is modelled on the Swiss FINMA rule that lets a VASP serve a customer without full KYC below CHF 1,000 per 30 days. Today an exchange enforces that rule by seeing every transaction. Veil enforces it while seeing none of them: the user proves `cumulative_spent + amount <= threshold` with a Groth16 proof verified on-chain by `sui::groth16`, and only crosses into a KYC-credential proof when the threshold is exceeded.

---

## What it actually does — and does not do

| Property | Status | Why |
|---|---|---|
| Transaction **amounts** hidden on-chain | Yes | Amounts live only inside Poseidon commitments and the ZK witness. Events carry no amounts. |
| **Threshold compliance** enforced without revealing amounts | Yes | `cumulativeNew <= threshold` is a circuit constraint, verified on-chain. |
| **KYC above threshold** without revealing identity | Yes | Second Groth16 proof of membership in a credential Merkle tree (`compliance.circom`). |
| Amount readable by a designated **auditor** | Yes | ECDH P-256 + AES-GCM ciphertext bound to `txAmountHash`, emitted in `ComplianceVerifiedEvent`. |
| **Sender anonymity** | **No** | The user's own wallet signs the deposit and the shielded transfer. The Sui transaction sender is the user. See `PRIV-002` in the red-team report. |
| **Recipient anonymity** | No | Withdrawals bind a recipient address hash into the proof; the recipient is visible on-chain. |
| Sybil-resistant spending limits | No | A user can generate a second `userSecret` and restart the counter. The threshold binds a commitment chain, not a person. |

The repo ships a sponsored-transaction relayer (`scripts/src/relayer.ts`). It is worth being precise about what that buys: Sui sponsored transactions move the **gas payer** to the relayer, but the transaction's `sender` field remains the user's address, because the Move code authorizes against it. **The relayer does not fix `PRIV-002`.** Real sender privacy would require submission without a user signature (Tornado-style relaying), which this protocol does not do.

I ran a privacy red team against my own protocol and it concluded the protocol has "effectively zero sender privacy". I kept the report in the repo instead of the headline claim: [`docs/privacy-red-team-report.md`](docs/privacy-red-team-report.md).

## The circuits

The construction is a **composition of standard circomlib gadgets** — Poseidon, `Num2Bits`, `LessEqThan`, `GreaterThan`, and a Poseidon Merkle-membership template. There is no new cryptography here. What is unusual is the *application*: turning a regulatory spending threshold into a ZK statement over a chained commitment, so a contract can enforce the rule while never learning the amounts.

### Real constraint counts

The "11 constraints" figure that used to be in this README was wrong: 11 is the number of *assertions written in the circuit*, not the R1CS constraint count. Four Poseidon instances and four `Num2Bits(64)` range checks dominate the real cost. Numbers below are `snarkjs r1cs info` output on the compiled circuits, compiled with `circom --O2` (full constraint simplification) — see [`docs/research/2026-08-22-poseidon2-hash-swap.md`](docs/research/2026-08-22-poseidon2-hash-swap.md), which measured `--O2` at roughly half the constraints and ~23% faster proving than circom's `--O1` default.

| Circuit | Assertions written | R1CS constraints | Non-linear | Public / private inputs |
|---|---|---|---|---|
| `transfer.circom` | 11 + Merkle membership | **6,384** | 6,384 (0 linear) | 7 / 47 |
| `compliance.circom` | 10 | **5,979** | 5,979 (0 linear) | 6 / 45 |
| `withdraw.circom` | 9 | **1,439** | 1,439 (0 linear) | 5 / 5 |

Reproduce:

```bash
cd circuits && npm install
circom transfer.circom --r1cs --O2 -o build -l node_modules
npx snarkjs r1cs info build/transfer.r1cs      # -> # of Constraints: 6384
```

### The transfer statement

| # | Assertion | Gadget |
|---|-----------|--------|
| C0 | `oldCommitment` is a leaf of `merkleRoot` (depth 20) | Poseidon(2) Merkle path |
| C1 | `oldCommitment == Poseidon(1, cumOld, randOld, userSecret)` | Poseidon(4) |
| C2 | `newCommitment == Poseidon(1, cumNew, randNew, userSecret)` | Poseidon(4) |
| C3 | `cumNew == cumOld + txAmount` | R1CS addition |
| C4 | `txAmount > 0` | GreaterThan(64) |
| C5–C8 | `cumOld`, `txAmount`, `cumNew`, `threshold` in `[0, 2^64)` | Num2Bits(64) ×4 |
| C9 | `cumNew <= threshold` | LessEqThan(64) |
| C10 | `nullifier == Poseidon(2, userSecret, epochId, randOld)` | Poseidon(4) |
| C11 | `txAmountHash == Poseidon(3, txAmount, salt)` | Poseidon(3) |

Domain tags (1 commitment, 2 transfer nullifier, 3 amount hash, 5 credential nullifier, 6 context binding, 7 withdraw nullifier, 8 recipient) keep the hash families separate.

Above the threshold, `pool::compliant_transfer` verifies **two** Groth16 proofs atomically: the transfer proof, plus a proof that the user holds an unexpired KYC credential in the pool's credential Merkle tree — without revealing which credential. The credential nullifier is derived per transfer, so a compliance proof cannot be replayed and uses are not linkable to each other.

## On-chain design (Move)

- `sui::groth16` BN254 native verification (`verifier.move`).
- UTXO-style commitments: the old commitment is *removed* from a dynamic field and a new one added, so a spent note cannot be reused to fork a parallel spending chain.
- Nullifier set in dynamic fields (no `Table` contention).
- Upper 24 bytes of each u64 public input are zero-checked before deserialization.
- Depth-20 Poseidon commitment accumulator, root stored on-chain, root updates timelocked.
- Verifying-key updates timelocked by one epoch; `AdminCap` bound to a specific pool; opt-in N-of-M multisig for freeze/unfreeze.

## Test counts (measured, not claimed)

Every number below is the output of the command next to it, run on this commit. There is deliberately no aggregate "N tests" headline: the layers are not comparable — 109 of them are byte-level unit tests of a single endianness converter.

| Suite | Result | Command |
|---|---|---|
| Move contract | **124 pass** | `cd contracts && sui move test` |
| `transfer.circom` (real Groth16 prove + verify) | **43 pass** | `cd circuits && node test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30 pass** | `cd circuits && node test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35 pass** | `cd circuits && node test/withdraw.test.mjs` |
| Proof converter (snarkjs JSON → arkworks bytes) | **109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (credential leaf, Merkle builder) | **67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz (fast-check) | 6 properties × 500 cases | `cd scripts && bun run src/fuzz-tests.ts` |

The circuit tests have two modes. With a compiled wasm + zkey in `circuits/build/` they run a real `groth16.fullProve` + `verify` per case; otherwise they fall back to simulating the constraints in JS with circomlibjs. **The counts above are full-proof mode** (`bash circuits/scripts/compile.sh` first — it downloads a ~85 MB ptau). The fallback mode is a linting aid, not evidence.

That distinction matters, because it hid a real bug: `transfer.circom` gained a Merkle-membership input and the test file was never updated to supply the authentication path. In fallback mode it still reported 40/40 green; in real proving mode 13 of those 40 could not even generate a witness. The tests now build the path, and three cases were added for the membership constraint itself.

## Security posture — read this before trusting anything

**This code is unaudited by any third party. Do not put real money in it.** It was built for Sui Overflow 2026 and deployed only to testnet.

What exists is self-review, and self-review of one's own greenfield code is worth far less than an external audit. The artifacts worth reading:

- [`docs/privacy-red-team-report.md`](docs/privacy-red-team-report.md) — 15 findings, including three CRITICALs that say the protocol does not achieve sender privacy. This is the most useful document in the repo.
- [`docs/threat-model.md`](docs/threat-model.md) — STRIDE model of the protocol.
- [`docs/zk-vulnerability-research.md`](docs/zk-vulnerability-research.md) — the ZK bug classes the circuits were checked against (under-constrained signals, missing range checks, nullifier malleability, domain separation).

Known blockers, all still open:

1. Trusted setup is a **single-contributor dev ceremony** (`circuits/scripts/compile.sh`). A multi-party ceremony script exists (`circuits/scripts/ceremony.sh`) but has not been run with independent contributors.
2. `UpgradeCap` is held by an EOA — not burned, not multisig'd.
3. Admin can drain the pool (timelocked withdrawal, or instant `emergency_withdraw` while frozen).
4. `EPOCH_DURATION_MS` is 1 hour for demo purposes; the FINMA framing needs 30 days.
5. `token::faucet()` must be removed from production bytecode.
6. Sybil: nothing binds one `userSecret` to one human, so the threshold is bypassable today. Fixing it means gating *deposits* on the credential tree, not just above-threshold transfers.

## Run it

```bash
git clone https://github.com/alexandre-mrt/veil && cd veil
bash scripts/init.sh                                  # deps + contract build

cd contracts && sui move test                         # 124 pass
cd ../circuits && bash scripts/compile.sh             # compile + dev trusted setup (~85 MB ptau)
npm test                                              # 108 pass (43 + 30 + 35), real Groth16
cd ../scripts && bun run src/test-converter.ts        # 109 pass
cd ../frontend && bun run dev                         # localhost:3000
```

Prerequisites: `circom` 2.2.x, `sui` CLI (testnet), `bun`, Node 20+.

## Deployed (Sui testnet)

| Object | ID |
|--------|----|
| Package | `0x5cd79f85f1adca022513d76c60d557f8b17afed91f741d14016c7a23cab6c228` |
| Pool | `0x6ba8019987c7c5d02d2c2b11e0eddd491428d0cc6bbed05ab79760e069ce913a` |
| ComplianceConfig | `0xa6c92b963d9b67896416ae2eb23f0fadbbc62e90fba6ca18db5f96b6bc4f63c7` |

Testnet only, 1-hour epochs, valueless test token minted by an open faucet.

## Layout

```
circuits/    transfer.circom, compliance.circom, withdraw.circom + Poseidon Merkle template + tests
contracts/   pool.move (UTXO + accumulator), compliance.move, verifier.move (groth16), multisig.move, token
frontend/    Next.js 14 + dApp-kit, snarkjs proving in a Web Worker
scripts/     proof converter (snarkjs → arkworks bytes), relayer, e2e, fuzz, auditor tool
docs/        red-team report, threat model, architecture, protocol flow + C4 diagrams
```

The proof converter (`scripts/src/proof-converter.ts`) is the most reusable piece: snarkjs emits Groth16 proofs as decimal-string JSON, while `sui::groth16` expects arkworks-compressed little-endian bytes with sign bits. That conversion is fiddly, and it is where the 109 unit tests live.

## Track

Sui Overflow 2026 — DeFi & Payments.

## License

MIT
