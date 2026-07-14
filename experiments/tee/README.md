# Veil TEE Credential-Issuance Spike

Makes Veil's KYC credential **issuance** layer attestable and stateless, following
[MystenLabs Nautilus](https://github.com/MystenLabs/nautilus) (AWS Nitro Enclaves + Sui).

## Problem

Today the admin builds the credential tree off-chain (`scripts/src/seed-credential-tree.ts`)
and publishes the root via `compliance::update_credential_root`. The admin sees every
applicant's `userSecret` and could insert a leaf for someone never verified. The ZK layer
is trustless; the issuance layer is not.

## Design

```
Applicant ──(userSecret, kycLevel, expiryEpoch)──> Enclave (Nitro, attested code)
                                                     │ verifies KYC (mock in spike)
                                                     │ leaf = Poseidon(4, userSecret,
                                                     │        kycLevel, expiryEpoch, issuerId)
                                                     │ signs IntentMessage{intent=1, ts, payload}
                                                     ▼
Anyone ──(leaf, ..., ts, sig)──> veil_tee::record_issuance
                                   │ staleness check (10 min window)
                                   │ enclave::verify_signature (Ed25519 over BCS)
                                   ▼
                                 CredentialIssuedEvent ──> tree maintainer inserts leaf,
                                                           publishes root via
                                                           compliance::update_credential_root
```

- **Credential leaf preimage** (matched against Veil, see "Proven" below):
  `Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId)` — domain tag 4, circomlib
  BN254 Poseidon, exactly `computeCredentialLeaf` in `scripts/src/compliance-utils.ts`
  and constraint C1 in `circuits/compliance.circom`.
- **Byte convention**: leaf travels as 32-byte little-endian field element, same as
  Veil's on-chain roots and Groth16 public inputs (`scripts/src/proof-converter.ts`).
- **Statelessness is structural**: `AppState` holds only the ephemeral signing key and
  the issuer id — no storage handle, no collection, no interior mutability anywhere in
  the crate. The claim is consumed by value and `user_secret` is zeroized on drop
  (`zeroize::ZeroizeOnDrop`). The request body is never logged.

## Layout

```
enclave-service/         Rust (axum) enclave service
  src/lib.rs             AppState, constants, error type
  src/leaf.rs            Poseidon(4,...) leaf derivation (light-poseidon, circomlib params)
  src/intent.rs          IntentMessage BCS wrapper + signing (mirrors Nautilus common.rs)
  src/issuance.rs        POST /issue_credential (mock KYC gate clearly marked)
  src/attestation.rs     GET /get_attestation — real NSM path behind `nitro` feature,
                         honest 501 otherwise; GET /health_check
  src/bin/gen_vector.rs  deterministic cross-language test vector generator
  src/bin/verify_response.rs  offline verifier for live server responses
move/
  enclave/               vendored Nautilus enclave package (one test-only addition, below)
  veil_tee/              CredentialIssuance verification + tests w/ Rust-signed vectors
```

## Run

```bash
# Rust: build + 10 unit tests (Poseidon parity, BCS parity, sign/verify, issuance)
cd enclave-service && cargo test

# Regenerate the cross-language vector consumed by the Move tests
cargo run --bin gen_vector

# Move: 6 tests incl. cross-language BCS parity + Rust-signature verification
# (needs a recent framework with sui::nitro_attestation; sui 1.75.0 used)
cd ../move/veil_tee && /tmp/sui-devnet-175/sui move test

# Live service
cd ../../enclave-service && PORT=3211 cargo run --bin veil-tee-enclave
curl -s localhost:3211/health_check           # -> boot pubkey
curl -s -X POST localhost:3211/issue_credential -H 'Content-Type: application/json' \
  -d '{"payload":{"user_secret":"12345","kyc_level":1,"expiry_epoch":99999999}}' \
  | cargo run --quiet --bin verify_response -- <pk_from_health_check>
```

Env: `VEIL_ISSUER_ID` (default 42, the Veil demo issuer), `PORT` (default 3000).

## Proven (executed on this machine, 2026-07-14)

1. **Leaf parity with Veil** — Rust `Poseidon(4, 12345, 1, 99999999, 42)` equals
   `0x058716c244de50aff018d87da1f3649ca547a7a0ac66bc120a5789d3a2e5e0c3`, the exact leaf
   in `frontend/src/lib/demoCredential.json` (produced by `seed-credential-tree.ts`),
   re-derived independently with circomlibjs. A second circomlibjs vector
   (`Poseidon(4, 777777777, 2, 123456, 42)`) is also pinned. Tests:
   `leaf::tests::test_leaf_matches_veil_demo_credential`, `..._second_vector`.
2. **Rust/Move BCS parity** — Move `bcs::to_bytes(IntentMessage<CredentialIssuance>)`
   equals the Rust-signed bytes, byte for byte (`test_bcs_parity_with_rust`). The Rust
   side also reproduces the upstream Nautilus weather test vector
   (`test_nautilus_reference_vector`).
3. **Cross-language signature** — an Ed25519 signature produced by the Rust service
   verifies inside Move through `enclave::verify_signature`
   (`test_record_issuance_with_rust_signature`); tampering with any signed field,
   staleness > 10 min, and wrong leaf length all abort (4 negative tests).
4. **Live HTTP flow** — server booted with a fresh key, issued the demo credential over
   HTTP, response verified offline (`verify_response`: SIGNATURE VALID, leaf matches
   Veil demo), and the mock KYC gate rejected `kyc_level: 9`.

## NOT proven without AWS (be honest, this is the trust-critical part)

No AWS access in this spike, therefore:

- **No genuine Nitro attestation document** was ever produced or parsed. The
  `/get_attestation` NSM path (feature `nitro`, mirroring Nautilus `common.rs`) has
  **never been compiled or executed** here — there is no `/dev/nsm` on macOS. The
  default build returns HTTP 501 instead of fabricating a document.
- **No real PCR0/1/2 values** exist: they require a reproducible EIF build
  (`make ENCLAVE_APP=...` on an EC2 Nitro parent). `EnclaveConfig` is initialized with
  zero PCRs — registration against zero PCRs is a dev stance only (Nautilus rule #1).
- **`sui::nitro_attestation` cert-chain verification was not exercised** with our key.
  `enclave::register_enclave` (attestation → PCR check → pk extraction) is untouched
  upstream code, but for tests the `Enclave<T>` object is constructed with a test-only
  helper (below) instead of a real attestation.
- Consequently the end-to-end trust chain "AWS root CA → PCRs → ephemeral pk" is
  **UNPROVEN**. What is proven is everything downstream of the attested pk: given a
  registered `Enclave<VEIL_TEE>` holding the service's pubkey, issuance signatures
  verify on-chain exactly as designed. A real enclave drops in with zero code changes:
  build EIF → `update_pcrs` → `register_enclave` → same endpoints, same signatures.

### Deviations from upstream Nautilus

`move/enclave/sources/enclave.move` is vendored verbatim from the mirror
(`~/projects/tools/sui-source-mirror/repos/nautilus`) plus **one** appended block:
`#[test_only] new_enclave_for_testing<T>(pk, ctx)`. Upstream only creates `Enclave<T>`
via `register_enclave`, which needs a genuine attestation for a key we control —
unobtainable off Nitro hardware. The production path is unchanged; upstream's own
`test_serde` still passes in the vendored package.

## Residual trust assumptions (even with real AWS)

- AWS could forge attestations (compromise or legal compulsion).
- The `Cap<VEIL_TEE>` holder can swap PCRs to a different binary — transfer to the
  Veil multisig or burn after pinning.
- `record_issuance` is type-bound to `Enclave<VEIL_TEE>` (only creatable via
  `register_enclave` against the single `EnclaveConfig<VEIL_TEE>`), but an enclave
  registered *before* an `update_pcrs` rotation keeps its stale `config_version` and
  stays usable until someone calls `destroy_old_enclave` (permissionless, upstream
  Nautilus behavior). PCR rotation must be followed by destroying old enclaves.
- The applicant's `userSecret` transits the enclave in plaintext (TLS-terminated
  inside): confidentiality is trusted-code + Nitro isolation, not cryptography. A
  blind-issuance scheme would remove this but requires changing the leaf format.
- The mock KYC gate accepts any structurally valid claim; a real deployment must
  verify identity against a provider pinned in `allowed_endpoints.yaml`.
- Replay inside the 10-minute window is possible for the *same* leaf (idempotent for
  the tree, but the maintainer should deduplicate leaves).
- The tree maintainer can still *censor* (refuse to insert a signed leaf); it can no
  longer *forge*. Full trustlessness needs on-chain leaf accumulation.
