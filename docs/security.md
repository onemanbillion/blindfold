# Security model and limitations

Blindfold removes the need to trust any *single* party with bids, and makes everything that touches money publicly checkable. It does not remove trust entirely. This page says exactly where trust remains.

## What is protected, and from whom

| Property | Holds against | Relies on |
| --- | --- | --- |
| Losing bids are never revealed | The operator, the seller, other bidders, any one keyholder | At most one of the three keyholders is corrupt |
| The winning amount is correct | A dishonest bidder sending malformed shares | Bit check with a seed drawn after bidding closes |
| The bid set is the one anchored on-chain | The operator adding, dropping or swapping bids | On-chain share fingerprints checked by every keyholder |
| Only the winner can settle | Anyone else paying the winning amount | The bid key, known only to the bidder |
| Payment and refunds are auditable | The seller claiming they didn't receive or did refund | Published viewing key |
| Bidder identity stays private on-chain | Chain observers, holders of the viewing key | Shielded deposits; contact address encrypted to the seller |

## Trust that remains

**Honest majority of keyholders.** Shamir sharing with threshold 1 means any two keyholders together can reconstruct every bid. Privacy needs at least two of the three to be honest and genuinely independent: different operators, different infrastructure, ideally different jurisdictions. The demo deployment runs all three keyholders in one Railway project under one account, which demonstrates the protocol but provides no real separation.

**Semi-honest computation.** The MPC follows MPyC's model, which is secure against parties that follow the protocol while trying to learn more (honest-but-curious). A keyholder that actively deviates inside the computation could corrupt the outcome. The coordinator's requirement that all three parties return the identical result catches a party that simply lies about the output, but not every possible active attack. Maliciously secure MPC is future work.

**Correctness of inputs is enforced; sincerity is not.** The bit check guarantees every counted bid is an integer in `[0, 2^52)` and consistently shared. It cannot stop a bidder from bidding an amount they never intend to pay. The deposit and the runner-up fallback contain the damage: a defaulting winner loses the deposit and the next bid wins.

**No enforced payment or delivery.** Zcash has no smart contracts, so neither side of the trade is atomic:
- A winner cannot be forced to pay. See above.
- A seller cannot be forced to deliver. zkSNARKs ownership is recorded in Zilk Road's database (see [selling-zksnarks.md](selling-zksnarks.md)), which Blindfold cannot read or write, so the item cannot be held in escrow and seller ownership cannot be verified. This is the same trust bidders already place in the marketplace.
- Deposit refunds are manual. They are visible through the viewing key, but nothing forces them.

**Coordinator availability.** The coordinator decides when to start the closing session and runs the watcher. It cannot see bids or change the anchored set, but it can stall. Anyone can re-derive the anchored set from the viewing key and run the closing session with the three keyholders.

## What is revealed

- The winning bid ID and amount, always (including when a reserve is not met).
- The number of anchored bids, their deposit heights, and which were malformed or missing a share.
- To the seller only: every bidder's contact address, if they supplied one. Bidders who want refund privacy can supply a fresh address.
- To each keyholder: the IP address of the browser sending it a share, and the timing. Use Tor or a VPN if that matters.
- Through the viewing key, to everyone: deposit amounts (all equal), heights, memos (which carry no bid information), the payment, and outgoing refunds. Never the senders.

## Ties and edge cases

- Equal top bids: the earliest anchored deposit wins (argmax returns the first maximum).
- A bid sent to only one or two keyholders is excluded and reported as unshared.
- A bidder may bid several times; each bid is independent and needs its own deposit.
- Losing the receipt makes a winning bid impossible to settle; the fallback then moves on.
- Times shown for on-chain auctions are estimates from the block interval (75 seconds today; NU7 is planned to reduce it to 25 seconds).

## Not yet done

- Malicious-secure MPC (for example MPyC with authenticated shares, or a SPDZ-style protocol).
- Zero-knowledge proofs of funds that don't link the proof to later spends.
- Independent keyholder operators with published identities.
- Native escrow once Zcash Shielded Assets (ZSAs) carry collectibles on-chain.
- An independent security audit.
