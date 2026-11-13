"""Generate giftPricingV2.fixtures.json from the reference sim.py.

Run from this folder: python3 generateGiftPricingV2Fixtures.py
The committed JSON is what the TypeScript test reads; tests never run Python.
Rule (spec b.2): total == ceil(round(sim * 100, 6)).
"""
import contextlib
import io
import json
import math

with contextlib.redirect_stdout(io.StringIO()):
    from sim import sim  # noqa: E402  (sim.py prints its own table on import)

NOMINALS = [500, 1000, 1234, 5000, 9999, 10000, 30000, 100000, 500000]


def tier(n):
    if n == 1:
        return (0.0299, 0.49, 0.0115)
    if n <= 6:
        return (0.0349, 0.49, 0.016)
    return (0.0399, 0.49, 0.016)


rows = []
for cents in NOMINALS:
    g = cents / 100
    total, _, _, _ = sim(g, 0, 1.99, 0, 1)
    rows.append({"nominalCents": cents, "method": "PIX", "installmentCount": 1,
                 "totalCents": math.ceil(round(total * 100, 6))})
    for n in range(1, 13):
        p, f, m = tier(n)
        total, _, _, _ = sim(g, p, f, m, n)
        rows.append({"nominalCents": cents, "method": "CREDIT_CARD",
                     "installmentCount": n,
                     "totalCents": math.ceil(round(total * 100, 6))})

with open("giftPricingV2.fixtures.json", "w") as handle:
    json.dump(rows, handle, indent=2)
    handle.write("\n")
print(len(rows))
