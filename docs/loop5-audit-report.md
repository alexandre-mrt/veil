# Loop 5 — Comprehensive 11-Agent Security Audit

**Date:** 2026-05-16
**Scope:** Full Veil protocol (contracts, circuits, frontend, scripts, relayer)
**Method:** 11 specialized security reviewer agents running in parallel
**Branch:** `feat/tier3-compliance` (commit `bb6f99a`, merged to `main`)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| HIGH | 5 |
| MEDIUM | 15 |
| LOW | 25 |
| INFO | 20 |
| **Total (deduplicated)** | **68** |

**Overall risk: MEDIUM** (no exploitable critical on-chain vulnerabilities; critical findings are infrastructure/operational)

The on-chain contract logic is sound. The ZK circuits are correctly designed with proper domain separation, range proofs, and nullifier uniqueness. The main risks are operational (UpgradeCap, trusted setup, relayer) and design-level (admin centralization, no user withdrawal, Sybil on spending limits).

---

## Agents and Risk Ratings

| # | Agent | Risk | Findings |
|---|-------|------|----------|
| 1 | Access Control | LOW | 3L, 9I |
| 2 | Arithmetic & Math Safety | LOW | 2M, 5L, 5I |
| 3 | Cryptography & Identity | MEDIUM | 1H, 2M, 9L |
| 4 | Cross-Protocol Composition | MEDIUM | 2H, 6M, 7L |
| 5 | DeFi Economics & Game Theory | HIGH | 3C, 5H, 4M, 4L |
| 6 | Flash Loans & Hot Potato | MEDIUM | 3M, 6L |
| 7 | Infrastructure & Operations | HIGH | 3C, 4H, 6M, 8L |
| 8 | Object Model & Ownership | MEDIUM | 3M, 9L |
| 9 | Oracle & Timing | MEDIUM | 1H, 3M, 6L |
| 10 | Type Safety & Abilities | MEDIUM | 2M, 9L |
| 11 | Persona Flows (6 personas) | MEDIUM | 2H, 6M, 7L |

---

## CRITICAL Findings (3, deduplicated)

### C-01: UpgradeCap Unsecured — Single EOA Owner
**Agents:** Infra-Ops, Cross-Protocol
**File:** `contracts/Published.toml:12`

The UpgradeCap is owned by a personal EOA. The upgrade policy is `compatible` (most permissive). A compromised key can silently upgrade the contract to bypass all verification.

**Fix:** Transfer to multisig or call `sui::package::make_immutable` before mainnet.

### C-02: Trusted Setup Uses Dev-Only Entropy
**Agent:** Infra-Ops
**Files:** `circuits/scripts/compile.sh:79`, `circuits/scripts/compile-compliance.sh:80`

Single-contributor setup with `echo "veil-dev-entropy-$(date +%s)"`. Anyone who ran the script holds the toxic waste and can forge proofs.

**Fix:** Run multi-party ceremony with 3-5 independent contributors before mainnet.

### C-03: Relayer Zero Rate Limiting + Open CORS
**Agents:** Infra-Ops, Cross-Protocol, DeFi Economics
**File:** `scripts/src/relayer.ts:310`

`Access-Control-Allow-Origin: *`, no rate limiting, no authentication, blindly sponsors any TransactionKind.

**Fix:** Restrict CORS, add rate limiting, validate targets the Veil package.

---

## HIGH Findings (5, deduplicated)

### H-01: Admin Emergency Withdraw Bypasses All Timelocks
**Agents:** Persona Flows, Flash Loans, DeFi Economics, Cross-Protocol, Access Control
**File:** `pool.move:285-298`

`freeze_pool` + `emergency_withdraw` in a single PTB drains the entire pool instantly. No timelock, no cap.

**Fix:** Require pool to be frozen for >= 1 epoch before emergency_withdraw, or add a multisig.

### H-02: userSecret Stored in Plaintext localStorage
**Agents:** Persona Flows, Cross-Protocol
**File:** `frontend/src/hooks/usePrivateState.ts:87`

Master secret stored as base64 JSON in localStorage. Any XSS extracts it.

**Fix:** Encrypt with wallet-derived key (Tier 1.1 in FUTURE_IMPROVEMENTS.md).

### H-03: No User Withdrawal Mechanism
**Agents:** DeFi Economics, Persona Flows
**File:** `pool.move` (no `zk_withdraw` function)

Users cannot self-withdraw. Funds exit only via admin withdrawal or shielded transfers (which don't reduce pool balance).

**Fix:** Implement ZK withdrawal circuit (Tier 2.2 in FUTURE_IMPROVEMENTS.md).

### H-04: EPOCH_DURATION_MS Hardcoded to 1 Hour (Testnet)
**Agents:** Infra-Ops, Oracle/Timing
**File:** `pool.move:10`

Compile-time constant. All timelocks are 1 hour on testnet. Must be 30 days for mainnet.

**Fix:** Redeploy with `2_592_000_000` before mainnet. Consider making it a pool parameter.

### H-05: E2E Test Uses Wrong Epoch Divisor
**Agent:** Oracle/Timing
**File:** `scripts/src/e2e-test.ts:208`

Hardcoded `2_592_000_000` (30 days) while contract uses `3_600_000` (1 hour). Epoch mismatch breaks E2E on testnet.

**Fix:** Use shared constant from `constants.ts`.

---

## MEDIUM Findings (15, deduplicated)

| ID | Title | Agents |
|----|-------|--------|
| M-01 | `requiredKycLevel` missing range proof in compliance circuit (8-bit wraparound) | Arithmetic, Crypto |
| M-02 | AdminCap `store` ability enables wrapping in shared containers | Type Safety, Object Model, Access Control |
| M-03 | Fake ComplianceConfig defense fragile (checks pool_id but not registered config ID) | Object Model, Cross-Protocol |
| M-04 | Sybil attack on spending limits (multiple userSecrets) | DeFi Economics |
| M-05 | Pool balance insolvency after admin withdrawal (no committed funds tracking) | DeFi Economics, Cross-Protocol |
| M-06 | Compliance toggle timing attack (locks existing non-compliant users) | DeFi Economics, Persona Flows |
| M-07 | TreasuryCap supply attack (uncapped minting up to MAX_SUPPLY) | DeFi Economics |
| M-08 | Relayer error messages leak internal state | Cross-Protocol, Infra-Ops |
| M-09 | `pool_uid_mut` grants unconstrained dynamic field write to package modules | Type Safety |
| M-10 | No object destruction functions (Pool, AdminCap, ComplianceConfig permanent) | Object Model |
| M-11 | Off-chain epoch uses Date.now() vs on-chain Clock (desync risk) | Oracle/Timing |
| M-12 | Relayer can hold transactions for epoch shopping | Oracle/Timing |
| M-13 | Commitment griefing via front-running deposit_and_register | Crypto, DeFi Economics |
| M-14 | VEIL token lacks DenyList (no address-level freeze capability) | Flash Loans |
| M-15 | No CI/CD pipeline (tests only run locally) | Infra-Ops |

---

## Verified Secure (confirmed by multiple agents)

| Property | Agents | Verdict |
|----------|--------|---------|
| Domain separation (6 tags) | Crypto, Arithmetic | Sound — all tags distinct, different arities |
| Nullifier uniqueness | Crypto, Flash Loans | Guaranteed — randOld makes each unique |
| Commitment binding to userSecret | Crypto, Type Safety | Prevents theft — Poseidon(1, cum, rand, secret) |
| AdminCap isolation (cross-pool) | Access Control, Persona Flows | Correct — cap.pool_id == pool.id enforced everywhere |
| Dynamic field type-tag dispatch | Object Model, Type Safety | No collision possible between key types |
| Flash loan resistance | Flash Loans | Blocked by commitment maturity check |
| Balance overflow | Arithmetic | Safe — MAX_SUPPLY << u64::MAX |
| le_bytes_to_u64 + upper bytes zero | Arithmetic | Correct and consistently applied |
| Groth16 BN254 verification | Crypto | Correct curve ID, input ordering, no malleability |
| Epoch grace period | Oracle, Arithmetic | Underflow-safe (on_chain_epoch > 0 guard) |
| Clock manipulation | Oracle | Not feasible on Sui (consensus-driven) |
| Coin<TOKEN> phantom type safety | Type Safety | Enforced by Sui framework |
| TOKEN OTW pattern | Type Safety | Correct (drop-only, zero-field, consumed in init) |

---

## Pre-Mainnet Checklist

- [ ] Burn or multisig UpgradeCap
- [ ] Run MPC trusted setup ceremony (3+ contributors)
- [ ] Harden relayer (CORS, rate limit, TX validation, separate keypair)
- [ ] Change EPOCH_DURATION_MS to 2_592_000_000 (30 days)
- [ ] Remove `token::faucet()` from production bytecode
- [ ] Add `Num2Bits(8)` on `requiredKycLevel` in compliance circuit
- [ ] Encrypt localStorage secrets (Tier 1.1)
- [ ] Fix E2E test epoch divisor
- [ ] Add CI/CD pipeline (sui move test, circuit tests, converter tests)
- [ ] Pin Sui framework to commit hash in Move.toml
- [ ] Pin snarkjs to exact version across all packages
- [ ] Remove .env.testnet from git tracking
- [ ] Add CSP headers to frontend
- [ ] Verify .zkey and .wasm integrity hashes
