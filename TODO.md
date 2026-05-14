# TODO — Veil Night Shift

## Phase 1: Foundation (parallel)
- [ ] T1: Circom transfer circuit (transfer.circom + compile + test)
- [ ] T2: Move contract (pool.move + verifier.move + token.move + tests)
- [ ] T3: snarkjs → Sui proof byte converter (proof-converter.ts + tests)
- [ ] T4: Project scaffolding (frontend, init.sh, CLAUDE.md, DESIGN.md)

## Phase 2: Integration (sequential deps)
- [ ] T5: End-to-end proof pipeline (e2e-test.ts — CRITICAL PATH)
- [ ] T6: Frontend wallet + deposit (components + hooks)
- [ ] T7: Frontend transfer with proof generation (Web Worker + snarkjs)

## Phase 3: Polish
- [ ] T8: Withdraw flow + full cycle demo
- [ ] T9: Epoch management (auto-reset, countdown)
- [ ] T10: Tests + README + architecture diagram

## Phase 4: Ship
- [ ] Stability gate (3 reviewers)
- [ ] PR creation
- [ ] Debrief + postmortem
