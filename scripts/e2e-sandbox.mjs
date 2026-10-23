// End-to-end test against a running Blindfold deployment, using a sandbox auction.
//   BASE=http://localhost:8080 node scripts/e2e-sandbox.mjs
import {
  createBid, newSellerKey, unseal, encodePaymentMemo, decodeReceipt, encodeReceipt, zatToZec,
} from '../packages/core/src/index.js';

const BASE = process.env.BASE || 'http://localhost:8080';
const j = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${d.error}`);
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ok -', m); };

const seller = newSellerKey();
const { auction, sellerToken } = await j('/api/auctions', { method: 'POST', body: {
  mode: 'sandbox', item: { collection: 'zkSNARKs', tokenId: 1234 }, sellerPublicKey: seller.publicKey,
  minBidZec: '0.5', depositZec: '0.001', durationMinutes: 10,
} });
console.log('auction', auction.id, auction.parties);

const bids = [];
for (const [zec, addr] of [['1.25', 'u1alice'], ['3.1', 'u1bob'], ['2.75', 'u1carol'], ['0.2', 'u1dave']]) {
  const amountZat = BigInt(Math.round(Number(zec) * 1e8));
  const b = createBid({ auctionId: auction.id, amountZat, sellerPublicKey: auction.sellerPublicKey, contactAddress: addr + 'x'.repeat(60) });
  for (const [i, p] of b.packets.entries()) {
    const r = await fetch(`${auction.parties[i]}/v1/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
    if (!r.ok) throw new Error(await r.text());
  }
  await j(`/api/auctions/${auction.id}/sandbox/anchor`, { method: 'POST', body: { memo: b.memo } });
  bids.push({ zec, addr, ...b });
}
// A cheater: valid-looking shares of a malformed bid (one "bit" equal to 2), with honest commitments.
{
  const b = createBid({ auctionId: auction.id, amountZat: 99n * 100000000n });
  // Replace each party's first bit share with shares of 2 (still a consistent sharing).
  const { shamirShare, shareCommitment } = await import('../packages/core/src/index.js');
  const two = shamirShare(2n).map(String);
  const evil = b.packets.map((p, i) => ({ ...p, bits: [two[i], ...p.bits.slice(1)] }));
  evil.forEach((p, i) => { p.commitment = shareCommitment(auction.id, b.bidId, i, p.bits); });
  const memo = ['BF1', 'B', auction.id, b.bidId, ...evil.map((p) => p.commitment), '-'].join(' ');
  for (const [i, p] of evil.entries()) {
    await fetch(`${auction.parties[i]}/v1/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
  }
  await j(`/api/auctions/${auction.id}/sandbox/anchor`, { method: 'POST', body: { memo } });
  bids.push({ zec: 'malformed', bidId: b.bidId });
}
// A bid with shares at only two parties: must be excluded.
{
  const b = createBid({ auctionId: auction.id, amountZat: 50n * 100000000n });
  for (const i of [0, 1]) await fetch(`${auction.parties[i]}/v1/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b.packets[i]) });
  await j(`/api/auctions/${auction.id}/sandbox/anchor`, { method: 'POST', body: { memo: b.memo } });
}

await j(`/api/auctions/${auction.id}/end-now`, { method: 'POST', body: { sellerToken } });
let a;
for (let t = 0; t < 60; t++) { a = await j(`/api/auctions/${auction.id}`); if (a.status === 'settling' || a.status === 'no_sale' || a.status === 'failed') break; await sleep(1000); }
console.log('status', a.status, JSON.stringify(a.result.sessions.at(-1)));
const bob = bids[1];
assert(a.status === 'settling', 'auction closed and awaits payment');
assert(a.result.winner === bob.bidId, 'highest valid bid (3.1) wins');
assert(a.result.amountZat === '310000000', 'winning amount revealed');
assert(a.result.sessions[0].malformed.length === 1, 'malformed bid detected');
assert(a.result.sessions[0].unshared.length === 1, 'bid missing a share excluded');

// Wrong payment is rejected.
const memo = encodePaymentMemo({ auctionId: a.id, bidId: bob.bidId, bidKey: bob.bidKey });
let rejected = false;
try { await j(`/api/auctions/${a.id}/sandbox/pay`, { method: 'POST', body: { memo, amountZec: '3' } }); } catch { rejected = true; }
assert(rejected, 'underpayment rejected');
const carolMemo = encodePaymentMemo({ auctionId: a.id, bidId: bids[2].bidId, bidKey: bids[2].bidKey });
rejected = false;
try { await j(`/api/auctions/${a.id}/sandbox/pay`, { method: 'POST', body: { memo: carolMemo, amountZec: '3.1' } }); } catch { rejected = true; }
assert(rejected, 'payment from a losing bid rejected');

if (process.env.TEST_FALLBACK) {
  console.log('waiting for settlement deadline to pass (fallback)…');
  for (let t = 0; t < 900; t++) { a = await j(`/api/auctions/${a.id}`); if (a.result?.defaulted?.length && a.status === 'settling') break; await sleep(2000); }
  assert(a.result.winner === bids[2].bidId && a.result.amountZat === '275000000', 'runner-up (2.75) wins after default');
} else {
  await j(`/api/auctions/${a.id}/sandbox/pay`, { method: 'POST', body: { memo, amountZec: '3.1' } });
  a = await j(`/api/auctions/${a.id}`);
  assert(a.status === 'paid', 'correct payment verified');
  const contacts = a.anchors.filter((x) => x.sealedContact).map((x) => unseal(x.sealedContact, seller.secretKey));
  assert(contacts.includes(bob.addr + 'x'.repeat(60)), 'seller can unseal the winner address');
}
console.log('E2E PASSED', a.id);
