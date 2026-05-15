# Night Shift Problems — Veil

> All critical and major issues resolved. E2E verified on Sui testnet.

---

## ALL FIXED

1. CommitmentKey used nullifier bytes → uses new_commitment
2. withdraw() no access control → requires AdminCap
3. Epoch ID hardcoded → dynamic from Date.now()
4. No public_inputs length check → assert >= 192 bytes
5. AdminCap had `store` ability → key-only
6. Circuit missing threshold constraint → added LessEqThan(64)
7. Randomness 32 bytes (BN254 overflow) → 31 bytes
8. EPOCH_DURATION_MS duplicated → import from constants.ts
9. Contract no epoch/threshold validation → le_bytes_to_u64 + asserts
10. DepositForm used tx.gas (SUI) → queries TOKEN coins
11. G2 coordinate swap was WRONG → snarkjs stores [c0,c1] correctly, removed swap
12. Poseidon F.toObject conversion → circuit tests 8/8 pass
13. Deploy error handling → catches stderr, handles Published.toml
14. Keypair mismatch → loads key matching sui client active-address
15. Object version stale → waitForTransaction after create_pool

## VERIFIED ON TESTNET

- Package: 0xdb8b862787a152f5581298b991e2c86dc1b0f0eb5b868e9a313b45bc06f8d111
- Pool: 0xbd5d353cd5c0bed612692e6a76429d63b84c71201b5a28ffd542af70641e0303
- Transfer tx: 257rYRLT6wzH6uqxa4r5f8iFNcuc47GkUFXTRctVRZBC
- Nullifier replay: correctly rejected (abort code 2)

## KNOWN LIMITATIONS (not bugs)

### proof-converter.ts duplicated
- scripts/ and frontend/ have copies. Share via workspace for production.

### userSecret in plaintext localStorage
- Add PBKDF2+AES-GCM for production. Documented.

### Trusted setup is dev-only
- Single contributor. Production needs MPC ceremony.

### Token OTW named TOKEN not VEIL
- Move 2024 constraint. Display name "VEIL" preserved via create_currency.
