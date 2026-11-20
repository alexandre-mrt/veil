/// Gas decomposition of sui::groth16 verification, for scripts/bench/gas.ts.
/// Not part of Veil — a measurement fixture. Each entry point takes the same byte arguments so
/// differences between them isolate one step of the verifier pipeline.
module groth16_gas::bench;

use sui::groth16;

/// Holds a VK prepared once at creation (the optimisation suggested in veil::verifier's header).
public struct Prepared has key {
    id: UID,
    pvk: groth16::PreparedVerifyingKey,
}

/// Baseline: identical arguments, no crypto. Subtract this from the others.
public fun noop(_vk: vector<u8>, _proof: vector<u8>, _inputs: vector<u8>) {}

/// prepare_verifying_key alone.
public fun prepare_only(vk: vector<u8>, _proof: vector<u8>, _inputs: vector<u8>) {
    let _pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
}

/// What veil::verifier does today: prepare + verify on every call.
public fun prepare_and_verify(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>) {
    let curve = groth16::bn254();
    let pvk = groth16::prepare_verifying_key(&curve, &vk);
    let p = groth16::proof_points_from_bytes(proof);
    let i = groth16::public_proof_inputs_from_bytes(inputs);
    assert!(groth16::verify_groth16_proof(&curve, &pvk, &i, &p), 0);
}

/// One-time: store the prepared key in a shared object.
public fun store_prepared(vk: vector<u8>, ctx: &mut TxContext) {
    let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
    transfer::share_object(Prepared { id: object::new(ctx), pvk });
}

/// Verify against the stored prepared key (vk argument ignored; kept for equal arg size).
public fun verify_prepared(p_obj: &Prepared, _vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>) {
    let p = groth16::proof_points_from_bytes(proof);
    let i = groth16::public_proof_inputs_from_bytes(inputs);
    assert!(groth16::verify_groth16_proof(&groth16::bn254(), &p_obj.pvk, &i, &p), 0);
}

/// Noop with the shared object as input — baseline for verify_prepared (shared-object read cost).
public fun noop_shared(_p_obj: &Prepared, _vk: vector<u8>, _proof: vector<u8>, _inputs: vector<u8>) {}

/// Sweep helpers: repeat a step `n` times in one transaction. Sui charges computation in
/// buckets, so a single verify can hide inside the minimum bucket; the bucket boundary crossed
/// as `n` grows bounds the per-call cost from above and below.
public fun noop_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let mut k = 0;
    while (k < n) { noop(vk, proof, inputs); k = k + 1; };
}

public fun prepare_and_verify_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let mut k = 0;
    while (k < n) { prepare_and_verify(vk, proof, inputs); k = k + 1; };
}

public fun verify_prepared_n(p_obj: &Prepared, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let mut k = 0;
    while (k < n) { verify_prepared(p_obj, vector[], proof, inputs); k = k + 1; };
}

public fun prepare_only_n(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>, n: u64) {
    let mut k = 0;
    while (k < n) { prepare_only(vk, proof, inputs); k = k + 1; };
}
