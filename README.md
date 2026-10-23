# Blindfold

**Sealed-bid auctions on Zcash where nobody sees the bids, not even the auction house.**

Bidders' browsers split each bid into secret shares and send one to each of three independent servers ("keyholders"). At the closing block the keyholders run a secure multiparty computation over their shares and reveal exactly one thing: the winning bid and its amount. Losing bids are never revealed to anyone. Deposits and the final payment are ordinary shielded Zcash transactions, sent from any existing wallet by scanning a QR code, and anyone can audit them through the auction's published viewing key.

**Live demo: https://web-production-1ec12.up.railway.app** — the featured lots are *sandbox* lots: the secret sharing and the three-party computation are real; deposits and payments are simulated. On-chain auctions use real shielded ZEC.

```
 bidder's browser                  keyholders (3 servers)               Zcash
 ───────────────                   ──────────────────────               ─────
 bid = 1.75 ZEC
 split into 52 shared bits ──────► share 1 │ share 2 │ share 3
 deposit + memo (fingerprints) ─────────────────────────────────────► seller's shielded address
                                                                        (viewing key is public)
 closing block ─────────────────►  MPC: check bits, rebuild bids,
                                   argmax → winner + amount only
 winner pays amount + bid key ──────────────────────────────────────► verified by anyone
```

## What's in this repository

| Path | What it is |
| --- | --- |
| [`packages/core`](packages/core) | `@blindfold/core`, the protocol library. Secret sharing compatible with MPyC, BF1 memos, sealed contact addresses, bid receipts, ZIP 321 payment URIs, payment verification. Runs in browsers and Node. |
| [`services/party`](services/party) | A keyholder: FastAPI service that stores shares and runs its side of the MPC session with [MPyC](https://github.com/lschoe/mpyc). Run three, operated by different people. |
| [`services/web`](services/web) | The auction house: website, coordinator, and a view-only chain watcher built on [zcash-devtool](https://github.com/zcash/zcash-devtool). |
| [`docs`](docs) | Protocol specification, security model and limitations, selling zkSNARKs, deployment. |
| [`scripts/e2e-sandbox.mjs`](scripts/e2e-sandbox.mjs) | End-to-end test: honest bids, a malformed bid, a bid missing a share, wrong payments, runner-up fallback. |

## How it works, briefly

1. **Seal.** The browser writes the bid in zatoshi as 52 bits and Shamir-shares every bit among three parties (degree-1 polynomials over MPyC's `SecInt(64)` field). Each keyholder receives its 52 shares directly from the browser. The bidder then sends a small deposit to the seller's shielded address with a memo containing the bid ID, a SHA-256 fingerprint of each keyholder's shares, and the bidder's own shielded address encrypted to the seller (X25519 + ChaCha20-Poly1305).
2. **Anchor.** Only bids whose deposit is mined before the closing height count. The watcher reads them with the auction's viewing key. Keyholders accept a bid into the computation only if their stored shares match the on-chain fingerprint, so the operator cannot add, drop or swap bids.
3. **Compare blind.** The keyholders open a random linear combination of `b·(b−1)` for each bid's bits. It is 0 for every honest bid and nonzero for malformed or inconsistent ones, which are discarded. They rebuild each bid from its bits, zero out bids below the minimum, run a secure argmax, and open only the winner's index and amount. The public check seed is drawn after bidding closes.
4. **Settle.** The winner pays exactly the winning amount with a memo revealing the bid's secret key (`bidId = H(auction, key)`). Anyone with the viewing key can verify it. If the winner doesn't pay before the deadline, the keyholders compute the next highest bid.

Read [docs/protocol.md](docs/protocol.md) for the full specification and [docs/security.md](docs/security.md) for the threat model and limitations.

## Use the library

```js
import { createBid, zip321, zecToZat } from '@blindfold/core';

const bid = createBid({
  auctionId: 'k3m9qx2p7a',
  amountZat: zecToZat('1.75'),
  sellerPublicKey,               // from the auction
  contactAddress: 'u1…',         // bidder's address for refund and delivery, sealed to the seller
});

// One packet per keyholder; each is meaningless on its own.
await Promise.all(bid.packets.map((p, i) =>
  fetch(`${partyUrls[i]}/v1/shares`, { method: 'POST', body: JSON.stringify(p), headers: { 'content-type': 'application/json' } })));

// A QR code any Zcash wallet can pay.
const uri = zip321([{ address: sellerAddress, amountZat: depositZat, memo: bid.memo }]);
```

## Run it locally

Requirements: Node 22+, Python 3.11+, and optionally a Rust toolchain for the chain watcher.

```sh
# keyholders
pip install -r services/party/requirements.txt
for i in 0 1 2; do
  (cd services/party && PARTY_INDEX=$i COORDINATOR_TOKEN=dev DATA_DIR=./data$i \
     uvicorn party:app --port 900$((i+1)) &)
done

# auction house
cd packages/core && npm install && cd ../../services/web && npm install && npm run build
COORDINATOR_TOKEN=dev \
PARTY_URLS=http://localhost:9001,http://localhost:9002,http://localhost:9003 \
PARTY_MPC_PEERS=localhost:11501,localhost:11502,localhost:11503 \
npm start            # http://localhost:8080

# tests
(cd packages/core && npm test)
node scripts/e2e-sandbox.mjs
```

Without `zcash-devtool` on the `PATH`, the site runs sandbox auctions only. See [docs/deploy.md](docs/deploy.md) for a full deployment.

## Status

A working prototype built for Zecathon 2026. It is new and unaudited; keep real amounts modest and read the limitations first.

## License

MIT. zkSNARKs artwork belongs to its creators and is displayed from Zilk Road, the collection's marketplace; Blindfold is independent of both.
