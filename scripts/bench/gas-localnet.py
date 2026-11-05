#!/usr/bin/env python3
"""gas-localnet.py — measure real on-chain gas per Veil entry point on a local Sui network.

Prereqs: `sui` CLI matching contracts/Move.toml's framework rev (testnet-v1.72.1), and a running
`sui start --force-regenesis --with-faucet`, active env `local`, funded active address.
Usage:   python3 scripts/bench/gas-localnet.py [--gas-price-note]
Output:  a markdown table of computation / storage / rebate / net gas (MIST) per call.
NOT covered (needs valid Groth16 proofs => circom-built zkeys): shielded_transfer,
zk_withdraw, compliant_transfer. Those rows are reported as UNMEASURED by the caller.
"""
import json, subprocess, os, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
CONTRACTS = os.path.join(ROOT, "contracts")
CLOCK = "0x6"
rows = []

def sui(*args, cwd=CONTRACTS):
    r = subprocess.run(["sui", *args], cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"sui {' '.join(args[:3])} failed:\n{r.stderr[-2000:]}")
    return json.loads(r.stdout)

def record(name, d):
    g = d["effects"]["gasUsed"]
    c, s, rb = int(g["computationCost"]), int(g["storageCost"]), int(g["storageRebate"])
    st = d["effects"]["status"]["status"]
    rows.append((name, st, c, s, rb, c + s - rb))
    return d

def call(name, fn, args, module="pool", pkg=None, type_args=None):
    cmd = ["client", "call", "--package", pkg, "--module", module, "--function", fn,
           "--gas-budget", "500000000", "--json", "--args", *args]
    d = sui(*cmd)
    return record(name, d)

def created(d, suffix):
    return [c["objectId"] for c in d["objectChanges"] if c["type"] == "created" and c["objectType"].endswith(suffix)][0]

# test-publish refuses to re-publish while an ephemeral Pub.local.toml exists; start clean.
for f in ("Pub.local.toml",):
    fp = os.path.join(CONTRACTS, f)
    if os.path.exists(fp): os.remove(fp)
pub = record("publish (6 modules)", sui("client", "test-publish", "--build-env", "testnet", "--gas-budget", "500000000", "--json"))
pkg = [c["packageId"] for c in pub["objectChanges"] if c["type"] == "published"][0]
treasury = created(pub, "::token::TOKEN>")  # TreasuryCap<TOKEN>
treasury = [c["objectId"] for c in pub["objectChanges"] if c["type"]=="created" and "TreasuryCap" in c["objectType"]][0]
addr = json.loads(subprocess.run(["sui","client","active-address","--json"],capture_output=True,text=True).stdout)
vk = "0x" + "00" * 232  # structurally valid length only; verify paths are not exercised here
d = call("create_pool", "create_pool", [vk, "1000000000", "3600000"], pkg=pkg)
pool = created(d, "::pool::Pool")
cap = created(d, "::pool::AdminCap")

def coin_from_faucet():
    d = call("token_faucet::faucet (1000 TOKEN mint)", "faucet", [treasury], module="token_faucet", pkg=pkg)
    return [c["objectId"] for c in d["objectChanges"] if c["type"]=="created" and "Coin<" in c["objectType"] and "TOKEN" in c["objectType"]][0]

def split(coin, amt):
    d = sui("client", "split-coin", "--coin-id", coin, "--amounts", str(amt), "--gas-budget", "50000000", "--json")
    return [c["objectId"] for c in d["objectChanges"] if c["type"]=="created"][0]

coin = coin_from_faucet()
for i in range(3):
    piece = split(coin, 100_000_000)
    comm = "0x" + format(i + 1, "02x") * 32
    call(f"deposit_and_register #{i+1} (100 TOKEN)", "deposit_and_register", [pool, piece, comm, CLOCK], pkg=pkg)
call("propose_vk_update", "propose_vk_update", [pool, cap, vk, CLOCK], pkg=pkg)
call("cancel_vk_update", "cancel_vk_update", [pool, cap], pkg=pkg)
call("propose_withdrawal", "propose_withdrawal", [pool, cap, "100000000", addr, CLOCK], pkg=pkg)
call("cancel_withdrawal", "cancel_withdrawal", [pool, cap], pkg=pkg)
call("update_commitment_root (propose)", "update_commitment_root", [pool, cap, "0x" + "ab" * 32, CLOCK], pkg=pkg)
call("freeze_pool", "freeze_pool", [pool, cap, CLOCK], pkg=pkg)
call("unfreeze_pool", "unfreeze_pool", [pool, cap], pkg=pkg)

print("| Call | Status | Computation | Storage | Rebate | Net (MIST) |\n|---|---|---|---|---|---|")
for r in rows:
    print(f"| {r[0]} | {r[1]} | {r[2]:,} | {r[3]:,} | {r[4]:,} | {r[5]:,} |")
