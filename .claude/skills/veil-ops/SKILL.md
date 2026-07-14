---
name: veil-ops
description: >
  Building, testing, deploying and running Veil. Use for the exact build/test commands per package
  (sui move build/test, circuit compile.sh and ceremony.sh, snarkjs artifacts, bun test suites),
  the four test suites and what each one actually covers (Move, circuit, converter, frontend, plus
  E2E and fuzz), the deployment sequence and the current testnet object ids, the sponsored-transaction
  relayer server (/sponsor, /submit, /health, RELAYER_API_KEY, CORS), the auditor CLI
  (decrypt/report/verify with a P-256 key), credential-tree seeding and root publication, and the
  deploy gotchas that bite in production (Vercel --force, gRPC URL, CSP, module splits, UpgradeCap).
  For protocol semantics see /veil-protocol; circuits and proof bytes /veil-zk; dApp code /veil-frontend.
last_updated: 2026-07-14
---

# Veil Ops

Four packages, three package managers' worth of habits. `contracts/` is Sui Move, `circuits/` uses
**npm** (circom/snarkjs tooling expects it), `frontend/` and `scripts/` use **bun**.

`bash scripts/init.sh` installs everything and does a first `sui move build`. It warns rather than
fails if `circom` or the `sui` CLI is missing.

## Build

| What | Command |
|---|---|
| Contracts | `cd contracts && sui move build` |
| Circuits (transfer) | `cd circuits && bash scripts/compile.sh` |
| Circuits (compliance / withdraw) | `bash scripts/compile-compliance.sh` / `compile-withdraw.sh` |
| Production trusted setup | `cd circuits && bash scripts/ceremony.sh` |
| Frontend | `cd frontend && bun run dev` (or `bun run build`) |

`compile.sh` compiles with `circom --r1cs --wasm --sym`, prints the real constraint count via
`snarkjs r1cs info`, downloads `powersOfTau28_hez_final_15.ptau` (~85 MB, cached as
`build/pot15_final.ptau`), runs the Groth16 setup with **one dev contribution**, and exports the VK.
It warns loudly, and it means it: a single-contributor setup means whoever ran it can forge proofs.
`ceremony.sh` is the multi-contributor path and is what production must use.

Artifacts land in `circuits/build/`. The two the frontend needs go to `frontend/public/circuits/`
(`transfer.wasm`, `transfer_final.zkey`); without them the dApp falls back to mock proofs.

## Test

| Suite | Command | Covers |
|---|---|---|
| Move (124) | `cd contracts && sui move test` | pool, compliance, multisig, withdraw, scenarios |
| Circuit (100) | `cd circuits && npm test` | `test/{transfer,compliance,withdraw}.test.mjs` — witness generation, constraint violations must fail |
| Converter (109) | `cd scripts && bun run src/test-converter.ts` | snarkjs→arkworks byte layout (G1/G2 compression, LE, sign bits, VK) |
| Frontend (19) | `cd frontend && bun run test` | Vitest: crypto, wallet-key, constants |
| E2E | `cd scripts && bun run src/e2e-test.ts` | full deposit→prove→transfer against a live network |
| E2E compliance | `cd scripts && bun run src/e2e-compliance-test.ts` | the dual-proof path |
| Fuzz | `cd scripts && bun run fuzz` | fast-check property tests |

Green unit tests are necessary and not sufficient. The failure mode this project keeps hitting is a
proof that verifies in snarkjs and is rejected on-chain — only the E2E scripts catch that, because
only they actually submit a transaction. Run `e2e-test.ts` before claiming a circuit or converter
change works.

Lint/format anywhere JS/TS: `bunx biome check --write .`.

## Deploy

Sequence, in order — each step produces an id the next one needs:

1. `sui move build` and `sui move test` clean.
2. Publish the package. Note the package id, `AdminCap`, `TreasuryCap`, `UpgradeCap`.
3. Compile the circuits, export the transfer VK, convert it to Sui bytes
   (`vkToSuiBytes` in `scripts/src/proof-converter.ts`).
4. `pool::create_pool(transfer_vk, threshold, epoch_duration_ms)` → Pool id.
   (`scripts/create-pool.ts`)
5. Withdraw VK: `propose_withdraw_vk` → wait one epoch → apply.
6. Compliance: `compliance::create_compliance_config(...)` with the credential root, required KYC
   level, auditor P-256 public key and compliance VK (`scripts/deploy-compliance.ts`).
7. Publish the commitment Merkle root via `update_commitment_root` (1-epoch timelock).
8. Sync every id into `frontend/.env` (`NEXT_PUBLIC_*`) and deploy.

Supporting scripts: `scripts/src/deploy.ts`, `scripts/create-pool.ts`,
`scripts/deploy-compliance.ts`, `scripts/src/manage-upgrade-cap.ts` (`bun run manage-upgrade-cap`),
`scripts/src/seed-credential-tree.ts` (rebuilds the demo credential tree and **checks the computed
root against the on-chain bytes** — run it after any credential change).

Remember that almost every parameter is timelocked one epoch (VKs, roots, auditor key, KYC level,
compliance toggle, epoch duration, admin withdrawals). A deploy that changes one of them is
propose-now, apply-next-epoch, not a single transaction. Testnet epoch duration is 1 hour.

### Current testnet deployment

```
Package         0x5cd79f85f1adca022513d76c60d557f8b17afed91f741d14016c7a23cab6c228
Pool            0x6ba8019987c7c5d02d2c2b11e0eddd491428d0cc6bbed05ab79760e069ce913a
ComplianceConfig 0xa6c92b963d9b67896416ae2eb23f0fadbbc62e90fba6ca18db5f96b6bc4f63c7
AdminCap        0x038754ce782a7670884961335a7d7e50215a4793d2c44dde208c2527eeed28d4
TreasuryCap     0xdc0f16084cbd2d33d1fc3630e80bac565469550e93c5e147a7d9c04fa4a3058f
UpgradeCap      0x81637da203607af529fc2652c49d709e48d2246bc6097963ffb358d6b28a018e
Frontend        https://frontend-sepia-nine-30.vercel.app
```

The project `CLAUDE.md` is the source of truth for these; if you redeploy, update it, `frontend/.env`
and this block together.

## Relayer (sender privacy)

`scripts/src/relayer.ts`. Without it, the user's own address is the on-chain transaction sender and
the sender anonymity the circuits buy is thrown away at the transport layer.

```bash
cd scripts
bun run relayer            # serve on :3001
bun run relayer:demo       # scripted demo of the sponsor→sign→submit flow
bun run src/relayer.ts --help
```

Endpoints: `POST /sponsor` (wrap a `TransactionKind` with the relayer's gas payment → `txBytes`),
`POST /submit` (co-sign and execute a user-signed tx), `GET /health`.

Config: `PACKAGE_ID`, `RELAYER_API_KEY` (Bearer auth on `/sponsor` and `/submit`),
`RELAYER_CORS_ORIGIN` (defaults to the deployed Vercel origin). **If `RELAYER_API_KEY` is unset the
relayer runs open, with a warning** — that is a dev-mode convenience, and an open relayer is a free
gas faucet for anyone who finds it. Set it in anything reachable from the internet.

The relayer holds a funded key and pays gas for strangers; treat rate limiting and the allowlist as
security controls, not niceties. API details: `docs/relayer-api.md`.

## Auditor CLI

`scripts/src/auditor-tool.ts` (`bun run auditor`) decrypts the Tier-3 `ComplianceVerifiedEvent`
payloads with the auditor's **P-256 private key** (32-byte hex, no `0x`):

```bash
bun run src/auditor-tool.ts decrypt --pool <pool-id> --key <hex> [--network testnet]
bun run src/auditor-tool.ts report  --pool <pool-id> --key <hex> [--output report.json]
bun run src/auditor-tool.ts verify  --pool <pool-id> --key <hex> --event-id <tx-digest>
```

`decrypt` walks every compliance event for the pool; `report` adds totals and a date range;
`verify` does one event by digest. The key is used in memory only — never logged, never written to
disk. Keep it that way. `--package` skips the pool lookup.

The decrypted `(txAmount, salt)` recomputes `Poseidon(3, txAmount, salt)`, which must equal the
`txAmountHash` public input of the transfer proof. That check is what makes the auditor's view
trustworthy rather than sender-asserted. Background: `docs/auditor-guide.md`.

## Deploy gotchas

The ones that have actually bitten:

- **Vercel:** always `vercel --prod --force --yes`. Plain `--prod` may leave the alias on the
  previous build — you test the old bundle and conclude the fix did nothing.
- **gRPC URL:** `https://fullnode.testnet.sui.io:443`. `sui-testnet.mystenlabs.com` has no DNS
  record.
- **CSP:** snarkjs needs `'wasm-unsafe-eval'` in `script-src`, and `connect-src` must cover
  `*.sui.io`, `*.mystenlabs.com`, `api.slush.app` and the relayer origin. Fails only in production,
  only in the browser. See `/veil-frontend`.
- **Dynamic imports:** `new Function("m", "return import(m)")` does not survive the Next.js
  production bundle. Real `import()` in a switch. See `/veil-frontend`.
- **`TreasuryCap` is owned by the deployer** after publish. The faucet (`token_faucet::faucet`)
  needs it, so transfer it to the user or the multisig if the faucet should be callable by anyone
  other than you.
- **Module splits:** moving a function between Move modules changes its target path. Every
  `moveCall` target in the frontend and in `scripts/` must be updated in the same commit.
- **Circuit change ⇒ new VK ⇒ timelocked update.** Recompiling changes the VK; the on-chain VK from
  the previous build rejects every new proof, and swapping it takes an epoch. Plan the ordering.

## Docs

`docs/` holds `architecture.md`, `SPEC.md`, `threat-model.md`, `auditor-guide.md`,
`relayer-api.md`, `FUTURE_IMPROVEMENTS.md`, the audit reports (`loop5-audit-report.md`,
`tier3-audit-report.md`, `privacy-red-team-report.md`, `final-grade-report.md`,
`zk-vulnerability-research.md`) and the C4 diagram HTML. When a finding in one of those reports is
fixed, the fix is usually referenced by its id in a code comment (e.g. `CRYPTO-004`, `SKILL-002`) —
grep for the id before changing code near it.
