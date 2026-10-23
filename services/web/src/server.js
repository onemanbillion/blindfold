import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newAuctionId, newSellerKey, zecToZat, parseMemo } from '@blindfold/core';
import { db, getAuction, anchorsFor, tipFor, logEvent } from './db.js';
import {
  closeAuction, partyPublicUrls, recordAnchor, recordPayment, setUpWallet, startLoop, walletSummaries,
} from './coordinator.js';
import { createTestnetWallet, networkOf, watcherAvailable } from './watcher.js';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const BLOCK_SECONDS = Number(process.env.BLOCK_SECONDS || 75);
const REAL_ENABLED = process.env.REAL_AUCTIONS !== 'off';
let watcherOk = false;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const now = () => Date.now() / 1000;

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function requireSeller(a, token) {
  if (!token || sha(token) !== a.seller_token_hash) throw new HttpError(403, 'seller token does not match');
}

function publicAuction(a, { full = false } = {}) {
  const tip = a.mode === 'sandbox' ? null : tipFor(a.mode)?.tip ?? null;
  const result = a.result ? JSON.parse(a.result) : null;
  const bids = db.prepare('SELECT COUNT(*) AS n FROM anchors WHERE auction=?').get(a.id).n;
  let endsAt = a.ends_at;
  if (a.mode !== 'sandbox' && tip) endsAt = now() + Math.max(0, a.end_height - tip) * BLOCK_SECONDS;
  const out = {
    id: a.id,
    mode: a.mode,
    item: JSON.parse(a.item),
    status: a.status,
    bids,
    depositZat: a.deposit_zat,
    minBidZat: a.min_bid_zat,
    hasReserve: BigInt(a.reserve_zat || '0') > 0n,
    endsAt,
    endHeight: a.end_height,
    tip,
    result: result && {
      winner: result.winner || null,
      amountZat: result.amountZat || null,
      noSale: result.noSale || null,
      defaulted: result.defaulted || [],
      settleBy: result.settleBy || null,
      settleByHeight: result.settleByHeight || null,
      sessions: result.sessions || [],
    },
    payment: a.payment ? JSON.parse(a.payment) : null,
    delivered: !!a.delivered,
    featured: !!a.featured,
    created: a.created,
  };
  if (full) {
    Object.assign(out, {
      sellerAddress: a.seller_address,
      viewingKey: a.ufvk,
      sellerPublicKey: a.seller_pub,
      startHeight: a.start_height,
      settleBlocks: a.settle_blocks,
      settleSeconds: a.settle_seconds,
      blockSeconds: BLOCK_SECONDS,
      parties: partyPublicUrls(),
      wallet: walletSummaries.get(a.id) || null,
      anchors: anchorsFor(a.id).map((x) => ({
        bidId: x.bid_id, commitments: JSON.parse(x.commitments), sealedContact: x.sealed_contact,
        txid: x.txid, height: x.height, seen: x.seen,
      })),
      events: db.prepare('SELECT at, kind, detail FROM events WHERE auction=? ORDER BY at').all(a.id)
        .map((e) => ({ at: e.at, kind: e.kind, detail: e.detail ? JSON.parse(e.detail) : null })),
    });
  }
  return out;
}

const ITEM_IMAGE = (id) => `https://zilkroad.com/api/art/${id}?fmt=webp`;

function normalizeItem(item = {}) {
  const collection = String(item.collection || 'zkSNARKs').slice(0, 60);
  if (collection === 'zkSNARKs') {
    const tokenId = Number(item.tokenId);
    if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId > 9999) throw new HttpError(400, 'zkSNARKs token ID must be 0 to 9999');
    return {
      collection, tokenId,
      title: `zkSNARK #${tokenId}`,
      description: String(item.description || '').slice(0, 600),
      image: ITEM_IMAGE(tokenId),
      link: 'https://zilkroad.com/market',
    };
  }
  const image = String(item.image || '');
  if (image && !/^https:\/\//.test(image)) throw new HttpError(400, 'image must be an https URL');
  return {
    collection, tokenId: null,
    title: String(item.title || '').slice(0, 80) || 'Untitled lot',
    description: String(item.description || '').slice(0, 600),
    image, link: String(item.link || '').slice(0, 300),
  };
}

// ------------------------------------------------------------------ routes

async function createAuction(req) {
  const b = await body(req);
  const mode = b.mode === 'sandbox' ? 'sandbox' : 'real';
  const item = normalizeItem(b.item);
  const sellerPub = String(b.sellerPublicKey || '');
  if (!/^[0-9a-f]{64}$/.test(sellerPub)) throw new HttpError(400, 'seller public key missing');
  let deposit; let minBid; let reserve;
  try {
    deposit = zecToZat(b.depositZec ?? '0.001');
    minBid = zecToZat(b.minBidZec ?? '0.01');
    reserve = zecToZat(b.reserveZec || '0');
  } catch (e) { throw new HttpError(400, e.message); }
  if (deposit < 1000n) throw new HttpError(400, 'deposit must be at least 0.00001 ZEC so wallets will send it');
  const id = newAuctionId();
  const sellerToken = randomBytes(24).toString('hex');
  const base = {
    id, created: now(), item: JSON.stringify(item), seller_pub: sellerPub, seller_token_hash: sha(sellerToken),
    deposit_zat: String(deposit), min_bid_zat: String(minBid), reserve_zat: String(reserve),
  };

  if (mode === 'sandbox') {
    const minutes = Math.min(Math.max(Number(b.durationMinutes) || 30, 2), 60 * 24 * 7);
    db.prepare(`INSERT INTO auctions (id, created, mode, item, seller_address, seller_pub, seller_token_hash,
      deposit_zat, min_bid_zat, reserve_zat, ends_at, settle_seconds, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open')`).run(
      id, base.created, 'sandbox', base.item, 'sandbox', sellerPub, base.seller_token_hash,
      base.deposit_zat, base.min_bid_zat, base.reserve_zat, now() + minutes * 60, Math.min(minutes * 60, 3600));
  } else {
    if (!REAL_ENABLED || !watcherOk) throw new HttpError(503, 'on-chain auctions are not enabled on this server');
    const address = String(b.sellerAddress || '').trim();
    const ufvk = String(b.viewingKey || '').trim();
    const net = networkOf(ufvk);
    if (!/^uview/.test(ufvk) || !net) throw new HttpError(400, 'a unified full viewing key (uview1… or uviewtest1…) is required');
    if (networkOf(address) !== net || !/^u/.test(address)) throw new HttpError(400, 'the address must be a unified address on the same network as the viewing key');
    const blocks = Math.min(Math.max(Number(b.durationBlocks) || 1152, 24), 8064);
    const settleBlocks = Math.min(Math.max(Number(b.settleBlocks) || 576, 48), 4032);
    let birthday;
    try {
      ({ birthday } = await setUpWallet(id, ufvk));
    } catch (e) { throw new HttpError(400, `could not load that viewing key: ${e.message.slice(0, 200)}`); }
    db.prepare(`INSERT INTO auctions (id, created, mode, item, seller_address, ufvk, seller_pub, seller_token_hash,
      deposit_zat, min_bid_zat, reserve_zat, start_height, end_height, settle_blocks, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open')`).run(
      id, base.created, net, base.item, address, ufvk, sellerPub, base.seller_token_hash,
      base.deposit_zat, base.min_bid_zat, base.reserve_zat, birthday, birthday + blocks, settleBlocks);
    db.prepare('INSERT INTO chain VALUES (?,?,?) ON CONFLICT(network) DO UPDATE SET tip=MAX(tip, excluded.tip), at=excluded.at')
      .run(net, birthday, now());
  }
  logEvent(id, 'created', { mode });
  return { auction: publicAuction(getAuction(id), { full: true }), sellerToken };
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = (re) => p.match(re);
  let g;

  if (req.method === 'GET' && p === '/api/config') {
    return send(res, 200, { parties: partyPublicUrls(), realAuctions: REAL_ENABLED && watcherOk, blockSeconds: BLOCK_SECONDS });
  }
  if (req.method === 'GET' && p === '/api/auctions') {
    const rows = db.prepare('SELECT * FROM auctions ORDER BY featured DESC, created DESC LIMIT 200').all();
    return send(res, 200, rows.map((a) => publicAuction(a)));
  }
  if (req.method === 'POST' && p === '/api/auctions') return send(res, 201, await createAuction(req));
  if (req.method === 'POST' && p === '/api/admin/testnet-wallet') {
    // Operator self-test: create a throwaway testnet wallet to exercise the watcher end to end.
    if (!process.env.ADMIN_TOKEN || req.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`) throw new HttpError(403, 'admin only');
    return send(res, 200, await createTestnetWallet());
  }
  if (req.method === 'POST' && p === '/api/admin/selftest') {
    if (!process.env.ADMIN_TOKEN || req.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`) throw new HttpError(403, 'admin only');
    const out = await runSelftest();
    return send(res, out.ok ? 200 : 500, out);
  }

  if ((g = m(/^\/api\/auctions\/([a-z0-9]+)(\/.*)?$/))) {
    const a = getAuction(g[1]);
    if (!a) throw new HttpError(404, 'no auction with that ID');
    const sub = g[2] || '';
    if (req.method === 'GET' && sub === '') return send(res, 200, publicAuction(a, { full: true }));

    if (req.method === 'POST' && sub === '/sandbox/anchor') {
      if (a.mode !== 'sandbox') throw new HttpError(400, 'only sandbox auctions accept simulated deposits');
      if (a.status !== 'open' || now() >= a.ends_at) throw new HttpError(409, 'bidding has closed');
      const { memo } = await body(req);
      const r = recordAnchor(a.id, memo, { valueZat: a.deposit_zat, txid: `sandbox-${randomBytes(8).toString('hex')}` });
      if (!r.ok) throw new HttpError(400, r.reason);
      return send(res, 200, r);
    }
    if (req.method === 'POST' && sub === '/sandbox/pay') {
      if (a.mode !== 'sandbox') throw new HttpError(400, 'only sandbox auctions accept simulated payments');
      const { memo, amountZec } = await body(req);
      let valueZat;
      try { valueZat = String(zecToZat(amountZec)); } catch (e) { throw new HttpError(400, e.message); }
      const r = recordPayment(a.id, memo, { valueZat, txid: `sandbox-${randomBytes(8).toString('hex')}` });
      if (!r.ok) throw new HttpError(400, r.reason);
      return send(res, 200, r);
    }
    if (req.method === 'POST' && sub === '/end-now') {
      const { sellerToken } = await body(req);
      requireSeller(a, sellerToken);
      if (a.mode !== 'sandbox') throw new HttpError(400, 'on-chain auctions end at their block height');
      if (a.status !== 'open') throw new HttpError(409, 'auction is not open');
      db.prepare('UPDATE auctions SET ends_at=? WHERE id=?').run(now(), a.id);
      closeAuction(a.id);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sub === '/delivered') {
      const { sellerToken } = await body(req);
      requireSeller(a, sellerToken);
      if (a.status !== 'paid') throw new HttpError(409, 'the winner has not paid yet');
      db.prepare('UPDATE auctions SET delivered=1 WHERE id=?').run(a.id);
      logEvent(a.id, 'delivered');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sub === '/cancel') {
      const { sellerToken } = await body(req);
      requireSeller(a, sellerToken);
      if (a.status !== 'open') throw new HttpError(409, 'only open auctions can be cancelled');
      if (anchorsFor(a.id).length) throw new HttpError(409, 'bids are already sealed; the auction must run to its close');
      db.prepare("UPDATE auctions SET status='cancelled' WHERE id=?").run(a.id);
      logEvent(a.id, 'cancelled');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sub === '/memo-check') {
      const { memo } = await body(req);
      return send(res, 200, { parsed: parseMemo(memo) });
    }
  }
  throw new HttpError(404, 'not found');
}

// ------------------------------------------------------------------ static files

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2',
};

async function serveStatic(res, pathname) {
  let file = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) file = join(PUBLIC, 'index.html');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(PUBLIC, 'index.html'); // single-page app fallback
  }
  const data = await readFile(file);
  const type = TYPES[extname(file)] || 'application/octet-stream';
  const cache = /\.(js|css|woff2|svg|png)$/.test(file) && !file.endsWith('index.html') ? 'public, max-age=300' : 'no-cache';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  res.end(data);
}

/** Operator self-test: run the sandbox end-to-end script against this deployment. */
function runSelftest() {
  const script = fileURLToPath(new URL('../../../scripts/e2e-sandbox.mjs', import.meta.url));
  return new Promise((resolve) => execFile(process.execPath, [script],
    { env: { ...process.env, BASE: `http://127.0.0.1:${PORT}` }, timeout: 280_000 },
    (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.slice(-4000) })));
}

// ------------------------------------------------------------------ demo lots

function seedSandboxLots() {
  const lots = [
    { tokenId: 7539, hours: 0.75 },
    { tokenId: 9555, hours: 6 },
    { tokenId: 6415, hours: 26 },
    { tokenId: 8974, hours: 50 },
    { tokenId: 1910, hours: 74 },
    { tokenId: 2346, hours: 98 },
  ];
  for (const lot of lots) {
    const live = db.prepare(`SELECT COUNT(*) AS n FROM auctions WHERE featured=1
      AND json_extract(item, '$.tokenId') = ? AND (status IN ('open','closing','settling','settling_retry')
      OR closed_at > ?)`).get(lot.tokenId, now() - 6 * 3600).n;
    if (live) continue;
    const id = newAuctionId();
    const key = newSellerKey();
    const item = normalizeItem({
      collection: 'zkSNARKs', tokenId: lot.tokenId,
      description: 'Sandbox lot: bidding runs the real secret-sharing and three-party computation, but deposits and payments are simulated. No ZEC moves and the identity is not transferred.',
    });
    db.prepare(`INSERT INTO auctions (id, created, mode, item, seller_address, seller_pub, seller_token_hash,
      deposit_zat, min_bid_zat, reserve_zat, ends_at, settle_seconds, status, featured)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',1)`).run(
      id, now(), 'sandbox', JSON.stringify(item), 'sandbox', key.publicKey, sha(randomBytes(24).toString('hex')),
      '100000', '50000000', '0', now() + lot.hours * 3600, 1800);
    logEvent(id, 'created', { mode: 'sandbox', seeded: true });
  }
}

// ------------------------------------------------------------------ server

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await route(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    return await serveStatic(res, url.pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    send(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  }
}).listen(PORT, async () => {
  watcherOk = await watcherAvailable();
  console.log(`Blindfold web on :${PORT} (watcher ${watcherOk ? 'ready' : 'unavailable'}, parties ${partyPublicUrls().length})`);
  seedSandboxLots();
  setInterval(seedSandboxLots, 10 * 60_000);
  startLoop();
  if (process.env.SELFTEST_ON_BOOT === '1') {
    setTimeout(async () => {
      const r = await runSelftest();
      console.log(`[selftest] ${r.ok ? 'PASSED' : 'FAILED'}\n${r.output}`);
      if (!watcherOk) return;
      try {
        // Watcher check: a throwaway testnet account becomes a real (testnet) auction.
        const w = await createTestnetWallet();
        const key = newSellerKey();
        const res = await fetch(`http://127.0.0.1:${PORT}/api/auctions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'real', item: { collection: 'zkSNARKs', tokenId: 42, description: 'Operator self-test on Zcash testnet.' },
            sellerPublicKey: key.publicKey, sellerAddress: w.address, viewingKey: w.ufvk, durationBlocks: 48 }),
        });
        const d = await res.json();
        console.log(`[selftest] testnet auction ${res.ok ? d.auction.id : 'FAILED'} ${res.ok ? `birthday ${d.auction.startHeight}` : d.error}`);
      } catch (err) { console.log('[selftest] watcher FAILED', err.message); }
    }, 15_000);
  }
});
