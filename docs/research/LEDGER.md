# Research ledger

Append-only. One row per night. Never edit or delete a past row — if a verdict is later found
wrong, add a new row that supersedes it and say why.

This file did not exist before 2026-07-21.

| Date | Slug | Hypothesis | Verdict | Number that moved | PR |
|---|---|---|---|---|---|
| 2026-07-21 | baseline | Veil's own circuit/gas/latency numbers have never been measured together on one machine; establishing them is a precondition for every future comparison in this queue. | KEEP (gas sub-measurement BLOCKED — no `sui` CLI available this session) | transfer.circom: 13,611 R1CS constraints, 759.8 ms median server-side proving (Node, 7 iters), 1,129.9 ms median browser (Chromium/WASM, 5 iters), 723-byte proof, 4,025-byte VK. compliance.circom: 12,743 constraints, 715.3 ms prove. withdraw.circom: 3,058 constraints, 237.4 ms prove. On-chain gas per entry point: UNMEASURED (`sui` CLI unavailable in-session; see report). | research: 2026-07-21-baseline |
