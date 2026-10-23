// Auction lifecycle: watch for anchored bids, close auctions with the three parties,
// track settlement, and fall back to the runner-up when a winner does not pay.
//
// The coordinator never sees a bid. It only relays public data (which bids are
// anchored on-chain) and tells the parties when to start the MPC session.

import { randomInt } from 'node:crypto';
import { parseMemo, verifyPayment } from '@blindfold/core';
import { db, getAuction, anchorsFor, logEvent, setTip, tipFor } from './db.js';
import { initWallet, syncWallet, readWallet } from './watcher.js';

const TOKEN = process.env.COORDINATOR_TOKEN || '';
const PUBLIC_URLS = (process.env.PARTY_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const INTERNAL_URLS = (process.env.PARTY_INTERNAL_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PEERS = (process.env.PARTY_MPC_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CONFIRMATIONS = Number(process.env.CLOSE_CONFIRMATIONS || 2);

export const partyPublicUrls = () => PUBLIC_URLS;
const partyUrl = (i) => INTERNAL_URLS[i] || PUBLIC_URLS[i];

export const walletSummaries = new Map(); // auction id -> {tip, refunds:{count,totalZat}, syncedAt}

async function callParty(i, path, body, timeoutMs = 30_000) {
  const res = await fetch(`${partyUrl(i)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`party ${i} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const now = () => Date.now() / 1000;
const parseJSON = (s, d) => (s ? JSON.parse(s) : d);

// ------------------------------------------------------------------ anchoring

export function recordAnchor(auctionId, memo, { txid = null, height = null, valueZat = null } = {}) {
  const m = parseMemo(memo);
  if (!m || m.type !== 'bid' || m.auctionId !== auctionId) return { ok: false, reason: 'not a bid memo for this auction' };
  const exists = db.prepare('SELECT 1 FROM anchors WHERE auction=? AND bid_id=?').get(auctionId, m.bidId);
  if (exists) return { ok: true, duplicate: true, bidId: m.bidId };
  db.prepare('INSERT INTO anchors VALUES (?,?,?,?,?,?,?,?)').run(
    auctionId, m.bidId, JSON.stringify(m.commitments), m.sealedContact, txid, height, valueZat, now(),
  );
  logEvent(auctionId, 'anchor', { bidId: m.bidId, txid, height });
  return { ok: true, bidId: m.bidId };
}

// ------------------------------------------------------------------ closing

const closing = new Set();

export async function closeAuction(id) {
  if (closing.has(id)) return;
  closing.add(id);
  try {
    const a = getAuction(id);
    const excluded = parseJSON(a.excluded, []);
    const anchors = anchorsFor(id).filter((x) => !excluded.includes(x.bid_id));
    db.prepare("UPDATE auctions SET status='closing' WHERE id=?").run(id);
    const history = parseJSON(a.result, { sessions: [] });

    if (!anchors.length) return finishNoSale(id, history, excluded.length ? 'no remaining bids' : 'no bids');
    if (PUBLIC_URLS.length !== 3 || PEERS.length !== 3) throw new Error('three parties are not configured');

    // 1. Freeze: every party reports which anchored bids it holds matching shares for.
    const refs = anchors.map((x) => ({ bidId: x.bid_id, commitment: null, commitments: JSON.parse(x.commitments) }));
    const prep = await Promise.all([0, 1, 2].map((i) =>
      callParty(i, '/v1/prepare', { auctionId: id, bids: refs.map((r) => ({ bidId: r.bidId, commitment: r.commitments[i] })) })));
    const agreed = anchors.filter((x) => prep.every((p) => p.have.includes(x.bid_id))).map((x) => x.bid_id);
    const unshared = anchors.map((x) => x.bid_id).filter((b) => !agreed.includes(b));
    if (!agreed.length) return finishNoSale(id, history, 'no bid had shares at all three parties', { unshared });

    // 2. The public check seed is drawn only after shares froze, so no bidder can pre-compute it.
    const checkSeed = randomInt(1, 2 ** 31 - 1);
    const results = await Promise.all([0, 1, 2].map((i) =>
      callParty(i, '/v1/close', { auctionId: id, bidIds: agreed, minBid: a.min_bid_zat, checkSeed, peers: PEERS }, 300_000)));
    const key = (r) => JSON.stringify([r.valid, r.winner, r.amount]);
    if (!results.every((r) => key(r) === key(results[0]))) throw new Error('parties disagree on the result');
    const r = results[0];
    const session = {
      at: now(), bids: agreed.length, unshared,
      malformed: agreed.filter((_, i) => !r.valid[i]),
      winner: r.winner, amountZat: r.amount, checkSeed, parties: results.map((x) => x.party),
    };
    history.sessions.push(session);
    logEvent(id, 'mpc', session);

    if (!r.winner) return finishNoSale(id, history, 'no valid bid at or above the minimum');
    if (BigInt(r.amount) < BigInt(a.reserve_zat || '0')) return finishNoSale(id, history, 'reserve not met');

    history.winner = r.winner;
    history.amountZat = r.amount;
    const deadline = a.mode === 'sandbox'
      ? { settleBy: now() + a.settle_seconds }
      : { settleByHeight: (tipFor(a.mode)?.tip || a.end_height) + a.settle_blocks };
    Object.assign(history, deadline);
    db.prepare("UPDATE auctions SET status='settling', result=?, closed_at=? WHERE id=?")
      .run(JSON.stringify(history), now(), id);
  } catch (err) {
    logEvent(id, 'error', { message: err.message });
    const a = getAuction(id);
    const fails = db.prepare("SELECT COUNT(*) AS n FROM events WHERE auction=? AND kind='error'").get(id).n;
    db.prepare('UPDATE auctions SET status=? WHERE id=?').run(fails >= 6 ? 'failed' : (a.result ? 'settling_retry' : 'open'), id);
    console.error(`[close ${id}]`, err.message);
  } finally {
    closing.delete(id);
  }
}

function finishNoSale(id, history, reason, extra = {}) {
  history.noSale = { reason, ...extra };
  delete history.winner;
  delete history.amountZat;
  db.prepare("UPDATE auctions SET status='no_sale', result=?, closed_at=? WHERE id=?").run(JSON.stringify(history), now(), id);
  logEvent(id, 'no_sale', { reason });
}

// ------------------------------------------------------------------ settlement

export function recordPayment(id, memo, { txid = null, height = null, valueZat }) {
  const a = getAuction(id);
  const r = parseJSON(a.result, {});
  if (a.status !== 'settling' || !r.winner) return { ok: false, reason: 'auction is not awaiting payment' };
  const check = verifyPayment({ auctionId: id, winnerBidId: r.winner, amountZat: r.amountZat, memo, valueZat });
  if (!check.ok) return check;
  db.prepare("UPDATE auctions SET status='paid', payment=? WHERE id=?").run(JSON.stringify({ txid, height, valueZat, at: now() }), id);
  logEvent(id, 'paid', { txid, height, valueZat });
  return { ok: true };
}

function fallBack(id) {
  const a = getAuction(id);
  const r = parseJSON(a.result, {});
  const excluded = [...parseJSON(a.excluded, []), r.winner];
  r.defaulted = [...(r.defaulted || []), r.winner];
  delete r.winner;
  delete r.amountZat;
  db.prepare("UPDATE auctions SET excluded=?, result=?, status='closing' WHERE id=?").run(JSON.stringify(excluded), JSON.stringify(r), id);
  logEvent(id, 'default', { bidId: r.defaulted.at(-1) });
  return closeAuction(id);
}

// ------------------------------------------------------------------ chain ingestion

function ingest(a, wallet) {
  setTip(a.mode, wallet.tip);
  let refunds = 0n;
  let refundCount = 0;
  for (const o of wallet.outputs) {
    if (o.outgoing) { refunds += BigInt(o.valueZat); refundCount++; continue; }
    if (!o.incoming || !o.memo || o.height == null) continue;
    const m = parseMemo(o.memo);
    if (!m || m.auctionId !== a.id) continue;
    if (m.type === 'bid' && o.height >= a.start_height && o.height <= a.end_height
        && BigInt(o.valueZat) >= BigInt(a.deposit_zat)) {
      recordAnchor(a.id, o.memo, o);
    }
    if (m.type === 'payment') {
      const r = parseJSON(getAuction(a.id).result, {});
      if (r.settleByHeight == null || o.height <= r.settleByHeight) recordPayment(a.id, o.memo, o);
    }
  }
  walletSummaries.set(a.id, { tip: wallet.tip, refunds: { count: refundCount, totalZat: String(refunds) }, syncedAt: now() });
}

export async function setUpWallet(id, ufvk) {
  return initWallet(id, ufvk);
}

const syncing = new Set();
async function syncAuction(a) {
  if (syncing.has(a.id)) return;
  syncing.add(a.id);
  try {
    await syncWallet(a.id, a.mode);
    const w = readWallet(a.id);
    if (w) ingest(a, w);
  } catch (err) {
    console.error(`[sync ${a.id}]`, err.message);
  } finally {
    syncing.delete(a.id);
  }
}

// ------------------------------------------------------------------ tick

export async function tick() {
  const live = db.prepare("SELECT * FROM auctions WHERE status IN ('open','closing','settling','settling_retry','paid')").all();
  for (const a of live) {
    if (a.mode !== 'sandbox') await syncAuction(a);
    const cur = getAuction(a.id);
    const r = parseJSON(cur.result, {});
    if (cur.status === 'open') {
      const due = cur.mode === 'sandbox' ? now() >= cur.ends_at : (tipFor(cur.mode)?.tip || 0) >= cur.end_height + CONFIRMATIONS;
      if (due) closeAuction(cur.id);
    } else if (cur.status === 'settling_retry' || cur.status === 'closing') {
      // closeAuction ignores the call if a session for this auction is already running;
      // this resumes one interrupted by a restart.
      closeAuction(cur.id);
    } else if (cur.status === 'settling') {
      const late = cur.mode === 'sandbox' ? now() > r.settleBy : (tipFor(cur.mode)?.tip || 0) > r.settleByHeight;
      if (late) fallBack(cur.id);
    }
  }
}

export function startLoop(intervalMs = 20_000) {
  const loop = async () => {
    try { await tick(); } catch (err) { console.error('[tick]', err); }
    setTimeout(loop, intervalMs);
  };
  setTimeout(loop, 2_000);
}
