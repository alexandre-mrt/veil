//! Circom-compatible Poseidon: native hash (via light-poseidon, which ships the
//! exact circomlib round constants / MDS for BN254 x^5) and an R1CS gadget that
//! replicates the same reference permutation over `FpVar<Fr>`.
//!
//! Round structure (identical to circomlib / circomlibjs reference impl):
//!   state = [domain_tag = 0, inputs...], width t = n_inputs + 1
//!   for round in 0..R_F/2:            add ARK, full S-box (x^5), MDS
//!   for round in ..+R_P:              add ARK, partial S-box (state[0] only), MDS
//!   for round in ..+R_F/2:            add ARK, full S-box, MDS
//!   output = state[0]

use ark_bn254::Fr;
use ark_ff::Field;
use ark_r1cs_std::fields::fp::FpVar;
use ark_r1cs_std::fields::FieldVar;
use ark_relations::r1cs::SynthesisError;
use light_poseidon::{Poseidon, PoseidonHasher, PoseidonParameters};

/// Loads the circomlib BN254 x^5 Poseidon parameters for `n_inputs` inputs
/// (state width = n_inputs + 1).
pub fn circom_params(n_inputs: usize) -> PoseidonParameters<Fr> {
    let width = n_inputs + 1;
    light_poseidon::parameters::bn254_x5::get_poseidon_parameters::<Fr>(
        u8::try_from(width).expect("poseidon width fits in u8"),
    )
    .expect("valid circom poseidon width")
}

/// Native circomlib-compatible Poseidon hash (domain tag 0, output = state[0]).
pub fn circom_hash(inputs: &[Fr]) -> Fr {
    let mut hasher =
        Poseidon::<Fr>::new_circom(inputs.len()).expect("valid circom poseidon arity");
    hasher.hash(inputs).expect("poseidon hash")
}

/// Reference Poseidon permutation over native field elements with arbitrary
/// (ark, mds) constants — used to compare circomlib constants against
/// arkworks-Grain-generated constants under the *same* permutation structure.
pub fn permute_native(
    ark: &[Fr],
    mds: &[Vec<Fr>],
    width: usize,
    full_rounds: usize,
    partial_rounds: usize,
    inputs: &[Fr],
) -> Fr {
    assert_eq!(inputs.len(), width - 1, "inputs must be width - 1");
    let mut state: Vec<Fr> = Vec::with_capacity(width);
    state.push(Fr::from(0u64)); // circom domain tag
    state.extend_from_slice(inputs);

    let all_rounds = full_rounds + partial_rounds;
    let half = full_rounds / 2;
    for round in 0..all_rounds {
        for (i, s) in state.iter_mut().enumerate() {
            *s += ark[round * width + i];
        }
        let is_full = round < half || round >= half + partial_rounds;
        if is_full {
            for s in state.iter_mut() {
                *s = s.pow([5u64]);
            }
        } else {
            state[0] = state[0].pow([5u64]);
        }
        state = (0..width)
            .map(|i| {
                (0..width)
                    .map(|j| state[j] * mds[i][j])
                    .sum::<Fr>()
            })
            .collect();
    }
    state[0]
}

/// R1CS gadget for the circomlib Poseidon permutation.
///
/// ARK additions and MDS multiplications are affine (folded into linear
/// combinations, zero constraints); each x^5 S-box costs 3 constraints
/// (x2 = x*x, x4 = x2*x2, x5 = x4*x).
pub fn poseidon_circom_gadget(
    params: &PoseidonParameters<Fr>,
    inputs: &[FpVar<Fr>],
) -> Result<FpVar<Fr>, SynthesisError> {
    assert_eq!(
        inputs.len(),
        params.width - 1,
        "poseidon gadget arity mismatch"
    );
    let width = params.width;
    let mut state: Vec<FpVar<Fr>> = Vec::with_capacity(width);
    state.push(FpVar::zero()); // circom domain tag = 0
    state.extend_from_slice(inputs);

    let all_rounds = params.full_rounds + params.partial_rounds;
    let half = params.full_rounds / 2;

    for round in 0..all_rounds {
        // ARK (affine, no constraints)
        for (i, s) in state.iter_mut().enumerate() {
            *s = &*s + params.ark[round * width + i];
        }
        // S-box x^5
        let is_full = round < half || round >= half + params.partial_rounds;
        if is_full {
            for s in state.iter_mut() {
                *s = sbox5(s)?;
            }
        } else {
            state[0] = sbox5(&state[0])?;
        }
        // MDS (affine, no constraints)
        state = (0..width)
            .map(|i| {
                let mut acc = FpVar::<Fr>::zero();
                for j in 0..width {
                    acc += &state[j] * params.mds[i][j];
                }
                acc
            })
            .collect();
    }
    Ok(state[0].clone())
}

fn sbox5(x: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let x2 = x.square()?;
    let x4 = x2.square()?;
    Ok(&x4 * x)
}
