"""Blindfold MPC closing session.

Run once per party, all three at the same time, e.g.

    BF_JOB=/data/jobs/abc.json python mpc_close.py -I 0 -P a:11365 -P b:11365 -P c:11365

The job file holds this party's Shamir shares of every bid's bits plus the public
parameters. Each party only ever holds its own shares; the computation reveals
exactly two things: which bids were malformed (failing the bit check) and the
index and amount of the highest valid bid.
"""

import json
import os
import random
import sys

from mpyc.runtime import mpc

BITS = 52  # bids are sent as 52 secret-shared bits: always 0 <= bid < 2**52 zatoshi
secint = mpc.SecInt(64)
FIELD = secint.field


async def main():
    job_path = os.environ["BF_JOB"]
    out_path = os.environ.get("BF_OUT", job_path + ".out")
    with open(job_path) as f:
        job = json.load(f)

    await mpc.start()

    bids = job["bids"]  # [{bidId, bits: [52 decimal share strings]}] in agreed order
    min_bid = int(job["minBid"])
    # Public randomness for the bit check, fixed by the coordinator after shares froze.
    rng = random.Random(job["checkSeed"])

    bit_vectors = [[secint(FIELD(int(s))) for s in b["bits"]] for b in bids]

    # 1. Well-formedness: every shared bit b must satisfy b * (b - 1) == 0.
    #    A random linear combination per bid opens to 0 for honest bids (revealing
    #    nothing) and to a random-looking value for malformed or inconsistent ones.
    checks = []
    for vec in bit_vectors:
        z = secint(0)
        for b in vec:
            z += rng.randrange(1, 2**60) * (b * (b - 1))
        checks.append(z)
    opened = await mpc.output(checks)
    valid = [int(v) == 0 for v in opened]

    # 2. Rebuild each bid from its bits (a local, free linear operation).
    amounts = []
    keep = []
    for ok, vec in zip(valid, bit_vectors):
        if not ok:
            continue
        x = secint(0)
        for j, b in enumerate(vec):
            x += (1 << j) * b
        amounts.append(x)
        keep.append(len(keep))

    result = {"valid": valid, "winner": None, "amount": None}
    valid_ids = [b["bidId"] for b, ok in zip(bids, valid) if ok]

    if amounts:
        # 3. Bids under the minimum count as zero.
        effective = [x * (x >= min_bid) for x in amounts]
        idx, top = mpc.argmax(effective)
        idx, top = await mpc.output([idx, top])
        idx, top = int(idx), int(top)
        if top > 0:
            result["winner"] = valid_ids[idx]
            result["amount"] = str(top)

    await mpc.shutdown()
    with open(out_path, "w") as f:
        json.dump(result, f)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    mpc.run(main())
