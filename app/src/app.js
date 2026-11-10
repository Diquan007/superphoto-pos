// Super Photo Kassa - opstarten, inloggen, tabbladen en offline wachtrij
import { local, rpc, setConnection, hasConnection, isNet, isSession, ApiError, NetError,
         html, raw, esc, $, $$, toast, modal, askPin, alertBox, confirmBox, uuid, fmtDateTime, STORE_NAMES } from './lib.js';

// ---------- gedeelde toestand ----------
export const S = {
  settings: {},          // per pc: supabaseUrl, supabaseKey, store, printer, staff
  token: null,           // sessie van deze kassa
  store: null,           // winkelgegevens
  catalog: [],           // artikelen voor deze winkel
  customers: [],
  online: navigator.onLine,
  queue: [],             // offline opgeslagen transacties
  synced: [],            // recent gesynchroniseerde offline bonnen (voorlopig -> echt nummer)
  admin: null,           // {token, expires}
  views: {},
  dirty: false           // kassa heeft een lopende bon
};

export async function saveSettings() { await local.store.set('settings', S.settings); }

// ---------- verbinding en sessie ----------
export async function call(fn, args = {}) {
  try {
    const r = await rpc(fn, { p_token: S.token, ...args });
    setOnline(true);
    return r;
  } catch (e) {
    if (isNet(e)) setOnline(false);
    if (isSession(e)) { await sessionExpired(); throw new ApiError('Sessie verlopen, log opnieuw in.'); }
    throw e;
  }
}
export async function adminCall(fn, args = {}) {
  if (!S.admin || Date.now() > S.admin.expires) {
    const ok = await adminLogin();
    if (!ok) throw new ApiError('Geen toegang');
  }
  try {
    const r = await rpc(fn, { p_token: S.admin.token, ...args });
    setOnline(true);
    return r;
  } catch (e) {
    if (isNet(e)) setOnline(false);
    if (isSession(e)) { S.admin = null; return adminCall(fn, args); }
    throw e;
  }
}
export async function adminLogin() {
  for (;;) {
    const pin = await askPin('Beheerder', 'Voer uw beheerderspincode in');
    if (!pin) return false;
    try {
      const r = await rpc('pos_admin_login', { p_pin: pin });
      S.admin = { token: r.token, expires: Date.now() + 55 * 60 * 1000 };
      renderTopbar();
      return true;
    } catch (e) {
      if (isNet(e)) { toast('Geen internet. Beheer werkt alleen online.', 'error'); return false; }
      toast(e.message, 'error');
    }
  }
}
export function adminLogout() {
  if (S.admin) rpc('pos_logout', { p_token: S.admin.token }).catch(() => {});
  S.admin = null; renderTopbar();
  if (S.views.beheer) S.views.beheer.locked();
}

async function sessionExpired() {
  S.token = null;
  S.settings.session = null;
  await saveSettings();
  toast('De sessie is verlopen. Voer de pincode van de kassa opnieuw in.', 'error', 6000);
  showLogin();
}

let onlineState = null;
export function setOnline(v) {
  if (onlineState === v) return;
  onlineState = v; S.online = v;
  renderStatus();
  if (v) syncQueue();
}

// ---------- offline wachtrij ----------
async function loadQueue() { S.queue = await local.store.get('queue', []); S.synced = await local.store.get('synced', []); }
async function saveQueue() { await local.store.set('queue', S.queue); await local.store.set('synced', S.synced.slice(0, 50)); renderStatus(); }

export async function enqueue(fn, args, provisional) {
  S.queue.push({ id: args.client_id, fn, args, provisional, created: new Date().toISOString(), error: null });
  await saveQueue();
}
export function provisionalNo() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `V${p(d.getDate())}${p(d.getMonth() + 1)}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

let syncing = false;
export async function syncQueue() {
  if (syncing || !S.queue.length || !S.token) return;
  syncing = true;
  try {
    for (const item of [...S.queue]) {
      try {
        const argName = item.fn === 'pos_cash_out' ? 'p_out' : 'p_sale';
        const r = await rpc(item.fn, { p_token: S.token, [argName]: item.args });
        S.queue = S.queue.filter(q => q.id !== item.id);
        S.synced.unshift({ provisional: item.provisional, trans_no: r.sale.trans_no, at: new Date().toISOString() });
        toast(`Offline bon ${item.provisional} is opgeslagen als transactie ${r.sale.trans_no}`, 'ok', 6000);
        if (r.warnings && r.warnings.length) warnStock(r.warnings);
        setOnline(true);
      } catch (e) {
        if (isNet(e)) { setOnline(false); break; }
        if (isSession(e)) { await sessionExpired(); break; }
        item.error = e.message;    // blijft in de wachtrij; zichtbaar voor beheerder
      }
    }
  } finally {
    syncing = false;
    await saveQueue();
  }
  if (!S.queue.length) refreshCatalog();
}

export function warnStock(list) {
  for (const w of list) {
    toast(`Let op: ${w.stock_no} ${w.name} staat nu op ${w.qty} in voorraad`, 'error', 8000);
  }
}

// ---------- artikelen en klanten ----------
export async function refreshCatalog() {
  if (!S.token) return;
  try {
    const c = await call('pos_catalog');
    S.catalog = c.products;
    S.store = { ...S.store, ...c.store };
    await local.store.set('catalog_' + S.store.code, { products: c.products, store: c.store, at: c.generated_at });
    const cust = await call('pos_customers');
    S.customers = cust;
    await local.store.set('customers', cust);
    Object.values(S.views).forEach(v => v.catalogChanged && v.catalogChanged());
  } catch (e) {
    if (!isNet(e)) console.warn(e);
  }
}

// ---------- printen ----------
export async function printHtml(htmlDoc) {
  try {
    const r = await local.printReceipt(htmlDoc, S.store.receipt_width_mm || 80, S.settings.printer || null);
    if (r && r.ok === false && r.reason && r.reason !== 'cancelled') toast('Printen mislukt: ' + r.reason, 'error');
  } catch (e) { toast('Printen mislukt: ' + e.message, 'error'); }
}

// ---------- schermen ----------
const app = () => $('#app');

function screen(inner) {
  app().innerHTML = html`<div class="center-screen"><div class="card login-card">
     <div class="brand"><span class="logo">SP</span><div><div class="brand-name">Super Photo</div><div class="muted">Kassa</div></div></div>
     ${raw(inner)}</div></div>`;
}

async function showConnect(message = '') {
  screen(html`<h1>Koppelen met de database</h1>
    <p class="muted">Eenmalig per computer. U vindt deze gegevens in Supabase onder <b>Project Settings → API</b>.</p>
    ${raw(message ? html`<p class="error-text">${message}</p>` : '')}
    <label>Project URL<input id="cUrl" placeholder="https://xxxx.supabase.co" value="${S.settings.supabaseUrl || ''}"></label>
    <label>Publishable key (of anon key)<input id="cKey" placeholder="sb_publishable_..." value="${S.settings.supabaseKey || ''}"></label>
    <button class="btn primary big" id="cGo">Verbinden</button>`);
  $('#cGo').onclick = async () => {
    const url = $('#cUrl').value.trim(), key = $('#cKey').value.trim();
    if (!/^https?:\/\/.+/.test(url) || key.length < 20) return toast('Vul de URL en de sleutel volledig in.', 'error');
    setConnection(url, key);
    try {
      await rpc('pos_status');
      S.settings.supabaseUrl = url; S.settings.supabaseKey = key;
      await saveSettings();
      start();
    } catch (e) { toast(e.message, 'error', 6000); }
  };
}

async function showSetup(status) {
  screen(html`<h1>Eerste installatie</h1>
    <p class="muted">Kies drie verschillende pincodes van 4 tot 8 cijfers. Alleen u kent de beheerderspincode.</p>
    <div class="grid2">
      <label>Beheerderspincode (alleen u)<input id="sAdmin" type="password" inputmode="numeric" maxlength="8"></label>
      <label>Herhaal beheerderspincode<input id="sAdmin2" type="password" inputmode="numeric" maxlength="8"></label>
      <label>Pincode kassa Mahony<input id="sMah" type="password" inputmode="numeric" maxlength="8"></label>
      <label>Pincode kassa Indira<input id="sInd" type="password" inputmode="numeric" maxlength="8"></label>
      <label>Eerste transactienummer Mahony<input id="sMahStart" value="100001" inputmode="numeric"></label>
      <label>Eerste transactienummer Indira<input id="sIndStart" value="200001" inputmode="numeric"></label>
    </div>
    <button class="btn primary big" id="sGo">Opslaan</button>`);
  $('#sGo').onclick = async () => {
    if ($('#sAdmin').value !== $('#sAdmin2').value) return toast('De beheerderspincodes zijn niet gelijk.', 'error');
    try {
      await rpc('pos_setup', { p_admin_pin: $('#sAdmin').value, p_mah_pin: $('#sMah').value, p_ind_pin: $('#sInd').value,
                               p_mah_start: +$('#sMahStart').value, p_ind_start: +$('#sIndStart').value });
      toast('Pincodes opgeslagen.', 'ok');
      start();
    } catch (e) { toast(e.message, 'error', 6000); }
  };
}

let statusCache = null;
async function showLogin() {
  const stores = statusCache ? statusCache.stores : [{ code: 'MAH', name: 'Super Photo Mahony' }, { code: 'IND', name: 'Super Photo Indira' }];
  screen(html`<h1>Welke kassa is dit?</h1>
    <p class="muted">Kies de winkel en voer de pincode van die kassa in.</p>
    <div class="store-choice">${raw(stores.map(s => html`
      <button class="store-btn ${s.code}" data-code="${s.code}"><span>${STORE_NAMES[s.code]}</span><small>${s.address || ''}</small></button>`).join(''))}</div>
    ${raw(S.queue.length ? html`<p class="warn-text">Er staan ${S.queue.length} offline transactie(s) klaar om te versturen.</p>` : '')}`);
  $$('.store-btn').forEach(b => b.onclick = () => loginStore(b.dataset.code));
  if (S.settings.store) $(`.store-btn[data-code="${S.settings.store}"]`)?.classList.add('last');
}

async function loginStore(code) {
  const pin = await askPin('Kassa ' + STORE_NAMES[code], 'Pincode van deze kassa');
  if (!pin) return;
  try {
    const r = await rpc('pos_login', { p_store: code, p_pin: pin });
    S.token = r.token; S.store = r.store;
    S.settings.store = code;
    S.settings.session = { token: r.token, store: r.store, expires: Date.now() + 15.5 * 3600 * 1000 };
    await saveSettings();
  } catch (e) {
    if (isNet(e)) toast('Geen internet. Inloggen lukt alleen online (of herstart terwijl de kassa nog ingelogd is).', 'error', 7000);
    else toast(e.message, 'error');
    return;
  }
  await openShell();
}

export async function lock() {
  if (S.dirty && !(await confirmBox('Kassa vergrendelen', 'Er staat nog een bon open. Toch vergrendelen? De bon blijft bewaard.'))) return;
  if (S.token) rpc('pos_logout', { p_token: S.token }).catch(() => {});
  adminLogout();
  S.token = null; S.settings.session = null;
  await saveSettings();
  showLogin();
}

// ---------- hoofdscherm ----------
const TABS = [
  { id: 'kassa',    label: 'Kassa',          key: 'F1' },
  { id: 'orders',   label: 'Ophaalorders',   key: 'F3' },
  { id: 'kasuit',   label: 'Kas uit',        key: 'F4' },
  { id: 'afsluiten',label: 'Dagafsluiting',  key: 'F6' },
  { id: 'voorraad', label: 'Voorraad',       key: 'F7' },
  { id: 'beheer',   label: 'Beheer',         key: 'F8' }
];
let current = 'kassa';

async function openShell() {
  try { await buildShell(); }
  catch (e) { console.error(e); alertBox('Er ging iets mis bij het openen', e.message + '\n' + (e.stack || '')); }
}
async function buildShell() {
  // artikelen: eerst uit cache, dan vers ophalen
  const cached = await local.store.get('catalog_' + S.store.code, null);
  if (cached) { S.catalog = cached.products; S.store = { ...cached.store, ...S.store }; }
  S.customers = await local.store.get('customers', []);
  document.body.dataset.store = S.store.code;

  app().innerHTML = html`
    <header class="topbar">
      <div class="brand small"><span class="logo">SP</span><div><div class="brand-name">Super Photo</div>
        <div class="store-name">${STORE_NAMES[S.store.code]}</div></div></div>
      <nav class="tabs">${raw(TABS.map(t => html`<button class="tab" data-tab="${t.id}">${t.label}<kbd>${t.key}</kbd></button>`).join(''))}</nav>
      <div class="top-right">
        <label class="staff-pick">Medewerker <select id="staffSel"></select></label>
        <button class="pill" id="netPill"></button>
        <span id="adminPill"></span>
        <button class="btn ghost" id="lockBtn" title="Kassa vergrendelen">Vergrendel</button>
      </div>
    </header>
    <div id="updateBar" class="update-bar" hidden></div>
    <main id="views">${raw(TABS.map(t => `<section class="view" id="view-${t.id}" hidden></section>`).join(''))}</main>`;

  const mods = {
    kassa: await import('./views/kassa.js'), orders: await import('./views/orders.js'),
    kasuit: await import('./views/kasuit.js'), afsluiten: await import('./views/afsluiten.js'),
    voorraad: await import('./views/voorraad.js'), beheer: await import('./views/beheer.js')
  };
  for (const t of TABS) S.views[t.id] = mods[t.id].create($('#view-' + t.id));
  $$('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#lockBtn').onclick = lock;
  $('#netPill').onclick = showQueueDialog;
  renderStaff();
  renderTopbar();
  renderStatus();
  showTab('kassa');
  refreshCatalog();
  syncQueue();
}

export function staff() { return $('#staffSel')?.value || ''; }
export function renderStaff() {
  const sel = $('#staffSel'); if (!sel) return;
  const list = S.store.staff || [];
  sel.innerHTML = html`<option value="">— kies —</option>${raw(list.map(n => html`<option>${n}</option>`).join(''))}`;
  if (list.includes(S.settings.staff)) sel.value = S.settings.staff;
  sel.onchange = () => { S.settings.staff = sel.value; saveSettings(); };
}
export async function requireStaff() {
  if (staff()) return staff();
  const list = S.store.staff || [];
  if (!list.length) return '';
  const v = await modal({ title: 'Wie helpt de klant?', body: html`<div class="staff-grid">${raw(list.map(n => html`<button class="btn big" data-n="${n}">${n}</button>`).join(''))}</div>`,
    buttons: [{ label: 'Annuleren', value: null }],
    onOpen: (root, done) => $$('[data-n]', root).forEach(b => b.onclick = () => done(b.dataset.n)) });
  if (v) { $('#staffSel').value = v; S.settings.staff = v; saveSettings(); }
  return v;
}

export function showTab(id) {
  current = id;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + id);
  S.views[id]?.show?.();
}

function renderTopbar() {
  const el = $('#adminPill'); if (!el) return;
  el.innerHTML = S.admin ? '<button class="pill adm" id="adminOut" title="Beheer afmelden">Beheer ✕</button>' : '';
  if (S.admin) $('#adminOut').onclick = adminLogout;
}

function renderStatus() {
  const el = $('#netPill'); if (!el) return;
  const n = S.queue.length, err = S.queue.filter(q => q.error).length;
  el.className = 'pill ' + (err ? 'bad' : S.online ? 'ok' : 'off');
  el.textContent = err ? `${err} fout bij versturen` : S.online ? (n ? `Online · ${n} versturen…` : 'Online') : `Offline${n ? ' · ' + n + ' wachtend' : ''}`;
}

async function showQueueDialog() {
  await modal({ title: 'Verbinding en offline bonnen', wide: true,
    body: html`<p>Status: <b>${S.online ? 'online' : 'offline'}</b>. Offline bonnen worden automatisch verstuurd zodra er internet is.</p>
      <h3>Nog te versturen (${S.queue.length})</h3>
      ${raw(S.queue.length ? `<table class="tbl"><tr><th>Voorlopig nr</th><th>Tijd</th><th>Soort</th><th>Probleem</th></tr>${S.queue.map(q =>
        html`<tr><td>${q.provisional}</td><td>${fmtDateTime(q.created)}</td><td>${q.fn === 'pos_cash_out' ? 'Kas uit' : 'Verkoop'}</td><td class="error-text">${q.error || ''}</td></tr>`).join('')}</table>` : '<p class="muted">Niets.</p>')}
      <h3>Recent verstuurd</h3>
      ${raw(S.synced.length ? `<table class="tbl"><tr><th>Voorlopig nr</th><th>Transactienummer</th><th>Verstuurd</th></tr>${S.synced.slice(0, 15).map(s =>
        html`<tr><td>${s.provisional}</td><td><b>${s.trans_no}</b></td><td>${fmtDateTime(s.at)}</td></tr>`).join('')}</table>` : '<p class="muted">Niets.</p>')}`,
    buttons: [{ label: 'Nu versturen', kind: 'primary', value: 'sync' }, { label: 'Sluiten', value: null }]
  }).then(v => { if (v === 'sync') { S.queue.forEach(q => q.error = null); syncQueue(); } });
}

// ---------- updates & afsluiten ----------
local.onUpdate(d => {
  S.update = { ...d, at: new Date() };
  const bar = $('#updateBar'); if (!bar) return;
  if (d.state === 'downloading' || d.state === 'progress') {
    if (S.update.readyShown) return;
    bar.hidden = false;
    bar.innerHTML = html`<span class="muted">Nieuwe versie${d.version ? ' ' + d.version : ''} wordt op de achtergrond gedownload${d.percent != null ? '… ' + d.percent + '%' : '…'} U kunt gewoon doorwerken.</span>`;
  }
  if (d.state === 'ready') {
    S.update.readyShown = true;
    bar.hidden = false;
    bar.innerHTML = html`Nieuwe versie ${d.version} staat klaar. <button class="btn small primary" id="updNow">Nu bijwerken en herstarten</button>
      <span class="muted">(of automatisch bij afsluiten)</span>`;
    $('#updNow').onclick = async () => {
      if (S.queue.length) return toast('Wacht tot alle offline bonnen verstuurd zijn.', 'error');
      if (S.dirty && !(await confirmBox('Bijwerken', 'Er staat nog een bon open. Toch herstarten?'))) return;
      local.installUpdate();
    };
  }
});
local.onCloseRequest(async () => {
  if (S.queue.length && !(await confirmBox('Afsluiten', `Er staan nog ${S.queue.length} offline bon(nen) die niet verstuurd zijn. Ze blijven bewaard en worden verstuurd bij de volgende start. Toch afsluiten?`, 'Afsluiten', 'danger'))) return;
  if (S.dirty && !(await confirmBox('Afsluiten', 'Er staat nog een bon open. Toch afsluiten?', 'Afsluiten', 'danger'))) return;
  local.closeApp();
});

// sneltoetsen voor tabbladen
document.addEventListener('keydown', e => {
  if (!S.token || document.querySelector('.modal-back')) return;
  const t = TABS.find(t => t.key === e.key);
  if (t) { e.preventDefault(); showTab(t.id); }
});
window.addEventListener('online', () => syncQueue());
setInterval(() => { if (S.token) { if (S.queue.length) syncQueue(); } }, 20000);
setInterval(() => { if (S.token && !S.dirty) refreshCatalog(); }, 5 * 60 * 1000);

// ---------- opstarten ----------
async function start() {
  S.settings = await local.store.get('settings', {});
  // webversie: databasegegevens staan al in config.js
  if (!S.settings.supabaseUrl && window.SP_CONFIG && window.SP_CONFIG.url) {
    S.settings.supabaseUrl = window.SP_CONFIG.url; S.settings.supabaseKey = window.SP_CONFIG.key;
  }
  await loadQueue();
  if (!S.settings.supabaseUrl || !S.settings.supabaseKey) return showConnect();
  setConnection(S.settings.supabaseUrl, S.settings.supabaseKey);
  try {
    statusCache = await rpc('pos_status');
    setOnline(true);
    if (statusCache.update_repo) local.setUpdateSource(statusCache.update_repo);
    if (statusCache.setup_needed) return showSetup(statusCache);
  } catch (e) {
    if (!isNet(e)) return showConnect(e.message);
    setOnline(false);
  }
  // nog geldige sessie? (bijv. herstart tijdens stroomstoring of zonder internet)
  const sess = S.settings.session;
  if (sess && sess.expires > Date.now()) {
    S.token = sess.token; S.store = sess.store;
    return openShell();
  }
  showLogin();
}

window.__S = S;   // voor probleemoplossing in de ontwikkelaarshulpmiddelen
start();
