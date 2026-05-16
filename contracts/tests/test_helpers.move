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
