import QRCode from 'qrcode';
import {
  createBid, shamirShare, zecToZat, zatToZec, zip321, encodeReceipt, decodeReceipt,
  encodePaymentMemo, newSellerKey, unseal, deriveBidId,
} from '@blindfold/core';

// ------------------------------------------------------------------ utilities

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const zec = (zat) => `${zatToZec(zat)} ZEC`;
const short = (s, n = 8) => (s && s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-4)}` : s || '');

let config = { parties: [], realAuctions: false, blockSeconds: 75 };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

const myBids = () => store.get('bf.bids', []);
function saveBid(entry) {
  const all = myBids().filter((b) => b.bidId !== entry.bidId);
  all.unshift(entry);
  store.set('bf.bids', all);
}
const sellerSecrets = (id) => store.get(`bf.seller.${id}`, null);

function countdown(endsAt) {
  const s = Math.max(0, Math.round(endsAt - Date.now() / 1000));
  if (s === 0) return 'closing now';
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  if (d) return `${d}d ${h}h left`;
  if (h) return `${h}h ${m}m left`;
  return `${m}m ${String(sec).padStart(2, '0')}s left`;
}
setInterval(() => $$('[data-ends]').forEach((el) => { el.textContent = countdown(Number(el.dataset.ends)); }), 1000);

function copyButton(text, label = 'Copy') {
  const id = `c${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => {
    const b = document.getElementById(id);
    if (b) b.onclick = async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Copy failed'; }
      setTimeout(() => { b.textContent = label; }, 1600);
    };
  });
  return `<button type="button" class="btn quiet small" id="${id}">${label}</button>`;
}

async function qrInto(el, uri) {
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, uri, { margin: 1, width: 400, errorCorrectionLevel: 'L' });
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Payment QR code for your Zcash wallet');
  el.replaceChildren(canvas);
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const modeLabel = (m) => ({ sandbox: 'Sandbox', main: 'Mainnet', test: 'Testnet' }[m] || m);
const statusLine = (a) => ({
  open: a.endsAt ? null : 'Open',
  closing: 'Computing the winner',
  settling: 'Awaiting payment',
  settling_retry: 'Computing the winner',
  paid: a.delivered ? 'Sold and delivered' : 'Sold, payment verified',
  no_sale: 'No sale',
  failed: 'Needs operator attention',
  cancelled: 'Cancelled',
}[a.status]);

function art(item, mode, big = false) {
  const img = item.image
    ? `<img src="${esc(item.image)}" alt="${esc(item.title)}" loading="${big ? 'eager' : 'lazy'}" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  const tag = item.tokenId != null ? `<span class="tag">#${esc(item.tokenId)}</span>` : '';
  return `<div class="plinth">${img}<span class="noimg" aria-hidden="true"></span>${tag}<span class="mode">${modeLabel(mode)}</span></div>`;
}

// ------------------------------------------------------------------ home

async function viewHome() {
  main.innerHTML = `
    <section class="hero">
      <div>
        <h1>Sealed bids nobody can open.</h1>
        <p class="lede">Bid on zkSNARKs and other Zcash collectibles without revealing your number to anyone: not other bidders, not the seller, not us. Only the winning price ever comes out.</p>
        <div class="row"><a class="btn" href="#lots">Browse lots</a><a class="btn quiet" href="#/how">How it works</a></div>
      </div>
      <div class="splitter" aria-labelledby="split-title">
        <h3 id="split-title">Live example. Type any bid.</h3>
        <div class="amount"><input id="demo-amt" inputmode="decimal" value="1.75" aria-label="Example bid in ZEC"><span>ZEC</span></div>
        <p class="caption">Your browser splits it into three random numbers, one per keyholder:</p>
        <div class="keyholders" id="demo-shares"></div>
        <p class="verdict">Each number alone reveals nothing. Together, the keyholders compare bids without reconstructing them and reveal only the winner.</p>
      </div>
    </section>
    <section id="lots">
      <div class="section-head">
        <h2>Open lots</h2>
        <p>Sandbox lots run the real cryptography with simulated payments.</p>
      </div>
      <div class="lots" id="open-lots"><p class="muted">Loading lots…</p></div>
      <div class="section-head" style="margin-top:64px"><h2>Recently closed</h2></div>
      <div class="lots" id="closed-lots"></div>
    </section>
    <section class="steps" aria-label="How a sealed bid works">
      <ol>
        <li><span class="step-num">Step 1</span><h3>Seal</h3><p>Your browser splits your bid into three shares and sends one to each keyholder. A tiny deposit from your own wallet anchors the bid on Zcash.</p></li>
        <li><span class="step-num">Step 2</span><h3>Compare blind</h3><p>At the closing block, the keyholders run a secure computation over their shares. Out comes one thing: the winning bid and its amount.</p></li>
        <li><span class="step-num">Step 3</span><h3>Settle in the open</h3><p>The winner pays from any Zcash wallet. Anyone can check the payment matches through the auction's published viewing key.</p></li>
      </ol>
    </section>`;

  const input = $('#demo-amt');
  const render = () => {
    let zat;
    try { zat = zecToZat(input.value || '0'); } catch { return; }
    const shares = shamirShare(zat);
    const ops = config.partyOperators || ['Keyholder 1', 'Keyholder 2', 'Keyholder 3'];
    $('#demo-shares').innerHTML = shares.map((s, i) => `
      <div class="keyholder live"><span class="dot">${esc(ops[i] || `Keyholder ${i + 1}`)}</span>
        <div class="share">${s.toString()}</div></div>`).join('');
  };
  input.addEventListener('input', render);
  render();

  const auctions = await api('/api/auctions');
  const open = auctions.filter((a) => a.status === 'open').sort((x, y) => (x.endsAt || 9e12) - (y.endsAt || 9e12));
  const closed = auctions.filter((a) => a.status !== 'open' && a.status !== 'cancelled').slice(0, 8);
  const card = (a) => `
    <a class="lot" href="#/lot/${a.id}">
      ${art(a.item, a.mode)}
      <div class="meta"><h3>${esc(a.item.title)}</h3>
        <p>${a.status === 'open' ? `<span data-ends="${a.endsAt}">${countdown(a.endsAt)}</span> · ${a.bids} sealed bid${a.bids === 1 ? '' : 's'}`
          : a.result?.amountZat ? `${statusLine(a)} · ${zec(a.result.amountZat)}` : statusLine(a)}</p></div>
    </a>`;
  $('#open-lots').innerHTML = open.length ? open.map(card).join('') : '<p class="muted">No open lots right now. <a href="#/sell">List one</a>.</p>';
  $('#closed-lots').innerHTML = closed.length ? closed.map(card).join('') : '<p class="muted">Nothing has closed yet.</p>';
}

// ------------------------------------------------------------------ lot page

let lotTimer = null;

async function viewLot(id) {
  const a = await api(`/api/auctions/${id}`);
  const mine = myBids().filter((b) => b.auctionId === id);
  const anchored = new Set(a.anchors.map((x) => x.bidId));
  const ends = a.mode === 'sandbox' ? a.endsAt : a.endsAt;

  main.innerHTML = `
    <div class="auction">
      <div>${art(a.item, a.mode, true)}</div>
      <div>
        <div class="crumbs"><a href="#/">Lots</a> / ${esc(a.item.collection)}</div>
        <h1 style="font-size:clamp(1.9rem,3.6vw,2.6rem)">${esc(a.item.title)}</h1>
        ${a.item.description ? `<p class="muted">${esc(a.item.description)}</p>` : ''}
        <dl class="facts">
          <div><dt>${a.status === 'open' ? 'Closes' : 'Status'}</dt><dd>${a.status === 'open'
            ? `<span data-ends="${ends}">${countdown(ends)}</span>` : esc(statusLine(a))}</dd></div>
          <div><dt>Sealed bids</dt><dd>${a.bids}</dd></div>
          <div><dt>Minimum bid</dt><dd>${zec(a.minBidZat)}</dd></div>
        </dl>
        ${a.mode !== 'sandbox' ? `<p class="muted">Closes at block ${a.endHeight.toLocaleString()}${a.tip ? `; the chain is at ${a.tip.toLocaleString()}` : ''}. Times are estimates at ${a.blockSeconds} seconds per block.</p>` : ''}
        <div id="lot-action"></div>
        ${mine.length ? `<div class="panel"><h2>Your bids on this lot</h2><table><thead><tr><th>Bid</th><th>Amount</th><th>On-chain</th></tr></thead><tbody>
          ${mine.map((b) => `<tr><td class="mono">${b.bidId}</td><td>${zec(b.amountZat)}</td><td>${anchored.has(b.bidId) ? '<span class="ok">Sealed</span>' : 'Waiting for deposit'}</td></tr>`).join('')}
          </tbody></table><p class="muted">Receipts live in this browser. Keep a copy from <a href="#/bids">My bids</a>.</p></div>` : ''}
        ${auditPanel(a)}
      </div>
    </div>`;

  const box = $('#lot-action');
  if (a.status === 'open') renderBidForm(box, a);
  else renderOutcome(box, a, mine);

  clearInterval(lotTimer);
  lotTimer = setInterval(async () => {
    if (!location.hash.startsWith(`#/lot/${id}`)) return clearInterval(lotTimer);
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if ($('#lot-action [data-busy]')) return;
    const fresh = await api(`/api/auctions/${id}`).catch(() => null);
    if (fresh && (fresh.status !== a.status || fresh.bids !== a.bids || JSON.stringify(fresh.payment) !== JSON.stringify(a.payment))) viewLot(id);
  }, 8000);
}

function renderBidForm(box, a) {
  const real = a.mode !== 'sandbox';
  box.innerHTML = `
    <form class="panel" id="bid-form" novalidate>
      <h2>Place a sealed bid</h2>
      ${real ? '' : '<div class="banner sandbox">Sandbox lot: the bid is genuinely split and computed blind, but the deposit and payment are simulated. No ZEC moves.</div>'}
      <div class="field">
        <label for="bid-amt">Your bid</label>
        <div class="amount"><input id="bid-amt" inputmode="decimal" placeholder="${zatToZec(a.minBidZat)}" required><span>ZEC</span></div>
        <span class="hint">Minimum ${zec(a.minBidZat)}. If you win, you pay exactly this. You can bid again later; each bid needs its own deposit.</span>
      </div>
      <div class="field">
        <label for="bid-addr">Your shielded address ${real ? '' : '<span class="hint" style="display:inline">(optional in the sandbox)</span>'}</label>
        <input id="bid-addr" autocomplete="off" spellcheck="false" placeholder="u1…" ${real ? 'required' : ''}>
        <span class="hint">Encrypted so only the seller can read it: they use it to refund your deposit and to deliver the item if you win.</span>
      </div>
      <button class="btn" type="submit">Seal my bid</button>
      <p class="error" id="bid-err" role="alert"></p>
    </form>`;

  $('#bid-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#bid-err');
    err.textContent = '';
    let amountZat;
    try { amountZat = zecToZat($('#bid-amt').value); } catch { err.textContent = 'Enter an amount in ZEC, like 1.5'; return; }
    if (amountZat < BigInt(a.minBidZat)) { err.textContent = `The minimum bid is ${zec(a.minBidZat)}.`; return; }
    const contact = $('#bid-addr').value.trim();
    if (real && !/^u1[0-9a-z]{60,}$/.test(contact) && !/^utest1[0-9a-z]{60,}$/.test(contact)) { err.textContent = 'Paste a unified shielded address from your wallet (starts with u1).'; return; }
    let bid;
    try {
      bid = createBid({ auctionId: a.id, amountZat, sellerPublicKey: a.sellerPublicKey, contactAddress: contact || undefined });
    } catch (ex) { err.textContent = ex.message.includes('memo') ? 'That address is too long to fit in a memo. Use an Orchard-only address.' : ex.message; return; }
    sealFlow(box, a, bid, amountZat);
  };
}

async function sealFlow(box, a, bid, amountZat) {
  const real = a.mode !== 'sandbox';
  box.innerHTML = `
    <div class="panel" data-busy>
      <h2>Sealing your bid</h2>
      <ol class="flow">
        <li class="now" id="f1"><span class="n">1</span><span>Send one share to each keyholder</span></li>
        <li id="f2"><span class="n">2</span><span>Save your receipt</span></li>
        <li id="f3"><span class="n">3</span><span>${real ? 'Send the deposit from your wallet' : 'Simulate the deposit'}</span></li>
      </ol>
      <div class="nodes">${[0, 1, 2].map((i) => `<div class="node" id="node${i}"><b>Keyholder ${i + 1}</b>sending…</div>`).join('')}</div>
      <div id="seal-body"></div>
    </div>`;

  const results = await Promise.allSettled(bid.packets.map(async (p, i) => {
    const url = a.parties[i];
    if (!url) throw new Error('not configured');
    const res = await fetch(`${url}/v1/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
    const node = $(`#node${i}`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      node.className = 'node fail'; node.innerHTML = `<b>Keyholder ${i + 1}</b>${esc(d.detail || 'refused')}`;
      throw new Error(d.detail || `keyholder ${i + 1} refused the share`);
    }
    node.className = 'node sent';
    node.innerHTML = `<b>Keyholder ${i + 1}</b>share stored`;
  }));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) {
    $('#seal-body').innerHTML = `<p class="error">Your bid was not placed: ${esc(failed.reason.message)}. Nothing was sent to the chain, so you can simply try again.</p><button class="btn quiet" id="retry">Back</button>`;
    $('#retry').onclick = () => renderBidForm(box, a);
    return;
  }
  $('#f1').className = 'done';
  $('#f2').className = 'now';

  const receiptText = encodeReceipt(bid.receipt);
  saveBid({ auctionId: a.id, bidId: bid.bidId, amountZat: String(amountZat), receipt: receiptText, memo: bid.memo, title: a.item.title, created: Date.now() });

  const uri = zip321([{ address: a.sellerAddress, amountZat: a.depositZat, memo: bid.memo, message: `Blindfold bid ${bid.bidId}` }]);
  $('#seal-body').innerHTML = `
    <p>Your receipt is saved in this browser. It's the only proof the bid is yours, so keep a copy too.</p>
    <div class="row" style="margin-bottom:22px"><button class="btn quiet small" id="dl-receipt">Download receipt</button>${copyButton(receiptText, 'Copy receipt')}</div>
    ${real ? `
      <h3>Send the ${zec(a.depositZat)} deposit</h3>
      <div class="qr"><div id="qr"></div><div>
        <p>Scan with Zodl, Zingo, Ywallet or any Zcash wallet. The memo is filled in for you: it carries your encrypted shares' fingerprints, not your bid. Send from a shielded balance.</p>
        <p><a class="btn small" href="${esc(uri)}">Open in wallet</a></p>
        <div class="copyline"><span>${esc(uri)}</span>${copyButton(uri)}</div>
        <p class="hint" style="margin-top:10px">Your bid counts once the deposit is mined before block ${a.endHeight.toLocaleString()}. This page updates on its own.</p>
      </div></div>`
    : `<button class="btn" id="sim-dep">Simulate the ${zec(a.depositZat)} deposit</button><p class="hint">On a real lot, you'd scan a QR code here and your wallet would send the deposit with this memo:</p><div class="keybox">${esc(bid.memo)}</div>`}
    <p class="error" id="dep-err"></p>`;
  $('#dl-receipt').onclick = () => download(`blindfold-${a.id}-${bid.bidId}.txt`, `${receiptText}\n`);
  $('#f2').className = 'done';
  $('#f3').className = 'now';
  if (real) qrInto($('#qr'), uri);
  else $('#sim-dep').onclick = async () => {
    try {
      await api(`/api/auctions/${a.id}/sandbox/anchor`, { method: 'POST', body: { memo: bid.memo } });
      viewLot(a.id);
    } catch (ex) { $('#dep-err').textContent = ex.message; }
  };
  box.firstElementChild.removeAttribute('data-busy');
}

function renderOutcome(box, a, mine) {
  const r = a.result || {};
  const winner = r.winner && mine.find((b) => b.bidId === r.winner);
  if (a.status === 'closing' || a.status === 'settling_retry') {
    box.innerHTML = `<div class="panel"><h2>Bidding has closed</h2><p>The three keyholders are comparing the sealed bids. This usually takes under a minute.</p></div>`;
    return;
  }
  if (a.status === 'no_sale' || a.status === 'failed' || a.status === 'cancelled') {
    box.innerHTML = `<div class="panel"><h2>${a.status === 'cancelled' ? 'Cancelled by the seller' : 'No sale'}</h2>
      <p>${esc(r.noSale?.reason ? `Reason: ${r.noSale.reason}.` : 'This lot did not sell.')} ${a.bids ? 'Every bid stays secret.' : ''}</p></div>`;
    return;
  }
  const amount = r.amountZat ? zec(r.amountZat) : '';
  const lost = mine.filter((b) => b.bidId !== r.winner);
  let html = `<div class="panel"><h2>${a.status === 'paid' ? 'Sold' : 'Winning bid'}</h2>
    <div class="result-amount">${amount}</div>
    <p>Bid <span class="mono">${esc(r.winner)}</span> won among ${r.sessions?.at(-1)?.bids ?? a.bids} sealed bids. No other amount was revealed.</p>`;
  if (r.defaulted?.length) html += `<p class="muted">The first winner did not pay in time, so the keyholders computed the next highest bid.</p>`;
  if (a.status === 'paid') {
    html += `<p class="ok">Payment verified${a.payment?.txid && !a.payment.txid.startsWith('sandbox') ? ` in transaction <span class="mono">${short(a.payment.txid, 10)}</span>` : ''}.</p>
      <p>${a.delivered ? 'The seller has marked the item as delivered.' : 'The seller transfers the item to the winner next.'}</p>`;
  } else {
    const deadline = r.settleBy ? `<span data-ends="${r.settleBy}">${countdown(r.settleBy)}</span>` : `block ${r.settleByHeight?.toLocaleString()}`;
    html += `<p class="muted">The winner has until ${deadline} to pay. If they don't, the next highest bid wins.</p>`;
  }
  if (lost.length) html += `<p class="muted">Your bid${lost.length > 1 ? 's' : ''} didn't win. ${lost.length > 1 ? 'They stay' : 'It stays'} secret: nobody will ever learn the amount.</p>`;
  html += '</div>';
  box.innerHTML = html;

  if (winner && a.status === 'settling') renderPayment(box, a, winner);
  else if (a.status === 'settling') {
    const pay = document.createElement('div');
    pay.className = 'panel';
    pay.innerHTML = `<h2>Won from another device?</h2><p>Paste your bid receipt to get the payment request.</p>
      <textarea id="paste-receipt" placeholder="bf1r:…" aria-label="Bid receipt"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn quiet" id="use-receipt">Use receipt</button></div><p class="error" id="rc-err"></p>`;
    box.append(pay);
    $('#use-receipt').onclick = () => {
      try {
        const rc = decodeReceipt($('#paste-receipt').value);
        if (rc.auctionId !== a.id) throw new Error('That receipt is for a different lot.');
        saveBid({ auctionId: a.id, bidId: rc.bidId, amountZat: rc.amountZat, receipt: $('#paste-receipt').value.trim(), title: a.item.title, created: Date.now() });
        viewLot(a.id);
      } catch (ex) { $('#rc-err').textContent = ex.message; }
    };
  }
}

function renderPayment(box, a, winner) {
  const rc = decodeReceipt(winner.receipt);
  const memo = encodePaymentMemo({ auctionId: a.id, bidId: rc.bidId, bidKey: rc.bidKey });
  const amount = a.result.amountZat;
  const real = a.mode !== 'sandbox';
  const uri = zip321([{ address: a.sellerAddress, amountZat: amount, memo, message: `Blindfold settlement ${a.id}` }]);
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<h2>You won. Pay to claim it.</h2>
    <p>Pay exactly ${zec(amount)}. The memo reveals your bid's secret key, which proves the payment comes from the winning bidder.</p>
    ${real ? `<div class="qr"><div id="pay-qr"></div><div>
        <p><a class="btn" href="${esc(uri)}">Open in wallet</a></p>
        <div class="copyline"><span>${esc(uri)}</span>${copyButton(uri)}</div>
        <p class="hint" style="margin-top:10px">Don't change the amount or memo: the verification is public and will fail.</p></div></div>`
    : `<button class="btn" id="sim-pay">Simulate paying ${zec(amount)}</button><div class="keybox" style="margin-top:12px">${esc(memo)}</div>`}
    <p class="error" id="pay-err"></p>`;
  box.append(panel);
  if (real) qrInto($('#pay-qr'), uri);
  else $('#sim-pay').onclick = async () => {
    try {
      await api(`/api/auctions/${a.id}/sandbox/pay`, { method: 'POST', body: { memo, amountZec: zatToZec(amount) } });
      viewLot(a.id);
    } catch (ex) { $('#pay-err').textContent = ex.message; }
  };
}

function auditPanel(a) {
  const sessions = a.result?.sessions || [];
  return `<details class="audit">
    <summary>Verify this auction yourself</summary>
    <p class="muted" style="margin-top:12px">Everything below is public. With the viewing key, any Zcash wallet or explorer that accepts one shows the same deposits and payment.</p>
    ${a.mode !== 'sandbox' ? `<h3>Viewing key</h3><div class="keybox">${esc(a.viewingKey)}</div><div class="row" style="margin:8px 0 18px">${copyButton(a.viewingKey, 'Copy viewing key')}</div>
      <h3>Seller's address</h3><div class="keybox">${esc(a.sellerAddress)}</div>` : ''}
    <h3 style="margin-top:18px">Keyholders</h3>
    <ul>${a.parties.map((u, i) => `<li><a href="${esc(u)}/v1/info" rel="noopener">Keyholder ${i + 1}</a> <span class="muted">${esc(new URL(u).host)}</span></li>`).join('')}</ul>
    <h3>Sealed bids on-chain</h3>
    ${a.anchors.length ? `<table><thead><tr><th>Bid</th><th>${a.mode === 'sandbox' ? 'Seen' : 'Block'}</th><th>Share fingerprints</th></tr></thead><tbody>
      ${a.anchors.map((x) => `<tr><td class="mono">${x.bidId}</td><td>${x.height ?? new Date(x.seen * 1000).toLocaleString()}</td><td class="mono">${x.commitments.map((c) => c.slice(0, 8)).join(' ')}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No sealed bids yet.</p>'}
    ${sessions.length ? `<h3>Blind comparisons</h3><table><thead><tr><th>Bids compared</th><th>Malformed</th><th>Winner</th><th>Amount</th></tr></thead><tbody>
      ${sessions.map((s) => `<tr><td>${s.bids}</td><td>${s.malformed.length}</td><td class="mono">${s.winner || '–'}</td><td>${s.amountZat ? zec(s.amountZat) : '–'}</td></tr>`).join('')}
      </tbody></table><p class="muted">All three keyholders returned the identical result; the site rejects any disagreement.</p>` : ''}
    ${a.wallet ? `<p class="muted">Deposit refunds sent by the seller so far: ${a.wallet.refunds.count} (${zec(a.wallet.refunds.totalZat)}).</p>` : ''}
  </details>`;
}

// ------------------------------------------------------------------ my bids

function viewBids() {
  const bids = myBids();
  main.innerHTML = `<div class="prose"><h1>My bids</h1>
    <p>Receipts are stored only in this browser. Each one holds your bid's amount and secret key, so treat it like a password.</p>
    ${bids.length ? `<table><thead><tr><th>Lot</th><th>Bid</th><th>Amount</th><th></th></tr></thead><tbody>
      ${bids.map((b, i) => `<tr><td><a href="#/lot/${b.auctionId}">${esc(b.title || b.auctionId)}</a></td><td class="mono">${b.bidId}</td><td>${zec(b.amountZat)}</td>
        <td><button class="btn quiet small" data-dl="${i}">Download</button></td></tr>`).join('')}</tbody></table>
      <button class="btn quiet" id="dl-all">Download all receipts</button>`
    : '<p class="muted">No bids from this browser yet.</p>'}
    <h2>Import a receipt</h2>
    <textarea id="imp" placeholder="bf1r:…" aria-label="Receipt to import"></textarea>
    <div class="row" style="margin-top:10px"><button class="btn quiet" id="imp-go">Import</button></div><p class="error" id="imp-err"></p></div>`;
  $$('[data-dl]').forEach((b) => { b.onclick = () => { const x = bids[b.dataset.dl]; download(`blindfold-${x.auctionId}-${x.bidId}.txt`, `${x.receipt}\n`); }; });
  const all = $('#dl-all');
  if (all) all.onclick = () => download('blindfold-receipts.txt', bids.map((b) => `${b.title || b.auctionId}\n${b.receipt}\n`).join('\n'));
  $('#imp-go').onclick = async () => {
    try {
      const text = $('#imp').value.trim();
      const rc = decodeReceipt(text);
      const lot = await api(`/api/auctions/${rc.auctionId}`).catch(() => null);
      saveBid({ auctionId: rc.auctionId, bidId: rc.bidId, amountZat: rc.amountZat, receipt: text, title: lot?.item.title, created: Date.now() });
      viewBids();
    } catch (ex) { $('#imp-err').textContent = ex.message; }
  };
}

// ------------------------------------------------------------------ sell

function viewSell() {
  const realOk = config.realAuctions;
  main.innerHTML = `<div class="prose" style="max-width:860px">
    <h1>List an item</h1>
    <p>You keep custody the whole time. Bids and payments go straight to your own shielded address; Blindfold only watches it through a viewing key you publish.</p>
    <form id="sell" novalidate>
      <div class="choice" role="radiogroup" aria-label="Auction type">
        <label><input type="radio" name="mode" value="real" ${realOk ? 'checked' : 'disabled'}><span><b>On-chain auction</b>Real ZEC deposits and payment, verified through your viewing key.${realOk ? '' : ' Not enabled on this server.'}</span></label>
        <label><input type="radio" name="mode" value="sandbox" ${realOk ? '' : 'checked'}><span><b>Sandbox</b>Real secret sharing and blind comparison, simulated payments. Good for trying it out.</span></label>
      </div>
      <div class="form-grid">
        <div>
          <div class="field"><label for="s-token">zkSNARKs token ID</label><input id="s-token" inputmode="numeric" placeholder="e.g. 4821" required>
            <span class="hint">The number of the identity you hold on <a href="https://zilkroad.com/account" rel="noopener">Zilk Road</a>.</span></div>
          <div class="field"><label for="s-desc">Notes for bidders</label><textarea id="s-desc" style="font-family:var(--body);font-size:1rem" maxlength="600" placeholder="Optional"></textarea></div>
        </div>
        <div><div id="s-preview" style="max-width:300px">${art({ title: '?', tokenId: null, image: '' }, 'sandbox')}</div></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="s-min">Minimum bid</label><div class="amount"><input id="s-min" inputmode="decimal" value="0.5"><span>ZEC</span></div></div>
        <div class="field"><label for="s-res">Reserve price</label><div class="amount"><input id="s-res" inputmode="decimal" placeholder="none"><span>ZEC</span></div>
          <span class="hint">Hidden. If the top bid is under it, there's no sale (the top bid is revealed either way).</span></div>
        <div class="field"><label for="s-dep">Deposit per bid</label><div class="amount"><input id="s-dep" inputmode="decimal" value="0.001"><span>ZEC</span></div>
          <span class="hint">Anchors each bid on-chain and deters spam. You refund losing bidders afterwards.</span></div>
        <div class="field"><label for="s-dur">Duration</label><select id="s-dur"></select></div>
      </div>
      <fieldset id="real-fields" style="border:0;padding:0;margin:0">
        <div class="field"><label for="s-addr">Your shielded receiving address</label><input id="s-addr" spellcheck="false" autocomplete="off" placeholder="u1…">
          <span class="hint">Use a fresh account just for this auction: its viewing key becomes public.</span></div>
        <div class="field"><label for="s-ufvk">That account's unified full viewing key</label><textarea id="s-ufvk" placeholder="uview1…"></textarea>
          <span class="hint">Lets anyone, including our watcher, see deposits and the winning payment. It cannot spend. Zingo, Ywallet and zcash-devtool can export one.</span></div>
      </fieldset>
      <button class="btn" type="submit">Create auction</button>
      <p class="error" id="sell-err" role="alert"></p>
    </form>
    <h2>After it sells</h2>
    <ol>
      <li>The winner pays you directly. The site verifies the payment publicly.</li>
      <li>Your seller console decrypts the winner's delivery address and every bidder's refund address. Only your browser can do this.</li>
      <li>Transfer the zkSNARK to the winner on Zilk Road, then refund the losing deposits with the one-scan refund request.</li>
    </ol>
    <p class="muted">zkSNARKs ownership lives in Zilk Road's records, which have no public API, so Blindfold cannot hold the item in escrow or check that you own it. Bidders rely on your reputation for delivery, exactly as on any marketplace. See <a href="#/how">limitations</a>.</p>
  </div>`;

  const durs = { real: [[288, 'About 6 hours (288 blocks)'], [1152, 'About 1 day (1,152 blocks)'], [3456, 'About 3 days'], [8064, 'About 1 week']],
    sandbox: [[3, '3 minutes (quick demo)'], [30, '30 minutes'], [120, '2 hours'], [1440, '1 day']] };
  const sync = () => {
    const mode = $('input[name=mode]:checked').value;
    $('#real-fields').hidden = mode !== 'real';
    $('#s-dur').innerHTML = durs[mode].map(([v, l], i) => `<option value="${v}" ${i === 1 ? 'selected' : ''}>${l}</option>`).join('');
  };
  $$('input[name=mode]').forEach((r) => { r.onchange = sync; });
  sync();
  $('#s-token').oninput = () => {
    const t = $('#s-token').value.trim();
    $('#s-preview').innerHTML = art(/^\d{1,4}$/.test(t)
      ? { title: `zkSNARK #${t}`, tokenId: t, image: `https://zilkroad.com/api/art/${t}?fmt=webp` }
      : { title: '?', tokenId: null, image: '' }, $('input[name=mode]:checked').value === 'real' ? 'main' : 'sandbox');
  };

  $('#sell').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#sell-err');
    err.textContent = '';
    const mode = $('input[name=mode]:checked').value;
    const key = newSellerKey();
    const body = {
      mode,
      item: { collection: 'zkSNARKs', tokenId: $('#s-token').value.trim(), description: $('#s-desc').value.trim() },
      sellerPublicKey: key.publicKey,
      minBidZec: $('#s-min').value.trim(), reserveZec: $('#s-res').value.trim(), depositZec: $('#s-dep').value.trim(),
      [mode === 'real' ? 'durationBlocks' : 'durationMinutes']: Number($('#s-dur').value),
      sellerAddress: $('#s-addr').value.trim(), viewingKey: $('#s-ufvk').value.trim(),
    };
    const btn = e.submitter;
    btn.disabled = true;
    btn.textContent = mode === 'real' ? 'Loading your viewing key…' : 'Creating…';
    try {
      const out = await api('/api/auctions', { method: 'POST', body });
      store.set(`bf.seller.${out.auction.id}`, { sellerToken: out.sellerToken, sellerSecretKey: key.secretKey });
      location.hash = `#/manage/${out.auction.id}?new=1`;
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Create auction';
    }
  };
}

// ------------------------------------------------------------------ seller console

async function viewManage(id, params) {
  const a = await api(`/api/auctions/${id}`);
  let secrets = sellerSecrets(id);
  const keyFile = secrets ? `blindfold-seller-key:${btoa(JSON.stringify({ id, ...secrets }))}` : '';
  main.innerHTML = `<div class="prose" style="max-width:860px">
    <div class="crumbs"><a href="#/lot/${id}">${esc(a.item.title)}</a> / seller console</div>
    <h1>Seller console</h1>
    ${params.get('new') ? `<div class="banner sandbox"><b>Save your seller key now.</b> It's the only way to read bidders' refund and delivery addresses, and to manage this auction. It never leaves your browser.</div>
      <div class="row" style="margin-bottom:22px"><button class="btn" id="dl-key">Download seller key</button><a class="btn quiet" href="#/lot/${id}">View the public lot page</a></div>` : ''}
    <div id="console"></div></div>`;
  if ($('#dl-key')) $('#dl-key').onclick = () => download(`blindfold-seller-${id}.txt`, `${keyFile}\n`);

  const c = $('#console');
  if (!secrets) {
    c.innerHTML = `<p>Load the seller key you downloaded when you created this auction.</p>
      <textarea id="key-in" placeholder="blindfold-seller-key:…" aria-label="Seller key"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn" id="key-go">Load key</button></div><p class="error" id="key-err"></p>`;
    $('#key-go').onclick = () => {
      try {
        const raw = $('#key-in').value.trim().replace(/^blindfold-seller-key:/, '');
        const k = JSON.parse(atob(raw));
        if (k.id !== id) throw new Error('That key belongs to another auction.');
        store.set(`bf.seller.${id}`, { sellerToken: k.sellerToken, sellerSecretKey: k.sellerSecretKey });
        viewManage(id, new URLSearchParams());
      } catch (ex) { $('#key-err').textContent = ex.message.startsWith('That') ? ex.message : 'That is not a valid seller key.'; }
    };
    return;
  }

  const contacts = a.anchors.map((x) => {
    let address = null;
    try { address = x.sealedContact ? unseal(x.sealedContact, secrets.sellerSecretKey) : null; } catch { address = null; }
    return { ...x, address };
  });
  const r = a.result || {};
  const winner = contacts.find((x) => x.bidId === r.winner);
  // Once the sale is settled (or there is none), every deposit is refunded except
  // those of winners who failed to pay.
  const settled = a.status === 'paid' || a.status === 'no_sale';
  const refundable = settled ? contacts.filter((x) => x.address && !(r.defaulted || []).includes(x.bidId)) : [];
  const real = a.mode !== 'sandbox';

  let html = `<dl class="facts"><div><dt>Status</dt><dd>${esc(a.status === 'open' ? 'Open' : statusLine(a))}</dd></div><div><dt>Sealed bids</dt><dd>${a.bids}</dd></div>
    <div><dt>Result</dt><dd>${r.amountZat ? zec(r.amountZat) : '–'}</dd></div></dl>`;

  if (a.status === 'open') {
    html += `<p>Bids are sealed: you'll see the winning amount when the auction closes, and nothing else.</p>
      <div class="row">${a.mode === 'sandbox' ? '<button class="btn quiet" id="end-now">End the auction now</button>' : ''}${a.bids === 0 ? '<button class="btn quiet" id="cancel">Cancel auction</button>' : ''}</div>`;
  }
  if (winner) {
    html += `<h2>Winner's delivery address</h2>
      ${winner.address ? `<div class="keybox">${esc(winner.address)}</div><div class="row" style="margin:8px 0">${copyButton(winner.address, 'Copy address')}</div>` : '<p class="muted">The winner didn\'t include an address.</p>'}
      <p>${a.status === 'paid' ? '<span class="ok">Paid and verified.</span> Transfer the item on Zilk Road to this address, then mark it delivered.' : 'Wait for the payment to be verified before transferring the item.'}</p>
      ${a.status === 'paid' && !a.delivered ? '<button class="btn" id="delivered">Mark as delivered</button>' : ''}`;
  }
  if (refundable.length && a.status !== 'open') {
    const payments = refundable.map((x) => ({ address: x.address, amountZat: a.depositZat, memo: `Blindfold deposit refund ${x.bidId}` }));
    const uri = real ? zip321(payments) : '';
    html += `<h2>Refund deposits</h2><p>${refundable.length} bidder${refundable.length > 1 ? 's' : ''} to refund, ${zec(BigInt(a.depositZat) * BigInt(refundable.length))} in total.${r.defaulted?.length ? ' Winners who failed to pay forfeit their deposit and are left out.' : ''}</p>
      ${real ? `<div class="qr"><div id="refund-qr"></div><div><p>One scan pays every refund, if your wallet supports multi-payment requests (ZIP 321). Otherwise pay each address below.</p>
        <p><a class="btn small" href="${esc(uri)}">Open in wallet</a></p></div></div>` : '<p class="muted">Sandbox: refunds are illustrative.</p>'}
      <table><thead><tr><th>Bid</th><th>Refund address</th></tr></thead><tbody>${refundable.map((x) => `<tr><td class="mono">${x.bidId}</td><td class="mono">${esc(short(x.address, 14))}</td></tr>`).join('')}</tbody></table>`;
    setTimeout(() => { if (real && $('#refund-qr')) qrInto($('#refund-qr'), uri); });
  }
  html += `<p class="error" id="m-err"></p>`;
  c.innerHTML = html;

  const act = (sel, path) => {
    const b = $(sel);
    if (b) b.onclick = async () => {
      try { await api(`/api/auctions/${id}/${path}`, { method: 'POST', body: { sellerToken: secrets.sellerToken } }); viewManage(id, new URLSearchParams()); } catch (ex) { $('#m-err').textContent = ex.message; }
    };
  };
  act('#end-now', 'end-now');
  act('#cancel', 'cancel');
  act('#delivered', 'delivered');
}

// ------------------------------------------------------------------ how it works

function viewHow() {
  main.innerHTML = `<article class="prose">
    <h1>How Blindfold works</h1>
    <p>Blindfold runs sealed-bid, first-price auctions on Zcash in which no single party ever sees a bid. Losing bids are never revealed to anyone. The only number that comes out is the winning price.</p>

    <h2>The three keyholders</h2>
    <p>When you bid, your browser turns the amount into 52 bits and splits each bit with <a href="https://en.wikipedia.org/wiki/Shamir%27s_secret_sharing" rel="noopener">Shamir secret sharing</a>. Each of three independent servers, the keyholders, receives one share of every bit. A single share is a uniformly random 96-bit number: it carries no information at all.</p>
    <div class="diagram">${howDiagram()}</div>
    <p>At the closing block, the keyholders run a secure multiparty computation (built on <a href="https://github.com/lschoe/mpyc" rel="noopener">MPyC</a>). Working only on shares, they check every bid is well formed, rebuild each bid from its bits, compare them, and open just two values: which bid is highest, and its amount.</p>

    <h2>What goes on-chain</h2>
    <ul>
      <li><b>The deposit.</b> A small shielded payment to the seller anchors your bid. Its memo holds your bid ID, a fingerprint of each keyholder's shares, and your shielded address encrypted so only the seller can read it. It does not hold your bid.</li>
      <li><b>The payment.</b> The winner pays the seller exactly the winning amount. Its memo reveals the bid's secret key, proving the payment comes from the winning bidder.</li>
    </ul>
    <p>The seller publishes the auction account's viewing key, so anyone can watch deposits arrive before the closing block and check the winner paid the right amount. Bidders stay shielded: a viewing key shows what an address received, never who sent it.</p>

    <h2>Why you can trust the result</h2>
    <ul>
      <li>Fingerprints anchored on-chain stop the operator from adding, dropping or swapping bids: a keyholder refuses shares that don't match.</li>
      <li>Bids are shared as bits, and the computation proves each shared bit is 0 or 1. A malformed or inconsistent bid is detected and discarded without revealing anything about the honest ones.</li>
      <li>All three keyholders must return the same result, and the public check seed is drawn only after bidding closes.</li>
      <li>If the winner doesn't pay before the deadline, the keyholders compute the next highest bid, revealing only that one.</li>
    </ul>

    <h2>Limitations</h2>
    <p>Blindfold narrows trust a lot, but it does not remove it. Read these before bidding real ZEC.</p>
    <ul>
      <li><b>Honest majority.</b> Any two keyholders who collude can reconstruct every bid. Privacy depends on at least two of the three being honest and run by different people. The demo deployment runs all three on one operator's account; a production auction should use three independent operators.</li>
      <li><b>Honest-but-curious computation.</b> The keyholders follow the protocol in this version; a keyholder that actively lies inside the computation could corrupt the result. Requiring identical results from all three catches crude cheating, not a subtle attack.</li>
      <li><b>Payment isn't automatic.</b> Zcash has no smart contracts, so a winner can't be forced to pay. The deposit and the runner-up fallback limit the damage.</li>
      <li><b>Delivery relies on the seller.</b> zkSNARKs ownership is recorded by Zilk Road, which has no public API. Blindfold cannot escrow the item or verify the seller owns it. Native shielded assets (ZSAs) arriving with NU7 could change this.</li>
      <li><b>Refunds are manual.</b> The seller refunds losing deposits. Refunds are visible through the viewing key, but nothing forces them.</li>
      <li><b>Reserve and ties.</b> If there's a reserve and the top bid misses it, the top amount is still revealed. Equal top bids go to the earliest deposit.</li>
      <li><b>Metadata.</b> Deposit timing is public, and a keyholder sees your IP address when your browser sends it a share. Use Tor or a VPN if that matters to you.</li>
      <li><b>Receipts.</b> Lose your receipt and you can't prove a winning bid. The fallback then moves on to the next bid.</li>
      <li><b>Prototype.</b> This code is new and unaudited. Keep amounts modest.</li>
    </ul>

    <h2>Run your own</h2>
    <p>Blindfold is a library plus three small services. The <a href="https://github.com/onemanbillion/blindfold" rel="noopener">source and protocol spec</a> are on GitHub under the MIT license.</p>
  </article>`;
}

function howDiagram() {
  const rows = [0, 1, 2].map((i) => {
    const y = 28 + i * 76;
    return `
      <path class="edge" d="M160 128 C 205 128, 215 ${y + 24}, 258 ${y + 24}" marker-end="url(#ar)"/>
      <rect class="box" x="262" y="${y}" width="184" height="48" rx="8"/>
      <text class="t" x="280" y="${y + 21}">Keyholder ${i + 1}</text>
      <text class="t sub" x="280" y="${y + 37}">sees one random share</text>
      <path class="edge" d="M446 ${y + 24} C 490 ${y + 24}, 500 128, 540 128" marker-end="url(#ar)"/>`;
  }).join('');
  return `<svg viewBox="0 0 720 256" role="img" aria-label="A bid is split into three shares, one per keyholder; the keyholders compute the winner together">
    <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="head" d="M0 0L10 5L0 10z"/></marker></defs>
    <rect class="box" x="10" y="104" width="150" height="48" rx="8"/>
    <text class="t" x="28" y="125">Your browser</text>
    <text class="t sub" x="28" y="141">bid split locally</text>
    ${rows}
    <rect class="box strong" x="544" y="100" width="166" height="56" rx="8"/>
    <text class="t inv" x="562" y="124">Blind comparison</text>
    <text class="t sub" x="562" y="141" style="fill:var(--line-strong)">reveals only the winner</text>
  </svg>`;
}

// ------------------------------------------------------------------ router

async function router() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  $$('header.site nav a').forEach((a) => {
    const href = a.getAttribute('href');
    a.toggleAttribute('aria-current', href === `#/${parts[0] || ''}` || (href === '#/' && (!parts[0] || parts[0] === 'lot')));
    if (a.hasAttribute('aria-current')) a.setAttribute('aria-current', 'page');
  });
  try {
    if (!parts.length || path === 'lots') await viewHome();
    else if (parts[0] === 'lot' && parts[1]) await viewLot(parts[1]);
    else if (parts[0] === 'sell') viewSell();
    else if (parts[0] === 'bids') viewBids();
    else if (parts[0] === 'how') viewHow();
    else if (parts[0] === 'manage' && parts[1]) await viewManage(parts[1], params);
    else await viewHome();
  } catch (ex) {
    main.innerHTML = `<div class="prose"><h1>Something went wrong</h1><p class="error">${esc(ex.message)}</p><p><a href="#/">Back to the lots</a></p></div>`;
  }
  if (!location.hash.includes('lots')) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', router);
api('/api/config').then((c) => { config = { ...config, ...c }; }).catch(() => {}).finally(router);
// Make bid IDs derivable for debugging in the console.
window.blindfold = { deriveBidId };
