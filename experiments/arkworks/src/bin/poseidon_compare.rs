// probe: compare ark grain constants vs light-poseidon circom constants, and sponge output
use ark_bn254::Fr;
use ark_crypto_primitives::sponge::poseidon::{find_poseidon_ark_and_mds, PoseidonConfig, PoseidonSponge};
use ark_crypto_primitives::sponge::{CryptographicSponge, FieldBasedCryptographicSponge};
use ark_ff::PrimeField;
use veil_arkworks_spike::poseidon::circom_params;

fn main() {
    let p = circom_params(4); // t=5, full=8, partial=60
    let (ark_rounds, mds) = find_poseidon_ark_and_mds::<Fr>(Fr::MODULUS_BIT_SIZE as u64, 4, 8, 60, 0);
    let ark_flat: Vec<Fr> = ark_rounds.iter().flatten().cloned().collect();
    println!("MODULUS_BIT_SIZE = {}", Fr::MODULUS_BIT_SIZE);
    println!("ark constants equal: {}", ark_flat == p.ark);
    println!("mds equal: {}", mds == p.mds);
    println!("circom ark[0] = {}", p.ark[0]);
    println!("grain  ark[0] = {}", ark_flat[0]);

    // arkworks-native sponge with the same config
    let cfg = PoseidonConfig::new(8, 60, 5, mds, ark_rounds, 4, 1);
    let mut sponge = PoseidonSponge::new(&cfg);
    sponge.absorb(&vec![Fr::from(1u64), Fr::from(2u64), Fr::from(3u64), Fr::from(4u64)]);
    let out: Vec<Fr> = sponge.squeeze_native_field_elements(1);
    println!("ark sponge H(1,2,3,4) = {}", out[0]);
    println!("circomlib  H(1,2,3,4) = 18821383157269793795438455681495246036402687001665670618754263018637548127333");
}
