# On-chain gas per entry point — toolchain unblock attempt (BLOCKED, UNMEASURED)

Date: 2026-11-10. Queue item #1. Third consecutive night this axis is blocked, now for a third,
different reason.

## Hypothesis

Running `sui move test --gas-limit`/`sui client dry-run` (or reading historical gas from the deployed
testnet package) yields a real per-entry-point gas number for `deposit`, `shielded_transfer`,
`zk_withdraw` and the compliance verify path, and the Groth16 verify share of each is the dominant
term (which is what makes queue item #3, batched verification, worth building).
**No number was produced tonight. This hypothesis is untested.**

## Threat / privacy model

Not applicable — no protocol change was made. Residual risk of the gap itself: the 124-test Move suite
has not been run in this loop since it began, so contract regressions are not covered by research runs
(CI in `.github/workflows` does run it).

## Approach (what was tried, with the actual results)

1. **Proxy status** — `curl "$HTTPS_PROXY/__agentproxy/status"`: proxy enabled, no recent relay failures.
2. **Public fullnode RPC** (`suix_queryTransactionBlocks` route from the queue):
   `curl -X POST https://fullnode.testnet.sui.io:443 ...sui_getLatestCheckpointSequenceNumber`
   → `curl: (56) CONNECT tunnel failed, response 403`. The environment's network policy does not
   allow that host. Not a sandbox-approval issue this time; it is an egress allowlist.
3. **GitHub API for release lookup** — `api.github.com/repos/MystenLabs/sui/releases/latest` → HTTP 403.
   (`git ls-remote --tags` works and gave `testnet-v1.83.1` as newest tag.)
4. **Prebuilt CLI download** — the same URL pattern `.github/workflows` uses
   (`github.com/MystenLabs/sui/releases/download/<tag>/sui-<tag>-ubuntu-x86_64.tgz`) **succeeds**:
   `testnet-v1.83.1 200 1191379244` bytes and `mainnet-v1.83.1 200 1191433564` bytes.
   (Both written to the same filename, so only the mainnet tarball survived; unimportant.)
5. **Extract and run the binary** (`tar -xzf`, `chmod +x`, `sui --version`) → **denied by the Claude
   Code auto-mode classifier** ("Code from External"). I did not try to route around it: the intent
   of the denial is "don't execute downloaded binaries unattended". The 1.1 GB tarball was deleted.

So: the CLI is *obtainable* here, it is just not *executable* under the unattended-run policy.
No Move test, publish or dry-run was run, therefore **no gas figure appears anywhere in this repo
from this night, and none should be inferred**.

## Results

| Metric | Baseline | After |
|---|---|---|
| Gas per entry point | not measured | **not measured (BLOCKED)** |
| Move test suite | not run | **not run (BLOCKED)** |

Raw output is quoted inline in "Approach" above (the only commands that produced output).

## Verdict: **BLOCKED**

Exact missing piece: permission to execute a pinned prebuilt `sui` binary in this routine, *or* a
`sui` already installed in the environment image / setup script. Nothing else is missing — the
download path and tag are known good.

Suggested unblock (owner action, pick one):
- Add the prebuilt `sui` (pinned tag, checksum-verified) to the routine's environment setup script so it
  is on `PATH` before the session starts; or
- add a permission rule allowing `sui` / `tar` on a download directory for this routine; or
- allow `fullnode.testnet.sui.io` in the environment network policy (gives historical gas via
  `suix_queryTransactionBlocks`, but not the Move test suite).

## Where this could be used

Once measured, per-entry-point gas is the input for any "N shielded payments → 1 verification"
design (e.g. confidential payroll on Sui with a t-of-n auditor board, where a pay run is a burst of
transfers against one shared pool object) and for the gas-cost chapter of the thesis comparing
Groth16-on-Move against recursive aggregation.

## Open questions (tomorrow's queue)

- Is unattended execution of a pinned, checksum-verified `sui` acceptable? (Decides whether #1 can ever
  run in this loop; if not, #1 should move to a manual/CI-measured track and a CI job that prints gas.)
- Because #1 and #3 both depend on it, tonight's re-rank moves #2 (Poseidon2 vs Poseidon, fully
  measurable with the already-working circom/snarkjs toolchain) to the top until #1 is unblocked.
