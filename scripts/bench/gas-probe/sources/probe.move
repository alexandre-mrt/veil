/// Gas probe: isolates the cost of the `sui::groth16` natives used by veil::verifier so that the
/// per-verification share of an entry point's computation cost can be bracketed. Bench-only —
/// never part of the deployed package. See docs/research/2026-10-13-onchain-gas-baseline.md.
module probe::probe;

use sui::groth16;

/// n x (prepare_verifying_key + proof/inputs parsing + verify) — what veil::verifier does today.
public fun verify_raw(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64): bool {
    let mut i = 0;
    let mut ok = true;
    while (i < n) {
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
        let p = groth16::proof_points_from_bytes(proof);
        let x = groth16::public_proof_inputs_from_bytes(inputs);
        ok = ok && groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &x, &p);
        i = i + 1;
    };
    ok
}

/// n x prepare_verifying_key only.
public fun prepare_only(vk: vector<u8>, n: u64): bool {
    let mut i = 0;
    while (i < n) {
        let _pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
        i = i + 1;
    };
    true
}

/// prepare once, then n x verify against the prepared key (the "store the PVK" optimisation).
public fun verify_prepared(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64): bool {
    let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
    let mut i = 0;
    let mut ok = true;
    while (i < n) {
        let p = groth16::proof_points_from_bytes(proof);
        let x = groth16::public_proof_inputs_from_bytes(inputs);
        ok = ok && groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &x, &p);
        i = i + 1;
    };
    ok
}
