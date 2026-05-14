# Night Shift Log — Veil

## Plan (approved)

### Phase 1: Foundation (Tasks T1-T4, parallel)

#### T1: Circom Transfer Circuit
**Agent:** night-coder (sonnet, worktree)
**Files to create:**
- `circuits/transfer.circom`
- `circuits/utils/poseidon_commitment.circom`
- `circuits/utils/range_proof.circom`
- `circuits/scripts/compile.sh`
- `circuits/scripts/generate_witness.js`
- `circuits/test/transfer.test.js`

**Exact implementation:**

```circom
// circuits/transfer.circom
pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";

template Transfer() {
    // === PUBLIC INPUTS (order matters for Sui verification) ===
    signal input oldCommitment;      // Poseidon(1, cumulative_old, randomness_old)
    signal input newCommitment;      // Poseidon(1, cumulative_new, randomness_new)
    signal input threshold;          // KYC-free limit
    signal input epochId;            // Current epoch from Clock
    signal input nullifier;          // Poseidon(2, user_secret, epoch_id)
    signal input txAmountHash;       // Poseidon(tx_amount, salt)

    // === PRIVATE INPUTS ===
    signal input cumulativeOld;
    signal input cumulativeNew;
    signal input txAmount;
    signal input randomnessOld;
    signal input randomnessNew;
    signal input userSecret;
    signal input salt;

    // === CONSTRAINT 1: Old commitment validity ===
    // Domain separator 1 for commitments
    component oldCommHash = Poseidon(3);
    oldCommHash.inputs[0] <== 1;  // domain separator
    oldCommHash.inputs[1] <== cumulativeOld;
    oldCommHash.inputs[2] <== randomnessOld;
    oldCommitment === oldCommHash.out;

    // === CONSTRAINT 2: New commitment validity ===
    component newCommHash = Poseidon(3);
    newCommHash.inputs[0] <== 1;
    newCommHash.inputs[1] <== cumulativeNew;
    newCommHash.inputs[2] <== randomnessNew;
    newCommitment === newCommHash.out;

    // === CONSTRAINT 3: Cumulative update ===
    cumulativeNew === cumulativeOld + txAmount;

    // === CONSTRAINT 4: tx_amount > 0 (non-zero transfer) ===
    component txGtZero = GreaterThan(64);
    txGtZero.in[0] <== txAmount;
    txGtZero.in[1] <== 0;
    txGtZero.out === 1;

    // === CONSTRAINT 5: Range proof on cumulative_old [0, 2^64) ===
    component oldRange = Num2Bits(64);
    oldRange.in <== cumulativeOld;

    // === CONSTRAINT 6: Range proof on tx_amount [0, 2^64) ===
    component txRange = Num2Bits(64);
    txRange.in <== txAmount;

    // === CONSTRAINT 7: Range proof on cumulative_new [0, 2^64) ===
    // This also implicitly proves cumulative_new < 2^64
    component newRange = Num2Bits(64);
    newRange.in <== cumulativeNew;

    // === CONSTRAINT 8: Nullifier computation ===
    // Domain separator 2 for nullifiers
    component nullHash = Poseidon(3);
    nullHash.inputs[0] <== 2;  // domain separator
    nullHash.inputs[1] <== userSecret;
    nullHash.inputs[2] <== epochId;
    nullifier === nullHash.out;

    // === CONSTRAINT 9: tx_amount_hash computation ===
    component txHash = Poseidon(2);
    txHash.inputs[0] <== txAmount;
    txHash.inputs[1] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash]} = Transfer();
```

**compile.sh:**
```bash
#!/bin/bash
set -e
cd "$(dirname "$0")/.."
mkdir -p build
# Compile circuit
circom transfer.circom --r1cs --wasm --sym -o build/
# Download Powers of Tau (Hermez, 2^15)
if [ ! -f build/pot15_final.ptau ]; then
  wget -O build/pot15_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
fi
# Generate zkey (Groth16)
snarkjs groth16 setup build/transfer.r1cs build/pot15_final.ptau build/transfer_0000.zkey
# Contribute to ceremony (random)
snarkjs zkey contribute build/transfer_0000.zkey build/transfer_final.zkey --name="veil-dev" -v -e="$(openssl rand -hex 32)"
# Export verification key
snarkjs zkey export verificationkey build/transfer_final.zkey build/transfer_vk.json
echo "Circuit compiled. Constraints: $(snarkjs r1cs info build/transfer.r1cs | grep constraints)"
```

**test:** Node.js script that generates a witness with known values, produces a proof, and verifies it locally with snarkjs.

**Acceptance criteria:**
- Circuit compiles without errors
- Witness generation works for valid inputs
- Proof generation succeeds
- Local verification passes
- Invalid inputs (negative amount, wrong commitment) fail
- Constraint count < 55,000

---

#### T2: Move Contract — Core Pool
**Agent:** night-coder (sonnet, worktree)
**Files to create:**
- `contracts/sources/pool.move`
- `contracts/sources/verifier.move`
- `contracts/sources/token.move`
- `contracts/Move.toml`
- `contracts/tests/pool_tests.move`

**Exact implementation for pool.move:**

```move
module veil::pool {
    use sui::coin::{Self, Coin};
    use sui::clock::Clock;
    use sui::dynamic_field;
    use sui::event;
    use veil::token::VEIL;
    use veil::verifier;

    // Error codes
    const E_FROZEN: u64 = 1;
    const E_NULLIFIER_ALREADY_SPENT: u64 = 2;
    const E_INVALID_PROOF: u64 = 3;
    const E_INVALID_EPOCH: u64 = 4;
    const E_THRESHOLD_EXCEEDED: u64 = 5;
    const E_INSUFFICIENT_BALANCE: u64 = 6;

    const EPOCH_DURATION_MS: u64 = 2_592_000_000; // 30 days

    public struct Pool has key {
        id: UID,
        balance: Balance<VEIL>,
        transfer_vk: vector<u8>,
        threshold: u64,
        frozen: bool,
    }

    public struct AdminCap has key, store { id: UID }

    // Dynamic field key for nullifiers
    public struct NullifierKey has copy, drop, store { nullifier: vector<u8> }

    // Dynamic field key for commitments
    public struct CommitmentKey has copy, drop, store { nullifier: vector<u8> }

    // Events
    public struct DepositEvent has copy, drop {
        sender: address,
        amount: u64,
        epoch: u64,
    }

    public struct TransferEvent has copy, drop {
        nullifier: vector<u8>,
        new_commitment: vector<u8>,
        epoch: u64,
    }

    fun init(ctx: &mut TxContext) {
        // Pool created separately via create_pool
    }

    public entry fun create_pool(
        transfer_vk: vector<u8>,
        threshold: u64,
        ctx: &mut TxContext,
    ) {
        let pool = Pool {
            id: object::new(ctx),
            balance: balance::zero<VEIL>(),
            transfer_vk,
            threshold,
            frozen: false,
        };
        let cap = AdminCap { id: object::new(ctx) };
        transfer::share_object(pool);
        transfer::transfer(cap, ctx.sender());
    }

    fun get_epoch(clock: &Clock) -> u64 {
        clock::timestamp_ms(clock) / EPOCH_DURATION_MS
    }

    public entry fun deposit(
        pool: &mut Pool,
        coin: Coin<VEIL>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!pool.frozen, E_FROZEN);
        let amount = coin.value();
        pool.balance.join(coin.into_balance());
        event::emit(DepositEvent {
            sender: ctx.sender(),
            amount,
            epoch: get_epoch(clock),
        });
    }

    public entry fun shielded_transfer(
        pool: &mut Pool,
        proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
        clock: &Clock,
        _ctx: &mut TxContext,
    ) {
        assert!(!pool.frozen, E_FROZEN);

        // Verify Groth16 proof
        let valid = verifier::verify_transfer_proof(
            &pool.transfer_vk,
            proof_bytes,
            public_inputs_bytes,
        );
        assert!(valid, E_INVALID_PROOF);

        // Extract nullifier from public inputs (5th input, bytes 128..160)
        let nullifier = extract_nullifier(&public_inputs_bytes);

        // Check nullifier not spent
        let nf_key = NullifierKey { nullifier };
        assert!(
            !dynamic_field::exists_(&pool.id, nf_key),
            E_NULLIFIER_ALREADY_SPENT,
        );

        // Mark nullifier as spent
        dynamic_field::add(&mut pool.id, nf_key, true);

        // Store new commitment
        let new_commitment = extract_new_commitment(&public_inputs_bytes);
        let comm_key = CommitmentKey { nullifier };
        dynamic_field::add(&mut pool.id, comm_key, new_commitment);

        event::emit(TransferEvent {
            nullifier,
            new_commitment,
            epoch: get_epoch(clock),
        });
    }

    public entry fun withdraw(
        pool: &mut Pool,
        amount: u64,
        recipient: address,
        _ctx: &mut TxContext,
    ) {
        assert!(!pool.frozen, E_FROZEN);
        assert!(pool.balance.value() >= amount, E_INSUFFICIENT_BALANCE);
        let coin = coin::take(&mut pool.balance, amount, _ctx);
        transfer::public_transfer(coin, recipient);
    }

    public entry fun freeze(pool: &mut Pool, _cap: &AdminCap) {
        pool.frozen = true;
    }

    public entry fun unfreeze(pool: &mut Pool, _cap: &AdminCap) {
        pool.frozen = false;
    }

    fun extract_nullifier(public_inputs: &vector<u8>): vector<u8> {
        // Nullifier is the 5th public input (index 4), bytes 128..160
        let mut result = vector::empty<u8>();
        let mut i = 128;
        while (i < 160) {
            result.push_back(public_inputs[i]);
            i = i + 1;
        };
        result
    }

    fun extract_new_commitment(public_inputs: &vector<u8>): vector<u8> {
        // New commitment is the 2nd public input (index 1), bytes 32..64
        let mut result = vector::empty<u8>();
        let mut i = 32;
        while (i < 64) {
            result.push_back(public_inputs[i]);
            i = i + 1;
        };
        result
    }
}
```

**verifier.move:**
```move
module veil::verifier {
    use sui::groth16;

    public fun verify_transfer_proof(
        vk_bytes: &vector<u8>,
        proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
    ): bool {
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), vk_bytes);
        let proof = groth16::proof_points_from_bytes(proof_bytes);
        let inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
        groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &inputs, &proof)
    }
}
```

**token.move:** OTW pattern, TreasuryCap, faucet function (1000 VEIL per call).

**Move.toml:**
```toml
[package]
name = "veil"
edition = "2024"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "mainnet" }

[addresses]
veil = "0x0"
```

**Tests:** deploy pool, deposit, attempt transfer with mock proof bytes, test freeze, test nullifier replay rejection.

**Acceptance criteria:**
- `sui move build` passes
- `sui move test` passes
- Pool creation, deposit, freeze work
- Nullifier replay is rejected
- Invalid proof fails gracefully

---

#### T3: snarkjs → Sui Proof Byte Converter
**Agent:** night-coder (sonnet, worktree)
**Files to create:**
- `scripts/proof-converter.ts` (standalone converter)
- `scripts/test-converter.ts` (test with known proof)

**Exact implementation:**

The converter must transform snarkjs JSON proof format to Sui's expected bytes:
```typescript
// snarkjs output format:
// { pi_a: [bigint, bigint, "1"], pi_b: [[bigint, bigint], [bigint, bigint], ["1","0"]], pi_c: [bigint, bigint, "1"] }
// Sui expects: compressed arkworks format (LE with sign bits)
// G1 compressed = 32 bytes (x-coord LE + sign bit in MSB of last byte)
// G2 compressed = 64 bytes (x-coord Fq2 LE + sign bit)
// Total proof = 128 bytes (G1 + G2 + G1)

// Public inputs: each Fr scalar as 32 bytes LE, concatenated

export function snarkjsProofToSuiBytes(proof: SnarkjsProof): Uint8Array;
export function snarkjsPublicInputsToSuiBytes(publicSignals: string[]): Uint8Array;
export function snarkjsVkToSuiBytes(vk: SnarkjsVerificationKey): Uint8Array;
```

Key details:
- BN254 field modulus: 21888242871839275222246405745257275088696311157297823662689037894645226208583
- G1 affine point: (x, y) → compress to x + sign_bit(y)
- G2 affine point: (x0+x1*u, y0+y1*u) → compress to (x0, x1) + sign_bit(y)
- Little-endian byte ordering for all field elements
- Sign bit: if y > (p-1)/2, set MSB of last byte

**Acceptance criteria:**
- Convert a snarkjs proof → verify on Sui testnet
- Round-trip test: generate proof with snarkjs, convert, verify with Sui groth16
- Edge cases: zero values, max field values

---

#### T4: Project Scaffolding
**Agent:** night-coder (sonnet, worktree)
**Files to create:**
- `frontend/package.json` (Next.js + deps)
- `frontend/tsconfig.json`
- `frontend/next.config.ts`
- `frontend/biome.json`
- `frontend/src/app/layout.tsx`
- `frontend/src/app/page.tsx`
- `frontend/src/app/providers.tsx` (DAppKitProvider + QueryClient)
- `frontend/src/lib/constants.ts` (contract addresses, network config)
- `frontend/src/lib/types.ts` (VeilPrivateState, Credential, etc.)
- `scripts/init.sh` (install all deps)
- `CLAUDE.md` (project-level)

**init.sh:**
```bash
#!/bin/bash
set -e
echo "=== Installing Circom ==="
command -v circom || (curl --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/nickcoutsos/circom-installer/main/install.sh -sSf | bash)
echo "=== Installing circuit deps ==="
cd circuits && npm init -y && npm install circomlib snarkjs && cd ..
echo "=== Installing frontend deps ==="
cd frontend && bun install && cd ..
echo "=== Building Move contract ==="
cd contracts && sui move build && cd ..
echo "Done!"
```

**Acceptance criteria:**
- `./scripts/init.sh` runs without errors
- `cd frontend && bun run dev` starts Next.js
- `cd contracts && sui move build` passes
- CLAUDE.md exists with overview, structure, commands

---

### Phase 2: Integration (Tasks T5-T7, depends on Phase 1)

#### T5: End-to-End Proof Pipeline
**Agent:** night-coder (opus, worktree)
**Depends on:** T1 (circuit), T2 (contract), T3 (converter)
**Files to create/modify:**
- `scripts/e2e-test.ts` — full pipeline test
- `scripts/deploy.ts` — deploy contract to testnet

**Pipeline:**
1. Compile circuit (circom → r1cs + wasm)
2. Generate witness with test inputs
3. Generate Groth16 proof (snarkjs)
4. Convert proof bytes (snarkjs → Sui format)
5. Deploy Move contract to testnet
6. Call `shielded_transfer` with proof bytes
7. Verify transaction succeeded
8. Test: replay same nullifier → should fail
9. Test: invalid proof → should fail

**This is the most critical task.** If this works, everything else is UI.

**Acceptance criteria:**
- `bun run scripts/e2e-test.ts` passes end-to-end on Sui testnet
- Valid proof verifies on-chain
- Invalid proof rejected
- Nullifier replay rejected
- Console output shows gas costs

---

#### T6: Frontend — Wallet + Deposit
**Agent:** night-coder (opus, worktree) — UI task needs opus
**Depends on:** T4 (scaffold)
**Files to create:**
- `frontend/src/components/WalletConnect.tsx`
- `frontend/src/components/DepositForm.tsx`
- `frontend/src/components/BalanceDisplay.tsx`
- `frontend/src/components/PrivacyStatus.tsx`
- `frontend/src/hooks/useVeilPool.ts`
- `frontend/src/hooks/usePrivateState.ts`
- `frontend/src/app/page.tsx` (updated with components)
- `frontend/src/app/globals.css`
- `frontend/DESIGN.md`

**Design direction:** Dark theme, terminal-aesthetic (like ShadowBook). Monospace fonts. Green/amber accents. No gradients, no glow, no generic AI aesthetics.

**usePrivateState hook:**
- Manages VeilPrivateState in encrypted localStorage
- Password-based encryption (PBKDF2 + AES-GCM)
- Auto-save on state changes
- Export/import for backup

**Acceptance criteria:**
- Wallet connects via dApp-kit
- User can deposit VEIL tokens to pool
- Balance displays correctly
- Private state persists across page refreshes
- Privacy tier indicator works (shows "Anonymous" when under threshold)

---

#### T7: Frontend — Transfer with Proof
**Agent:** night-coder (opus, worktree) — UI task
**Depends on:** T5 (e2e pipeline), T6 (wallet)
**Files to create:**
- `frontend/src/components/TransferForm.tsx`
- `frontend/src/components/ProofProgress.tsx`
- `frontend/src/hooks/useProofGeneration.ts`
- `frontend/src/workers/proof-worker.ts`
- `frontend/public/circuits/transfer.wasm` (copy from build)
- `frontend/public/circuits/transfer_final.zkey` (copy from build)

**Proof generation flow:**
1. User enters amount + recipient
2. Web Worker loads circuit WASM + zkey
3. Compute witness from private state + inputs
4. Generate Groth16 proof (~5-15s)
5. Convert proof bytes to Sui format
6. Build PTB: call `shielded_transfer` with proof + public inputs
7. Sign and execute transaction
8. Update local private state (new cumulative, new randomness)

**ProofProgress component:**
- Shows step-by-step progress
- Estimated time remaining
- Success/failure with tx hash link

**Acceptance criteria:**
- User can execute a shielded transfer
- Proof generation shows progress
- Transaction verifies on Sui testnet
- Private state updates correctly
- Cumulative spending tracks across transfers
- UI shows tier change when approaching threshold

---

### Phase 3: Polish (Tasks T8-T10, depends on Phase 2)

#### T8: Withdraw + Full Flow
**Agent:** night-coder (sonnet, worktree)
**Files:** WithdrawForm.tsx, useWithdraw.ts
**Full flow:** Deposit → Multiple transfers → Withdraw → Verify balances

#### T9: Epoch Management
**Agent:** night-coder (sonnet, worktree)
**Files:** epoch logic in contract + frontend epoch display
**Auto-detect new epoch, reset cumulative counter, show epoch countdown**

#### T10: Testing + Documentation
**Agent:** night-tester (sonnet, worktree)
**Files:** comprehensive tests for circuits, contract, frontend
**README.md with demo instructions, architecture diagram**

---

### Phase 4: Stability Gate + PR

## Architecture Decisions
- Circom + snarkjs for MVP (browser-native proving)
- BN254 curve (Sui Groth16 id 1)
- Custom VEIL test token
- Account-based commitment model (not UTXO)
- Single shared pool (both tiers)
- Dynamic fields for nullifiers (not Table)
- Fixed 30-day epochs from on-chain Clock
- Domain-separated Poseidon: H(1,...) commitments, H(2,...) nullifiers
