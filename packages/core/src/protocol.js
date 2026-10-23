// Blindfold protocol v1 (BF1): identifiers, commitments, memos, sealed contact
// details, receipts and ZIP 321 payment requests.
//
// Everything here runs the same in a browser and in Node, with no network access.

import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { shareBid, PARTIES } from './field.js';

export const VERSION = 'BF1';
export const MEMO_MAX_BYTES = 512;
const ZAT_PER_ZEC = 100_000_000n;

// ---------------------------------------------------------------- encoding

const te = new TextEncoder();
const td = new TextDecoder();

export function base64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const h = (s) => bytesToHex(sha256(utf8ToBytes(s)));

// ---------------------------------------------------------------- amounts

/** Parse a ZEC decimal string ("1.25") into zatoshi. */
export function zecToZat(zec) {
  const s = String(zec).trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error(`invalid ZEC amount: ${zec}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * ZAT_PER_ZEC + BigInt(frac.padEnd(8, '0'));
}

/** Format zatoshi as a minimal ZEC decimal string ("1.25"). */
export function zatToZec(zat) {
  const z = BigInt(zat);
  const whole = z / ZAT_PER_ZEC;
  const frac = (z % ZAT_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ---------------------------------------------------------------- identifiers

const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A short, URL-safe auction identifier. */
export function newAuctionId() {
  return Array.from(randomBytes(10), (b) => B32[b % B32.length]).join('');
}

/** The bid ID is derived from the bidder's secret key, so revealing the key later proves ownership. */
export function deriveBidId(auctionId, bidKeyHex) {
  return h(`${VERSION}|bid|${auctionId}|${bidKeyHex}`).slice(0, 16);
}

/** Commitment that binds party i's shares of a bid; anchored on-chain in the bid memo. */
export function shareCommitment(auctionId, bidId, partyIndex, shares) {
  return h(`${VERSION}|share|${auctionId}|${bidId}|${partyIndex}|${shares.join(',')}`).slice(0, 24);
}

// ---------------------------------------------------------------- sealed contact

/** Seller keypair used only to receive bidders' sealed refund/delivery addresses. */
export function newSellerKey() {
  const sk = x25519.utils.randomSecretKey();
  return { secretKey: bytesToHex(sk), publicKey: bytesToHex(x25519.getPublicKey(sk)) };
}

function sealKey(shared, ephPub, recipientPub) {
  return hkdf(sha256, shared, concatBytes(ephPub, recipientPub), utf8ToBytes(`${VERSION} seal`), 32);
}

/** Encrypt a short string (a shielded address) so only the seller can read it. */
export function seal(plaintext, sellerPublicKeyHex) {
  const recipientPub = hexToBytes(sellerPublicKeyHex);
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = sealKey(x25519.getSharedSecret(eph, recipientPub), ephPub, recipientPub);
  // A fresh ephemeral key per message makes the all-zero nonce safe.
  const ct = chacha20poly1305(key, new Uint8Array(12)).encrypt(te.encode(plaintext));
  return base64urlEncode(concatBytes(ephPub, ct));
}

export function unseal(sealed, sellerSecretKeyHex) {
  const raw = base64urlDecode(sealed);
  const ephPub = raw.slice(0, 32);
  const sk = hexToBytes(sellerSecretKeyHex);
  const key = sealKey(x25519.getSharedSecret(sk, ephPub), ephPub, x25519.getPublicKey(sk));
  return td.decode(chacha20poly1305(key, new Uint8Array(12)).decrypt(raw.slice(32)));
}

// ---------------------------------------------------------------- memos

/**
 * Bid anchor memo, sent with the bid deposit:
 *   BF1 B <auctionId> <bidId> <c0> <c1> <c2> <sealedContact|->
 */
export function encodeBidMemo({ auctionId, bidId, commitments, sealedContact }) {
  const memo = [VERSION, 'B', auctionId, bidId, ...commitments, sealedContact || '-'].join(' ');
  assertMemoSize(memo);
  return memo;
}

/**
 * Settlement memo, sent with the winning payment. Revealing the bid key proves the
 * payer owns the winning bid:
 *   BF1 P <auctionId> <bidId> <bidKeyHex>
 */
export function encodePaymentMemo({ auctionId, bidId, bidKey }) {
  const memo = [VERSION, 'P', auctionId, bidId, bidKey].join(' ');
  assertMemoSize(memo);
  return memo;
}

export function assertMemoSize(memo) {
  const n = te.encode(memo).length;
  if (n > MEMO_MAX_BYTES) throw new Error(`memo is ${n} bytes, over the ${MEMO_MAX_BYTES}-byte limit`);
}

/** Parse any BF1 memo. Returns null for anything else. */
export function parseMemo(memo) {
  if (typeof memo !== 'string') return null;
  const parts = memo.replace(/\0+$/, '').trim().split(/\s+/);
  if (parts[0] !== VERSION) return null;
  if (parts[1] === 'B' && parts.length === 8) {
    const [, , auctionId, bidId, c0, c1, c2, sealed] = parts;
    if (!/^[0-9a-f]{16}$/.test(bidId) || ![c0, c1, c2].every((c) => /^[0-9a-f]{24}$/.test(c))) return null;
    return { type: 'bid', auctionId, bidId, commitments: [c0, c1, c2], sealedContact: sealed === '-' ? null : sealed };
  }
  if (parts[1] === 'P' && parts.length === 5) {
    const [, , auctionId, bidId, bidKey] = parts;
    if (!/^[0-9a-f]{32}$/.test(bidKey)) return null;
    return { type: 'payment', auctionId, bidId, bidKey };
  }
  return null;
}

// ---------------------------------------------------------------- bids

/**
 * Prepare everything a bidder's browser needs. Nothing here leaves the device
 * except: one share bundle per party (each meaningless alone) and the memo.
 *
 * @param {object} o
 * @param {string} o.auctionId
 * @param {bigint|string} o.amountZat
 * @param {string} [o.sellerPublicKey]  to seal the bidder's address
 * @param {string} [o.contactAddress]   bidder's shielded address for refund and delivery
 */
export function createBid({ auctionId, amountZat, sellerPublicKey, contactAddress }) {
  const bidKey = bytesToHex(randomBytes(16));
  const bidId = deriveBidId(auctionId, bidKey);
  const shares = shareBid(BigInt(amountZat));
  const commitments = shares.map((s, i) => shareCommitment(auctionId, bidId, i, s));
  const sealedContact = contactAddress && sellerPublicKey ? seal(contactAddress, sellerPublicKey) : null;
  const memo = encodeBidMemo({ auctionId, bidId, commitments, sealedContact });
  const packets = shares.map((bits, i) => ({ auctionId, bidId, party: i, bits, commitment: commitments[i] }));
  const receipt = { v: 1, auctionId, bidId, bidKey, amountZat: String(amountZat) };
  return { bidId, bidKey, memo, packets, commitments, receipt };
}

/** Check a share packet against its commitment (parties run the same check in Python). */
export function verifyPacket(p) {
  return p.bits.length > 0 && shareCommitment(p.auctionId, p.bidId, p.party, p.bits) === p.commitment;
}

// ---------------------------------------------------------------- receipts

export function encodeReceipt(receipt) {
  return 'bf1r:' + base64urlEncode(te.encode(JSON.stringify(receipt)));
}

export function decodeReceipt(str) {
  const s = str.trim();
  if (!s.startsWith('bf1r:')) throw new Error('not a Blindfold bid receipt');
  const r = JSON.parse(td.decode(base64urlDecode(s.slice(5))));
  if (deriveBidId(r.auctionId, r.bidKey) !== r.bidId) throw new Error('receipt is corrupted');
  return r;
}

// ---------------------------------------------------------------- settlement

/**
 * Publicly verify a settlement payment seen through the auction's viewing key.
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyPayment({ auctionId, winnerBidId, amountZat, memo, valueZat }) {
  const m = typeof memo === 'string' ? parseMemo(memo) : memo;
  if (!m || m.type !== 'payment') return { ok: false, reason: 'not a settlement memo' };
  if (m.auctionId !== auctionId) return { ok: false, reason: 'different auction' };
  if (m.bidId !== winnerBidId) return { ok: false, reason: 'not the winning bid' };
  if (deriveBidId(auctionId, m.bidKey) !== m.bidId) return { ok: false, reason: 'bid key does not match bid ID' };
  if (BigInt(valueZat) < BigInt(amountZat)) return { ok: false, reason: 'paid less than the winning bid' };
  return { ok: true };
}

// ---------------------------------------------------------------- ZIP 321

const enc = encodeURIComponent;

/**
 * Build a ZIP 321 payment URI that any Zcash wallet can scan.
 * @param {{address: string, amountZat: bigint|string, memo?: string, message?: string}[]} payments
 */
export function zip321(payments) {
  if (!payments.length) throw new Error('no payments');
  const fields = (p, i) => {
    const sfx = i === 0 ? '' : `.${i}`;
    const out = [];
    if (i > 0 || payments.length > 1) out.push(`address${sfx}=${p.address}`);
    out.push(`amount${sfx}=${zatToZec(p.amountZat)}`);
    if (p.memo) out.push(`memo${sfx}=${base64urlEncode(te.encode(p.memo))}`);
    if (p.message) out.push(`message${sfx}=${enc(p.message)}`);
    return out;
  };
  const params = payments.flatMap((p, i) => fields(p, i));
  const path = payments.length === 1 ? payments[0].address : '';
  return `zcash:${path}?${params.join('&')}`;
}

export const parties = PARTIES;
