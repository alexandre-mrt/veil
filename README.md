# Veil — Private Payments on Sui

> Anonymous below threshold. Compliant above. Zero-knowledge proofs protect your spending.

## The Problem

Blockchain payments are fully transparent. Every transaction amount, sender, and receiver is visible on-chain. Existing privacy solutions fall into two traps: fully anonymous (Zcash, Tornado Cash) which creates regulatory risk, or fully transparent which provides no privacy. There is nothing in between.

## The Solution

Veil introduces **cumulative spending proofs** — a novel ZK primitive that lets users:

- **Spend anonymously** below a regulatory threshold (CHF 1,000/epoch, aligned with FINMA)
- **Prove KYC compliance** above the threshold without revealing identity
- **Allow selective audit** by regulators via ElGamal encryption (Tier 2, stretch goal)

Each user's on-chain footprint is a single commitment — a Poseidon hash of their cumulative spending. Transfers update this commitment with a ZK proof. No amounts ever appear in plaintext.

## How It Works

```
User action: send 100 VEIL anonymously
         |
         v
[Client browser]
  Generate Groth16 proof (snarkjs WASM, ~2s)
  Prove: new_commitment = commit(old_total + 100)
         nullifier is unique for this epoch
         all values fit in 64 bits
         |
         v
[Sui Move contract: veil::pool]
  Verify proof via sui::groth16 (BN254 native)
  Check nullifier not already spent
  Store nullifier + new commitment
  Emit TransferEvent (no amounts, no identity)
```

### Cumulative Spending Proof

Each transfer proof establishes nine constraints without revealing any amount:

1. `old_commitment = Poseidon(1, cumulative_old, randomness_old)` — old state is well-formed
2. `new_commitment = Poseidon(1, cumulative_new, randomness_new)` — new state is well-formed
3. `cumulative_new = cumulative_old + tx_amount` — the update is correct
4. `tx_amount > 0` — no zero-value transfers
5. `cumulative_old` fits in 64 bits — no underflow
6. `tx_amount` fits in 64 bits — no overflow
7. `cumulative_new` fits in 64 bits — no overflow
8. `nullifier = Poseidon(2, user_secret, epoch_id)` — epoch-bound, domain-separated
9. `tx_amount_hash = Poseidon(tx_amount, salt)` — receiver-side verification

All constraints are checked in-circuit. The contract only sees the six public inputs; private values never leave the user's browser.

### Epoch-Based Privacy Reset

Spending counters reset every 30 days (epoch boundary). Each epoch:
- Genesis commitment: `Poseidon(1, 0, 0)` — deterministic, no linkability to previous epoch
- Nullifier: `Poseidon(2, user_secret, epoch_id)` — one per user per epoch, prevents replay

### Tiered Compliance

| Tier | Condition | Privacy | Compliance |
|------|-----------|---------|------------|
| 0 | Cumulative < CHF 1,000/epoch | Fully anonymous | None required |
| 1 | Cumulative >= CHF 1,000/epoch | Identity hidden | ZK proof of KYC credential |
| 2 | Regulatory request | Auditor view only | ElGamal decryption by regulator |

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full ASCII diagram.

```
User Wallet
    |
    +-- amount < CHF 1K --> Transfer Proof (6 public inputs, ~1,250 constraints)
    |
    +-- amount >= CHF 1K -> Transfer + Compliance Proof (6 + 4 inputs, ~8,450 constraints)
    |
    v
veil::pool (Sui Move)
    +-- sui::groth16 native BN254 verifier
    +-- nullifier set (dynamic fields, no replay)
    +-- commitment store (per-epoch state)
    +-- shielded balance (Coin<TOKEN>)
    +-- freeze mechanism (AdminCap)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| ZK Circuits | Circom 2.1 + snarkjs 0.7 (BN254 Groth16) |
| Smart Contract | Sui Move 2024 |
| On-chain Verification | `sui::groth16` native BN254 verifier |
| Token | Custom `VEIL` token (TreasuryCap + faucet) |
| Frontend | Next.js 14 App Router |
| Wallet Integration | `@mysten/dapp-kit` |
| Client-side Proving | snarkjs WASM in Web Worker |
| Private State | Encrypted localStorage |

## Quick Start

```bash
git clone https://github.com/alexandre-mrt/veil
cd veil

# Install all dependencies (circom, snarkjs, bun, sui CLI required)
bash scripts/init.sh

# Build and test the Move contract
cd contracts && sui move build && sui move test

# Compile the ZK circuit and run trusted setup
cd ../circuits && bash scripts/compile.sh

# Test the circuit constraints
cd circuits && npm test

# Run the full end-to-end pipeline against testnet
cd ../scripts && bun run src/e2e-test.ts

# Start the frontend
cd ../frontend && bun run dev
```

**Prerequisites:**
- `circom` 2.1.x — install via `cargo install circom`
- `snarkjs` 0.7.x — install via `npm install -g snarkjs`
- `sui` CLI — configured on testnet (`sui client switch --env testnet`)
- `bun` — install via `curl -fsSL https://bun.sh/install | bash`

## Project Structure

```
veil/
├── circuits/
│   ├── transfer.circom          # Cumulative spending proof circuit
│   ├── scripts/
│   │   └── compile.sh           # Circom compilation + Groth16 setup
│   ├── test/
│   │   └── transfer.test.mjs    # Circuit constraint tests
│   └── build/                   # Generated: .r1cs, .wasm, .zkey, vk.json
├── contracts/
│   ├── Move.toml
│   └── sources/
│       ├── pool.move            # Core protocol: deposit, transfer, withdraw
│       ├── verifier.move        # sui::groth16 wrapper
│       └── token.move           # VEIL token (TreasuryCap + faucet)
├── frontend/
│   └── src/
│       ├── app/                 # Next.js App Router pages
│       ├── components/          # UI components
│       ├── hooks/               # Wallet + proof generation hooks
│       └── lib/                 # snarkjs WASM helpers, state management
├── scripts/
│   ├── init.sh                  # Monorepo dependency installer
│   └── src/
│       ├── e2e-test.ts          # Full pipeline: compile -> prove -> deploy -> verify
│       ├── deploy.ts            # Move contract deployment
│       └── proof-converter.ts   # snarkjs -> Sui byte format conversion
└── docs/
    └── architecture.md          # Detailed architecture with ASCII diagrams
```

## Security Considerations

**Domain-separated Poseidon hashing** — commitments use tag `1` (`H(1, cumulative, randomness)`), nullifiers use tag `2` (`H(2, user_secret, epoch_id)`). No cross-type hash collision is possible.

**Range proofs on all values** — `Num2Bits(64)` is applied to `cumulative_old`, `tx_amount`, and `cumulative_new` independently. An attacker cannot cause integer overflow to reset a spending counter.

**Nullifier-based replay prevention** — each nullifier is stored in a dynamic field after use. Re-submitting the same proof aborts with `E_NULLIFIER_SPENT (2)`. Nullifiers are deterministic — there is no randomness an attacker can manipulate.

**VK integrity** — the verifying key is stored at pool creation and controlled by `AdminCap`. The `sui::groth16` verifier internally enforces that `gamma_g2 != delta_g2`, preventing the FOOM Cash-style vulnerability where a malformed VK accepts any proof.

**Epoch from on-chain Clock** — the `epoch_id` in proofs is derived from `sui::clock::Clock`, a shared Sui object. Users cannot supply a past or future epoch to reuse nullifiers.

**Freeze mechanism** — `AdminCap` holders can pause the pool instantly via `freeze_pool`. All entry functions check `pool.frozen` as the first assertion.

**No PII on-chain** — commitments, nullifiers, and `tx_amount_hash` are Poseidon field elements. No amounts, addresses, or credential data are ever stored or emitted in plaintext.

## Novel Contributions

1. **Cumulative spending proofs** — first implementation on any blockchain. Rather than proving individual transactions, Veil proves the running total for an epoch, enabling continuous compliance monitoring without per-transaction disclosure.

2. **Tiered privacy aligned with FINMA / MiCA** — the CHF 1,000/epoch threshold mirrors real Swiss regulatory requirements. Below the threshold: no credentials required. Above: ZK proof of KYC membership in a Merkle tree (compliance circuit, ~7,200 constraints). The design is jurisdiction-parameterizable.

3. **Epoch-based nullifiers with clean reset** — nullifiers are bound to `epoch_id`, so they expire at epoch boundaries. Users get a fresh spending allowance each epoch with no cryptographic linkage to previous epochs. Epoch genesis is deterministic (`Poseidon(1, 0, 0)`), requiring no interaction.

4. **Native BN254 on Sui** — uses `sui::groth16` with curve id `bn254()`, enabling on-chain Groth16 verification at native speed without a custom verifier contract.

## Track

Sui Overflow 2026 — DeFi & Payments

## License

MIT
