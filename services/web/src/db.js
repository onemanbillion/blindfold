import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || './data';
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'blindfold.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS auctions (
    id TEXT PRIMARY KEY,
    created REAL NOT NULL,
    mode TEXT NOT NULL,              -- 'sandbox' | 'main' | 'test'
    item TEXT NOT NULL,              -- JSON {collection, tokenId, title, description, image, link}
    seller_address TEXT NOT NULL,
    ufvk TEXT,                       -- published viewing key (real auctions)
    seller_pub TEXT NOT NULL,        -- x25519 key bidders seal their address to
    seller_token_hash TEXT NOT NULL,
    deposit_zat TEXT NOT NULL,
    min_bid_zat TEXT NOT NULL,
    reserve_zat TEXT NOT NULL DEFAULT '0',
    start_height INTEGER, end_height INTEGER, settle_blocks INTEGER,
    ends_at REAL,                    -- sandbox: wall-clock close
    settle_seconds INTEGER,
    status TEXT NOT NULL,            -- open | closing | settling | paid | no_sale | failed
    result TEXT,                     -- JSON from the MPC session(s)
    excluded TEXT NOT NULL DEFAULT '[]',
    payment TEXT,                    -- JSON {txid, height, valueZat}
    closed_at REAL,
    delivered INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS anchors (
    auction TEXT NOT NULL,
    bid_id TEXT NOT NULL,
    commitments TEXT NOT NULL,       -- JSON [c0,c1,c2]
    sealed_contact TEXT,
    txid TEXT, height INTEGER, value_zat TEXT,
    seen REAL NOT NULL,
    PRIMARY KEY (auction, bid_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    auction TEXT NOT NULL, at REAL NOT NULL, kind TEXT NOT NULL, detail TEXT
  );
  CREATE TABLE IF NOT EXISTS chain (network TEXT PRIMARY KEY, tip INTEGER, at REAL);
`);

export function logEvent(auction, kind, detail = null) {
  db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(auction, Date.now() / 1000, kind, detail ? JSON.stringify(detail) : null);
}

export function getAuction(id) {
  return db.prepare('SELECT * FROM auctions WHERE id = ?').get(id);
}

export function anchorsFor(id) {
  return db.prepare('SELECT * FROM anchors WHERE auction = ? ORDER BY COALESCE(height, 0), seen, txid').all(id);
}

export function tipFor(network) {
  return db.prepare('SELECT tip, at FROM chain WHERE network = ?').get(network) || null;
}

export function setTip(network, tip) {
  db.prepare('INSERT INTO chain VALUES (?,?,?) ON CONFLICT(network) DO UPDATE SET tip=excluded.tip, at=excluded.at')
    .run(network, tip, Date.now() / 1000);
}
