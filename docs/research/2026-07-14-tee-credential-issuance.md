# TEE credential issuance — replacing Veil's trusted admin issuer with an attestable enclave

Date: 2026-07-14 · Branch: `research/2026-07-14-arkworks-tee` · **Verdict: PARK** (attestation path unprovable without AWS)

## Hypothesis

A Nautilus-style AWS Nitro enclave can issue Veil's KYC credential leaf and sign it, so the issuer
becomes **attestable** (you can verify which code ran) and **stateless** (it structurally cannot
retain the applicant's documents) — removing the admin from Veil's trust base without changing the ZK
compliance layer. Target: prove the cross-language signature/BCS path end to end; be honest about what
cannot be proven off Nitro hardware.

## The gap this attacks

Today Veil's KYC credentials are issued off-chain by the admin: `scripts/src/seed-credential-tree.ts`
builds the credential Merkle tree and the admin publishes the root via
`compliance::update_credential_root` under a 1-epoch timelock. The ZK layer is trustless — the
compliance circuit proves membership, KYC level and expiry without revealing identity — **but the
tree is whatever the admin says it is.** The admin sees every applicant's documents and can insert a
leaf for a person who was never verified. The cryptography is sound; the *issuance* is a trusted
third party.

A TEE closes exactly that gap and nothing more: trust moves from "the admin is honest" to "AWS Nitro
+ a reproducible enclave build are honest" — a smaller, auditable claim (you check the PCRs against a
build you can reproduce).

## Threat / privacy model

- **What it defends against:** a **curious or dishonest credential issuer** — the weakest link in
  Veil's compliance story today, and fully trusted. With an attested enclave, the issuer can only run
  the pinned code (PCR0/1/2), and the stateless design means it retains nothing about the applicant
  after responding.
- **What it does NOT defend against — the residual surface, stated bluntly:**
  - **The attestation root itself.** You are trusting AWS Nitro's hardware, the NSM, and the cert
    chain. This is a hardware-and-vendor trust assumption, not cryptography.
  - **Anything upstream of the enclave.** If the KYC documents fed in are forged, the enclave
    faithfully issues a credential for a forgery. TEE attests *the code that ran*, not *the truth of
    the input*.
  - **Confidentiality is isolation, not encryption.** The applicant's documents are protected by
    Nitro's memory isolation while in the enclave, not by a cryptographic guarantee.
  - **Stale config after PCR rotation:** after `update_pcrs`, previously-registered `Enclave<VEIL_TEE>`
    objects keep a stale `config_version` and stay valid until `destroy_old_enclave` is called —
    upstream Nautilus behavior, now documented rather than silently implied away.
- **Assumptions:** AWS Nitro integrity; a reproducible enclave build so PCRs are meaningful; the
  on-chain `sui::nitro_attestation` cert-chain verification (framework `0x2`).
- **STRIDE map:** targets `Spoofing` of the credential issuer — the one Veil's current model does not
  cover. Introduces a new hardware trust root (documented).

## What was built, and what a security review caught

`experiments/tee/`: a Rust enclave service (`enclave-service/`) and a Move package (`move/veil_tee/`)
that depends on a vendored copy of Nautilus's reusable `enclave` package.

The enclave generates an ephemeral Ed25519 keypair, accepts a KYC claim, derives the credential leaf,
and returns it wrapped in a signed `IntentMessage`. On-chain, `veil_tee::record_issuance` reconstructs
that message, BCS-encodes it, and verifies the signature against the attested pubkey via
`enclave::verify_signature`.

**The build/destruct/review pattern earned its keep here.** The build passed all tests — but the
**reviewer** (reading the diff, not executing) caught what execution could not:

> `record_issuance<T>` was **generic**, unbound to `EnclaveConfig<VEIL_TEE>`. A `register_enclave` is
> permissionless, so an attacker could self-register `Enclave<ATTACKER>`, pass it to the generic
> `record_issuance`, and forge a valid `CredentialIssuedEvent` — directly contradicting the "can no
> longer forge" claim.

This is a Sui Move authorization-bypass class: a generic `<T>` on a function consuming a
permissionlessly-creatable attested object. The fix bound the parameter to the concrete
`Enclave<VEIL_TEE>` type, which is only creatable through the single `EnclaveConfig<VEIL_TEE>` minted
in `init` behind the one-time-witness cap — so **the type parameter itself is the authorization**. It
was proven the right way, with a **compile-fail probe**: passing `Enclave<ATTACKER>` is rejected by
the compiler (`Invalid argument for parameter 'enclave'`), which a runtime test cannot demonstrate.

## Results — measured (my own re-run, sui 1.75.0)

```
experiments/tee/enclave-service $ cargo test --release
test result: ok. 10 passed; 0 failed

experiments/tee/move/veil_tee $ /tmp/sui-devnet-175/sui move test
[ PASS ] test_bcs_parity_with_rust
[ PASS ] test_record_issuance_with_rust_signature
[ PASS ] test_stale_signature_rejected
[ PASS ] test_tampered_kyc_level_rejected
[ PASS ] test_tampered_leaf_rejected
[ PASS ] test_wrong_leaf_length_rejected
Test result: OK. Total tests: 6; passed: 6; failed: 0
```

**Proven by execution:**
- **Cross-language BCS parity + signature.** A signature produced by the Rust enclave over an
  `IntentMessage` verifies inside Move through the upstream `enclave::verify_signature`. Both verifiers
  confirmed it is non-vacuous: tampering the payload or the signature makes verification fail. This is
  the whole point of the spike — Rust and Move must serialize the message to identical bytes or the
  signature is worthless.
- **The credential leaf matches Veil's real one.** `Poseidon(4, userSecret, kycLevel, expiryEpoch,
  issuerId)` (domain tag 4), confirmed byte-identical to `frontend/src/lib/demoCredential.json` via an
  independent circomlibjs run and reproduced by Rust `light-poseidon`. A leaf Veil's compliance
  circuit would actually accept — not a decorative hash.
- **Statelessness** is structural (no logging of the claim, no persistence keyed by applicant),
  verified by grep.
- **Live E2E:** the server booted with a fresh ephemeral key, `POST /issue_credential` returned a
  signed message whose leaf reversed to the exact demo leaf, and `/get_attestation` honestly returns
  501 off-Nitro.

**NOT proven (no AWS — the trust-critical part, stated plainly in the README):** a genuine Nitro
attestation document, real PCR values, and `sui::nitro_attestation`'s cert-chain verification. What
is proven is everything *downstream* of the attested pubkey; the binding of that pubkey to real
attested code is **UNPROVEN** without an EC2 Nitro instance. The reviewer's honesty audit confirmed
nothing in the code or docs overclaims this.

## Verdict — PARK

Everything that can be built and tested off Nitro hardware works and is honestly scoped: the leaf
matches Veil's, the cross-language signature path is proven, statelessness is structural, and the
forgery bug the review caught is fixed at the type level. It is parked, not kept, because the
**trust-critical half — the attestation root — is unprovable in this environment.** Unblocking it
needs one thing: an EC2 Nitro instance to produce a real attestation document and real PCRs, then
verify `register_enclave` against them on-chain.

The code is structured so a real enclave drops in without redesign.

## Where this could be used

- **Veil's compliance tier:** replace the trusted admin issuer with an attested one, so "this
  credential exists" implies "a reproducible KYC enclave verified it", not "the admin says so".
  Directly strengthens the protocol's central compliance claim.
- **Any Sui protocol with an off-chain issuer or oracle** that wants attestable, stateless issuance:
  the Rust↔Move `IntentMessage` BCS-parity harness here is the reusable, tested core.
- **Thesis, the ZKP + TEE direction:** a concrete, measured pairing of an attested stateless issuer
  with a ZK credential circuit — and, as a bonus, a documented example of the generic-`<T>`
  authorization-bypass class and its type-level fix.

## Open questions → queue

- Run it on a real EC2 Nitro instance: produce the attestation document, pin the real PCRs, and prove
  `register_enclave` accepts the enclave on-chain. This is the single blocker to a KEEP.
- Reproducible enclave build (the `Containerfile` path) so the PCRs mean something to a third party.
- Revocation: does an enclave-attested revocation list beat accumulator-based revocation (RSA/KZG) on
  cost? (queue #10.)
