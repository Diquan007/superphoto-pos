// Gedeelde hulpmiddelen: database, opslag, opmaak, dialogen
// -----------------------------------------------------------

// ---------- lokale opslag (Electron, of browser voor testen) ----------
export const local = window.pos ? window.pos : {
  store: {
    get: async (n, f) => { try { const v = localStorage.getItem('sp_' + n); return v ? JSON.parse(v) : f; } catch { return f; } },
    set: async (n, v) => { try { localStorage.setItem('sp_' + n, JSON.stringify(v)); return true; } catch { return false; } }
  },
  printers: async () => [],
  printReceipt: async (html) => {
    const w = window.open('', '_blank', 'width=400,height=600');
    if (w) { w.document.write(html); w.document.close(); w.print(); }
    return { ok: true };
  },
  appInfo: async () => ({ version: 'browser', packaged: false }),
  installUpdate: async () => {}, setUpdateSource: async () => false, checkUpdate: async () => ({ ok: false, reason: 'Alleen in het Windows-programma' }), onUpdate: () => {}, onCloseRequest: () => {}, closeApp: async () => window.close()
};

// ---------- database (Supabase / PostgREST) ----------
export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export class NetError extends Error {}

let conn = { url: '', key: '' };
export function setConnection(url, key) { conn = { url: url.replace(/\/+$/, ''), key: key.trim() }; }
export function hasConnection() { return !!(conn.url && conn.key); }

export async function rpc(fn, args = {}, timeoutMs = 15000) {
  if (!hasConnection()) throw new NetError('Geen database ingesteld');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json', apikey: conn.key };
  // zoals de officiële Supabase-bibliotheek: sleutel ook als Bearer (niet bij de lokale testserver)
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(conn.url)) headers.Authorization = 'Bearer ' + conn.key;
  let res;
  try {
    res = await fetch(`${conn.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), signal: ctl.signal });
  } catch (e) {
    throw new NetError('Geen verbinding met internet');
  } finally { clearTimeout(t); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status >= 500 && res.status !== 500) throw new NetError('Server niet bereikbaar (' + res.status + ')');
    const msg = (data && (data.message || data.error_description || data.hint)) || ('Fout ' + res.status);
    if (res.status === 401 || res.status === 403) {
      if (/SESSIE_VERLOPEN/.test(msg)) throw new ApiError('SESSIE_VERLOPEN', res.status);
      throw new ApiError('De databasesleutel klopt niet. Controleer de koppeling (Beheer > Instellingen).', res.status);
    }
    if (res.status === 404 && /function|schema cache/i.test(msg)) {
      throw new ApiError('De database is nog niet (volledig) ingericht. Draai de SQL-bestanden in Supabase.', 404);
    }
    throw new ApiError(msg, res.status);
  }
  return data;
}

export const isNet = e => e instanceof NetError;
export const isSession = e => e instanceof ApiError && e.message === 'SESSIE_VERLOPEN';

// ---------- opmaak ----------
const nf = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const srd = n => 'SRD ' + nf.format(Number(n) || 0);
export const num = n => nf.format(Number(n) || 0);
export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export function parseAmount(s) {
  if (typeof s === 'number') return s;
  s = String(s ?? '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}
const pad = n => String(n).padStart(2, '0');
// 'jjjj-mm-dd' is een kalenderdag (geen tijdzone); al het andere is een tijdstip
const toDate = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) : new Date(d);
export function fmtDate(d) { if (!d) return ''; d = toDate(d); return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`; }
export function fmtTime(d) { if (!d) return ''; d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function fmtDateTime(d) { return d ? fmtDate(d) + ' ' + fmtTime(d) : ''; }
export function isoDay(d = new Date()) { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export const STORE_NAMES = { MAH: 'Mahony', IND: 'Indira', MAG: 'Magazijn' };
export const LOCATION_NAMES = { MAH: 'Winkel Mahony', IND: 'Winkel Indira', MAG: 'Magazijn Mahony' };
export const METHOD_NAMES = { cash: 'Contant', pin: 'PIN' };

export function uuid() { return crypto.randomUUID(); }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// klein sjabloonhulpje: html`...` met automatische escaping
export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    let v = i < vals.length ? vals[i] : '';
    const isRaw = x => x && typeof x === 'object' && '__raw' in x;
    if (isRaw(v)) v = v.__raw;
    else if (Array.isArray(v)) v = v.map(x => isRaw(x) ? x.__raw : esc(x)).join('');
    else v = esc(v);
    return out + s + v;
  }, '');
}
export const raw = s => ({ __raw: s });

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- meldingen ----------
export function toast(msg, kind = 'info', ms = 3500) {
  let box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// ---------- dialoogvenster ----------
// modal({title, body (html), buttons:[{label, kind, value}], onOpen(root), wide})
export function modal({ title, body, buttons = [{ label: 'Sluiten', value: null }], onOpen, wide, validate }) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Sluiten">✕</button></div>
      <div class="modal-body">${raw(body || '')}</div>
      <div class="modal-foot">${raw(buttons.map((b, i) =>
        html`<button class="btn ${b.kind || ''}" data-i="${i}">${b.label}</button>`).join(''))}</div></div>`;
    document.body.appendChild(back);
    const root = $('.modal', back);
    const done = v => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const def = buttons.findIndex(b => b.default);
        if (def >= 0) { e.preventDefault(); e.stopPropagation(); click(def); }
      }
    };
    const click = async i => {
      const b = buttons[i];
      if (b.value !== null && b.value !== undefined && validate) {
        const ok = await validate(root, b.value);
        if (ok === false) return;
      }
      done(typeof b.value === 'function' ? b.value(root) : b.value);
    };
    document.addEventListener('keydown', onKey, true);
    $('[data-close]', back).onclick = () => done(null);
    $$('.modal-foot button', back).forEach(btn => btn.onclick = () => click(+btn.dataset.i));
    if (onOpen) onOpen(root, done);
    const first = $('input:not([type=hidden]):not([disabled]), select, textarea', root);
    setTimeout(() => (first || $('.modal-foot .btn.primary', root) || root).focus(), 30);
  });
}

export async function confirmBox(title, text, okLabel = 'Ja', kind = 'primary') {
  return modal({ title, body: html`<p>${text}</p>`,
    buttons: [{ label: 'Annuleren', value: false }, { label: okLabel, kind, value: true, default: true }] });
}

export async function alertBox(title, text) {
  return modal({ title, body: html`<p>${text}</p>`, buttons: [{ label: 'OK', kind: 'primary', value: true, default: true }] });
}

// Pincode vragen met groot cijferblok (ook bedienbaar met toetsenbord)
export function askPin(title, subtitle = '') {
  return new Promise(resolve => {
    let pin = '';
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = html`<div class="modal pin-modal">
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body"><p class="muted">${subtitle}</p>
        <div class="pin-dots"></div>
        <div class="pinpad">${raw([1,2,3,4,5,6,7,8,9,'C',0,'OK'].map(k =>
          `<button class="pinkey ${k === 'OK' ? 'ok' : ''}" data-k="${k}">${k === 'C' ? '⌫' : k}</button>`).join(''))}</div></div></div>`;
    document.body.appendChild(back);
    const dots = $('.pin-dots', back);
    const draw = () => { dots.innerHTML = pin ? '●'.repeat(pin.length) : '<span class="muted">pincode</span>'; };
    const done = v => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const press = k => {
      if (k === 'C') pin = pin.slice(0, -1);
      else if (k === 'OK') { if (pin.length >= 4) done(pin); return; }
      else if (pin.length < 8) pin += k;
      draw();
    };
    const onKey = e => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('C');
      else if (e.key === 'Enter') press('OK');
      else if (e.key === 'Escape') done(null);
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    $$('.pinkey', back).forEach(b => b.onclick = () => press(b.dataset.k));
    $('[data-close]', back).onclick = () => done(null);
    draw();
  });
}

// Zoekveld met suggestielijst (voor artikelen en klanten)
// attachSuggest(input, { source: q => items, render: item => html, pick: item => void })
export function attachSuggest(input, { source, render, pick, max = 12, minChars = 1 }) {
  const box = document.createElement('div');
  box.className = 'suggest';
  input.parentElement.style.position = 'relative';
  input.parentElement.appendChild(box);
  input.setAttribute('autocomplete', 'off');
  let items = [], hi = 0;
  const close = () => { box.style.display = 'none'; items = []; };
  const draw = () => {
    if (!items.length) return close();
    box.innerHTML = items.map((it, i) => `<div class="sg ${i === hi ? 'hi' : ''}" data-i="${i}">${render(it)}</div>`).join('');
    box.style.display = 'block';
  };
  const update = () => {
    const q = input.value.trim();
    items = q.length >= minChars ? source(q).slice(0, max) : [];
    hi = 0; draw();
  };
  input.addEventListener('input', update);
  input.addEventListener('focus', () => { if (input.value.trim().length >= minChars) update(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', e => {
    if (box.style.display !== 'block') return;
    if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[hi]) { e.preventDefault(); e.stopPropagation(); const it = items[hi]; close(); pick(it); }
    else if (e.key === 'Escape') { close(); e.stopPropagation(); }
  });
  box.addEventListener('mousedown', e => {
    const el = e.target.closest('.sg'); if (!el) return;
    e.preventDefault(); const it = items[+el.dataset.i]; close(); pick(it);
  });
  return { close, refresh: update };
}

// Artikelen zoeken: stocknummer begint met, of naam bevat (alle woorden)
export function searchProducts(products, q) {
  q = q.toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  const exact = products.filter(p => p.stock_no.toLowerCase() === q);
  const starts = products.filter(p => p.stock_no.toLowerCase().startsWith(q) && p.stock_no.toLowerCase() !== q);
  const named = products.filter(p => !p.stock_no.toLowerCase().startsWith(q) &&
    words.every(w => p.name.toLowerCase().includes(w) || (p.category || '').toLowerCase().includes(w)));
  return [...exact, ...starts, ...named];
}
