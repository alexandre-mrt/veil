---
name: veil-frontend
description: >
  The Veil dApp: Next.js 14 App Router + @mysten/dapp-kit-react v2 + SuiGrpcClient, with snarkjs
  WASM proving in the browser. Use for the proof-generation hooks and their progress UI, the
  encrypted private state (AES-GCM in localStorage, key derived from a wallet signature via
  PBKDF2, cached in IndexedDB), the ECDH-P256 auditor-encryption hook, proof-gated forms
  (deposit / transfer / compliant transfer / withdraw), the admin and auditor panels, sponsored
  transactions through the relayer, and the Next.js gotchas that break proving in production
  (dynamic import of snarkjs, CSP wasm-unsafe-eval, no SSR). For circuit and byte-layout questions
  see /veil-zk; for protocol semantics see /veil-protocol; for deploy and relayer ops see /veil-ops.
last_updated: 2026-07-14
---

# Veil Frontend

`frontend/` — Next.js 14 (App Router, `"use client"` everywhere that matters), React 18,
`@mysten/dapp-kit-react` 2.x + `@mysten/dapp-kit-core`, `@mysten/sui` 2.16 with **`SuiGrpcClient`**,
`snarkjs` 0.7.6, `circomlibjs`, Vitest, Biome. Package manager: **bun**.

## Wiring

`src/lib/dapp-kit.ts` builds a single memoized `createDAppKit({...})` instance with a
`SuiGrpcClient` per network, and augments the `Register` interface so the hooks are typed.
`src/app/providers.tsx` wraps it in `<DAppKitProvider dAppKit={dAppKit}>` behind an error boundary.

**gRPC base URL must be `https://fullnode.testnet.sui.io:443`.** `sui-testnet.mystenlabs.com` has
no DNS record and fails at runtime with an opaque network error.

All ids come from env via `requireEnv` in `src/lib/constants.ts` (`NEXT_PUBLIC_PACKAGE_ID`,
`NEXT_PUBLIC_POOL_ID`, `NEXT_PUBLIC_COMPLIANCE_CONFIG_ID`, `NEXT_PUBLIC_TREASURY_CAP_ID`,
`NEXT_PUBLIC_ADMIN_CAP_ID`, threshold, epoch duration). Nothing is hardcoded — `requireEnv` throws
at import time rather than letting the app run against `undefined`.

## Proving in the browser

Proof generation runs **on the main thread**, not in a Web Worker. `useProofGeneration` drives a
`ProofStep` state machine (`loading-circuit → computing-witness → generating-proof →
converting-bytes → done`) with a `progress` number, and `ProofProgress.tsx` renders it. If proving
times become painful, moving `snarkjs.groth16.fullProve` into a worker is the obvious next step —
the step/progress interface already isolates the change.

Artifacts are fetched from `public/circuits/` (`transfer.wasm`, `transfer_final.zkey`). The hook
probes for them first and falls back to a **mock proof** (`isMock: true`, 128 zero bytes, a delay)
when they are absent, so the UI is developable without a compiled circuit. A mock proof must never
reach a real network — it exists for local UI work only.

### snarkjs must be imported dynamically, and only one way

```ts
// src/lib/dynamicRequire.ts
export async function dynamicRequire(moduleName: string): Promise<unknown> {
  switch (moduleName) {
    case "circomlibjs":
      // @ts-expect-error — no type declarations
      return import("circomlibjs");
    case "snarkjs":
      // @ts-expect-error — no type declarations for dynamic import
      return import("snarkjs");
    default:
      throw new Error(`Unknown dynamic module: ${moduleName}`);
  }
}
```

snarkjs and circomlibjs are browser-only (WASM, no types) and must not be evaluated during SSR or
pre-bundling. **`new Function("m", "return import(m)")` breaks in the production bundle** — the
bundler cannot see the import, so the chunk is never emitted and the call fails only after deploy.
A real `import()` inside a switch, with `@ts-expect-error`, is the pattern that survives
`next build`. Do not "clean it up" back into a dynamic specifier.

Proof bytes are produced by `src/lib/proof-converter.ts` — the same snarkjs→arkworks conversion as
`scripts/src/proof-converter.ts`. The byte layout is documented in `/veil-zk`; do not re-derive it.

## Private state

Everything that makes the protocol private lives only on the client: `userSecret`, `cumulative`,
`randomness`, the current commitment, the local transaction list. Lose it and the funds are
unspendable.

`usePrivateState` stores it under `localStorage["veil-state"]`, **encrypted with AES-GCM** (12-byte
IV prepended, base64). The key is not a password:

`useWalletKey` asks the wallet to sign a fixed, deterministic message
(`dAppKit.signPersonalMessage`), runs the signature through PBKDF2-SHA256 (100k iterations) to get
an AES-256-GCM key, and caches the resulting non-extractable `CryptoKey` in IndexedDB for the
session. The encryption key is therefore bound to control of the wallet, and no raw secret is ever
exported.

> The earlier design derived the key from the wallet **address**, which is public — anyone with
> localStorage access could decrypt. The signature-based derivation replaced it. Do not regress to
> address-derived keys.

Rules: never write `userSecret` or randomness to localStorage unencrypted, never `console.log` them
in a build that ships, and **never advance the cumulative state until the transaction is confirmed
on-chain** — a proof that was generated but whose transaction failed must not move the counter, or
the next proof will reference a commitment that does not exist.

## Auditor encryption

`useAuditorEncryption` is the client half of the Tier-3 auditor path, plain Web Crypto: import the
auditor's raw uncompressed P-256 public key (65 bytes) → generate an ephemeral P-256 keypair →
ECDH → HKDF-SHA256 → AES-GCM-256 → encrypt `(txAmount, salt)`.

Payload on the wire: `ephemeral_pubkey (65) || iv (12) || ciphertext || tag (16)` — the contract
rejects anything under 93 bytes (`E_INVALID_ENCRYPTED_AMOUNT`). The ephemeral public key is
exported **before** HKDF consumes the private key. Protocol rationale is in `/veil-protocol`.

## Hooks and components

| Hook | Does |
|---|---|
| `useWalletKey` | Wallet-signature → AES key, cached in IndexedDB |
| `usePrivateState` | Encrypted local state, epoch rollover |
| `useProofGeneration` | Transfer proof, step/progress machine, mock fallback |
| `useComplianceProof` | Compliance-circuit proof |
| `useAuditorEncryption` | ECDH-P256 amount encryption |
| `useShieldedTransfer` / `useCompliantTransfer` | Build + submit the one- and two-proof transfers |
| `useDepositAndRegister` / `useWithdraw` | Deposit (standard denominations only) and ZK withdraw |
| `useVeilPool` / `useEpoch` | Pool state, on-chain epoch |
| `useSponsoredTransaction` | Relayer flow for sender privacy |

Forms are proof-gated: `TransferForm`, `CompliantTransferForm`, `DepositForm`, `WithdrawForm` each
block submission until a proof exists and surface the proof step rather than a generic spinner.
`AdminPanel` (+ `components/admin/`) drives the timelocked admin actions; `AuditorInfo` and
`AuditorEventBrowser` are the auditor-side views; `ComplianceStatus`, `PrivacyStatus` and
`CredentialManager` show tier and credential state.

## Sponsored transactions (sender privacy)

Without sponsorship the user's own Sui address pays gas and appears as the transaction sender —
which throws away the on-chain sender anonymity the circuits buy. `useSponsoredTransaction` routes
through the relayer (`scripts/src/relayer.ts`, default `http://localhost:3001`):

1. frontend builds the `TransactionKind` bytes
2. `POST /sponsor` — relayer wraps them with its own gas payment, returns `txBytes`
3. user signs `txBytes`
4. `POST /submit` — relayer co-signs and submits

The relayer's address is the on-chain sender. There is **no Enoki and no zkLogin** in this codebase;
sponsorship is this custom relayer. See `/veil-ops` for running it.

## Next.js production gotchas

The ones that cost real debugging time:

- **CSP.** `next.config.mjs` needs `script-src 'self' 'unsafe-inline' 'unsafe-eval'
  'wasm-unsafe-eval'` (snarkjs compiles WASM), and `connect-src` must list `https://*.sui.io`,
  `https://*.mystenlabs.com`, `wss://*.mystenlabs.com`, `https://api.slush.app` (wallet SDK) and
  `http://localhost:3001` (relayer). Google Fonts need matching `style-src` / `font-src` entries.
  A missing `wasm-unsafe-eval` fails only in the browser, only in production, with a console error
  that never mentions proving.
- **No SSR for anything touching snarkjs or `crypto.subtle`.** `"use client"`, and dynamic-import
  the module inside the handler, not at module scope.
- **Vercel:** always `vercel --prod --force --yes`. A plain `--prod` can leave the alias pointing at
  the previous build, so you test the old bundle and conclude your fix did nothing.
- Moving a function between Move modules changes its target path — every `moveCall` target in the
  frontend must be updated in the same commit, or the build fails at call time, not at compile time.

Tests: `bun run test` (Vitest, jsdom) — `src/__tests__/` covers `crypto`, `wallet-key`, `constants`.
Lint/format: `bunx biome check --write .`. UI rules live in `frontend/DESIGN.md`; cite it for any
visual change.
