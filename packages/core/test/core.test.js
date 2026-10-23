import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shamirShare, shamirReconstruct, shareBid, P, BID_BITS,
  createBid, verifyPacket, parseMemo, encodePaymentMemo, verifyPayment,
  newSellerKey, seal, unseal, encodeReceipt, decodeReceipt,
  zecToZat, zatToZec, zip321, base64urlDecode, MEMO_MAX_BYTES, newAuctionId,
} from '../src/index.js';

test('shamir round trip with any two shares', () => {
  const s = shamirShare(123456789n);
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
    assert.equal(shamirReconstruct([{ x: a + 1, y: s[a] }, { x: b + 1, y: s[b] }]), 123456789n);
  }
});

test('bit sharing reconstructs the bid', () => {
  const amount = 150_000_000n;
  const shares = shareBid(amount);
  assert.equal(shares.length, 3);
  assert.equal(shares[0].length, BID_BITS);
  let v = 0n;
  for (let j = 0; j < BID_BITS; j++) {
    const bit = shamirReconstruct([{ x: 1, y: BigInt(shares[0][j]) }, { x: 3, y: BigInt(shares[2][j]) }]);
    assert.ok(bit === 0n || bit === 1n);
    v += bit << BigInt(j);
  }
  assert.equal(v, amount);
  assert.throws(() => shareBid(1n << 52n));
});

test('amounts', () => {
  assert.equal(zecToZat('1.5'), 150_000_000n);
  assert.equal(zecToZat('0.00000001'), 1n);
  assert.equal(zatToZec(150_000_000n), '1.5');
  assert.equal(zatToZec(100_000_000n), '1');
  assert.throws(() => zecToZat('1.123456789'));
});

test('sealed contact round trip', () => {
  const k = newSellerKey();
  const ua = 'u1' + 'q'.repeat(211);
  assert.equal(unseal(seal(ua, k.publicKey), k.secretKey), ua);
  assert.throws(() => unseal(seal(ua, k.publicKey), newSellerKey().secretKey));
});

test('bid creation, memo, packets, receipt, payment verification', () => {
  const auctionId = newAuctionId();
  const seller = newSellerKey();
  const ua = 'u1' + 'x'.repeat(211);
  const bid = createBid({ auctionId, amountZat: 250_000_000n, sellerPublicKey: seller.publicKey, contactAddress: ua });
  assert.ok(new TextEncoder().encode(bid.memo).length <= MEMO_MAX_BYTES, 'memo fits');
  const m = parseMemo(bid.memo);
  assert.equal(m.type, 'bid');
  assert.equal(m.bidId, bid.bidId);
  assert.deepEqual(m.commitments, bid.commitments);
  assert.equal(unseal(m.sealedContact, seller.secretKey), ua);
  for (const p of bid.packets) assert.ok(verifyPacket(p));
  const tampered = { ...bid.packets[1], bits: [...bid.packets[1].bits] };
  tampered.bits[0] = '1';
  assert.equal(verifyPacket(tampered), false);

  const r = decodeReceipt(encodeReceipt(bid.receipt));
  assert.equal(r.bidId, bid.bidId);

  const memo = encodePaymentMemo({ auctionId, bidId: r.bidId, bidKey: r.bidKey });
  assert.deepEqual(verifyPayment({ auctionId, winnerBidId: bid.bidId, amountZat: 250_000_000n, memo, valueZat: 250_000_000n }), { ok: true });
  assert.equal(verifyPayment({ auctionId, winnerBidId: bid.bidId, amountZat: 250_000_000n, memo, valueZat: 249_999_999n }).ok, false);
  const forged = encodePaymentMemo({ auctionId, bidId: bid.bidId, bidKey: '0'.repeat(32) });
  assert.equal(verifyPayment({ auctionId, winnerBidId: bid.bidId, amountZat: 1n, memo: forged, valueZat: 1n }).ok, false);
});

test('zip321', () => {
  const one = zip321([{ address: 'u1abc', amountZat: 1_000_000n, memo: 'hi' }]);
  assert.equal(one, 'zcash:u1abc?amount=0.01&memo=aGk');
  assert.equal(new TextDecoder().decode(base64urlDecode('aGk')), 'hi');
  const two = zip321([{ address: 'u1a', amountZat: 1n }, { address: 'u1b', amountZat: 2n, memo: 'x' }]);
  assert.equal(two, 'zcash:?address=u1a&amount=0.00000001&address.1=u1b&amount.1=0.00000002&memo.1=eA');
});

test('field matches MPyC SecInt(64)', () => {
  assert.equal(P, 79228162514264337593543950319n);
});
