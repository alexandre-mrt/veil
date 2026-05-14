# Night Shift Problems — Veil

> Check this file first in the morning. It contains uncertainties, assumptions, and blocked items.

---

## FIXED — Blockers (from stability gate)

1. **CommitmentKey used nullifier bytes** → Fixed: uses new_commitment (1a84b9f)
2. **withdraw() no access control** → Fixed: requires AdminCap (1a84b9f)
3. **Epoch ID hardcoded to 1n** → Fixed: dynamic from Date.now() (1a84b9f)
4. **No public_inputs length check** → Fixed: assert >= 192 bytes (1a84b9f)
5. **AdminCap had `store` ability** → Fixed: key-only (1a84b9f)

## FIXED — Majors

6. **Circuit missing threshold constraint** → Fixed: added LessEqThan(64) (f433b5e)
7. **Randomness 32 bytes → BN254 overflow** → Fixed: 31 bytes (f433b5e)
8. **EPOCH_DURATION_MS in 3 places** → Fixed: import from constants.ts (f433b5e)
9. **Contract no epoch/threshold validation** → Fixed: le_bytes_to_u64 + asserts (96788c1)
10. **DepositForm used tx.gas (SUI)** → Fixed: queries TOKEN coins (96788c1)

## REMAINING — Known Limitations

### proof-converter.ts duplicated between scripts/ and frontend/
- **Files:** scripts/src/proof-converter.ts, frontend/src/lib/proof-converter.ts
- **Impact:** Will drift. Share via workspace package in production.
- **Priority:** LOW for hackathon

### userSecret in plaintext localStorage
- **File:** frontend/src/hooks/usePrivateState.ts
- **Impact:** XSS can extract master secret. Add PBKDF2+AES-GCM for production.
- **Priority:** Documented limitation for hackathon

### Trusted setup is dev-only
- **File:** circuits/scripts/compile.sh
- **Impact:** Single contributor with timestamp entropy. Production needs MPC ceremony.
- **Priority:** Documented

### circom not installed on dev machine
- **Impact:** Circuit compilation and full E2E test require circom CLI
- **Action:** `cargo install circom` or download binary

## ASSUMPTIONS

### Token OTW named TOKEN not VEIL
- Move 2024 requires OTW = uppercase module name. Display name "VEIL" preserved.

### Used @mysten/dapp-kit 1.x (not 2.x)
- 2.x has breaking Lit-based API. 1.x is correct for React patterns.
