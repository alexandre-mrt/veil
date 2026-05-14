# Ground Truth: Brainstorm

## Approach Selection

### Option A: Circom + snarkjs (SELECTED for MVP)
**Pros:** Browser-native proving, large ecosystem (circomlib), fast iteration, snarkjs output directly compatible with Sui Groth16 after byte conversion.
**Cons:** snarkjs proof bytes need conversion to arkworks format for Sui. Limited to BN254. Circom is less flexible than arkworks for complex circuits.

### Option B: Arkworks Rust (SELECTED for thesis, later)
**Pros:** Full Rust control, native performance, flexible circuit design, same ecosystem as Sui's fastcrypto.
**Cons:** Server-side proving required (WASM not performant enough), more complex setup, v0.5 API instability.

### Option C: Noir (Aztec)
**Pros:** Modern ZK DSL, good ergonomics, no trusted setup (UltraPlonk).
**Cons:** No native Sui verifier, would need custom Move verifier, smaller ecosystem.
**Rejected:** No Sui Groth16 compatibility.

## Circuit Architecture Options

### Option A: Single unified circuit (REJECTED)
Merge transfer + compliance into one circuit.
**Rejected:** 10 combined public inputs > 8 max Sui limit.

### Option B: Two separate circuits (SELECTED)
Transfer circuit (6 inputs) + Compliance circuit (4 inputs), submitted together when needed.
**Pros:** Fits within 8-input limit, modular, compliance optional for Tier 0.

### Option C: Recursive proofs
Prove transfer inside compliance proof.
**Rejected:** Too complex for hackathon, no recursive proof support in Sui Groth16.

## Token Options

### Option A: SUI native
Simple but unrealistic for payment protocol demo.

### Option B: USDC testnet
Realistic but requires faucet + external dependency.

### Option C: Custom test token (SELECTED)
Full control, easy faucet, clean demo. Mint VEIL token with TreasuryCap.

## Nullifier Design

### Option A: Note-based nullifiers (Zcash style)
nullifier = Poseidon(user_secret, note_commitment)
**Selected for transfer circuit.** One nullifier per epoch per user.

### Option B: Epoch-based nullifiers
nullifier = Poseidon(user_secret, epoch_id)
**Used for epoch tracking.** Links spending counter to user+epoch.

## State Model

### Option A: UTXO (Zcash/Tornado style)
Each deposit creates a note, transfer consumes + creates notes.
**Rejected for MVP:** Too complex, need to manage note set.

### Option B: Account-based with commitments (SELECTED)
Single commitment per user per epoch tracking cumulative spending.
**Pros:** Simpler state management, natural epoch reset, no UTXO set.
**Cons:** Less privacy (commitment updates are observable), but sufficient for MVP.

## Frontend Proving

### Option A: Full client-side (snarkjs Web Worker) (SELECTED)
User's secrets never leave browser. Proof generated in ~2-15s depending on circuit size.

### Option B: Server-side proof generation
Faster but user must trust server with private inputs.
**Fallback if client-side too slow.**
