#[test_only]
module veil::test_helpers;

public fun valid_commitment(seed: u8): vector<u8> {
    let mut commitment = vector[];
    let mut i: u8 = 0;
    while (i < 32) {
        commitment.push_back(seed + i);
        i = i + 1;
    };
    commitment
}

public fun make_n_zero_bytes(n: u64): vector<u8> {
    let mut result = vector[];
    let mut i: u64 = 0;
    while (i < n) {
        result.push_back(0u8);
        i = i + 1;
    };
    result
}

public fun make_224_zero_bytes(): vector<u8> {
    make_n_zero_bytes(224)
}

public fun make_inputs_with_threshold(threshold: u64): vector<u8> {
    let mut inputs = make_224_zero_bytes();
    let mut i: u8 = 0;
    while (i < 8) {
        let byte_val = ((threshold >> ((i as u8) * 8)) & 0xFF as u8);
        *&mut inputs[64 + (i as u64)] = byte_val;
        i = i + 1;
    };
    inputs
}

/// Minimal dummy VK (232 zero bytes) — shared across test files to avoid duplication.
public fun dummy_vk(): vector<u8> {
    make_n_zero_bytes(232)
}

/// Shared 32-byte dummy Merkle root for tests.
public fun dummy_root(): vector<u8> {
    vector[1u8,2u8,3u8,4u8,5u8,6u8,7u8,8u8,9u8,10u8,11u8,12u8,13u8,14u8,15u8,16u8,17u8,18u8,19u8,20u8,21u8,22u8,23u8,24u8,25u8,26u8,27u8,28u8,29u8,30u8,31u8,32u8]
}

/// Shared 33-byte dummy auditor public key for tests.
public fun dummy_auditor_key(): vector<u8> {
    vector[0xABu8,0xCDu8,0xEFu8,0x01u8,0x02u8,0x03u8,0x04u8,0x05u8,0x06u8,0x07u8,0x08u8,0x09u8,0x0Au8,0x0Bu8,0x0Cu8,0x0Du8,0x0Eu8,0x0Fu8,0x10u8,0x11u8,0x12u8,0x13u8,0x14u8,0x15u8,0x16u8,0x17u8,0x18u8,0x19u8,0x1Au8,0x1Bu8,0x1Cu8,0x1Du8,0x1Eu8]
}
