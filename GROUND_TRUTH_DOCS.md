# Ground Truth: Interfaces & Contracts

## Circuit Interfaces

### transfer.circom — Public Inputs (order matters for Sui verification)
```
signal input old_commitment;      // Poseidon(cumulative_old, randomness_old)
signal input new_commitment;      // Poseidon(cumulative_new, randomness_new)
signal input threshold;           // KYC-free limit (e.g., 1000 * 10^6 for USDC decimals)
signal input epoch_id;            // Current epoch (from on-chain Clock)
signal input nullifier;           // Poseidon(2, user_secret, epoch_id) — domain-separated
signal input tx_amount_hash;      // Poseidon(tx_amount, salt) — for receiver verification
```

### transfer.circom — Private Inputs
```
signal input cumulative_old;      // Previous cumulative spending
signal input cumulative_new;      // cumulative_old + tx_amount
signal input tx_amount;           // This transaction's amount
signal input randomness_old;      // Blinding factor for old commitment
signal input randomness_new;      // Blinding factor for new commitment
signal input user_secret;         // User's master secret (never revealed)
signal input salt;                // Salt for tx_amount_hash
```

### transfer.circom — Constraints
```
1. old_commitment === Poseidon(1, cumulative_old, randomness_old)
2. new_commitment === Poseidon(1, cumulative_new, randomness_new)
3. cumulative_new === cumulative_old + tx_amount
4. tx_amount > 0
5. cumulative_old >= 0 AND cumulative_old < 2^64
6. tx_amount >= 0 AND tx_amount < 2^64
7. nullifier === Poseidon(2, user_secret, epoch_id)
8. tx_amount_hash === Poseidon(tx_amount, salt)
```

### First-tx-of-epoch special case
```
old_commitment === Poseidon(1, 0, 0)  // deterministic genesis
cumulative_old === 0
```

## Move Contract Interfaces

### veil::pool
```move
module veil::pool;

// Shared objects
public struct Pool has key {
    id: UID,
    transfer_pvk: vector<u8>,         // PreparedVerifyingKey for transfer circuit
    compliance_pvk: vector<u8>,        // PreparedVerifyingKey for compliance circuit  
    credential_root: u256,             // Merkle root of valid credentials
    epoch_duration_ms: u64,            // 30 days in ms
    threshold: u64,                    // KYC-free limit
    total_deposited: u64,
    frozen: bool,                      // Emergency freeze
}

public struct AdminCap has key, store { id: UID }

// Entry functions
public entry fun deposit(pool: &mut Pool, coin: Coin<VEIL>, clock: &Clock, ctx: &mut TxContext);
public entry fun transfer(
    pool: &mut Pool,
    proof_bytes: vector<u8>,
    public_inputs: vector<u8>,
    recipient: address,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
);
public entry fun withdraw(pool: &mut Pool, nullifier: vector<u8>, amount: u64, clock: &Clock, ctx: &mut TxContext);
public entry fun freeze(pool: &mut Pool, cap: &AdminCap);
public entry fun update_credential_root(pool: &mut Pool, cap: &AdminCap, new_root: u256);
```

### veil::token
```move
module veil::token;

public struct VEIL has drop {}

public entry fun mint(treasury: &mut TreasuryCap<VEIL>, amount: u64, recipient: address, ctx: &mut TxContext);
public entry fun faucet(treasury: &mut TreasuryCap<VEIL>, ctx: &mut TxContext); // 1000 VEIL
```

## Frontend Types

### Private State (encrypted localStorage)
```typescript
interface VeilPrivateState {
  userSecret: bigint;           // Master secret
  currentEpoch: number;
  cumulativeSpending: bigint;   // Current epoch total
  randomness: bigint;           // Current commitment randomness
  credentials: Credential[];    // KYC credentials (if any)
}

interface Credential {
  leaf: bigint;                 // Poseidon hash of credential data
  kycLevel: number;
  expiry: number;
  merkleProof: bigint[];
  merkleIndex: number;
}
```

### Proof Generation
```typescript
async function generateTransferProof(
  privateState: VeilPrivateState,
  txAmount: bigint,
  epochId: bigint,
  threshold: bigint,
): Promise<{ proof: Uint8Array; publicInputs: Uint8Array }>;
```

## Naming Conventions
- Move: snake_case (pool, transfer, credential_root)
- Circom: camelCase signals (oldCommitment, newCommitment)
- TypeScript: camelCase (generateTransferProof, VeilPrivateState)
- Constants: UPPER_SNAKE_CASE (MAX_THRESHOLD, EPOCH_DURATION_MS)

## Error Codes (Move)
```
E_FROZEN = 1
E_NULLIFIER_ALREADY_SPENT = 2
E_INVALID_PROOF = 3
E_INVALID_EPOCH = 4
E_THRESHOLD_EXCEEDED = 5
E_INSUFFICIENT_BALANCE = 6
E_INVALID_COMMITMENT = 7
```
