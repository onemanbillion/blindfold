// Chain watcher: follows each real auction's shielded address through its published
// viewing key, using zcash-devtool as a view-only light client (it can never spend).
//
// Each auction gets its own wallet directory. zcash-devtool keeps the decrypted
// transactions in SQLite, which we read directly.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './db.js';

const BIN = process.env.ZCASH_DEVTOOL || 'zcash-devtool';
// lightwalletd servers: 'zecrocks', 'ywallet', or a comma-separated host:port list.
const SERVERS = { main: process.env.LIGHTWALLETD_MAIN || 'zecrocks', test: process.env.LIGHTWALLETD_TEST || 'zecrocks' };
const serverArgs = (net) => ['-s', SERVERS[net] || 'zecrocks'];
const WALLETS = join(DATA_DIR, 'wallets');
mkdirSync(WALLETS, { recursive: true });

export const watcherAvailable = () =>
  new Promise((resolve) => execFile(BIN, ['--help'], (err) => resolve(!err)));

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`zcash-devtool ${args[3] || ''} failed: ${(stderr || err.message).slice(-600)}`));
      else resolve(stdout);
    });
  });
}

const walletDir = (id) => join(WALLETS, id);

/** Network implied by a viewing key or address prefix. */
export function networkOf(s) {
  if (/^(uviewtest|utest|ztestsapling|zxviewtestsapling|tm)/.test(s)) return 'test';
  if (/^(uview|u1|zs|zxviews|t1|t3)/.test(s)) return 'main';
  return null;
}

/** Create a view-only wallet for an auction; its birthday is the current chain tip. */
export async function initWallet(id, ufvk) {
  const dir = walletDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  await run(['wallet', '-w', dir, 'init-fvk', '--name', `auction-${id}`, '--fvk', ufvk, ...serverArgs(networkOf(ufvk))], 120_000);
  const conn = new DatabaseSync(join(dir, 'data.sqlite'), { readOnly: true });
  try {
    const row = conn.prepare('SELECT birthday_height AS h FROM accounts LIMIT 1').get();
    return { birthday: Number(row.h) };
  } finally {
    conn.close();
  }
}

/** Operator self-test: a throwaway wallet whose viewing key can seed a test auction. */
export async function createTestnetWallet(net = 'test') {
  const id = `selftest-${net}-${Date.now()}`;
  const dir = join(WALLETS, id);
  await run(['wallet', '-w', dir, 'init', '--name', 'selftest', '-i', join(dir, '..', `${id}.age`), '-n', net, ...serverArgs(net)], 120_000);
  const accounts = await run(['wallet', '-w', dir, 'list-accounts'], 30_000);
  const addresses = await run(['wallet', '-w', dir, 'list-addresses'], 30_000);
  const ufvk = accounts.match(/(uview(?:test)?1[0-9a-z]+)/)?.[1];
  const address = addresses.match(/Default Address: (u(?:test)?1[0-9a-z]+)/)?.[1];
  return { ufvk, address, accounts, addresses };
}

export async function syncWallet(id, net) {
  await run(['wallet', '-w', walletDir(id), 'sync', ...serverArgs(net)], 15 * 60_000);
}

function decodeMemo(blob) {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (!bytes.length || bytes[0] > 0xf4) return null; // empty or non-text memo
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

const displayTxid = (blob) => Buffer.from(blob).reverse().toString('hex');

/** Read the chain tip and every output this viewing key can see. */
export function readWallet(id) {
  const file = join(walletDir(id), 'data.sqlite');
  if (!existsSync(file)) return null;
  const conn = new DatabaseSync(file, { readOnly: true });
  try {
    let tip = 0;
    try {
      tip = Math.max(tip, Number(conn.prepare('SELECT MAX(block_range_end) - 1 AS h FROM scan_queue').get()?.h || 0));
    } catch { /* older schema */ }
    tip = Math.max(tip, Number(conn.prepare('SELECT MAX(height) AS h FROM blocks').get()?.h || 0));
    const rows = conn.prepare(`
      SELECT t.txid AS txid, t.mined_height AS height, o.value AS value, o.memo AS memo,
             o.to_account_uuid AS to_acct, o.from_account_uuid AS from_acct, o.is_change AS is_change,
             o.to_address AS to_address
      FROM v_tx_outputs o JOIN v_transactions t ON t.txid = o.txid
    `).all();
    const outputs = rows.map((r) => ({
      txid: displayTxid(r.txid),
      height: r.height == null ? null : Number(r.height),
      valueZat: String(r.value),
      memo: decodeMemo(r.memo),
      incoming: r.to_acct != null && r.from_acct == null,
      outgoing: r.from_acct != null && !r.is_change && r.to_acct == null,
    }));
    return { tip, outputs };
  } finally {
    conn.close();
  }
}
