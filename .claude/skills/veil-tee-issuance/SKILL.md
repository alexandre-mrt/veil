---
name: veil-tee-issuance
description: >
  RESEARCH TRACK — no TEE code exists in Veil today. Enclave-based KYC credential issuance on Sui
  (Nautilus on AWS Nitro Enclaves) as a master-thesis direction: a stateless enclave verifies
  identity documents, signs a blinded credential commitment, and forgets everything, while the user
  proves credential possession in zero knowledge. Use for enclave attestation and PCR verification,
  the Enclave<T> / verify_signature Move pattern, BCS field-order parity between Rust and Move,
  stateless no-retention design, the TEE threat and degradation model, the centralized-signer
  fallback, and bridging a TEE-issued credential into the Groth16 credential circuit. Veil's
  credentials are admin-issued off-chain today — see /veil-protocol for the shipped credential tree
  and revocation, and /veil-zk for the compliance circuit a TEE credential would have to satisfy.
last_updated: 2026-07-14
---

# Veil × TEE credential issuance — research track

> **Status: research, not production.** There is **no TEE, enclave, Nautilus or attestation code in
> this repository.** Today, KYC credentials are issued off-chain by the admin:
> `scripts/src/seed-credential-tree.ts` builds the credential Merkle tree and the admin publishes the
> root through `compliance::update_credential_root` under a 1-epoch timelock. That is a trusted-issuer
> model, and it is the honest description of `main`. Everything below is a design for replacing that
> trusted issuer with an attestable one — the master-thesis direction (ZKP + TEE anonymous
> credentials). An autonomous agent must not read this skill as documentation of shipped code.

## The problem this track attacks

Veil's compliance tier is cryptographically sound *given* a credential tree — the circuit proves
membership, expiry and KYC level without revealing identity (`/veil-zk`). But the tree itself is
whatever the admin says it is. The admin sees every applicant's identity documents, and nothing stops
them inserting a leaf for a person who was never verified. The ZK layer is trustless; the issuance
layer is not.

A TEE closes exactly that gap and nothing more: it makes the issuer *attestable* (you can verify
which binary is running) and *stateless* (it structurally cannot retain the documents it saw). It
does not make the system trustless — it moves the trust from "the admin is honest" to "AWS Nitro and
a reproducible build are honest", which is a smaller and much more auditable claim.

## Concrete experiments worth running

**E1 — Blind issuance parity.** Get an enclave to sign a credential leaf whose preimage it never
learns: the user sends only `commitment = Poseidon(secret, address, salt)`, the enclave signs
`Poseidon(commitment, kycLevel, expiry, nullifierBase)`, and the on-chain contract accepts the leaf
only under a valid `Enclave<T>` signature. **Metric:** the leaf produced by the enclave must be
byte-identical to what `seed-credential-tree.ts` produces today, and the resulting proof must satisfy
the *unmodified* `compliance.circom`. If the circuit has to change, the experiment failed — that is
the whole test.

**E2 — Sybil-resistant issuance via a deterministic nullifier base.** `nullifierBase =
Poseidon(hash(canonical_identity_doc))`: the same passport always yields the same base, so
double-registration is detectable on-chain *without* the chain ever learning the document.
**Metric:** does this actually close the Sybil hole `/veil-protocol` currently admits (one human,
N wallets, N × threshold of anonymous spending)? Test the bypass explicitly: same person, different
document type (passport vs national ID) — if the canonical hash differs, it does not close.

**E3 — Attestation cost and liveness on Sui.** Register a real enclave (real PCRs, not zeros), rotate
it, and measure. **Metric:** gas for `register_enclave` + `verify_signature` per credential; and the
recovery path — an enclave restart mints a fresh ephemeral keypair, so credential issuance is *down*
until re-registration. Multiple `Enclave<T>` objects against one `EnclaveConfig` is the redundancy
answer; prove it works before claiming the design is deployable.

## Architecture

```
User                          Enclave (Nitro)                    Sui
 |  commitment = Poseidon(       |                                |
 |    secret, address, salt)     |                                |
 |  ---- commitment + KYC docs ->|                                |
 |                               | verify docs (KYC provider API) |
 |                               | kycLevel, expiry               |
 |                               | nullifierBase = P(doc_hash)    |
 |                               | leaf = P(commitment, level,    |
 |                               |          expiry, nullifierBase) |
 |                               | sign(bcs(IntentMessage{leaf}))  |
 |                               | -- drop all KYC data --         |
 |  <---- signed credential -----|                                |
 |                                                                |
 |  --------- add_credential(leaf, sig) ------------------------->|
 |                                       verify_signature(Enclave)|
 |                                       insert leaf, emit index  |
```

The enclave never learns `secret` — it signs a commitment it cannot open. So even a fully compromised
enclave cannot impersonate a user or link a credential to its holder. It can only *forge new*
credentials, which is a different and more detectable failure.

Privacy split: the enclave sees the documents (ephemerally) and never the secret; the chain sees only
a leaf hash and a Merkle root; the verifier learns only what the circuit exposes.

## What Nitro actually guarantees

| Property | Guarantee | Caveat you must design around |
|---|---|---|
| Code integrity | PCR0/1/2 pin the exact binary | Only meaningful if the build is reproducible |
| No persistence | No disk, no filesystem | tmpfs still exists — a careless `fs::write` breaks it |
| Ephemeral key | Fresh Ed25519 per boot, non-exportable | Restart ⇒ key lost ⇒ must re-register |
| Memory isolation | Hypervisor-enforced | Shared L3 cache: timing side-channels exist in the literature |
| Network | vsock to parent only | The parent proxies HTTP — terminate TLS *inside* the enclave |
| Attestation | AWS root CA | AWS is the root of trust. This is the trust model, not a bug. |

**Degradation, which is the interesting property:** if the enclave is fully compromised, the attacker
can issue credentials for unverified identities (integrity is gone) but learns **nothing** about
existing holders and cannot break their ZK proofs (privacy holds). Detection is PCR mismatch;
recovery is update PCRs → register new enclave → destroy the old `Enclave<T>` object. Design for this
asymmetry: it is what makes TEE+ZK stronger than TEE alone.

## Move side

The on-chain contract holds a Merkle accumulator of credential leaves and gates insertion on an
enclave signature:

```move
public fun add_credential<T>(
    tree: &mut CredentialTree,
    enclave: &Enclave<T>,
    leaf: vector<u8>, kyc_level: u8, expires_at: u64, nullifier_base: vector<u8>,
    timestamp_ms: u64, signature: vector<u8>, clock: &Clock,
) {
    let payload = CredentialData { leaf, kyc_level, expires_at, nullifier_base };
    assert!(enclave.verify_signature(ISSUE_INTENT, timestamp_ms, payload, &signature), EInvalidSignature);
    assert!(expires_at > clock.timestamp_ms(), ECredentialExpired);
    // insert leaf, update root, emit CredentialAdded { leaf_index, new_root }
}
```

Leaves are **not** stored on-chain — only the root and the incremental `filled_subtrees`. Users keep
their own leaf index and Merkle path. That matches how Veil's commitment tree already works
(`/veil-protocol`).

**BCS field order is load-bearing.** The Rust `CredentialData` and the Move `CredentialData` must
match field-by-field, type-by-type: both serialize in declaration order. Add a field to one and not
the other, or reorder, and signature verification fails silently — or worse, passes for the wrong
data. Keep a paired serde test on both sides asserting the *same* hex. This is not a style rule; it
is the integrity boundary.

## Rules that would be non-negotiable if this shipped

1. **Never persist user data in the enclave.** No `fs::write`, no logging of documents, no session
   state, no database. The enclave is a pure function: request in, signed credential out, memory
   dropped. Audit `allowed_endpoints.yaml` — it should list the KYC provider and the sanctions API,
   and nothing that can store.
2. **The commitment must be blinding, and the enclave must never see the secret.** The user computes
   `Poseidon(secret, address, salt)` locally. If the enclave ever receives `secret`, a compromised
   enclave deanonymizes every credential it ever issued.
3. **Zero PCRs are a dev-only backdoor.** `make run-debug` yields PCR0/1/2 all zeros, and a config
   with zero PCRs accepts *any* enclave, including a malicious one. Real PCRs before anything real.
   The same applies to the `register_dev_enclave` shortcut below — it must not exist in a deployed
   package.
4. **`nullifierBase` never appears on-chain.** It is derived from the identity document. Only the
   circuit-derived `nullifier = Poseidon(nullifierBase, secret)` is public. Publishing the base
   itself would let anyone with the document link it to the credential.
5. **Expiry is checked in the circuit *and* on-chain, against the real clock.** The circuit compares
   `expiry >= currentEpoch`, but `currentEpoch` is a public input the prover supplies — the contract
   must confirm it matches the actual chain clock, or a stale proof passes. Veil already enforces this
   pattern for epochs (`E_EPOCH_MISMATCH`).
6. **Groth16 malleability still applies.** The nullifier, not the proof bytes, is the uniqueness
   anchor. Same rule as everywhere else in this project.

## Fallback: centralized signer

The on-chain contract does not care *how* the signing key was registered — `verify_signature` is a
plain Ed25519 check. So the whole flow can be prototyped with a trusted server holding an Ed25519
keypair and registering its public key directly, no attestation. That is a legitimate staging step
(it validates the BCS parity, the Merkle insertion and the circuit end-to-end without touching AWS),
and it is exactly as trustworthy as today's admin-issued tree — i.e. not at all. Ship the attestation
before calling it done, and delete the dev-registration function.

## Build sketch

```bash
cd nautilus/ && make ENCLAVE_APP=credential-issuer
cat out/nitro.pcrs                      # record PCR0/1/2 — this is the identity of the binary
sui client publish                      # credential_tree package
sui client call --function update_pcrs ...
make run && sh expose_enclave.sh && sh register_enclave.sh ...
```

Versions to pin: Nautilus (`MystenLabs/nautilus`, main, **not audited**, Apache 2.0), Sui framework
with `sui::nitro_attestation`, `sui::poseidon` (BN254, max 16 inputs), `sui::groth16` (max 8 public
inputs). References worth reading before starting: the Nautilus `Design.md`, and Trail of Bits'
"Notes on AWS Nitro Enclaves attack surface" (2024) for what the isolation does *not* cover.
