#!/usr/bin/env python3
"""
Independently re-derive expected values for every fixture, straight from the raw
transaction JSON, using NO code from src/.

Cross-implementation validation: if the TypeScript normalizer and this throwaway
Python agree on every fixture, the numbers pinned in the tests are verified, not
echoed back from the thing under test.

Updated for Phase 2.5: the quote asset comes from a registry, and the DOMINANT
leg (largest by USD) is THE quote — legs are never summed.
"""
import json, glob, os

WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"

# mint -> (symbol, decimals, price_source)
REGISTRY = {
    WSOL: ("SOL", 9, "sol"),
    USDC: ("USDC", 6, "stable"),
    USDT: ("USDT", 6, "stable"),
}
REFERENCE_SOL_USD = 150


def keys(tx):
    return [k if isinstance(k, str) else k["pubkey"] for k in tx["transaction"]["message"]["accountKeys"]]


def signers(tx):
    return {k["pubkey"] for k in tx["transaction"]["message"]["accountKeys"]
            if isinstance(k, dict) and k.get("signer")}


def native_deltas(tx):
    m, ks = tx["meta"], keys(tx)
    out = {}
    fee_payer = ks[0] if ks else None
    for i, k in enumerate(ks):
        d = m["postBalances"][i] - m["preBalances"][i]
        if k == fee_payer:
            d += m["fee"]                      # gas is not spend
        out[k] = out.get(k, 0) + d
    return out


def token_deltas(tx, mint):
    m = tx["meta"]
    out = {}
    for b in (m.get("preTokenBalances") or []):
        if b["mint"] != mint or not b.get("owner"):
            continue
        o = out.setdefault(b["owner"], {"before": 0, "after": 0})
        o["before"] += int(b["uiTokenAmount"]["amount"])
    for b in (m.get("postTokenBalances") or []):
        if b["mint"] != mint or not b.get("owner"):
            continue
        o = out.setdefault(b["owner"], {"before": 0, "after": 0})
        o["after"] += int(b["uiTokenAmount"]["amount"])
    for o in out.values():
        o["delta"] = o["after"] - o["before"]
    return out


def quote_legs(tx):
    """Every registry quote, netted per owner. Native SOL folds into wSOL."""
    legs = {}
    for qmint in REGISTRY:
        for owner, d in token_deltas(tx, qmint).items():
            if d["delta"]:
                legs.setdefault(owner, {})[qmint] = legs.get(owner, {}).get(qmint, 0) + d["delta"]
    for owner, d in native_deltas(tx).items():
        if d:
            legs.setdefault(owner, {})[WSOL] = legs.get(owner, {}).get(WSOL, 0) + d
    return legs


def approx_usd(qmint, raw):
    sym, dec, src = REGISTRY[qmint]
    unit = REFERENCE_SOL_USD if src == "sol" else 1
    return abs(raw) / (10 ** dec) * unit


def dominant(legs, want):
    """Largest leg by USD on the requested side. NEVER a sum."""
    side = {m: d for m, d in legs.items() if (d < 0 if want == "out" else d > 0)}
    if not side:
        return None
    best = max(side.items(), key=lambda kv: approx_usd(kv[0], kv[1]))
    return best[0], abs(best[1])


def classify(tx, mint):
    if tx["meta"].get("err"):
        return None
    sg = signers(tx)
    md = token_deltas(tx, mint)
    legs = quote_legs(tx)

    def pick(cands, mag=False):
        size = (lambda d: abs(d["delta"])) if mag else (lambda d: d["delta"])
        s = [c for c in cands if c[0] in sg]
        return max(s or cands, key=lambda c: size(c[1]))[0]

    buyers = [(o, d) for o, d in md.items()
              if d["delta"] > 0 and any(v < 0 for v in legs.get(o, {}).values())]
    if buyers:
        o = pick(buyers)
        q = dominant(legs.get(o, {}), "out")
        if not q or q[1] == 0:
            return None
        d = md[o]
        assert d["after"] - d["before"] == d["delta"]
        return dict(kind="buy", who=o, tokens=d["delta"], quote_mint=q[0],
                    quote_symbol=REGISTRY[q[0]][0], quote_raw=q[1],
                    before=d["before"], after=d["after"])

    sellers = [(o, d) for o, d in md.items()
               if d["delta"] < 0 and any(v > 0 for v in legs.get(o, {}).values())]
    if sellers:
        o = pick(sellers, mag=True)
        q = dominant(legs.get(o, {}), "in")
        if not q or q[1] == 0:
            return None
        d = md[o]
        return dict(kind="sell", who=o, tokens=abs(d["delta"]), quote_mint=q[0],
                    quote_symbol=REGISTRY[q[0]][0], quote_raw=q[1],
                    before=d["before"], after=d["after"])
    return None


out = {}
for path in sorted(glob.glob("test/fixtures/*.json")):
    f = json.load(open(path))
    name = os.path.basename(path)[:-5]
    r = classify(f["tx"], f["mint"])
    out[name] = r
    if r:
        signed = r["tokens"] if r["kind"] == "buy" else -r["tokens"]
        assert r["after"] - r["before"] == signed, f"delta invariant broken: {name}"
        print(f"{name:30s} {r['kind']:5s} {r['quote_symbol']:5s} quoteRaw={r['quote_raw']:<14} "
              f"tokens={r['tokens']:<18} before={r['before']:<20} after={r['after']}")
    else:
        print(f"{name:30s} null")

json.dump(out, open("/tmp/claude-1000/-home-emberwarden-RiceBuybot/d0fdcc5d-ba4a-4d57-aa99-94358593e10d/scratchpad/py-expected-25.json", "w"), indent=2)
