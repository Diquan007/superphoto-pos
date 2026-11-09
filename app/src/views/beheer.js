// Tabblad Beheer (alleen met beheerderspincode)
import { S, adminCall, adminLogin, refreshCatalog, saveSettings, printHtml, renderStaff } from '../app.js';
import { local, rpc, html, raw, esc, $, $$, srd, num, round2, parseAmount, toast, modal, alertBox, confirmBox, askPin,
         attachSuggest, searchProducts, isNet, fmtDate, fmtDateTime, isoDay, STORE_NAMES, LOCATION_NAMES, METHOD_NAMES } from '../lib.js';
import { saleReceipt, testReceipt } from '../receipt.js';

const SECTIONS = [
  ['overzicht', 'Overzicht'], ['dashboard', 'Dashboard'], ['transacties', 'Transacties'], ['artikelen', 'Artikelen'],
  ['voorraad', 'Voorraad'], ['meldingen', 'Meldingen'], ['afsluitingen', 'Dagafsluitingen'], ['instellingen', 'Instellingen']
];
const KIND_NL = { sale: 'Verkoop', balance: 'Restbetaling', cash_out: 'Kas uit' };
const PKIND = { receive: 'Ontvangen', transfer: 'Uit magazijn', new_item: 'Nieuw artikel' };

export function create(root) {
  let section = 'overzicht';
  let products = [];   // beheerlijst (alle artikelen)

  root.innerHTML = html`<div class="admin">
      <nav class="side-nav" id="aNav">${raw(SECTIONS.map(([id, l]) => html`<button data-s="${id}">${l}<span class="count" data-c="${id}"></span></button>`).join(''))}</nav>
      <div class="admin-main" id="aMain"></div></div>`;
  const main = $('#aMain', root);
  $$('#aNav button', root).forEach(b => b.onclick = () => go(b.dataset.s));

  function locked() {
    $$('#aNav button', root).forEach(b => b.classList.remove('active'));
    main.innerHTML = html`<div class="center-msg"><h1>Beheer</h1><p class="muted">Alleen toegankelijk met de beheerderspincode.</p>
      <button class="btn primary big" id="aLogin">Inloggen als beheerder</button></div>`;
    $('#aLogin', main).onclick = async () => { if (await adminLogin()) go(section); };
  }
  async function go(s) {
    if (!S.admin || Date.now() > S.admin.expires) { if (!(await adminLogin())) return locked(); }
    section = s;
    $$('#aNav button', root).forEach(b => b.classList.toggle('active', b.dataset.s === s));
    main.onclick = null;
    main.innerHTML = '<p class="muted">Laden…</p>';
    try { await RENDER[s](); }
    catch (e) {
      if (e.message === 'Geen toegang') return locked();
      main.innerHTML = html`<p class="${isNet(e) ? 'warn-text' : 'error-text'}">${isNet(e) ? 'Geen internet. Beheer werkt alleen online.' : e.message}</p>`;
    }
  }

  // ================= Overzicht =================
  async function overzicht() {
    const o = await adminCall('pos_admin_overview');
    const cnt = (id, n) => { const el = $(`[data-c="${id}"]`, root); if (el) el.textContent = n ? n : ''; };
    cnt('meldingen', o.pending_proposals);
    cnt('afsluitingen', o.close_issues.length);
    main.innerHTML = html`<h1>Overzicht</h1>
      <div class="cards">
        <div class="stat ${o.low_stock.length ? 'bad' : ''}"><div class="stat-n">${o.low_stock.length}</div><div>artikelen op 0 of minder</div></div>
        <div class="stat ${o.close_issues.length ? 'bad' : ''}"><div class="stat-n">${o.close_issues.length}</div><div>afsluitingen met verschil</div></div>
        <div class="stat ${o.pending_proposals ? 'warn' : ''}"><div class="stat-n">${o.pending_proposals}</div><div>meldingen te beoordelen</div></div>
        <div class="stat ${o.unchecked_discounts.length ? 'warn' : ''}"><div class="stat-n">${o.unchecked_discounts.length}</div><div>kortingen te controleren</div></div>
      </div>
      ${raw(o.close_issues.length ? html`<h2>Afwijkingen bij dagafsluiting</h2>${raw(closeTable(o.close_issues, true))}` : '')}
      ${raw(o.unchecked_discounts.length ? html`<h2>Kortingen te controleren</h2><table class="tbl"><tr><th>Trans #</th><th>Datum</th><th>Winkel</th><th>Medewerker</th><th>Klant</th><th class="r">Subtotaal</th><th class="r">Korting</th><th></th></tr>
        ${raw(o.unchecked_discounts.map(s => html`<tr><td class="b">${s.trans_no}</td><td>${fmtDateTime(s.sold_at)}</td><td>${STORE_NAMES[s.store_code]}</td><td>${s.staff || ''}</td><td>${s.customer_name || ''}</td>
          <td class="r">${num(s.subtotal)}</td><td class="r b">${num(s.discount)}</td><td><button class="btn small" data-ack="discount" data-id="${s.trans_no}">Goedkeuren</button></td></tr>`).join(''))}</table>` : '')}
      ${raw(o.price_mismatches.length ? html`<h2>Afwijkende prijzen</h2><p class="muted small">Deze verkopen hadden een andere prijs dan in de artikellijst (bijv. offline verkocht vlak na een prijswijziging).</p>
        <table class="tbl"><tr><th>Trans #</th><th>Datum</th><th>Winkel</th><th>Regels</th><th></th></tr>
        ${raw(o.price_mismatches.map(s => html`<tr><td class="b">${s.trans_no}</td><td>${fmtDateTime(s.sold_at)}</td><td>${STORE_NAMES[s.store_code]}</td>
          <td class="small">${raw(s.lines.map(l => html`${l.qty}× ${l.stock_no} ${l.name} à ${num(l.unit_price)}`).join('<br>'))}</td>
          <td><button class="btn small" data-ack="mismatch" data-id="${s.trans_no}">Gezien</button></td></tr>`).join(''))}</table>` : '')}
      <h2>Voorraad op 0 of minder</h2>
      ${raw(o.low_stock.length ? html`<table class="tbl"><tr><th>Stock #</th><th>Artikel</th><th>Locatie</th><th class="r">Voorraad</th><th class="r">Waarschuwen bij</th></tr>
        ${raw(o.low_stock.map(l => html`<tr class="low"><td class="sn">${l.stock_no}</td><td>${l.name}</td><td>${l.location_name}</td><td class="r b">${l.qty}</td><td class="r muted">${l.min_stock}</td></tr>`).join(''))}</table>`
        : '<p class="muted">Alles op voorraad.</p>')}
      ${raw(S.queue.some(q => q.error) ? html`<h2>Offline bonnen met een fout</h2><p class="error-text">Op deze computer staan offline bonnen die de database weigerde. Klik bovenaan op de rode knop voor details.</p>` : '')}`;
    $$('[data-ack]', main).forEach(b => b.onclick = async () => {
      await adminCall('pos_admin_ack', { p_kind: b.dataset.ack, p_id: Number(b.dataset.id) });
      toast('Verwerkt.', 'ok'); overzicht();
    });
  }

  function closeTable(list, withAck) {
    return html`<table class="tbl"><tr><th>Datum</th><th>Winkel</th><th>Door</th><th class="r">Geteld</th><th class="r">Verwacht</th><th class="r">Verschil kas</th>
      <th class="r">DNP-teller</th><th class="r">Prints</th><th class="r">Pasfoto's verkocht</th><th class="r">Verschil DNP</th><th>Opmerking</th>${raw(withAck ? '<th></th>' : '')}</tr>
      ${raw(list.map(c => html`<tr>
        <td>${fmtDateTime(c.closed_at)}</td><td>${STORE_NAMES[c.store_code]}</td><td>${c.staff || ''}</td>
        <td class="r">${num(c.counted_cash)}</td><td class="r">${num(c.expected_cash)}</td>
        <td class="r b ${Number(c.cash_diff) ? 'error-text' : 'ok-text'}">${Number(c.cash_diff) > 0 ? '+' : ''}${num(c.cash_diff)}</td>
        <td class="r">${c.dnp_counter ?? ''}</td><td class="r">${c.dnp_prints ?? '—'}</td><td class="r">${c.dnp_sold}</td>
        <td class="r b ${c.dnp_diff ? 'error-text' : 'ok-text'}">${c.dnp_diff == null ? 'eerste keer' : (c.dnp_diff > 0 ? '+' : '') + c.dnp_diff}</td>
        <td class="small">${c.note || ''}</td>
        ${raw(withAck ? html`<td><button class="btn small" data-ack="close" data-id="${c.id}">Gezien</button></td>` : '')}</tr>`).join(''))}</table>
      <p class="muted small">Verschil kas: geteld min verwacht (contante verkopen + contante restbetalingen − kas uit). Verschil DNP: prints volgens de teller min verkochte DNP-pasfoto's (incl. 1058 Claim). Positief = meer prints dan verkocht.</p>`;
  }

  // ================= Dashboard =================
  let range = null;
  function presetRange(p) {
    const d = new Date(); const day = d.getDay() || 7;
    const startWeek = new Date(d); startWeek.setDate(d.getDate() - day + 1);
    const y = new Date(d); y.setDate(d.getDate() - 1);
    const startMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    const prevMonthStart = new Date(d.getFullYear(), d.getMonth() - 1, 1), prevMonthEnd = new Date(d.getFullYear(), d.getMonth(), 0);
    return { today: [d, d], yesterday: [y, y], week: [startWeek, d], month: [startMonth, d], prevmonth: [prevMonthStart, prevMonthEnd] }[p].map(isoDay);
  }
  function rangeBar(id) {
    range = range || presetRange('today');
    return html`<div class="filters range" id="${id}">
      ${raw(['today:Vandaag', 'yesterday:Gisteren', 'week:Deze week', 'month:Deze maand', 'prevmonth:Vorige maand'].map(x => { const [k, l] = x.split(':'); return `<button class="btn small" data-p="${k}">${l}</button>`; }).join(''))}
      <input type="date" data-r="0" value="${range[0]}"> t/m <input type="date" data-r="1" value="${range[1]}">
      <button class="btn small primary" data-go>Toon</button></div>`;
  }
  function bindRange(id, cb) {
    const bar = $('#' + id, main);
    $$('[data-p]', bar).forEach(b => b.onclick = () => { range = presetRange(b.dataset.p); cb(); });
    $('[data-go]', bar).onclick = () => { range = [$('[data-r="0"]', bar).value, $('[data-r="1"]', bar).value]; cb(); };
  }

  async function dashboard() {
    const r = await adminCall('pos_admin_report', { p_from: (range = range || presetRange('today'))[0], p_to: range[1] });
    const M = r.stores.MAH, I = r.stores.IND;
    const storeCol = (code, d) => {
      const pas = d.items.filter(i => i.pasfoto);
      const maxDay = Math.max(1, ...d.days.map(x => Number(x.revenue)));
      return html`<div class="store-col ${code}">
        <h2>${STORE_NAMES[code]}</h2>
        <div class="cards small">
          <div class="stat"><div class="stat-n">${srd(d.revenue)}</div><div>omzet (${d.transactions} verkopen)</div></div>
          <div class="stat"><div class="stat-n">${srd(d.received_cash)}</div><div>ontvangen contant</div></div>
          ${raw(code === 'MAH' ? html`<div class="stat"><div class="stat-n">${srd(d.received_pin)}</div><div>ontvangen PIN</div></div>` : '')}
          <div class="stat"><div class="stat-n">${srd(d.cash_out)}</div><div>kas uit</div></div>
          <div class="stat"><div class="stat-n">${srd(d.discount)}</div><div>korting gegeven</div></div>
        </div>
        ${raw(d.days.length > 1 ? html`<h3>Omzet per dag</h3><div class="bars">${raw(d.days.map(x => html`<div class="bar-row"><span>${fmtDate(x.day)}</span>
           <div class="bar"><div style="width:${Math.round(Number(x.revenue) / maxDay * 100)}%"></div></div><b>${num(x.revenue)}</b></div>`).join(''))}</div>` : '')}
        <h3>Pasfoto's</h3>${raw(itemTable(pas, true))}
        <h3>Verkocht per stocknummer</h3>${raw(itemTable(d.items))}
        ${raw(d.cash_outs.length ? html`<h3>Kas uit</h3><table class="tbl compact">${raw(d.cash_outs.map(c => html`<tr><td>${fmtDateTime(c.sold_at)}</td><td>${c.staff || ''}</td><td>${c.description}</td><td class="r">${num(c.amount)}</td></tr>`).join(''))}</table>` : '')}
      </div>`;
    };
    main.innerHTML = html`<div class="view-head"><h1>Dashboard</h1>${raw(rangeBar('dRange'))}</div>
      <div class="banner"><div><div class="muted">Totale omzet ${fmtDate(range[0])}${range[0] !== range[1] ? ' t/m ' + fmtDate(range[1]) : ''}</div>
        <div class="banner-n">${srd(Number(M.revenue) + Number(I.revenue))}</div></div>
        <div class="muted">${M.transactions + I.transactions} verkopen · ontvangen ${srd(Number(M.received_cash) + Number(I.received_cash) + Number(M.received_pin) + Number(I.received_pin))}</div>
        <button class="btn small" id="dCsv">Exporteren (CSV)</button></div>
      <div class="store-cols">${raw(storeCol('MAH', M))}${raw(storeCol('IND', I))}</div>`;
    bindRange('dRange', dashboard);
    $('#dCsv', main).onclick = () => exportCsv(r);
  }
  function itemTable(items, pas) {
    if (!items.length) return '<p class="muted small">Niets verkocht.</p>';
    const tq = items.reduce((a, i) => a + Number(i.qty), 0), tr = items.reduce((a, i) => a + Number(i.revenue), 0);
    return html`<table class="tbl compact"><tr><th>Stock #</th><th>Artikel</th><th class="r">Aantal</th><th class="r">Omzet</th></tr>
      ${raw([...items].sort((a, b) => b.revenue - a.revenue).map(i => html`<tr><td class="sn">${i.stock_no}</td><td>${i.name}${raw(pas && i.dnp ? ' <span class="tag">DNP</span>' : '')}</td><td class="r">${i.qty}</td><td class="r">${num(i.revenue)}</td></tr>`).join(''))}
      <tr class="sum"><td></td><td>Totaal</td><td class="r">${tq}</td><td class="r">${num(tr)}</td></tr></table>`;
  }
  function exportCsv(r) {
    const lines = [['Winkel', 'Stock #', 'Artikel', 'Aantal', 'Omzet SRD']];
    for (const code of ['MAH', 'IND']) for (const i of r.stores[code].items) lines.push([STORE_NAMES[code], i.stock_no, i.name, i.qty, String(i.revenue).replace('.', ',')]);
    const csv = '﻿' + lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `verkoop_${range[0]}_${range[1]}.csv`; a.click();
  }

  // ================= Transacties =================
  let txStore = '', txQ = '';
  async function transacties() {
    const list = await adminCall('pos_admin_sales', { p_from: (range = range || presetRange('today'))[0], p_to: range[1], p_store: txStore || null });
    main.innerHTML = html`<div class="view-head"><h1>Transacties</h1>${raw(rangeBar('tRange'))}</div>
      <div class="filters"><select id="tStore"><option value="">Beide winkels</option><option value="MAH">Mahony</option><option value="IND">Indira</option></select>
        <input id="tQ" placeholder="Zoek trans #, klant, medewerker" value="${txQ}"></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Trans #</th><th>Datum</th><th>Winkel</th><th>Soort</th><th>Medewerker</th><th>Klant</th>
        <th>Artikelen</th><th class="r">Totaal</th><th class="r">Betaald</th><th>Status</th><th></th></tr></thead><tbody id="tBody"></tbody></table></div>`;
    $('#tStore', main).value = txStore;
    const draw = () => {
      const s = txQ.toLowerCase();
      const vis = list.filter(t => !s || String(t.trans_no).includes(s) || (t.customer_name || '').toLowerCase().includes(s) || (t.staff || '').toLowerCase().includes(s));
      $('#tBody', main).innerHTML = vis.length ? vis.map(t => html`<tr class="${t.voided ? 'voided' : ''}">
        <td class="b">${t.trans_no}</td><td>${fmtDateTime(t.sold_at)}</td><td>${STORE_NAMES[t.store_code]}</td><td>${KIND_NL[t.kind]}${raw(t.ref_trans_no ? html` <span class="muted">op ${t.ref_trans_no}</span>` : '')}</td>
        <td>${t.staff || ''}</td><td>${t.customer_name || ''}</td>
        <td class="small">${raw(t.lines.map(l => html`${l.qty}× ${l.stock_no || ''} ${l.name}`).join('<br>'))}</td>
        <td class="r">${num(t.total)}</td><td class="r">${num(t.paid)} <span class="muted">${METHOD_NAMES[t.payment_method] || ''}</span></td>
        <td>${raw(t.voided ? html`<span class="tag red">Vervallen</span><div class="muted small">${t.void_reason || ''}</div>` : t.discount > 0 ? html`<span class="tag">korting ${num(t.discount)}</span>` : '')}</td>
        <td class="actions"><button class="btn small ghost" data-print="${t.trans_no}">Bon</button>
          ${raw(!t.voided ? `<button class="btn small danger" data-void="${t.trans_no}">Vervallen</button>` : '')}</td></tr>`).join('')
        : '<tr><td colspan="11" class="muted empty">Geen transacties in deze periode.</td></tr>';
      const tot = vis.filter(t => !t.voided && t.kind === 'sale').reduce((a, t) => a + Number(t.total), 0);
      $('#tBody', main).insertAdjacentHTML('beforeend', html`<tr class="sum"><td colspan="7">${vis.length} transacties (vervallen niet meegeteld in totaal)</td><td class="r">${num(tot)}</td><td colspan="3"></td></tr>`);
    };
    draw();
    bindRange('tRange', transacties);
    $('#tStore', main).onchange = e => { txStore = e.target.value; transacties(); };
    $('#tQ', main).addEventListener('input', e => { txQ = e.target.value.trim(); draw(); });
    main.onclick = async e => {
      const pb = e.target.closest('[data-print]'), vb = e.target.closest('[data-void]');
      if (pb) { const t = list.find(x => String(x.trans_no) === pb.dataset.print); const store = { ...S.store, ...(t.store_code !== S.store.code ? otherStore(t.store_code) : {}) }; printHtml(saleReceipt(store, t, { copy: true })); }
      if (vb) voidTx(list.find(x => String(x.trans_no) === vb.dataset.void));
    };
  }
  function otherStore(code) {
    return code === 'MAH' ? { code, address: 'Mahonylaan 47', phone: '+597-421524' } : { code, address: 'Indira Gandhiweg 175', phone: '+597 8972550' };
  }
  async function voidTx(t) {
    const linked = t.kind === 'sale' && t.payments.length ? html`<p class="warn-text">De restbetalingen op deze order (${t.payments.map(p => p.trans_no).join(', ')}) vervallen ook.</p>` : '';
    const reason = await modal({ title: `Transactie ${t.trans_no} vervallen verklaren`,
      body: html`<p>${KIND_NL[t.kind]} van ${fmtDateTime(t.sold_at)}, ${STORE_NAMES[t.store_code]}, totaal ${srd(t.total)}.</p>${raw(linked)}
        <p class="muted small">Artikelen waarvan de voorraad wordt bijgehouden gaan terug in de voorraad van de winkel waar ze verkocht zijn.</p>
        <label>Reden<input id="vReason" maxlength="300" placeholder="Bijv. verkeerd aangeslagen, klant annuleert"></label>`,
      buttons: [{ label: 'Annuleren', value: null }, { label: 'Vervallen verklaren', kind: 'danger', value: r => $('#vReason', r).value.trim(), default: true }],
      validate: r => { if (!$('#vReason', r).value.trim()) { toast('Vul een reden in.', 'error'); return false; } } });
    if (!reason) return;
    try {
      const r = await adminCall('pos_admin_void', { p_trans_no: t.trans_no, p_reason: reason });
      await alertBox('Vervallen', `Vervallen: ${r.voided.join(', ')}.` + (r.restored.length ? ' Terug in voorraad: ' + r.restored.map(x => `${x.qty}× ${x.stock_no} (${LOCATION_NAMES[x.location]})`).join(', ') + '.' : ''));
      refreshCatalog(); transacties();
    } catch (e) { alertBox('Niet gelukt', e.message); }
  }

  // ================= Artikelen =================
  let artQ = '', artCat = '';
  async function artikelen() {
    products = await adminCall('pos_admin_products');
    const cats = [...new Set(products.map(p => p.category))];
    main.innerHTML = html`<div class="view-head"><h1>Artikelen en prijzen</h1>
      <div class="filters"><input id="aQ" placeholder="Zoek stocknummer of naam" value="${artQ}">
        <select id="aCat"><option value="">Alle categorieën</option>${raw(cats.map(c => html`<option>${c}</option>`).join(''))}</select>
        <button class="btn primary" id="aNew">+ Nieuw artikel</button></div></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Stock #</th><th>Artikel</th><th>Categorie</th><th class="r">Prijs</th><th>Winkel</th>
        <th class="c">Voorraad</th><th class="r">Mahony</th><th class="r">Indira</th><th class="r">Magazijn</th><th></th></tr></thead><tbody id="aBody"></tbody></table></div>`;
    $('#aCat', main).value = artCat;
    const draw = () => {
      let list = artQ ? searchProducts(products, artQ) : products;
      if (artCat) list = list.filter(p => p.category === artCat);
      $('#aBody', main).innerHTML = list.map(p => html`<tr class="${p.active ? '' : 'inactive'}" data-no="${p.stock_no}">
        <td class="sn">${p.stock_no}</td><td>${p.name}${raw(!p.active ? ' <span class="tag">inactief</span>' : '')}${raw(!p.sellable ? ' <span class="tag">verbruik</span>' : '')}${raw(p.dnp ? ' <span class="tag">DNP</span>' : '')}</td>
        <td class="muted">${p.category}</td><td class="r b">${num(p.price)}</td><td>${p.only_store ? 'alleen ' + STORE_NAMES[p.only_store] : 'beide'}</td>
        <td class="c">${p.track_stock ? '✓' : ''}</td>
        <td class="r">${p.track_stock ? (p.qty_mah ?? '—') : ''}</td><td class="r">${p.track_stock ? (p.qty_ind ?? '—') : ''}</td><td class="r">${p.track_stock ? (p.qty_mag ?? '—') : ''}</td>
        <td class="actions"><button class="btn small" data-edit="${p.stock_no}">Wijzig</button>${raw(p.track_stock ? `<button class="btn small ghost" data-hist="${p.stock_no}">Historie</button>` : '')}</td></tr>`).join('');
    };
    draw();
    $('#aQ', main).addEventListener('input', e => { artQ = e.target.value.trim(); draw(); });
    $('#aCat', main).onchange = e => { artCat = e.target.value; draw(); };
    $('#aNew', main).onclick = () => editProduct(null, cats);
    main.onclick = e => {
      const eb = e.target.closest('[data-edit]'), hb = e.target.closest('[data-hist]');
      if (eb) editProduct(products.find(p => p.stock_no === eb.dataset.edit), cats);
      if (hb) history(products.find(p => p.stock_no === hb.dataset.hist));
    };
  }
  async function editProduct(p, cats, preset = {}) {
    const isNew = !p;
    p = p || { stock_no: preset.stock_no || '', name: preset.name || '', price: preset.price ?? '', category: preset.category || '', only_store: '', track_stock: true, sellable: true, dnp: false, min_stock: 0, active: true, note: '' };
    const res = await modal({ title: isNew ? 'Nieuw artikel' : `Artikel ${p.stock_no} wijzigen`, wide: true,
      body: html`<div class="grid3">
        <label>Stocknummer<input id="pNo" value="${p.stock_no}" ${isNew ? '' : 'disabled'}></label>
        <label class="span2">Naam<input id="pName" value="${p.name}" maxlength="100"></label>
        <label>Prijs SRD<input id="pPrice" inputmode="decimal" value="${p.price === '' ? '' : num(p.price)}"></label>
        <label>Categorie<input id="pCat" list="pCats" value="${p.category}"><datalist id="pCats">${raw(cats.map(c => html`<option>${c}</option>`).join(''))}</datalist></label>
        <label>Te koop in<select id="pStore"><option value="">Beide winkels</option><option value="MAH">Alleen Mahony</option><option value="IND">Alleen Indira</option></select></label>
        <label class="check"><input type="checkbox" id="pTrack" ${p.track_stock ? 'checked' : ''}> Voorraad bijhouden</label>
        <label>Waarschuwen bij voorraad ≤<input id="pMin" inputmode="numeric" value="${p.min_stock}"></label>
        <label class="check"><input type="checkbox" id="pSell" ${p.sellable ? 'checked' : ''}> Te koop aan de kassa (uit = verbruiksartikel)</label>
        <label class="check"><input type="checkbox" id="pDnp" ${p.dnp ? 'checked' : ''}> Pasfoto op DNP (telt mee voor DNP-teller)</label>
        <label class="check"><input type="checkbox" id="pActive" ${p.active ? 'checked' : ''}> Actief</label>
        <label class="span3">Opmerking<input id="pNote" value="${p.note || ''}"></label></div>
        ${raw(!isNew ? '<p class="muted small">Een prijswijziging geldt direct voor nieuwe verkopen in beide winkels.</p>' : '')}`,
      onOpen: r => { $('#pStore', r).value = p.only_store || ''; },
      buttons: [{ label: 'Annuleren', value: null }, { label: 'Opslaan', kind: 'primary', default: true, value: r => ({
        stock_no: $('#pNo', r).value.trim(), name: $('#pName', r).value.trim(), price: parseAmount($('#pPrice', r).value),
        category: $('#pCat', r).value.trim(), only_store: $('#pStore', r).value, track_stock: $('#pTrack', r).checked,
        min_stock: parseInt($('#pMin', r).value, 10) || 0, sellable: $('#pSell', r).checked, dnp: $('#pDnp', r).checked,
        active: $('#pActive', r).checked, note: $('#pNote', r).value.trim() }) }],
      validate: r => {
        if (!(parseAmount($('#pPrice', r).value) >= 0)) { toast('Vul een geldige prijs in.', 'error'); return false; }
      } });
    if (!res) return null;
    try {
      await adminCall('pos_admin_save_product', { p: res, p_is_new: isNew });
      toast('Artikel opgeslagen.', 'ok'); refreshCatalog();
      if (section === 'artikelen') artikelen();
      return res;
    } catch (e) { alertBox('Niet opgeslagen', e.message); return null; }
  }
  async function history(p) {
    const moves = await adminCall('pos_admin_stock_moves', { p_stock_no: p.stock_no });
    modal({ title: `Voorraadhistorie ${p.stock_no} ${p.name}`, wide: true,
      body: moves.length ? html`<table class="tbl compact"><tr><th>Moment</th><th>Locatie</th><th>Reden</th><th>Ref.</th><th class="r">Mutatie</th><th class="r">Daarna</th><th>Opmerking</th></tr>
        ${raw(moves.map(m => html`<tr><td>${fmtDateTime(m.at)}</td><td>${LOCATION_NAMES[m.location]}</td><td>${m.reason}</td><td>${m.ref || ''}</td>
          <td class="r ${m.delta < 0 ? 'error-text' : 'ok-text'}">${m.delta > 0 ? '+' : ''}${m.delta}</td><td class="r b">${m.qty_after}</td><td class="small">${m.note || ''}</td></tr>`).join(''))}</table>`
        : '<p class="muted">Nog geen mutaties.</p>' });
  }

  // ================= Voorraad (telling, ontvangst, verplaatsing) =================
  let stMode = 'count', stLoc = 'MAH', stFrom = 'MAG', stCat = '';
  async function voorraad() {
    products = await adminCall('pos_admin_products');
    const tracked = products.filter(p => p.track_stock && p.active);
    const cats = [...new Set(tracked.map(p => p.category))];
    main.innerHTML = html`<h1>Voorraad</h1>
      <div class="seg big" id="sMode"><button data-m="count">Telling invoeren</button><button data-m="receive">Ontvangst</button><button data-m="transfer">Verplaatsen</button></div>
      <div class="filters" id="sBar"></div>
      <div id="sBody"></div>`;
    const qtyKey = { MAH: 'qty_mah', IND: 'qty_ind', MAG: 'qty_mag' };
    const locSel = (id, val, label) => html`<label>${label} <select id="${id}">${raw(['MAH', 'IND', 'MAG'].map(c => `<option value="${c}" ${c === val ? 'selected' : ''}>${LOCATION_NAMES[c]}</option>`).join(''))}</select></label>`;
    const draw = () => {
      $$('#sMode button', main).forEach(b => b.classList.toggle('active', b.dataset.m === stMode));
      if (stMode === 'count') {
        $('#sBar', main).innerHTML = locSel('sLoc', stLoc, 'Locatie') + html`<label>Categorie <select id="sCat"><option value="">Alle</option>${raw(cats.map(c => html`<option ${c === stCat ? 'selected' : ''}>${c}</option>`).join(''))}</select></label>
          <input id="sFind" placeholder="Zoek in lijst">`;
        const list = tracked.filter(p => (!stCat || p.category === stCat) && (stLoc === 'MAG' || !p.only_store || p.only_store === stLoc));
        $('#sBody', main).innerHTML = html`<p class="muted small">Vul alleen in wat u geteld heeft. Lege vakken worden niet gewijzigd. Laat artikelen leeg die op deze locatie niet liggen.</p>
          <div class="table-wrap"><table class="tbl" id="sTbl"><thead><tr><th>Stock #</th><th>Artikel</th><th>Categorie</th><th class="r">Nu in systeem</th><th class="c">Geteld</th><th class="r">Verschil</th></tr></thead>
          <tbody>${raw(list.map(p => html`<tr data-name="${(p.stock_no + ' ' + p.name).toLowerCase()}"><td class="sn">${p.stock_no}</td><td>${p.name}</td><td class="muted">${p.category}</td>
            <td class="r">${p[qtyKey[stLoc]] ?? '—'}</td><td class="c"><input class="count-in" data-no="${p.stock_no}" data-cur="${p[qtyKey[stLoc]] ?? 0}" inputmode="numeric"></td><td class="r diff"></td></tr>`).join(''))}</tbody></table></div>
          <label>Opmerking<input id="sNote" placeholder="Bijv. maandtelling november"></label>
          <button class="btn primary big" id="sSave">Telling opslaan</button>`;
        $('#sLoc', main).onchange = e => { stLoc = e.target.value; draw(); };
        $('#sCat', main).onchange = e => { stCat = e.target.value; draw(); };
        $('#sFind', main).addEventListener('input', e => { const s = e.target.value.toLowerCase(); $$('#sTbl tbody tr', main).forEach(tr => tr.hidden = s && !tr.dataset.name.includes(s)); });
        $('#sTbl', main).addEventListener('input', e => {
          const inp = e.target.closest('.count-in'); if (!inp) return;
          const d = inp.value.trim() === '' ? '' : parseInt(inp.value, 10) - Number(inp.dataset.cur);
          const cell = $('.diff', inp.closest('tr')); cell.textContent = d === '' || isNaN(d) ? '' : (d > 0 ? '+' : '') + d; cell.className = 'r diff ' + (d < 0 ? 'error-text' : d > 0 ? 'ok-text' : '');
        });
        $('#sTbl', main).addEventListener('keydown', e => {
          if (e.key === 'Enter' && e.target.classList.contains('count-in')) {
            e.preventDefault(); const all = $$('.count-in', main).filter(i => !i.closest('tr').hidden); const i = all.indexOf(e.target); if (all[i + 1]) all[i + 1].focus();
          }
        });
        $('#sSave', main).onclick = async () => {
          const items = $$('.count-in', main).filter(i => i.value.trim() !== '').map(i => ({ stock_no: i.dataset.no, qty: parseInt(i.value, 10) }));
          if (!items.length) return toast('Er is niets ingevuld.', 'error');
          if (items.some(i => isNaN(i.qty) || i.qty < 0)) return toast('Alleen hele getallen van 0 of meer.', 'error');
          if (!(await confirmBox('Telling opslaan', `${items.length} artikel(en) op ${LOCATION_NAMES[stLoc]} instellen op het getelde aantal?`, 'Opslaan'))) return;
          await adminCall('pos_admin_count', { p_location: stLoc, p_items: items, p_note: $('#sNote', main).value.trim() || 'telling' });
          toast('Telling opgeslagen.', 'ok'); refreshCatalog(); voorraad();
        };
      } else {
        const rows = [];
        $('#sBar', main).innerHTML = stMode === 'transfer'
          ? locSel('sFrom', stFrom, 'Van') + locSel('sTo', stLoc === stFrom ? (stFrom === 'MAG' ? 'MAH' : 'MAG') : stLoc, 'Naar')
          : locSel('sTo', stLoc, 'Naar locatie');
        $('#sBody', main).innerHTML = html`<div class="card"><div class="grid2 tight"><div class="sg-host"><input id="sAdd" placeholder="Stocknummer of naam toevoegen"></div><span></span></div>
          <table class="tbl" id="sRows"><thead><tr><th>Stock #</th><th>Artikel</th><th class="c">Aantal</th><th></th></tr></thead><tbody></tbody></table>
          <label>Opmerking<input id="sNote" placeholder="${stMode === 'receive' ? 'Leverancier / factuurnummer' : 'Reden'}"></label>
          <button class="btn primary big" id="sSave">${stMode === 'receive' ? 'Ontvangst opslaan' : 'Verplaatsing opslaan'}</button></div>`;
        const drawRows = () => {
          $('#sRows tbody', main).innerHTML = rows.length ? rows.map((r, i) => html`<tr><td class="sn">${r.stock_no}</td><td>${r.name}</td>
            <td class="c"><input class="count-in" data-i="${i}" value="${r.qty}" inputmode="numeric"></td><td><button class="icon-btn" data-x="${i}">✕</button></td></tr>`).join('')
            : '<tr><td colspan="4" class="muted empty">Voeg artikelen toe.</td></tr>';
        };
        attachSuggest($('#sAdd', main), { source: s => searchProducts(tracked, s), render: p => html`<b>${p.stock_no}</b> ${p.name}`,
          pick: p => { if (!rows.find(r => r.stock_no === p.stock_no)) rows.push({ stock_no: p.stock_no, name: p.name, qty: '' }); $('#sAdd', main).value = ''; drawRows(); setTimeout(() => $$('.count-in', main).pop()?.focus(), 20); } });
        $('#sRows', main).addEventListener('input', e => { const i = e.target.dataset.i; if (i !== undefined) rows[+i].qty = e.target.value; });
        $('#sRows', main).addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) { rows.splice(+x.dataset.x, 1); drawRows(); } });
        $('#sRows', main).addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('count-in')) { e.preventDefault(); $('#sAdd', main).focus(); } });
        drawRows();
        $('#sTo', main).onchange = e => { stLoc = e.target.value; };
        if ($('#sFrom', main)) $('#sFrom', main).onchange = e => { stFrom = e.target.value; };
        $('#sSave', main).onclick = async () => {
          const items = rows.map(r => ({ stock_no: r.stock_no, qty: parseInt(r.qty, 10) }));
          if (!items.length) return toast('Voeg artikelen toe.', 'error');
          if (items.some(i => !(i.qty > 0))) return toast('Vul bij elk artikel een aantal in.', 'error');
          const to = $('#sTo', main).value, from = stMode === 'transfer' ? $('#sFrom', main).value : null;
          if (from && from === to) return toast('Kies twee verschillende locaties.', 'error');
          await adminCall('pos_admin_move', { p_kind: stMode, p_from: from, p_to: to, p_items: items, p_note: $('#sNote', main).value.trim() || null });
          toast('Opgeslagen.', 'ok'); refreshCatalog(); voorraad();
        };
      }
    };
    $$('#sMode button', main).forEach(b => b.onclick = () => { stMode = b.dataset.m; draw(); });
    draw();
  }

  // ================= Meldingen =================
  async function meldingen() {
    const [pending, done] = await Promise.all([adminCall('pos_admin_proposals', { p_status: 'pending' }), adminCall('pos_admin_proposals', { p_status: 'done' })]);
    const cnt = $(`[data-c="meldingen"]`, root); if (cnt) cnt.textContent = pending.length || '';
    main.innerHTML = html`<h1>Meldingen van personeel</h1>
      <p class="muted">Pas zo nodig aantal of locatie aan en keur goed. Pas dan verandert de voorraad.</p>
      ${raw(pending.length ? pending.map(p => html`<div class="card proposal" data-id="${p.id}">
        <div class="prop-head"><b>${PKIND[p.kind]}</b> · ${STORE_NAMES[p.store_code]} · ${p.staff || ''} · <span class="muted">${fmtDateTime(p.created_at)}</span></div>
        <div class="grid4 tight">
          ${raw(p.kind === 'new_item'
            ? html`<label>Nieuw stocknummer<input data-f="stock_no" placeholder="bijv. 1490"></label><label>Naam<input data-f="name" value="${p.new_name}"></label>
                   <label>Prijs SRD<input data-f="price" value="${num(p.new_price)}"></label><label>Categorie<input data-f="category" list="propCats" value="Lijsten"></label>`
            : html`<div class="span2"><span class="muted">Artikel</span><br><b>${p.stock_no} ${p.product_name || ''}</b></div>`)}
          <label>Aantal<input data-f="qty" value="${p.qty}" inputmode="numeric"></label>
          <label>${p.kind === 'transfer' ? 'Van magazijn naar' : 'Naar locatie'}<select data-f="location">${raw((p.kind === 'transfer' ? ['MAH', 'IND'] : ['MAH', 'IND', 'MAG']).map(c => `<option value="${c}" ${c === p.location ? 'selected' : ''}>${LOCATION_NAMES[c]}</option>`).join(''))}</select></label>
        </div>
        ${raw(p.note ? html`<p class="note-box">${p.note}</p>` : '')}
        <div class="btn-row"><input data-f="result_note" placeholder="Opmerking voor het personeel (optioneel)">
          <button class="btn danger" data-act="no">Afwijzen</button><button class="btn primary" data-act="yes">Goedkeuren</button></div>
      </div>`).join('') : '<p class="muted">Geen meldingen te beoordelen.</p>')}
      <datalist id="propCats">${raw([...new Set(S.catalog.map(p => p.category))].map(c => html`<option>${c}</option>`).join(''))}</datalist>
      <h2>Afgehandeld (60 dagen)</h2>
      ${raw(done.length ? html`<table class="tbl compact"><tr><th>Datum</th><th>Winkel</th><th>Door</th><th>Soort</th><th>Artikel</th><th class="r">Aantal</th><th>Locatie</th><th>Status</th></tr>
        ${raw(done.map(p => html`<tr><td>${fmtDateTime(p.created_at)}</td><td>${STORE_NAMES[p.store_code]}</td><td>${p.staff || ''}</td><td>${PKIND[p.kind]}</td>
          <td>${p.stock_no || ''} ${p.product_name || p.new_name || ''}</td><td class="r">${p.qty}</td><td>${LOCATION_NAMES[p.location] || ''}</td>
          <td>${p.status === 'approved' ? 'Goedgekeurd' : 'Afgewezen'}${raw(p.result_note ? html`<div class="muted small">${p.result_note}</div>` : '')}</td></tr>`).join(''))}</table>` : '<p class="muted">Nog niets.</p>')}`;
    main.onclick = async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const card = b.closest('.proposal'), id = Number(card.dataset.id);
      const edit = {}; $$('[data-f]', card).forEach(i => { if (i.value.trim() !== '') edit[i.dataset.f] = i.value.trim(); });
      if (edit.price) edit.price = parseAmount(edit.price);
      if (edit.qty) edit.qty = parseInt(edit.qty, 10);
      try {
        await adminCall('pos_admin_handle_proposal', { p_id: id, p_approve: b.dataset.act === 'yes', p_edit: edit });
        toast(b.dataset.act === 'yes' ? 'Goedgekeurd en verwerkt.' : 'Afgewezen.', 'ok'); refreshCatalog(); meldingen();
      } catch (err) { alertBox('Niet gelukt', err.message); }
    };
  }

  // ================= Dagafsluitingen =================
  async function afsluitingen() {
    const r = await adminCall('pos_admin_report', { p_from: (range = range || presetRange('month'))[0], p_to: range[1] });
    main.innerHTML = html`<div class="view-head"><h1>Dagafsluitingen</h1>${raw(rangeBar('cRange'))}</div>
      ${raw(r.closes.length ? closeTable(r.closes, true) : '<p class="muted">Geen afsluitingen in deze periode.</p>')}`;
    bindRange('cRange', afsluitingen);
    $$('[data-ack]', main).forEach(b => b.onclick = async () => { await adminCall('pos_admin_ack', { p_kind: 'close', p_id: Number(b.dataset.id) }); toast('Gezien.', 'ok'); afsluitingen(); });
    $$('[data-ack]', main).forEach(b => { const c = r.closes.find(x => String(x.id) === b.dataset.id); if (c && (c.acknowledged || (!Number(c.cash_diff) && !c.dnp_diff))) b.remove(); });
  }

  // ================= Instellingen =================
  async function instellingen() {
    const stores = await adminCall('pos_admin_settings');
    const printers = await local.printers();
    const info = await local.appInfo();
    main.innerHTML = html`<h1>Instellingen</h1>
      <div class="grid2">
        <div class="card"><h2>Deze computer</h2>
          <label>Bonprinter<select id="iPrinter"><option value="">Windows-printvenster tonen</option>
            ${raw(printers.map(p => html`<option value="${p.name}">${p.displayName}${p.isDefault ? ' (standaard)' : ''}</option>`).join(''))}</select></label>
          <p class="muted small">Bonbreedte voor deze winkel: ${S.store.receipt_width_mm} mm.</p>
          <div class="btn-row"><button class="btn" id="iTest">Testbon printen</button><button class="btn primary" id="iSavePr">Opslaan</button></div>
          <p class="muted small">Versie ${info.version} · database ${esc(S.settings.supabaseUrl || '')}</p>
          <button class="btn small ghost" id="iConn">Database-koppeling wijzigen</button>
        </div>
        <div class="card"><h2>Automatische updates</h2>
          <label>GitHub-repository (eigenaar/naam)<input id="iRepo" placeholder="bijv. superphoto/superphoto-pos"></label>
          <p class="muted small">Alle kassa's halen nieuwe versies hier op en installeren ze bij het afsluiten.</p>
          <button class="btn" id="iRepoSave">Opslaan</button></div>
        <div class="card"><h2>Back-up</h2>
          <p class="muted small">Download alle gegevens (verkopen, voorraad, artikelen, klanten) als één bestand en bewaar het op een USB-stick of in Google Drive. Doe dit minstens één keer per week.</p>
          <button class="btn primary" id="iBackup">Back-up downloaden</button></div>
        <div class="card"><h2>Pincodes wijzigen</h2>
          <label>Welke<select id="iPinT"><option value="MAH">Kassa Mahony</option><option value="IND">Kassa Indira</option><option value="ADMIN">Beheerder (uzelf)</option></select></label>
          <p class="muted small">Na het wijzigen van een kassapincode moet die kassa opnieuw inloggen.</p>
          <button class="btn" id="iPin">Nieuwe pincode instellen</button></div>
        ${raw(stores.map(s => html`<div class="card"><h2>Medewerkers ${STORE_NAMES[s.code]}</h2>
          <textarea data-staff="${s.code}" rows="5" placeholder="Eén naam per regel">${s.staff.join('\n')}</textarea>
          <button class="btn" data-savestaff="${s.code}">Opslaan</button></div>`).join(''))}
      </div>`;
    $('#iPrinter', main).value = S.settings.printer || '';
    try { const st = await rpc('pos_status'); $('#iRepo', main).value = st.update_repo || ''; } catch {}
    $('#iBackup', main).onclick = async () => {
      const data = await adminCall('pos_admin_export');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      a.download = `superphoto-backup-${isoDay()}.json`; a.click();
      toast(`Back-up gemaakt: ${data.sales.length} transacties, ${data.products.length} artikelen.`, 'ok', 5000);
    };
    $('#iRepoSave', main).onclick = async () => {
      try { await adminCall('pos_admin_set_update_repo', { p_repo: $('#iRepo', main).value.trim() }); toast('Opgeslagen. Kassa\'s gebruiken dit na de volgende start.', 'ok'); }
      catch (e) { alertBox('Niet opgeslagen', e.message); }
    };
    $('#iSavePr', main).onclick = async () => { S.settings.printer = $('#iPrinter', main).value; await saveSettings(); toast('Printer opgeslagen voor deze computer.', 'ok'); };
    $('#iTest', main).onclick = async () => { S.settings.printer = $('#iPrinter', main).value; await saveSettings(); printHtml(testReceipt(S.store)); };
    $('#iConn', main).onclick = async () => {
      if (!(await confirmBox('Koppeling wijzigen', 'De kassa wordt vergrendeld en vraagt opnieuw om de database-gegevens. Doorgaan?'))) return;
      S.settings.supabaseKey = ''; S.settings.session = null; await saveSettings(); location.reload();
    };
    $('#iPin', main).onclick = async () => {
      const t = $('#iPinT', main).value;
      const a = await askPin('Nieuwe pincode', 'Kies een nieuwe pincode (4–8 cijfers)'); if (!a) return;
      const b = await askPin('Herhaal', 'Voer dezelfde pincode nog eens in'); if (!b) return;
      if (a !== b) return toast('De pincodes zijn niet gelijk.', 'error');
      try { await adminCall('pos_admin_change_pin', { p_target: t, p_new_pin: a }); toast('Pincode gewijzigd.', 'ok'); }
      catch (e) { alertBox('Niet gelukt', e.message); }
    };
    $$('[data-savestaff]', main).forEach(b => b.onclick = async () => {
      const code = b.dataset.savestaff;
      const names = $(`[data-staff="${code}"]`, main).value.split('\n').map(s => s.trim()).filter(Boolean);
      await adminCall('pos_admin_set_staff', { p_store: code, p_staff: names });
      if (code === S.store.code) { S.store.staff = [...new Set(names)].sort(); renderStaff(); }
      toast('Medewerkers opgeslagen.', 'ok');
    });
  }

  const RENDER = { overzicht, dashboard, transacties, artikelen, voorraad, meldingen, afsluitingen, instellingen };
  locked();
  return { show() { go(section); }, locked };
}
