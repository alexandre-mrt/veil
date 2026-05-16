# Auditor Guide

This guide covers the compliance auditor workflow for Veil privacy pools. Auditors can decrypt encrypted transaction amounts from `ComplianceVerifiedEvent` events using their P-256 private key.

## Overview

When compliance mode is enabled on a Veil pool, each transfer includes a `ComplianceVerifiedEvent` with:
- `credential_nullifier` -- unique per-transfer credential nullifier (prevents replay)
- `encrypted_amount` -- the transaction amount encrypted for the auditor's public key

Only the designated auditor (whose public key is registered in `ComplianceConfig`) can decrypt these amounts.

## Setup

### 1. Generate P-256 Keypair

The auditor needs an ECDH P-256 keypair. Generate one using OpenSSL:

```bash
# Generate P-256 private key (PEM)
openssl ecparam -genkey -name prime256v1 -noout -out auditor-key.pem

# Extract raw 32-byte private key (hex)
openssl ec -in auditor-key.pem -text -noout 2>/dev/null | \
  grep -A 3 "priv:" | tail -3 | tr -d ' :\n'

# Extract raw 65-byte public key (uncompressed, hex)
openssl ec -in auditor-key.pem -text -noout 2>/dev/null | \
  grep -A 5 "pub:" | tail -5 | tr -d ' :\n'
```

Alternatively, generate in Node.js/Bun:

```typescript
const keypair = await crypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" },
  true,
  ["deriveBits"],
);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", keypair.privateKey);
console.log("Public key (65 bytes hex):", Buffer.from(pubRaw).toString("hex"));
console.log("Private key (d, base64url):", jwk.d);
```

### 2. Register Auditor Public Key

The pool admin registers the auditor's public key in `ComplianceConfig`:

```bash
# Admin calls set_auditor_key (requires AdminCap, 1-epoch timelock)
sui client call \
  --package <package-id> \
  --module compliance \
  --function propose_auditor_key_update \
  --args <compliance-config-id> <admin-cap-id> <pool-id> <auditor-pub-key-hex>
```

The key update takes effect after 1 epoch (timelock for user exit window).

### 3. Store Private Key Securely

The auditor's private key must be stored securely:
- Use hardware security module (HSM) or secure enclave in production
- Never share the private key or commit it to version control
- The CLI tool accepts the key as a command-line argument (suitable for scripting with secrets managers)

## Decryption Workflow

### Decrypt All Events

```bash
cd scripts

# Using pool ID (resolves package ID automatically)
bun run auditor -- decrypt --pool <pool-id> --key <private-key-hex>

# Using explicit package ID
bun run auditor -- decrypt --package <package-id> --key <private-key-hex>

# Specify network
bun run auditor -- decrypt --pool <pool-id> --key <private-key-hex> --network mainnet
```

The tool:
1. Fetches all `ComplianceVerifiedEvent` events from the Sui network
2. Decrypts each `encrypted_amount` field using ECDH P-256 + HKDF-SHA256 + AES-GCM-256
3. Outputs a table with: transaction digest, decrypted amount, salt, and timestamp

### Verify a Single Event

```bash
bun run auditor -- verify --pool <pool-id> --key <private-key-hex> --event-id <tx-digest>
```

This fetches the specific transaction's compliance events and decrypts them individually.

## Encryption Format

The encrypted amount follows this format (defined in `useAuditorEncryption.ts`):

```
Combined bytes: [ephemeralPubKey(65) | iv(12) | ciphertext(128 + 16)]

1. Ephemeral P-256 public key (65 bytes, uncompressed)
2. AES-GCM initialization vector (12 bytes, random)
3. AES-GCM ciphertext (128 bytes padded plaintext + 16 bytes GCM auth tag)
```

Key derivation:
- **ECDH**: ephemeral private key + auditor public key -> 256-bit shared secret
- **HKDF-SHA256**: salt = ephemeral public key (65 bytes), info = `"veil-auditor-v1"` -> AES-GCM-256 key
- **AES-GCM-256**: encrypt JSON payload padded to 128 bytes (prevents amount-range side channel)

Plaintext JSON format:
```json
{ "txAmount": "<raw-amount-string>", "salt": "<random-field-element>" }
```

## Verification

The auditor can verify that the encrypted amount matches the transfer proof's public input:

1. Decrypt the ciphertext to obtain `txAmount` and `salt`
2. Compute `txAmountHash = Poseidon(3, txAmount, salt)` (domain tag 3)
3. Compare with the `txAmountHash` public signal from the transfer proof

If they match, the encrypted amount is truthful -- the user cannot lie about the amount in the compliance ciphertext because the transfer circuit constrains `txAmountHash` to be consistent with the actual transferred amount.

## Reporting

Generate a JSON compliance report with all decrypted amounts, totals, and date range:

```bash
# Default output: report.json
bun run auditor -- report --pool <pool-id> --key <private-key-hex>

# Custom output path
bun run auditor -- report --pool <pool-id> --key <private-key-hex> --output compliance-report.json
```

The report includes:
- Generation timestamp and network
- Package ID and pool ID
- Total event count (successful + failed decryptions)
- Aggregate amount (raw and formatted with TOKEN decimals)
- Date range (earliest to latest event)
- Full event list with decrypted amounts, salts, and nullifiers

## Credential Revocation

Veil supports credential revocation through Merkle root rotation:

1. The issuer removes the revoked credential from the off-chain Merkle tree
2. The admin calls `update_credential_root(new_root)` with the updated tree
3. After 1-epoch timelock, the new root is applied
4. The revoked credential can no longer produce a valid Merkle membership proof

For faster revocation, use short credential expiry epochs (e.g., 7 days).
The credential must be re-issued periodically, providing natural revocation points.

## Security Considerations

- The auditor's private key grants access to all transaction amounts in the pool
- Key rotation requires an admin-initiated timelock proposal (1-epoch delay)
- The fixed-length plaintext padding (128 bytes) prevents ciphertext-length side channels
- GCM authentication ensures ciphertext integrity -- tampering is detected
- Each transfer uses a fresh ephemeral keypair, providing forward secrecy per-transaction
- Context-bound credential nullifiers prevent cross-transfer replay attacks
