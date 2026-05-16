# Veil -- Threat Model

## System Overview

Veil is a privacy payment protocol on Sui that hides transaction amounts using zero-knowledge proofs while enforcing cumulative spending limits. The system consists of:

- **Sui Move contracts** (5 modules + 1 testnet): pool, compliance, verifier, token, multisig, token_faucet
- **ZK circuits** (3 Circom circuits): transfer (11 constraints), compliance (~7200 constraints), withdraw (10 constraints)
- **Frontend** (Next.js 14): client-side proof generation via snarkjs WASM, encrypted local state
- **Relayer** (Bun HTTP server): sponsored transaction submission for sender privacy

Data flows: User generates Groth16 proofs in-browser, submits proof bytes + public inputs to Sui via direct transaction or relayer-sponsored transaction. On-chain, the verifier module calls `sui::groth16` native BN254 verification. Pool state is updated via UTXO-style commitment consumption and creation.

## Trust Boundaries

1. **User Browser <-> Sui Network (via RPC)**: User constructs and signs transactions. The Sui fullnode validates consensus and executes Move bytecode. Trust: Sui consensus is assumed honest.
2. **User Browser <-> Relayer (HTTP)**: User sends TransactionKind bytes; relayer adds gas payment and co-signs. Trust: relayer can censor but cannot forge or alter the user's Move calls.
3. **Relayer <-> Sui Network (RPC)**: Relayer submits dual-signed transactions. Trust: same as boundary 1.
4. **Admin <-> Sui Network (direct tx)**: Admin holds AdminCap and can freeze pool, update VKs, propose withdrawals. Trust: admin is a privileged role; all admin actions have 1-epoch timelocks for user exit windows.
5. **ZK Proof Generation (client-side, trustless)**: Proofs are generated in-browser using snarkjs WASM. The trusted setup ceremony determines soundness. Trust: Groth16 soundness under BN254 discrete log assumption + honest majority in MPC ceremony.

## Assets

1. **Pool Balance** -- TOKEN funds held in `Pool.balance`. The primary financial asset. Loss = direct fund theft.
2. **User Commitments (UTXO state)** -- Poseidon hash commitments stored as dynamic fields on Pool. Represent user balances within the privacy pool. Corruption = inability to transact or double-spend.
3. **User Secret (`userSecret` in browser)** -- Master secret used to derive commitments and nullifiers. Stored AES-GCM encrypted in localStorage with non-extractable IndexedDB keys. Compromise = commitment theft, unauthorized transfers.
4. **Verification Keys (on-chain)** -- `transfer_vk`, `withdraw_vk`, `compliance_vk` stored in Pool/ComplianceConfig. Malicious VK = accept forged proofs. Protected by 1-epoch timelock on all updates.
5. **Admin Capability (`AdminCap`)** -- Sui object granting admin access to a specific pool (`cap.pool_id == pool.id`). Theft = full pool control.
6. **Credential Data (KYC leaves)** -- Poseidon leaves `H(4, userSecret, kycLevel, expiryEpoch, issuerId)` in off-chain Merkle tree. Root stored on-chain in `ComplianceConfig.credential_root`. Compromise = fake KYC proofs if root is manipulated.
7. **Nullifier Set** -- Dynamic fields tracking spent nullifiers (transfer, withdrawal, credential). Corruption = double-spend or replay attacks.
8. **Upgrade Capability (`UpgradeCap`)** -- Controls package upgrades. Can inject arbitrary code. Pre-mainnet blocker: must be burned or transferred to multisig.

## Threat Analysis (STRIDE)

### Spoofing

| ID | Threat | Mitigation | Status |
|----|--------|------------|--------|
| S1 | Attacker impersonates pool admin | AdminCap ownership check (`cap.pool_id == pool.id`) on every admin function. Sui object ownership model prevents transfer without possession. | Mitigated |
| S2 | Attacker forges ZK proof to fake a valid transfer | Groth16 verification via `sui::groth16` native BN254 verifier. Computational soundness under discrete log assumption. | Mitigated |
| S3 | Attacker replays a previously valid proof | Nullifier consumption: each transfer/withdrawal nullifier is stored as a dynamic field and checked for uniqueness (`E_NULLIFIER_SPENT`). Credential nullifiers are context-bound (unique per transfer). | Mitigated |
| S4 | Attacker uses a fake ComplianceConfig with a permissive credential root | Pool stores registered `compliance_config: Option<ID>` and validates `pool.compliance_config == config.id` before accepting compliant transfers (`E_CONFIG_POOL_MISMATCH`). Single config per pool enforced. | Mitigated |
| S5 | Attacker creates AdminCap for another pool | AdminCap is created only in `create_pool` and bound to the new pool's ID. Cross-pool admin access fails with `E_NOT_POOL_ADMIN`. Tested in 4 access-control tests. | Mitigated |

### Tampering

| ID | Threat | Mitigation | Status |
|----|--------|------------|--------|
| T1 | Modify proof bytes in transit (browser to chain) | Groth16 verification fails on any byte modification. Transaction bytes are signed by the user. | Mitigated |
| T2 | Modify pool state directly (bypass Move logic) | Sui consensus prevents unauthorized state modification. Pool is a shared object; state changes only through published Move functions. | Mitigated |
| T3 | Modify VK to accept forged proofs | All VK updates (transfer, withdraw, compliance) require 1-epoch timelock. Proposed via `propose_vk_update`, applied lazily. Users have one epoch to exit if VK change is malicious. | Mitigated |
| T4 | Modify commitment Merkle root to include fake commitments | Admin-gated with 1-epoch timelock (`update_commitment_root`). `CommitmentRootUpdatedEvent` emitted for monitoring. | Mitigated |
| T5 | Modify credential root to include fake KYC credentials | Admin-gated with 1-epoch timelock (`update_credential_root`). Event emitted. Cancel function available. | Mitigated |
| T6 | Tamper with auditor key to decrypt compliance ciphertexts with attacker key | Auditor key update requires AdminCap + 1-epoch timelock (`propose_auditor_key_update`). | Mitigated |
| T7 | Tamper with encrypted localStorage (userSecret) | AES-GCM authenticated encryption detects tampering (GCM tag verification fails). Corrupted data triggers re-initialization. | Mitigated |

### Repudiation

| ID | Threat | Mitigation | Status |
|----|--------|------------|--------|
| R1 | Admin denies freezing the pool | `FreezeEvent` emitted on-chain with pool_id and frozen state. Immutable event log on Sui. | Mitigated |
| R2 | User denies making a transfer | `TransferEvent` emitted with nullifier and new_commitment. Nullifier is cryptographically tied to user's secret. | Mitigated |
| R3 | Admin denies proposing a withdrawal | `WithdrawalProposedEvent` emitted with amount, recipient, and effective epoch. | Mitigated |
| R4 | Admin denies changing compliance settings | `ComplianceToggleProposedEvent`, `CredentialRootUpdatedEvent`, `AuditorKeyUpdateProposedEvent`, `KycLevelUpdateProposedEvent` all emitted on-chain. | Mitigated |

### Information Disclosure

| ID | Threat | Mitigation | Status |
|----|--------|------------|--------|
| I1 | userSecret leaked via XSS | Primary: IndexedDB non-extractable AES-GCM keys (key material cannot be exported even by JS). Fallback: PBKDF2-derived key from wallet address. CSP headers restrict script sources. | Mitigated |
| I2 | Transaction amounts leaked from on-chain data | Amounts hidden inside Poseidon commitments. Only commitment hashes and nullifiers are stored/emitted. ZK proof verifies amount validity without revealing it. | Mitigated |
| I3 | Sender identity leaked via on-chain transaction | Sponsored transaction relayer hides sender address. Relayer pays gas; on-chain `gas_payer` is the relayer address. User can fall back to direct submission (loses sender privacy). | Mitigated |
| I4 | Deposit address linked to commitment via timing/amount | Known gap. Deposits are on-chain and visible. Standard denominations (100/500/1000 TOKEN) reduce amount correlation. Merkle accumulator provides anonymity set for transfers. Deposit-to-commitment link remains partially observable. | Accepted risk |
| I5 | Compliance ciphertext reveals amount to non-auditor | ECDH P-256 + AES-128-GCM encryption. Only the auditor's private key can decrypt. Ciphertext emitted in `ComplianceVerifiedEvent`. | Mitigated |
| I6 | Nullifier pattern reveals transfer frequency | Nullifiers are Poseidon hashes with randomness (`randomnessOld`), making them pseudorandom. No frequency pattern leakage beyond "a transfer occurred". | Mitigated |

### Denial of Service

| ID | Threat | Mitigation | Status |
|----|--------|------------|--------|
| D1 | Relayer refuses to relay transactions | User can submit directly to Sui network (loses sender privacy but retains functionality). Multiple independent relayers recommended for production. | Mitigated |
| D2 | Spam relayer with requests | Rate limiting: 10 requests/min/IP. API key authentication (`RELAYER_API_KEY`). Payload size limit: 50KB. CORS restricted to known origins. | Mitigated |
| D3 | Spam pool with fake commitments to exhaust dynamic fields | `deposit_and_register` requires standard deposit (100/500/1000 TOKEN per commitment). Minimum cost of 100 TOKEN per griefing attempt. | Mitigated |
| D4 | Admin freezes pool indefinitely, trapping funds | Emergency withdraw has 1-epoch timelock (must wait past `frozen_at_epoch`). Multisig governance (`multisig.move`) available to require N-of-M approval for freeze/unfreeze. | Mitigated |
| D5 | Epoch boundary race conditions cause transfer failures | Grace period: transfer circuit accepts current epoch OR previous epoch (`proof_epoch == on_chain_epoch || proof_epoch == on_chain_epoch - 1`). | Mitigated |
| D6 | Admin proposes malicious VK update to break transfers | 1-epoch timelock on all VK updates. Cancel functions available (`cancel_vk_update`, `cancel_withdraw_vk`). Users can exit via `zk_withdraw` or `emergency_withdraw` before VK takes effect. | Mitigated |

### Elevation of Privilege

| ID | Threat | Mitigation | Status |
|----|--------|------------|--------|
| E1 | Non-admin calls admin function | `assert_pool_admin(cap, pool)` checks `cap.pool_id == pool.id.to_inner()` on every admin operation. 19 admin functions gated. | Mitigated |
| E2 | Cross-pool admin attack (use cap from pool A on pool B) | `cap.pool_id` is set at creation and immutable. Mismatch aborts with `E_NOT_POOL_ADMIN`. Tested in 7 cross-pool access-control tests. | Mitigated |
| E3 | Package upgrade backdoor via UpgradeCap | Pre-mainnet blocker. UpgradeCap currently in EOA. Must be burned (`sui::package::make_immutable`) or transferred to multisig before mainnet. Management script exists (`manage-upgrade-cap.ts`). | Accepted risk (pre-mainnet) |
| E4 | Withdraw more than deposited via ZK proof manipulation | Withdraw circuit enforces `withdrawAmount <= cumulativeOld` (constraint C5) with 64-bit range proofs on both values. On-chain checks pool balance sufficiency. | Mitigated |
| E5 | Bypass compliance requirement via direct `shielded_transfer` | When `compliance_required == true`, `shielded_transfer` aborts with `E_COMPLIANCE_REQUIRED`. Compliance toggle applied lazily before the check. | Mitigated |
| E6 | Sybil attack: create multiple userSecrets to bypass spending threshold | Known limitation. Each userSecret gets its own cumulative spending counter. Mitigation requires identity-binding at deposit time (future work). | Accepted risk |
| E7 | Front-run ZK withdrawal to steal funds | Withdrawal circuit binds to recipient via `recipientHash = Poseidon(8, recipient)`. Changing recipient invalidates the Groth16 proof. | Mitigated |

## Attack Scenarios (tested in Move tests)

The following 19 attacker threat scenarios are tested in `scenario_tests.move`:

| # | Scenario | Error Code | Test Function |
|---|----------|------------|---------------|
| 1 | Bypass compliance with direct `shielded_transfer` when compliance required | `E_COMPLIANCE_REQUIRED (15)` | `threat_bypass_compliance_direct_transfer` |
| 2 | Wrong AdminCap used to create ComplianceConfig | `E_NOT_POOL_ADMIN (4)` | `threat_wrong_admincap_create_compliance_config` |
| 3 | Wrong AdminCap used to update credential root | `E_NOT_POOL_ADMIN (4)` | `threat_wrong_admincap_update_credential_root` |
| 4 | Non-standard deposit amount rejected | `E_NON_STANDARD_AMOUNT (14)` | `threat_nonstandard_deposit_rejected` |
| 5 | Dust deposit below MIN_DEPOSIT rejected | `E_DUST_DEPOSIT (11)` | `threat_dust_deposit_rejected` |
| 6 | Double freeze is idempotent (no abort) | -- | `threat_double_freeze_idempotent` |
| 7a | Deposit when pool is frozen | `E_FROZEN (1)` | `threat_deposit_when_frozen` |
| 7b | Deposit-and-register when pool is frozen | `E_FROZEN (1)` | `threat_deposit_and_register_when_frozen` |
| 8 | ComplianceConfig used with mismatched pool | `E_CONFIG_POOL_MISMATCH (106)` | `threat_compliance_config_pool_mismatch` |
| 9 | Non-standard deposit_and_register rejected | `E_NON_STANDARD_AMOUNT (14)` | `threat_nonstandard_deposit_and_register_rejected` |
| 10 | VK overwrite protection (propose while pending) | `E_VK_UPDATE_PENDING (17)` | `threat_vk_overwrite_protection` |
| 11 | Invalid commitment length (16 bytes, must be 32) | `E_INVALID_INPUTS_LENGTH (7)` | `threat_invalid_commitment_length` |
| 12 | Epoch commitment tracking (deposits at different epochs) | -- | `threat_epoch_commitment_tracking` |
| 13 | Emergency withdraw when frozen (positive test) | -- | `threat_emergency_withdraw_when_frozen` |
| 14 | Credential root timelock enforcement | -- | `threat_credential_root_timelock_enforcement` |
| 15 | VK too short rejected at pool creation | `E_INVALID_VK_LENGTH (18)` | `threat_vk_too_short_rejected` |
| 16 | VK update too short rejected | `E_INVALID_VK_LENGTH (18)` | `threat_vk_update_too_short_rejected` |
| 17 | Duplicate commitment rejected on deposit_and_register | `E_COMMITMENT_EXISTS (10)` | `threat_duplicate_commitment_rejected` |
| 18 | Credential root double-proposal blocked | `E_CREDENTIAL_ROOT_UPDATE_PENDING (108)` | `threat_credential_root_double_proposal_blocked` |
| 19 | Attacker cannot cancel admin's credential root update | `E_NOT_POOL_ADMIN (4)` | `threat_attacker_cannot_cancel_credential_root_update` |

## Residual Risks

| ID | Risk | Severity | Description | Mitigation Status |
|----|------|----------|-------------|-------------------|
| RR1 | UpgradeCap in EOA | Critical | Package upgrade can inject arbitrary code. | Pre-mainnet blocker. Burn or transfer to multisig. |
| RR2 | Trusted setup single contributor | High | Dev-only ceremony. Forged proofs possible if toxic waste retained. | MPC ceremony script exists. Must run with 3+ contributors + random beacon before mainnet. |
| RR3 | Sybil on spending limits | Medium | Multiple userSecrets bypass per-identity threshold. | Requires identity-binding at deposit (future work). No on-chain fix without breaking privacy model. |
| RR4 | Admin can drain pool via timelock | Medium | Admin proposes withdrawal, waits 1 epoch, executes. Users have 1-epoch window to exit. | Multisig governance reduces risk. Full decentralization requires DAO. |
| RR5 | Deposit-commitment linkability | Medium | Deposits are visible on-chain. Timing/amount analysis can link deposit to commitment. | Standard denominations reduce correlation. Merkle accumulator provides anonymity set. Full unlinkability requires deposit mixing (future work). |
| RR6 | EPOCH_DURATION_MS hardcoded to 1h | Low | Testnet setting. Must be 30 days (2,592,000,000 ms) for mainnet. | Configuration change before mainnet deploy. |
| RR7 | Relayer centralization | Low | Single relayer can censor. | Multiple independent relayers + direct submission fallback. |
| RR8 | PBKDF2 fallback key derivation | Low | In incognito mode, encryption key derived from wallet address (public). Weaker than IndexedDB non-extractable keys. | Acceptable for incognito sessions. Primary path uses non-extractable keys. |
| RR9 | Token faucet in production bytecode | Low | `token_faucet.move` allows free minting (gated by TreasuryCap). | Remove from sources before mainnet deployment. Separate module file for easy exclusion. |

## Security Controls Summary Table

| Control | Location | Type | Description |
|---------|----------|------|-------------|
| Groth16 verification | `verifier.move` | Preventive | BN254 native verification for transfer, compliance, and withdraw proofs |
| AdminCap binding | `pool.move:146-148` | Preventive | `cap.pool_id == pool.id` enforced on all admin operations |
| Nullifier uniqueness | `pool.move:234-239` | Preventive | Dynamic field existence check prevents double-spend |
| Commitment maturity | `pool.move:230` | Preventive | `pool_epoch > created_epoch` prevents same-epoch transfer (flash loan resistance) |
| Transfer VK timelock | `pool.move:348-379` | Detective/Preventive | 1-epoch delay on VK updates with cancel option |
| Withdraw VK timelock | `pool.move:498-525` | Detective/Preventive | 1-epoch delay on withdraw VK updates |
| Compliance toggle timelock | `pool.move:434-475` | Detective/Preventive | 1-epoch delay on compliance requirement changes |
| Withdrawal timelock | `pool.move:280-327` | Detective/Preventive | 1-epoch delay on admin withdrawals |
| Commitment root timelock | `pool.move:390-417` | Detective/Preventive | 1-epoch delay on Merkle root updates |
| Credential root timelock | `compliance.move:165-171` | Detective/Preventive | 1-epoch delay on credential root updates |
| Auditor key timelock | `compliance.move:174-180` | Detective/Preventive | 1-epoch delay on auditor key updates |
| KYC level timelock | `compliance.move:183-190` | Detective/Preventive | 1-epoch delay on KYC level changes |
| Standard deposit amounts | `pool.move:617-619` | Preventive | Only 100/500/1000 TOKEN accepted (anti-correlation) |
| Minimum deposit | `pool.move:153` | Preventive | `amount >= MIN_DEPOSIT (1000)` prevents dust griefing |
| Rate limiting | `relayer.ts:77-87` | Preventive | 10 req/min/IP with sliding window |
| API key auth | `relayer.ts:63-67` | Preventive | Bearer token on /sponsor and /submit endpoints |
| Payload size limit | `relayer.ts:71` | Preventive | 50KB max request body |
| CORS restriction | `relayer.ts:69-70` | Preventive | Restricted to known frontend origins |
| CSP headers | `next.config.mjs:16-22` | Preventive | Restricts script/connect sources, denies framing |
| AES-GCM encryption | `usePrivateState.ts:114-137` | Preventive | Encrypted localStorage with random IV per write |
| IndexedDB non-extractable keys | `usePrivateState.ts:58-74` | Preventive | Key material cannot be exported even by XSS |
| Multi-sig governance | `multisig.move` | Preventive | N-of-M approval for freeze/unfreeze operations |
| Single ComplianceConfig per pool | `pool.move:488-491` | Preventive | Prevents fake config substitution |
| Commitment uniqueness | `pool.move:244-249` | Preventive | `E_COMMITMENT_EXISTS` prevents duplicate commitments |
| Upper bytes zero check | `verifier.move:67-73` | Preventive | Prevents u64 overflow via non-zero upper 24 bytes |
| Epoch grace period | `pool.move:206-208` | Preventive | Accepts current or previous epoch to handle boundary races |
| Recipient binding (withdrawal) | `withdraw.circom:108-113` | Preventive | `recipientHash = Poseidon(8, recipient)` prevents front-running |
| Context-bound credential nullifiers | `compliance.circom:79-87` | Preventive | `contextId = Poseidon(6, transferNullifier, userSecret)` unique per transfer |
| Domain-separated Poseidon hashes | `transfer.circom`, `compliance.circom`, `withdraw.circom` | Preventive | Tags 1-8 prevent cross-domain hash collisions |
| Merkle accumulator | `pool.move:77-80`, `transfer.circom:52-61` | Privacy | Anonymity set = all commitments, root verified in circuit |
