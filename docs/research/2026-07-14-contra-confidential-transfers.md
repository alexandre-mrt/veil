# Sui native confidential transfers (`contra`) as a Veil transfer backend

Date: 2026-07-14 · Branch: `research/2026-07-14-contra-confidential-transfers` · **Verdict: PARK**

## Hypothesis

Mysten's newly-shipped confidential transfers (`contra`: Twisted ElGamal + Bulletproofs, devnet
public beta) can hide payment amounts on Sui at a fraction of Veil's Groth16 cost — and could
replace or complement Veil's shielded-pool transfer path. Target metric: **client-side proving
latency** and **on-chain gas per confidential payment**.

## What was built

`experiments/contra/` — a real, executing PoC on **Sui devnet**, shaped as one of Veil's stated
use cases (confidential payroll, `docs/FUTURE_IMPROVEMENTS.md` use case #3):

| actor | action |
|---|---|
| issuer | publishes VEIL (regulated coin), registers it as a confidential token, sets 1 auditor key |
| employer | wraps 12 000 VEIL, pays 3 employees in **one batched confidential transfer** |
| employees | merge pending deposits; one unwraps back to a public coin |
| auditor | recovers each account's viewing key, decrypts all 3 salaries |
| observer | keyless third party: decodes the `TransferEvent`s |

Run it: `cd experiments/contra && ./setup.sh && ./run.sh`.

## Results — measured on devnet, real transactions

Contra package published at `0x1990b0b6f553d3f9f459b7b4ae9c79f1d374055d739a26f68c3578fe0346f6cb`.

| step | latency | gas (MIST) |
|---|---|---|
| wrap 12 000 VEIL (public→confidential) | 1 165 ms | 1 156 104 |
| merge pending → active | 1 258 ms | 1 141 968 |
| **build batched transfer, 3 recipients (client-side proving)** | **352 ms** | — |
| **execute batched payroll on chain (3 hidden amounts, 1 tx)** | **1 252 ms** | **1 828 232** |
| unwrap 5 000 VEIL (confidential→public) | 946 ms | 2 632 516 |

Total for the whole scenario: **30 287 644 MIST** (~0.030 SUI), dominated by one-time account setup
(21 087 408 MIST for funding + creating 4 accounts in a single PTB).

Headline: **352 ms to prove a 3-recipient confidential payment, 1.83 M MIST to settle it.**

Correctness verified, not asserted: all three employee balances decrypted to exactly the intended
salaries (5 000 / 4 200 / 2 800 VEIL), the auditor independently recovered each viewing key and
decrypted the same amounts, and the sender re-derived its own outgoing amounts from the event
commitments with no stored per-transfer secret.

**Not measured:** per-transaction gas for the two steps executed in parallel batches (`register`,
the 3 employee merges) — the harness measures those as a group. Anyone quoting a per-register gas
number from this run would be making it up.

## Threat / privacy model

### What contra defends against
A **keyless chain observer**. Verified in Phase 4 of the PoC: the three `TransferEvent`s carry
`sender`, `receiver`, `batch_index` and ciphertext commitments — and **no plaintext amount field**.
An observer learns who paid whom, when, and how many recipients; the amounts are hidden behind
Twisted ElGamal commitments with Bulletproof range proofs.

### What it does NOT defend against — the residual surface
This is the part that matters for Veil, and it is large:

1. **Sender and receiver are always public.** contra hides *amounts only*. Veil hides *the sender*
   (via the shielded pool + sponsored-tx relayer) and unlinks sender from recipient entirely. These
   are different privacy properties, not competing implementations of the same one.
2. **`wrap` and `unwrap` reveal the amount and the counterparty.** Privacy exists only *inside* the
   confidential domain. Every entry and exit is a public, amount-revealing event — a correlation
   handle Veil's standard denominations (100/500/1000) were specifically designed to blunt.
3. **The auditor sees everything, per-account and forever.** contra's auditing is *key-escrow by
   design*: at `register`, the user encrypts their viewing key to the auditor set, so the auditor
   can decrypt **every past and future amount** for that account. Veil's model is the opposite —
   selective, per-transaction disclosure via a ZK compliance proof, where the auditor learns only
   what the proof reveals. Adopting contra wholesale would be a **strict privacy regression** on
   Veil's core compliance claim.
4. **No anonymity set.** Veil's Merkle accumulator gives an anonymity set the size of all
   commitments ever inserted. contra has none: each account is a distinct, named on-chain identity.

### Assumptions
- Discrete log in Ristretto255; Bulletproofs soundness (Bünz et al. 2018); Fiat-Shamir in the ROM
  (Blake2b256 for the sigma NIZKs, Merlin/STROBE for the Bulletproof transcript).
- **No trusted setup** — a genuine advantage over Veil's Groth16 circuits, which carry a
  per-circuit trusted setup and a VK-timelock governance burden.
- Amounts are u64 encoded as four u16 limbs; balances stay decryptable only while the fold count
  stays under the `0xFFFF` bound (`EBalancesFull` → merge to reset).

### Map to `docs/threat-model.md`
Covers the *amount-confidentiality* STRIDE entries. Covers **none** of the sender-unlinkability or
anonymity-set entries. Introduces a **new** exposure absent from Veil's current model:
**permanent auditor key escrow per account**.

## Verdict & rationale — PARK

Contra is **not a replacement** for Veil's transfer path, and swapping Veil onto it would trade away
sender privacy, the anonymity set, and selective disclosure — Veil's three actual contributions — to
buy amount-hiding that Veil already has.

It is parked, not rejected, because two things it does are genuinely better than Veil's:
- **No trusted setup** (vs Veil's per-circuit Groth16 ceremony + VK timelock machinery).
- **Cheap batched payments**: 3 recipients, one proof, one tx, 352 ms.

The interesting design is therefore a **hybrid**, not a migration — see the queue entry
`contra-hybrid-settlement`: keep Veil's shielded pool for sender-anonymous transfers, and use a
contra-style Ristretto/Bulletproofs balance for the *post-withdrawal* leg, where the recipient is
already public but the amount should not be. That path buys amount privacy on exit without a
trusted setup, and without touching the anonymity set.

## Where this could be used (beyond Veil)

- **Confidential B2B settlement on Sui** where counterparties are known and contractual (invoice
  netting, supplier payments, market-maker rebalancing): sender/receiver being public costs nothing,
  amounts are the sensitive part, and the per-account auditor is a *feature* for the finance team.
- **Payroll** (what the PoC models): employer and employee are already known to each other and to
  the regulator; the salary is what must not be public. Auditor key escrow maps cleanly onto a
  statutory audit right.
- **Thesis**: a direct, measured contrast between *escrowed-viewing-key auditing* (contra) and
  *proof-based selective disclosure* (Veil). That is the crisp comparison the compliance chapter
  needs — and it now rests on numbers from a real chain rather than on a reading of the spec.

## Engineering findings worth keeping

Four undocumented traps, each of which cost a failed run — all encoded in `experiments/contra/setup.sh`:

1. **The Sui CLI version is load-bearing.** contra HEAD calls
   `sui::rangeproofs::verify_bulletproofs_with_dst_ristretto255`. That native does not exist in
   Homebrew's `sui` 1.72 **nor in `devnet-v1.73.0`** — both fail with `unbound module member`.
   `devnet-v1.75.0` builds it. (Live devnet reports 1.76.0.)
2. **The documented devnet package id is dead.** `0xe0f1b22e…` (in Mysten's blog/docs) no longer
   exists — devnet was re-genesised (chain id `80d3582e` → `3b6f3fa4`). You must publish contra
   yourself, and contra's own `Move.toml` still pins the pre-wipe chain id.
3. **Bulletproofs WASM does not cross-compile with Apple clang.** The C deps (`clear_on_drop`,
   `blst`) need a wasm32 backend: point cc-rs at Homebrew LLVM. (A June note in memory claimed this
   was impossible and prescribed a native-CLI shim — that is now obsolete: it builds.)
4. **`contra-utils`' `patchMoveToml` reads the chain id from the *active* Sui CLI env**, and decides
   whether to inject the environments block via a plain substring check on the file — so an
   unrelated mention of that section name in a *comment* silently suppresses the injection. Run with
   an isolated `SUI_CONFIG_DIR` pinned to devnet (never `~/.sui`, which holds real keys).

## Open questions → next experiments

- `contra-hybrid-settlement` — Veil shielded pool (sender-anonymous) + contra-style Ristretto
  balance on the withdrawal leg. Does it hold amount privacy on exit *without* a trusted setup?
- `bulletproofs-vs-groth16` — head-to-head on the same machine: proving time, verify gas, proof
  size. Requires Veil's own `BASELINE.md` numbers first.
- `auditor-model-comparison` — formalise escrowed-viewing-key vs proof-based selective disclosure.
  What exactly does each auditor learn, and can contra's per-account escrow be narrowed to
  per-transaction with a DDH decryption proof (the SDK already exposes `decryptWithProof`)?
