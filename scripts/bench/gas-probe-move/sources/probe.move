/// Gas probe for Groth16 verification on Sui. NOT part of the Veil protocol — a measurement-only
/// package. Each function repeats one primitive `n` times inside a single transaction so that
/// sweeping `n` against the chain's bucketed computation cost recovers the per-call cost
/// (see scripts/bench/gas-probe.ts).
module gas_probe::probe;

use sui::groth16;

/// n x prepare_verifying_key  (what verifier.move pays on every call today)
public fun prepare_n(vk: vector<u8>, n: u64) {
    let curve = groth16::bn254();
    let mut i = 0;
    while (i < n) {
        let _pvk = groth16::prepare_verifying_key(&curve, &vk);
        i = i + 1;
    };
}

/// prepare once, then n x (parse proof + parse inputs + verify)
public fun verify_prepared_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64): bool {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &vk);
    let mut ok = true;
    let mut i = 0;
    while (i < n) {
        let p = groth16::proof_points_from_bytes(copy proof);
        let x = groth16::public_proof_inputs_from_bytes(copy inputs);
        ok = ok && groth16::verify_groth16_proof(&curve, &pvk, &x, &p);
        i = i + 1;
    };
    ok
}

/// n x (prepare + parse + verify) — exactly verifier::verify_*_proof repeated n times
public fun full_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64): bool {
    let curve = groth16::bn254();
    let mut ok = true;
    let mut i = 0;
    while (i < n) {
        let pvk = groth16::prepare_verifying_key(&curve, &vk);
        let p = groth16::proof_points_from_bytes(copy proof);
        let x = groth16::public_proof_inputs_from_bytes(copy inputs);
        ok = ok && groth16::verify_groth16_proof(&curve, &pvk, &x, &p);
        i = i + 1;
    };
    ok
}

/// n x empty loop iteration — separates interpreter loop overhead from native cost
public fun loop_n(n: u64) {
    let mut i = 0;
    while (i < n) { i = i + 1; };
}
