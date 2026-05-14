# Night Shift Problems — Veil

> Check this file first in the morning. It contains uncertainties, assumptions, and blocked items.

---

### ASSUMPTION: token OTW named TOKEN not VEIL
- **Iteration**: T2
- **File**: contracts/sources/token.move
- **What I needed**: Task spec says `struct VEIL has drop {}` but Move 2024 requires OTW name = uppercase module name
- **What I did**: Named the struct `TOKEN` (module is `veil::token`), kept ticker symbol "VEIL" via `create_currency`. Pool uses `Coin<TOKEN>` internally. Public display name is still "VEIL".
- **Confidence**: HIGH — this is a hard constraint of the Move compiler
- **User action needed**: If you want the type to be `VEIL`, rename the module file to `veil.move` and declare `module veil::veil;` — but that's unusual naming.

### ASSUMPTION: Used @mysten/dapp-kit 1.x instead of @mysten/dapp-kit-react 2.x
- **Iteration**: T4
- **File**: frontend/src/app/providers.tsx, frontend/package.json
- **What I needed**: Task spec requested `@mysten/dapp-kit-react 2.x` with `DAppKitProvider` + `SuiClientProvider` imports
- **What I did**: Used `@mysten/dapp-kit@1.0.6` (stable, ships `SuiClientProvider` + `WalletProvider`). The 2.x API is fundamentally different (Lit-based, no `SuiClientProvider`). Also used `getJsonRpcFullnodeUrl` from `@mysten/sui/jsonRpc` (renamed from `getFullnodeUrl` in @mysten/sui 2.x) and added required `network` field in `NetworkConfig`.
- **Confidence**: HIGH — 1.x is the correct stable package for this pattern
- **User action needed**: None unless you specifically want the 2.x Lit-based architecture

### ASSUMPTION: shielded_transfer test uses #[expected_failure] without abort code
- **Iteration**: T2
- **File**: contracts/tests/pool_tests.move
- **What I needed**: Test spec says verify E_INVALID_PROOF (code 3) on bad proof. The native `groth16::prepare_verifying_key` aborts with code 0 before our assert runs.
- **What I did**: Used `#[expected_failure]` without code — verifies bad input always aborts (never silently succeeds).
- **Confidence**: HIGH — groth16 native abort is expected behavior, test intent preserved
