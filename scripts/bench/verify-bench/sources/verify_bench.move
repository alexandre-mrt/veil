/// Bench-only package (never deployed outside a local network). Calls the same `sui::groth16`
/// natives as `veil::verifier`, N times in one transaction, so the marginal cost of one
/// verification / one VK preparation can be read off the computation-cost slope.
module verify_bench::verify_bench;

use sui::groth16;

/// `prepare_each = true` mirrors veil::verifier exactly (prepare_verifying_key on every call).
public fun verify_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64, prepare_each: bool): u64 {
    let curve = groth16::bn254();
    let pvk0 = groth16::prepare_verifying_key(&curve, &vk);
    let p = groth16::proof_points_from_bytes(proof);
    let i = groth16::public_proof_inputs_from_bytes(inputs);
    let mut ok = 0;
    let mut k = 0;
    while (k < n) {
        let valid = if (prepare_each) {
            let pvk = groth16::prepare_verifying_key(&curve, &vk);
            groth16::verify_groth16_proof(&curve, &pvk, &i, &p)
        } else {
            groth16::verify_groth16_proof(&curve, &pvk0, &i, &p)
        };
        if (valid) ok = ok + 1;
        k = k + 1;
    };
    ok
}

/// Only VK preparation, N times (isolates prepare cost).
public fun prepare_n(vk: vector<u8>, n: u64): u64 {
    let curve = groth16::bn254();
    let mut k = 0;
    while (k < n) {
        let _pvk = groth16::prepare_verifying_key(&curve, &vk);
        k = k + 1;
    };
    k
}
