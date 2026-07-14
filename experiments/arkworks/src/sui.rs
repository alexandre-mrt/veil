//! Serialization of arkworks Groth16 artifacts to the byte layout expected by
//! sui::groth16 (fastcrypto-zkp), cross-checked against scripts/src/proof-converter.ts.
//!
//! fastcrypto deserializes with arkworks `CanonicalDeserialize::deserialize_compressed`,
//! so arkworks `serialize_compressed` is the format by construction:
//!   proof         = A (G1, 32) | B (G2, 64) | C (G1, 32)               = 128 bytes
//!   vk            = alpha_g1 (32) | beta_g2 (64) | gamma_g2 (64) |
//!                   delta_g2 (64) | ic_len (u64 LE, 8) | IC[i] (32 each)
//!   public inputs = each Fr as 32-byte LE, concatenated
//!
//! `manual_compress_g1` / `manual_compress_g2` are a Rust port of the
//! proof-converter.ts logic, used in tests to prove the two layouts agree.

use ark_bn254::{Bn254, Fq, Fr};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::{Proof, VerifyingKey};
use ark_serialize::CanonicalSerialize;

pub fn proof_to_sui_bytes(proof: &Proof<Bn254>) -> Vec<u8> {
    let mut bytes = Vec::new();
    proof
        .serialize_compressed(&mut bytes)
        .expect("proof serialization");
    bytes
}

pub fn vk_to_sui_bytes(vk: &VerifyingKey<Bn254>) -> Vec<u8> {
    let mut bytes = Vec::new();
    vk.serialize_compressed(&mut bytes)
        .expect("vk serialization");
    bytes
}

pub fn public_inputs_to_sui_bytes(inputs: &[Fr]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for input in inputs {
        input
            .serialize_compressed(&mut bytes)
            .expect("field element serialization");
    }
    bytes
}

// ---------------------------------------------------------------------------
// Rust port of proof-converter.ts (the authority) for layout cross-checking.
// ---------------------------------------------------------------------------

fn fq_le32(x: &Fq) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&x.into_bigint().to_bytes_le());
    out
}

fn is_gt_half(y: &Fq) -> bool {
    // proof-converter.ts: y > (q-1)/2
    let q_half = Fq::MODULUS_MINUS_ONE_DIV_TWO;
    y.into_bigint() > q_half
}

/// Port of proof-converter.ts `compressG1`: x LE32, MSB of byte 31 = (y > (q-1)/2).
pub fn manual_compress_g1(p: &ark_bn254::G1Affine) -> [u8; 32] {
    let (x, y) = p.xy().expect("point not at infinity");
    let mut bytes = fq_le32(&x);
    if is_gt_half(&y) {
        bytes[31] |= 0x80;
    }
    bytes
}

/// Port of proof-converter.ts `compressG2`: x.c0 LE32 | x.c1 LE32,
/// sign bit in byte 63 by lexicographic (y.c1, y.c0) > half comparison.
pub fn manual_compress_g2(p: &ark_bn254::G2Affine) -> [u8; 64] {
    let (x, y) = p.xy().expect("point not at infinity");
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&fq_le32(&x.c0));
    out[32..].copy_from_slice(&fq_le32(&x.c1));

    let q_half = Fq::MODULUS_MINUS_ONE_DIV_TWO;
    let set_sign = if y.c1.into_bigint() > q_half {
        true
    } else {
        y.c1.into_bigint() == q_half && y.c0.into_bigint() > q_half
    };
    if set_sign {
        out[63] |= 0x80;
    }
    out
}
