// Veil credential-leaf derivation.
//
// EXACT preimage (from circuits/compliance.circom C1 and
// scripts/src/compliance-utils.ts computeCredentialLeaf):
//
//     leaf = Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId)
//
// Domain tag 4 = DOMAIN_CREDENTIAL_LEAF. Poseidon is the circomlib BN254
// instance (same parameters as circomlibjs); light-poseidon's `new_circom`
// implements those parameters. The unit test below pins the exact leaf that
// scripts/src/seed-credential-tree.ts produces for the demo credential.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use light_poseidon::{Poseidon, PoseidonHasher};
use num_bigint::BigUint;

use crate::EnclaveError;

/// Domain separation tag for credential leaves (circuits/compliance.circom).
pub const DOMAIN_CREDENTIAL_LEAF: u64 = 4;

/// Parse a field element from a decimal or 0x-prefixed hex string.
/// Rejects values >= BN254 scalar field modulus (fail fast — no silent reduction).
pub fn parse_field_element(s: &str) -> Result<Fr, EnclaveError> {
    let value = if let Some(hex_part) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        BigUint::parse_bytes(hex_part.as_bytes(), 16)
    } else {
        BigUint::parse_bytes(s.as_bytes(), 10)
    }
    .ok_or_else(|| EnclaveError::InvalidInput(format!("not a valid field element: {s:?}")))?;

    let modulus: BigUint = Fr::MODULUS.into();
    if value >= modulus {
        return Err(EnclaveError::InvalidInput(
            "value >= BN254 scalar field modulus".to_string(),
        ));
    }
    Ok(Fr::from(value))
}

/// Compute the credential leaf: Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId).
pub fn compute_credential_leaf(
    user_secret: Fr,
    kyc_level: u8,
    expiry_epoch: u64,
    issuer_id: u64,
) -> Result<Fr, EnclaveError> {
    let mut hasher = Poseidon::<Fr>::new_circom(5)
        .map_err(|e| EnclaveError::Internal(format!("Poseidon init failed: {e}")))?;
    hasher
        .hash(&[
            Fr::from(DOMAIN_CREDENTIAL_LEAF),
            user_secret,
            Fr::from(kyc_level as u64),
            Fr::from(expiry_epoch),
            Fr::from(issuer_id),
        ])
        .map_err(|e| EnclaveError::Internal(format!("Poseidon hash failed: {e}")))
}

/// Encode a field element as 32 little-endian bytes — the byte convention Veil
/// uses on-chain for roots and Groth16 public inputs (scripts/src/proof-converter.ts
/// bigintToLE32).
pub fn field_to_le32(f: Fr) -> [u8; 32] {
    let bytes = f.into_bigint().to_bytes_le();
    let mut out = [0u8; 32];
    out[..bytes.len()].copy_from_slice(&bytes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ground truth from Veil: scripts/src/seed-credential-tree.ts with
    /// USER_SECRET=12345, KYC_LEVEL=1, EXPIRY_EPOCH=99999999, ISSUER_ID=42
    /// produces leaf 0x058716c244de50aff018d87da1f3649ca547a7a0ac66bc120a5789d3a2e5e0c3
    /// (big-endian hex, as stored in frontend/src/lib/demoCredential.json).
    #[test]
    fn test_leaf_matches_veil_demo_credential() {
        let user_secret = parse_field_element("12345").unwrap();
        let leaf = compute_credential_leaf(user_secret, 1, 99_999_999, 42).unwrap();
        let be_hex = hex::encode(leaf.into_bigint().to_bytes_be());
        assert_eq!(
            be_hex,
            "058716c244de50aff018d87da1f3649ca547a7a0ac66bc120a5789d3a2e5e0c3"
        );
    }

    #[test]
    fn test_field_le32_of_demo_leaf() {
        let user_secret = parse_field_element("12345").unwrap();
        let leaf = compute_credential_leaf(user_secret, 1, 99_999_999, 42).unwrap();
        let le = field_to_le32(leaf);
        let mut be = le;
        be.reverse();
        assert_eq!(
            hex::encode(be),
            "058716c244de50aff018d87da1f3649ca547a7a0ac66bc120a5789d3a2e5e0c3"
        );
    }

    /// Second independent vector, computed with circomlibjs on 2026-07-14:
    /// Poseidon(4, 777777777, 2, 123456, 42)
    ///   = 0x165cdd7a170aa891116ac9db4f7bda9b024ac67f86720613003a291794cc2541
    #[test]
    fn test_leaf_matches_circomlibjs_second_vector() {
        let user_secret = parse_field_element("777777777").unwrap();
        let leaf = compute_credential_leaf(user_secret, 2, 123_456, 42).unwrap();
        let be_hex = hex::encode(leaf.into_bigint().to_bytes_be());
        assert_eq!(
            be_hex,
            "165cdd7a170aa891116ac9db4f7bda9b024ac67f86720613003a291794cc2541"
        );
    }

    #[test]
    fn test_rejects_oversized_field_element() {
        // BN254 scalar modulus itself must be rejected.
        let modulus_dec =
            "21888242871839275222246405745257275088548364400416034343698204186575808495617";
        assert!(parse_field_element(modulus_dec).is_err());
    }

    #[test]
    fn test_accepts_hex_input() {
        let a = parse_field_element("0x3039").unwrap(); // 12345
        let b = parse_field_element("12345").unwrap();
        assert_eq!(a, b);
    }
}
