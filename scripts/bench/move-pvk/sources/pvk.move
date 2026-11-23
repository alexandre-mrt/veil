/// Gas micro-benchmark for Veil's Groth16 verification path (scripts/bench/run-gas-local.sh).
/// Isolates the cost of `groth16::prepare_verifying_key` (done on every call by
/// contracts/sources/verifier.move) from the cost of the pairing check itself, by comparing:
///   verify_raw     — prepare_verifying_key + verify  (what Veil does today)
///   verify_cached  — pvk_from_bytes(stored parts) + verify  (the "store a PreparedVerifyingKey" option)
///   prepare_only   — prepare_verifying_key alone
///   touch          — reads the object and does nothing (fixed per-tx overhead)
/// Not deployed anywhere; bench-only.
module pvkbench::pvk;

use sui::groth16;

public struct Stored has key {
    id: UID,
    vk: vector<u8>,
    pvk_parts: vector<vector<u8>>,
}

public fun create(vk: vector<u8>, ctx: &mut TxContext) {
    let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
    let pvk_parts = groth16::pvk_to_bytes(pvk);
    transfer::freeze_object(Stored { id: object::new(ctx), vk, pvk_parts });
}

public fun verify_raw(s: &Stored, proof: vector<u8>, inputs: vector<u8>) {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &s.vk);
    let p = groth16::proof_points_from_bytes(proof);
    let i = groth16::public_proof_inputs_from_bytes(inputs);
    assert!(groth16::verify_groth16_proof(&curve, &pvk, &i, &p), 0);
}

public fun verify_cached(s: &Stored, proof: vector<u8>, inputs: vector<u8>) {
    let curve = groth16::bn254();
    let pvk = groth16::pvk_from_bytes(s.pvk_parts[0], s.pvk_parts[1], s.pvk_parts[2], s.pvk_parts[3]);
    let p = groth16::proof_points_from_bytes(proof);
    let i = groth16::public_proof_inputs_from_bytes(inputs);
    assert!(groth16::verify_groth16_proof(&curve, &pvk, &i, &p), 0);
}

public fun prepare_only(s: &Stored) {
    let _pvk = groth16::prepare_verifying_key(&groth16::bn254(), &s.vk);
}

public fun touch(s: &Stored) {
    assert!(s.vk.length() > 0, 1);
}
