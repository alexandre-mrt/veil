/// Bench-only module. Never shipped: scripts/bench/gas-localnet.mjs copies contracts/ to a temp
/// directory, drops this file next to the real sources, and publishes the COPY to a local network.
/// It exists so the cost of Groth16 verification can be isolated from the rest of an entry point
/// (and so a "prepared VK stored on-chain" variant can be priced without changing production code).
module veil::gasbench;

use sui::groth16::{Self, PreparedVerifyingKey};
use veil::verifier;

public struct Holder has key {
    id: UID,
    pvk: PreparedVerifyingKey,
}

/// Prepare the VK once and keep it in a shared object (the "optimization note" variant).
public fun make_holder(vk: vector<u8>, ctx: &mut TxContext) {
    let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
    transfer::share_object(Holder { id: object::new(ctx), pvk });
}

/// Same argument shapes as the real entry points, does nothing: isolates tx/call-arg overhead.
public fun noop(_vk: vector<u8>, _proof: vector<u8>, _inputs: vector<u8>) {}

/// prepare_verifying_key only (the per-call overhead the verifier.move note claims is ~82K gas).
public fun prepare_only(vk: vector<u8>) {
    let _pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk);
}

/// Exactly what pool.move / compliance.move do today: prepare + decode + verify, every call.
public fun verify_unprepared(vk: vector<u8>, proof: vector<u8>, inputs: vector<u8>) {
    assert!(verifier::verify_transfer_proof(&vk, proof, inputs), 1);
}

/// Verify against a VK that was prepared once and stored.
public fun verify_prepared(h: &Holder, proof: vector<u8>, inputs: vector<u8>) {
    let p = groth16::proof_points_from_bytes(proof);
    let i = groth16::public_proof_inputs_from_bytes(inputs);
    assert!(groth16::verify_groth16_proof(&groth16::bn254(), &h.pvk, &i, &p), 1);
}
