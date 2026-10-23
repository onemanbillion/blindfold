# @blindfold/core

The protocol library behind [Blindfold](../../README.md): sealed-bid auctions on Zcash where no single party sees a bid.

Works in browsers and Node 20+. Depends only on the audited `@noble` libraries.

```js
import {
  createBid, verifyPacket, parseMemo, encodePaymentMemo, verifyPayment,
  encodeReceipt, decodeReceipt, newSellerKey, seal, unseal,
  zip321, zecToZat, zatToZec, shareBid, shamirShare, P,
} from '@blindfold/core';
```

| Function | Purpose |
| --- | --- |
| `createBid({auctionId, amountZat, sellerPublicKey?, contactAddress?})` | Bid key and ID, one share packet per keyholder, the deposit memo, and a receipt |
| `verifyPacket(packet)` | Check a packet against its commitment (keyholders do the same in Python) |
| `parseMemo(text)` | Parse `BF1 B …` and `BF1 P …` memos |
| `encodePaymentMemo({auctionId, bidId, bidKey})` | The winner's settlement memo |
| `verifyPayment({auctionId, winnerBidId, amountZat, memo, valueZat})` | Public settlement check |
| `newSellerKey()`, `seal()`, `unseal()` | Encrypt a bidder's address so only the seller can read it |
| `encodeReceipt()`, `decodeReceipt()` | Portable `bf1r:` receipts |
| `zip321(payments)` | Payment URIs any Zcash wallet can scan, including multi-payment refunds |
| `shareBid(amount)`, `shamirShare(x)`, `P` | MPyC-compatible Shamir sharing over `SecInt(64)`'s field |

See [docs/protocol.md](../../docs/protocol.md) for the specification. `npm test` runs the unit tests.
