# Blindfold protocol, version 1 (BF1)

This document specifies how bids are sealed, anchored, compared and settled. The reference implementation is [`packages/core`](../packages/core) (browser side) and [`services/party`](../services/party) (keyholders).

## Roles

- **Seller.** Owns a shielded Zcash account dedicated to the auction. Publishes its unified address and unified full viewing key (UFVK). Holds an X25519 keypair (the *seller key*) generated in their browser.
- **Bidder.** Any Zcash wallet that can scan a [ZIP 321](https://zips.z.cash/zip-0321) payment request with a memo, plus a web browser.
- **Keyholders P0, P1, P2.** Three servers, ideally run by independent operators. Each stores shares and runs one side of the MPC session.
- **Coordinator.** The auction website. It relays public data and tells keyholders when to start. It never receives shares.

## Auction parameters

| Field | Meaning |
| --- | --- |
| `auctionId` | 10 characters from `abcdefghijkmnpqrstuvwxyz23456789` |
| `sellerAddress`, `ufvk` | Seller's unified address and the matching viewing key (published) |
| `sellerPublicKey` | X25519 public key, hex |
| `depositZat` | Deposit each bid must carry |
| `minBidZat` | Bids below this count as zero |
| `reserveZat` | Optional, kept by the coordinator; if the winning amount is below it, there is no sale |
| `startHeight`, `endHeight` | Deposits must be mined in `[startHeight, endHeight]` |
| `settleBlocks` | Blocks the winner has to pay after the result is published |

## Arithmetic

All secret sharing is over the prime field of MPyC's `SecInt(64)`:

```
P = 79228162514264337593543950319     (96 bits)
```

Shamir sharing with 3 parties and threshold t = 1: for secret `s`, pick `a` uniformly in GF(P) and give party *i* (0-based) the value `f(i+1)` where `f(x) = s + a·x`. Any one share is uniform; any two reconstruct `s`.

## 1. Sealing a bid (browser)

1. Pick a 16-byte random **bid key** `k`. The **bid ID** is
   `bidId = SHA256("BF1|bid|" ‖ auctionId ‖ "|" ‖ hex(k))[0..16 hex]`.
2. Write the bid `v` (zatoshi, `0 ≤ v < 2^52`) as bits `v_0 … v_51`, least significant first.
3. Shamir-share every bit independently. Party *i* gets the list `S_i = [share_i(v_0), …, share_i(v_51)]` as decimal strings.
4. Share commitment for party *i*:
   `c_i = SHA256("BF1|share|" ‖ auctionId ‖ "|" ‖ bidId ‖ "|" ‖ i ‖ "|" ‖ join(S_i, ","))[0..24 hex]`.
5. Optional sealed contact: the bidder's shielded address encrypted to the seller.
   `eph ← X25519 keygen; K = HKDF-SHA256(X25519(eph, sellerPub), salt = ephPub ‖ sellerPub, info = "BF1 seal", 32)`;
   `sealed = base64url(ephPub ‖ ChaCha20-Poly1305(K, nonce = 0^12).encrypt(address))`.
   The all-zero nonce is safe because every message uses a fresh ephemeral key.
6. Send `{auctionId, bidId, party: i, bits: S_i, commitment: c_i}` to `POST /v1/shares` on party *i*. The party verifies the length (52), that every value is below P, and the commitment, then stores it. It refuses shares once the auction is frozen.
7. Send the deposit with the **bid memo**:

```
BF1 B <auctionId> <bidId> <c0> <c1> <c2> <sealed | ->
```

With a 213-character unified address the memo is about 460 bytes, within Zcash's 512-byte limit.

8. Keep the **receipt**: `bf1r:` ‖ base64url(JSON `{v:1, auctionId, bidId, bidKey, amountZat}`). It is the only proof the bid belongs to this bidder.

## 2. Anchoring (coordinator)

The coordinator syncs a view-only wallet for the auction's UFVK. A bid is **anchored** when an incoming shielded output to the seller's account

- carries a well-formed bid memo for this `auctionId`,
- has value ≥ `depositZat`,
- is mined at a height in `[startHeight, endHeight]`.

If the same `bidId` appears twice, the earliest wins. Anchors are ordered by height, then first-seen time, then transaction ID; this order breaks ties.

## 3. Closing (keyholders)

Once the chain tip reaches `endHeight + 2`:

1. **Prepare.** The coordinator sends every party the anchored list `{bidId, c_i}`. Each party freezes the auction and replies with the bid IDs for which its stored commitment equals the anchored `c_i`. Only bids held by all three parties continue; others are reported as *unshared*.
2. **Check seed.** The coordinator draws a 31-bit seed after freezing and sends it with the agreed list. Because it is chosen after shares are fixed, a bidder cannot craft shares that pass the check by luck.
3. **MPC session** (all three parties, `mpc_close.py`):
   - Load each share as a `SecInt(64)` share directly (no re-sharing).
   - **Bit check.** For each bid, compute `z = Σ_j r_j · b_j · (b_j − 1)` with public random weights `r_j` from the seed, and open `z`. Honest bids give `z = 0`, revealing nothing. A bit that is not 0 or 1, or an inconsistent sharing (three shares not on a degree-1 line), gives `z ≠ 0` with overwhelming probability, and the bid is discarded as *malformed*.
   - Rebuild `x = Σ_j 2^j · b_j` (a local linear operation).
   - Set `y = x · [x ≥ minBid]`.
   - Secure argmax over `y`; open the index and the maximum only.
4. Every party returns `{valid[], winner, amount}`. The coordinator accepts the result only if all three are identical.
5. If the maximum is 0 there is no valid bid; if it is below the reserve, there is no sale. Otherwise the winner has `settleBlocks` to pay.

## 4. Settlement

The winner pays exactly `amount` to `sellerAddress` with the **payment memo**:

```
BF1 P <auctionId> <bidId> <hex(bidKey)>
```

Anyone can verify: the memo's `bidId` is the published winner, `SHA256("BF1|bid|" ‖ auctionId ‖ "|" ‖ bidKey)` matches it, and the received value is at least `amount`. Only the bidder knows `bidKey`, so a payment cannot be claimed by someone else.

**Fallback.** If no valid payment is mined by the deadline, the winner's bid is excluded and step 3 runs again on the remaining bids, revealing only the new winner. Defaulted winners forfeit their deposit.

## 5. After the sale

The seller's console unseals the winner's address (for delivery) and every bidder's address (for refunds), and builds a single multi-payment ZIP 321 request refunding all non-defaulted deposits. Outgoing refunds are visible through the UFVK, so the count and total are public.

## Endpoints

### Keyholder

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/info` | none | Party index, field, version |
| POST | `/v1/shares` | none (CORS open) | Store one share packet |
| POST | `/v1/prepare` | coordinator token | Freeze, report held bids |
| POST | `/v1/close` | coordinator token | Run the MPC session |

### Auction house

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/config` | Keyholder URLs, whether on-chain auctions are enabled |
| GET | `/api/auctions` | All lots |
| POST | `/api/auctions` | Create an auction (returns a one-time seller token) |
| GET | `/api/auctions/:id` | Full public state: anchors, sessions, viewing key, events |
| POST | `/api/auctions/:id/sandbox/anchor` | Sandbox only: record a simulated deposit |
| POST | `/api/auctions/:id/sandbox/pay` | Sandbox only: record a simulated payment |
| POST | `/api/auctions/:id/end-now` | Sandbox only, seller token: close early |
| POST | `/api/auctions/:id/delivered` | Seller token: mark the item delivered |
| POST | `/api/auctions/:id/cancel` | Seller token: cancel before any bid is anchored |
