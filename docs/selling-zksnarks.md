# Selling a zkSNARK with Blindfold

[zkSNARKs](https://x.com/zksnarks_) is a collection of 10,000 pixel-art "shielded identities" on Zcash. This page explains where those items actually live today, what that means for an auction, and the exact steps to sell one on Blindfold.

## Where the assets live

As of October 2026:

- **Artwork.** Served by Zilk Road, the collection's official marketplace, at `https://zilkroad.com/api/art/<token id>?fmt=webp`. Blindfold displays it from there and does not copy it.
- **Ownership.** Not on-chain. Native custom assets on Zcash (Zcash Shielded Assets, ZIP 226 and 227) are planned for the NU7 upgrade and are not on mainnet yet. Ownership of a zkSNARK is a record in Zilk Road's database that maps the identity to the holder's shielded address. Sellers prove control of that address to Zilk Road with a memo code. Payments are shielded; the title transfer is a database update by the marketplace.
- **No public API.** Zilk Road does not publish an ownership or transfer API, so third-party sites cannot verify who holds an identity or move it.

### What that means here

Blindfold can make the *bidding* trustless-ish and the *payment* publicly verifiable, but it cannot escrow the item or confirm the seller owns it. Delivery is a manual step on Zilk Road after payment, and bidders rely on the seller's reputation, exactly as they do for any off-chain-title sale. When ZSAs reach mainnet and collections move on-chain, delivery can become verifiable through the viewing key in the same way the payment is.

## Step by step

### Before listing

1. In a wallet that can export a **unified full viewing key** (Zingo, Ywallet, or `zcash-devtool`), create a **fresh account** used only for this auction. Its viewing key will be public, so don't reuse an account with other history.
2. Copy that account's unified address (`u1…`) and its viewing key (`uview1…`).
3. Note the token ID of the zkSNARK you hold on Zilk Road.

### Listing

4. On Blindfold, open **Sell**, choose **On-chain auction**, and enter the token ID, minimum bid, optional hidden reserve, deposit per bid and duration.
5. Paste the address and viewing key, then **Create auction**. The site loads the viewing key into a view-only wallet starting at the current block; this is when the auction opens.
6. **Download your seller key immediately.** It lives only in your browser, and it is the only way to read bidders' refund and delivery addresses.

### While it runs

Bidders' deposits arrive in your account with `BF1 B …` memos. They tell you nothing about the bids. You can watch them in your own wallet.

### After it closes

7. The site shows the winning amount and starts the payment window. When the winner's payment arrives and verifies, the lot shows **Sold, payment verified**.
8. Open the **seller console** (link on your confirmation page, or `#/manage/<auction id>`, then load your seller key). It decrypts the winner's delivery address.
9. Transfer the zkSNARK to that address on Zilk Road, then click **Mark as delivered**.
10. Refund deposits: the console shows one ZIP 321 multi-payment QR code covering every bidder except winners who defaulted. Wallets that don't support multi-payment requests can pay each listed address.

If the winner doesn't pay in time, the runner-up becomes the winner automatically, and only their amount is revealed.

## Trying it without ZEC

Choose **Sandbox** on the Sell page. You get the same flow with real secret sharing and a real three-party computation, but deposits and payments are simulated with buttons and nothing touches the chain.
