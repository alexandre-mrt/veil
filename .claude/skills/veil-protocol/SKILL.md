---
name: veil-protocol
description: >
  The Veil protocol design on Sui: what the on-chain state and the Move modules actually do.
  Use for identity-bound Poseidon commitments, note-based nullifiers, the UTXO spend model,
  epochs and cumulative spending, the depth-20 Merkle accumulator, standard deposit
  denominations, tiered KYC and the dual-proof compliance path, ECDH auditor encryption,
  credential nullifiers and revocation, admin timelocks and multisig governance, the threat and
  privacy model, and the pool/compliance/multisig/verifier/token module map with error codes
  (E_NULLIFIER_SPENT, E_COMMITMENT_CHAIN_BROKEN, E_COMPLIANCE_REQUIRED, E_MERKLE_ROOT_MISMATCH,
  E_CREDENTIAL_NULLIFIER_SPENT...). For circuits and proof bytes see /veil-zk; for the dApp see
  /veil-frontend; for build, test, deploy, relayer and auditor CLI see /veil-ops.
last_updated: 2026-07-14
---

# Veil Protocol Design

Privacy payments on Sui. UTXO-style commitments, cumulative spending proofs per epoch, and a
tiered compliance path that keeps amounts hidden from the chain but decryptable by a designated
auditor.

Ground truth is the code: `contracts/sources/{pool,compliance,verifier,multisig,token,token_faucet}.move`.
If this skill and the code disagree, the code wins — and fix this skill.

## Mental model

- **Not a mixer.** Users hold a single live commitment representing their cumulative state, not a
  bag of fixed-denomination notes. Deposit → transfer (spend old commitment, create new) →
  withdraw.
- **Cumulative, not per-transaction.** The circuit proves *"my total spending this epoch stays
  under the threshold"*, not *"this one transfer is small"*. That closes the split-into-many-small-
  transfers loophole a per-tx threshold would leave open.
- **One pool, both tiers.** Anonymous transfers and KYC-backed transfers land in the same
  commitment set, so the anonymity set is every user, not every user of your tier.
- **Compliance is cryptographic.** The auditor decrypts amounts from a ciphertext attached to the
  transaction; there is no database of amounts to query. Nothing readable is written on-chain.
- **The chain never sees an amount, a sender, or a recipient.** Every emitted event is scrubbed:
  `TransferEvent` carries only `{nullifier, new_commitment}`, `DepositEvent`/`WithdrawEvent` only
  `{pool_id}`.

## Core cryptographic objects

All hashing is Poseidon over BN254, with a domain tag as the **first** input. Tags are global
across all three circuits — never reuse one.

| Tag | Object | Preimage |
|-----|--------|----------|
| 1 | commitment | `Poseidon(1, cumulative, randomness, userSecret)` |
| 2 | transfer nullifier | `Poseidon(2, userSecret, epochId, randomnessOld)` |
| 3 | txAmountHash | `Poseidon(3, txAmount, salt)` |
| 4 | credential leaf | `Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId)` |
| 5 | compliance nullifier | `Poseidon(5, userSecret, contextId)` |
| 6 | context binding | `Poseidon(6, transferNullifier, userSecret)` |
| 7 | withdraw nullifier | `Poseidon(7, userSecret, randomnessOld, cumulativeOld)` |
| 8 | recipient binding | `Poseidon(8, recipient)` |

**Identity-bound commitments (tag 1).** `userSecret` is *inside* the commitment. Without it, a
commitment is just `H(value, randomness)` and anyone who learns the opening can spend it — a
commitment-theft bug the audit caught (CRYPTO-004). Binding to the secret means only the owner
can produce the transfer proof.

**Note-based nullifiers (tag 2).** The nullifier includes `randomnessOld`, so it is unique *per
commitment consumed*, not per (user, epoch). An earlier design keyed it on `(secret, epoch)`
alone, which silently allowed exactly one transfer per epoch (CRYPTO-006).

**Withdraw nullifiers (tag 7)** deliberately exclude `epochId`: a commitment can only be
withdrawn once, ever, regardless of epoch.

## On-chain state

`Pool` (shared object, `pool.move`):

- `balance: Balance<TOKEN>` — pool liquidity
- `commitment_root: vector<u8>` — root of the off-chain depth-20 Poseidon Merkle tree
- `next_leaf_index: u64`
- nullifier set and commitment set — **dynamic fields** on the Pool UID, keyed by
  `NullifierKey`/`CommitmentKey` wrapper structs (not a `Table`; keeps the Pool object small and
  avoids serialization bloat as the sets grow)
- `transfer_vk`, `withdraw_vk: vector<u8>` — raw Groth16 verifying keys
- `threshold`, `epoch_duration_ms`, `frozen`, `compliance_required`
- pending-update slots for each timelocked parameter

`ComplianceConfig` (shared object, `compliance.move`): `credential_root`, `required_kyc_level`,
`auditor_key`, compliance VK, `pool_id` (checked against the Pool on every call —
`E_CONFIG_POOL_MISMATCH`).

Epoch is computed on-chain from the `Clock`, never supplied by the user:
`current_epoch(clock, epoch_duration_ms) = timestamp_ms / epoch_duration_ms`. Testnet epoch
duration is 1 hour.

## The three flows

### Deposit — `pool::deposit_and_register`

Public operation, no proof. Caller sends a `Coin<TOKEN>` and a commitment. The commitment is
registered on-chain and inserted into the off-chain Merkle tree; the admin later publishes the
new root.

**Standard denominations only:** 100 / 500 / 1000 TOKEN (`DENOM_SMALL = 100_000_000`,
`DENOM_MEDIUM = 500_000_000`, `DENOM_LARGE = 1_000_000_000` at 6 decimals). Anything else aborts
with `E_NON_STANDARD_AMOUNT`. This exists because free-form deposit amounts are a deanonymization
oracle: a 731.44-token deposit and a 731.44-token exit are the same user. This was the main fix
out of the privacy red-team pass.

Commitments must also *mature* before they can be spent (`E_COMMITMENT_NOT_MATURE`) — a deposit
and an immediate spend in the same block would link trivially.

### Transfer — `pool::shielded_transfer` / `compliance::compliant_transfer`

The circuit proves, against 7 public inputs (`oldCommitment, newCommitment, threshold, epochId,
nullifier, txAmountHash, merkleRoot`):

1. `oldCommitment` is a member of the Merkle tree at `merkleRoot` (the anonymity set is every
   commitment ever inserted — the chain sees a root, not which leaf moved)
2. both commitments open correctly under the same `userSecret`
3. `cumulativeNew == cumulativeOld + txAmount`, `txAmount > 0`, everything range-checked to 64 bits
4. `cumulativeNew <= threshold`
5. the nullifier and `txAmountHash` derive correctly

The contract then, in `execute_transfer`: rejects if frozen (`E_FROZEN`), checks the epoch matches
(`E_EPOCH_MISMATCH`), checks the public-input `merkleRoot` equals `pool.commitment_root`
(`E_MERKLE_ROOT_MISMATCH`), verifies the Groth16 proof (`E_INVALID_PROOF`), checks the nullifier is
fresh (`E_NULLIFIER_SPENT`), checks `oldCommitment` exists on-chain (`E_COMMITMENT_CHAIN_BROKEN`)
and `newCommitment` does not (`E_COMMITMENT_EXISTS`), then consumes the old commitment, records the
nullifier, and registers the new commitment.

That commitment-chain check is what makes the cumulative counter unforgeable. Verifying the proof
alone is not enough: a valid proof merely says *some* well-formed `oldCommitment` with
`cumulativeOld = 0` exists. The contract must independently confirm that this specific commitment
is the live one. Skip that check and every user can reset their counter at will.

### Withdraw — `pool::zk_withdraw`

Partial withdrawal, no admin involvement. 5 public inputs: `commitment, withdrawAmount, nullifier,
recipientHash, newCommitment`. The circuit proves ownership, `0 < withdrawAmount <= cumulativeOld`,
and produces a change commitment for the remainder. `recipientHash = Poseidon(8, recipient)` binds
the proof to one address, so a validator cannot redirect the payout (`E_INVALID_RECIPIENT`).

**Withdrawals are not anonymous.** The consumed commitment is identified on-chain, and the amount
is public because the token has to move. The Merkle accumulator gives transfers an anonymity set;
the exit path is deliberately identifiable. This is stated in the header of `withdraw.circom` and
is a design choice, not an oversight.

## Compliance (Tier 3)

Below the threshold, a transfer needs one proof. Above it, `compliance_required` is on and the
user goes through `compliance::compliant_transfer`, which requires **two independent Groth16
proofs in the same transaction**:

1. the transfer proof (as above), and
2. a compliance proof from `compliance.circom` (6 public inputs: `merkleRoot, currentEpoch,
   contextId, requiredKycLevel, nullifier, validCredential`) proving the user holds an unexpired
   KYC credential of sufficient level in the credential Merkle tree — without revealing which one.

Plus an **encrypted amount** blob, which the contract length-checks
(`E_INVALID_ENCRYPTED_AMOUNT`, minimum 93 bytes) and emits in `ComplianceVerifiedEvent` for the
auditor to pick up.

### Context binding (tag 6) — the subtle one

`contextId = Poseidon(6, transferNullifier, userSecret)`, and the compliance nullifier is
`Poseidon(5, userSecret, contextId)`. So the credential nullifier is **unique per transfer**, yet
`transferNullifier` stays a *private* input to the compliance circuit.

Why it is built this way: if `transferNullifier` were a public input to the compliance proof, an
observer could join the compliance proof to the exact transfer it accompanies. And if `contextId`
were a constant (or per-epoch), the credential nullifier would repeat, so one credential could only
ever back one transfer — or, worse, replay across transfers. Hashing the transfer nullifier
*inside* the circuit gets uniqueness without the linkability.

Credential nullifiers are stored on the Pool UID via
`pool::add_credential_nullifier` and rejected on reuse (`E_CREDENTIAL_NULLIFIER_SPENT`).

### Auditor encryption — ECDH P-256 + AES-GCM

**Not ElGamal.** The auditor's key is a raw uncompressed P-256 public key (65 bytes). The client
generates an ephemeral P-256 keypair, does ECDH, stretches the shared secret with HKDF-SHA256 into
an AES-GCM-256 key, and encrypts `(txAmount, salt)`.

Wire format: `ephemeral_pubkey (65) || iv (12) || ciphertext || GCM tag (16)` — hence the 93-byte
minimum the contract enforces. The auditor recovers `(txAmount, salt)` and can recompute
`Poseidon(3, txAmount, salt)` and match it against the `txAmountHash` public input, which is what
ties the decrypted amount to the proof rather than trusting the sender.

This is symmetric-after-ECDH, so it is *not* homomorphic — the auditor decrypts one transaction at
a time and cannot sum ciphertexts. That was an acceptable trade for using Web Crypto primitives
that run in any browser with no extra library.

Rotating the auditor key is a timelocked admin action; old ciphertexts stay bound to the old key
(no forward secrecy — a leaked auditor key exposes every amount ever encrypted to it).

### Credential revocation

No revocation tree. The admin rebuilds the credential Merkle tree without the revoked leaf and
publishes the new root via `compliance::update_credential_root` (1-epoch timelock). Short credential
expiry epochs give natural revocation points: once the root rotates, an expired credential can no
longer produce a valid membership proof. The trade-off is documented at the top of `compliance.move`
— mid-epoch revocation is not instantaneous.

## Governance

Every parameter that could be used to steal or censor is **timelocked one epoch**: transfer VK,
withdraw VK, compliance VK, commitment root, credential root, auditor key, required KYC level,
compliance toggle, epoch duration, and admin withdrawals (propose → wait → execute, with a cancel
path for each). A VK swap with no delay is a rug: the admin installs a VK they hold the toxic waste
for and drains the pool in one transaction.

`multisig.move` sits above `AdminCap` for the dangerous actions (freeze/unfreeze, propose
withdrawal, propose VK update): M-of-N signers approve an action hash before it can execute
(`E_INSUFFICIENT_APPROVALS`, `E_NOT_SIGNER`, `E_ALREADY_APPROVED`).

`emergency_withdraw` exists but requires the pool to be frozen first (`E_POOL_NOT_FROZEN`) and has
its own delay (`E_EMERGENCY_WITHDRAW_NOT_READY`).

## Module map

| Module | Responsibility |
|---|---|
| `pool.move` | Pool state, deposit, shielded transfer, ZK withdraw, nullifier/commitment sets, epochs, freeze, all timelocks |
| `compliance.move` | ComplianceConfig, dual-proof `compliant_transfer`, credential root + nullifiers, auditor key, encrypted-amount plumbing |
| `verifier.move` | Thin `groth16::verify_*` wrappers (transfer / compliance / withdraw), `public(package)` only |
| `multisig.move` | M-of-N approval layer over the admin-capability actions |
| `token.move` | VEIL token, 6 decimals, `TreasuryCap` |
| `token_faucet.move` | Testnet faucet (needs the `TreasuryCap`) |

## Error codes

`pool.move` uses 1–35, `compliance.move` 100–115 (namespaced to avoid collision; `E_EPOCH_MISMATCH = 8`
is intentionally shared), `multisig.move` 200–205. The authoritative list is in the project
`CLAUDE.md` and at the top of each module. Do not invent new codes in an existing range without
checking both.

## Threat and privacy model

What Veil gives you:

| Property | Holds? | Mechanism / caveat |
|---|---|---|
| Amount confidentiality | Yes | Amounts live only in Poseidon commitments. The auditor can decrypt Tier-3 amounts. |
| Sender anonymity (transfer) | Yes | Merkle membership hides which commitment was consumed. Anonymity set = every commitment inserted. |
| Sender anonymity (on-chain tx origin) | Only via the relayer | Otherwise the Sui sender address is visible. See `/veil-ops`. |
| Unlinkability across transfers | Partial | Nullifiers are per-commitment and unlinkable, but timing and deposit/withdraw amounts still correlate. |
| Credential non-transferability | Yes | Credentials are bound to `userSecret`. Sharing the credential means sharing the wallet. |
| Withdrawal anonymity | **No** | By design — the consumed commitment and the amount are public. |
| Forward secrecy | **No** | A leaked `userSecret` exposes all past notes; a leaked auditor key exposes all past amounts. |
| Censorship resistance | **No** | Nullifiers are public; validators could censor by pattern. Inherent without an encrypted mempool. |

Known limits, honestly:

- **Sybil.** Cumulative proofs stop splitting *within* a wallet. They cannot stop a user from
  funding N wallets, because wallets are unlinkable by construction. The threshold is a privacy
  floor, not a hard identity boundary. Standard denominations and the cost of maintaining wallets
  raise the price; they do not make it impossible.
- **Small anonymity set.** Privacy is only as good as the number of commitments in the tree. With a
  handful of users, the Merkle membership proof hides nothing useful.
- **Trusted setup.** Groth16 needs a per-circuit ceremony. `circuits/scripts/compile.sh` runs a
  single dev contribution and prints a loud warning; `ceremony.sh` is the multi-contributor path.
  Toxic waste from a one-person setup means forged proofs, i.e. minting money.
- **Compromised auditor.** Decrypts every Tier-3 amount. Rotation limits the blast radius going
  forward, not backwards.

## Getting it wrong

1. **Verifying the proof and skipping the state checks.** A Groth16 proof is only a statement about
   its public inputs. If the contract does not check `merkleRoot` against the stored root, and that
   `oldCommitment` is live and `newCommitment` is new, and that the nullifier is fresh, the proof
   proves nothing useful.
2. **Reusing a domain tag.** Eight tags are in use across three circuits. A new hash with an old tag
   can be made to collide with an existing object.
3. **Putting anything identifying in an event.** No sender, no recipient, no amount. If you add an
   event field, ask what an observer joins it against.
4. **Adding a parameter setter with no timelock.** Anything the admin can change instantly is a rug
   vector.
5. **Accepting a non-standard deposit amount.** Amount correlation is the cheapest deanonymization
   attack that exists against this design.
