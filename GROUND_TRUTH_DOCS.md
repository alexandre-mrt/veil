# Ground Truth: Interfaces & Contracts (v2 — post-audit)

## Circuit Interfaces (v2)

### transfer.circom — Public Inputs (6, order matters)
```
signal input oldCommitment;      // Poseidon(1, cumulative_old, randomness_old, userSecret)
signal input newCommitment;      // Poseidon(1, cumulative_new, randomness_new, userSecret)
signal input threshold;          // KYC-free limit
signal input epochId;            // Current epoch from Clock
signal input nullifier;          // Poseidon(2, userSecret, epochId, randomnessOld)
signal input txAmountHash;       // Poseidon(3, txAmount, salt)
```

### transfer.circom — Private Inputs (7)
```
signal input cumulativeOld, cumulativeNew, txAmount;
signal input randomnessOld, randomnessNew, userSecret, salt;
```

### Circuit Constraints (11)
```
C1:  oldCommitment === Poseidon(1, cumOld, randOld, userSecret)
C2:  newCommitment === Poseidon(1, cumNew, randNew, userSecret)
C3:  cumNew === cumOld + txAmount
C4:  txAmount > 0  (GreaterThan(64))
C5:  cumOld fits 64 bits  (Num2Bits(64))
C6:  txAmount fits 64 bits  (Num2Bits(64))
C7:  cumNew fits 64 bits  (Num2Bits(64))
C8:  threshold fits 64 bits  (Num2Bits(64))
C9:  cumNew <= threshold  (LessEqThan(64))
C10: nullifier === Poseidon(2, userSecret, epochId, randOld)
C11: txAmountHash === Poseidon(3, txAmount, salt)
```

### Key Changes from v1
- Commitments: Poseidon(4) with userSecret (was Poseidon(3))
- Nullifiers: Poseidon(4) with randomnessOld — multiple txs per epoch
- txAmountHash: domain tag 3 (was no tag)
- Threshold: range-proved (was unconstrained)

## Contract: veil::pool (v2)

### State model: UTXO-style commitments
- Old commitment CONSUMED (removed) on each transfer
- New commitment CREATED
- Nullifier stored permanently (prevents replay)

### Functions
- `deposit_and_register(pool, coin, commitment)` — deposit + register genesis (anti-griefing)
- `deposit(pool, coin)` — deposit only (for adding more funds)
- `shielded_transfer(pool, proof, inputs, clock)` — verify + consume old + create new
- `withdraw(pool, cap, amount, recipient)` — AdminCap-gated
- `propose_vk_update(pool, cap, new_vk, clock)` — 1-epoch timelock
- `freeze_pool / unfreeze_pool` — AdminCap-gated + events

### Error Codes
```
E_FROZEN = 1, E_NULLIFIER_SPENT = 2, E_INVALID_PROOF = 3, E_NOT_POOL_ADMIN = 4,
E_THRESHOLD_MISMATCH = 5, E_INSUFFICIENT_BALANCE = 6, E_INVALID_INPUTS_LENGTH = 7,
E_EPOCH_MISMATCH = 8, E_COMMITMENT_CHAIN_BROKEN = 9, E_COMMITMENT_EXISTS = 10,
E_DUST_DEPOSIT = 11
```
