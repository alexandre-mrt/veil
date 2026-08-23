pragma circom 2.2.2;

// Shape C: 1 domain tag + 3 message elements — matches transfer.circom's oldHash/newHash/nfHash
// and withdraw.circom's commHash/changeHash/nfHash (all Poseidon(4)). This is Veil's single most
// common hash shape: 3 instances in transfer.circom, 3 in withdraw.circom.
include "../../../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

template ShapeCPoseidon() {
    signal input msg0;
    signal input msg1;
    signal input msg2;
    signal output out;

    component h = Poseidon(4);
    h.inputs[0] <== 7;
    h.inputs[1] <== msg0;
    h.inputs[2] <== msg1;
    h.inputs[3] <== msg2;
    out <== h.out;
}

component main = ShapeCPoseidon();
