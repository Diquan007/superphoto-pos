// Tabblad Kassa: verkopen, aanbetalingen, ophaalorders aanmaken
import { S, call, enqueue, provisionalNo, printHtml, requireStaff, warnStock, refreshCatalog } from '../app.js';
import { local, html, raw, esc, $, $$, srd, num, round2, parseAmount, toast, modal, alertBox, confirmBox,
         attachSuggest, searchProducts, uuid, isNet, STORE_NAMES, METHOD_NAMES, fmtDateTime } from '../lib.js';
import { saleReceipt } from '../receipt.js';

const TIMES = [];
for (let h = 8; h <= 20; h++) { TIMES.push(`${String(h).padStart(2, '0')}:00`); if (h < 20) TIMES.push(`${String(h).padStart(2, '0')}:30`); }

export function create(root) {
  const st = S.store.code;
  const methods = S.store.payment_methods || ['cash'];
  let cart = [];                // {stock_no, name, price, qty, track_stock, min_stock}
  let customerId = null;
  let method = methods[0];
  let partial = false;
  let busy = false;
  let catFilter = null;

  root.innerHTML = html`
  <div class="kassa">
    <div class="k-left">
      <div class="searchbar">
        <input id="kSearch" class="big-input" placeholder="Stocknummer of naam typen of scannen  (F2)" autocomplete="off">
      </div>
      <div class="chips" id="kCats"></div>
      <div class="results" id="kResults"></div>
      <div class="cart-wrap">
        <table class="tbl cart"><thead><tr><th>Stock #</th><th>Artikel</th><th class="r">Prijs</th><th class="c">Aantal</th><th class="r">Totaal</th><th></th></tr></thead>
          <tbody id="kCart"></tbody></table>
      </div>
    </div>
    <aside class="k-right">
      <div class="panel">
        <div class="panel-title">Klant <span class="muted small" id="kCustHint">(optioneel)</span></div>
        <div class="grid2 tight">
          <div><input id="kCName" placeholder="Naam"></div>
          <div><input id="kCPhone" placeholder="Telefoon" inputmode="tel"></div>
        </div>
      </div>
      <details class="panel" id="kOrder">
        <summary class="panel-title">Ophalen, route en opmerking <span class="badge" id="kOrderBadge" hidden>order</span></summary>
        <div class="grid2 tight">
          <label>Ophaaldatum<input type="date" id="kPDate"></label>
          <label>Tijd<select id="kPTime"><option value="">—</option>${raw(TIMES.map(t => `<option>${t}</option>`).join(''))}</select></label>
        </div>
        <div class="grid3 tight">
          <label>Van<select id="kVan"></select></label>
          <label>Door (maakt)<select id="kDoor"></select></label>
          <label>Afhalen in<select id="kAfh"></select></label>
        </div>
        <label>Opmerking<input id="kComment" maxlength="500" placeholder="Bijv. formaat, afwerking, bijzonderheden"></label>
      </details>
      <div class="panel">
        <div class="row-line"><span>Subtotaal</span><b id="kSub">SRD 0,00</b></div>
        <div class="row-line discount">
          <span>Korting</span>
          <span class="disc-in"><input id="kDisc" inputmode="decimal" placeholder="0"><select id="kDiscType"><option value="pct">%</option><option value="srd">SRD</option></select></span>
          <b id="kDiscAmt">SRD 0,00</b>
        </div>
        <div class="total-line"><span>Totaal</span><span id="kTotal">SRD 0,00</span></div>
      </div>
      <div class="panel pay">
        <div class="seg" id="kMethods">${raw(methods.map(m => html`<button data-m="${m}">${METHOD_NAMES[m]}</button>`).join(''))}</div>
        <label class="check"><input type="checkbox" id="kPartial"> Aanbetaling (klant betaalt nu een deel)</label>
        <div id="kPartialBox" hidden><label>Nu betaald SRD<input id="kPaid" inputmode="decimal" placeholder="0,00"></label>
          <div class="muted small">Openstaand: <b id="kOpen">SRD 0,00</b></div></div>
        <div id="kCashBox">
          <label>Ontvangen contant SRD<input id="kRecv" inputmode="decimal" placeholder="gepast"></label>
          <div class="quick" id="kQuick"></div>
          <div class="change-line"><span>Wisselgeld</span><span id="kChange">SRD 0,00</span></div>
        </div>
        <div class="pay-buttons">
          <button class="btn primary big" id="kPay">Afrekenen + bon <kbd>F9</kbd></button>
          <button class="btn" id="kPayNoPrint">Zonder bon <kbd>F10</kbd></button>
          <button class="btn ghost danger-text" id="kClear">Leegmaken <kbd>Esc</kbd></button>
        </div>
      </div>
    </aside>
  </div>`;

  const storeOpts = ['MAH', 'IND'].map(c => `<option value="${c}">${STORE_NAMES[c]}</option>`).join('');
  ['#kVan', '#kDoor', '#kAfh'].forEach(s => { $(s, root).innerHTML = storeOpts; $(s, root).value = st; });

  // ---------- zoeken ----------
  const search = $('#kSearch', root);
  const resultsEl = $('#kResults', root);
  let shown = [], hi = 0;
  const sellable = () => S.catalog.filter(p => p.sellable);

  function stockBadge(p) {
    if (!p.track_stock) return '';
    const inCart = cart.filter(c => c.stock_no === p.stock_no).reduce((a, c) => a + c.qty, 0);
    const q = (p.qty ?? 0) - inCart;
    return `<span class="stock ${q <= (p.min_stock || 0) ? 'low' : ''}">${q}</span>`;
  }
  function renderResults() {
    let q = search.value.trim();
    const m = q.match(/^(\d+)\s*[*x]\s*(.*)$/i);      // "3*1401" = 3 stuks
    if (m) q = m[2];
    if (q) shown = searchProducts(sellable(), q).slice(0, 60);
    else if (catFilter) shown = sellable().filter(p => p.category === catFilter);
    else shown = [];
    hi = Math.min(hi, Math.max(shown.length - 1, 0));
    resultsEl.innerHTML = shown.length ? shown.map((p, i) => html`
      <button class="res ${i === hi ? 'hi' : ''}" data-i="${i}"><span class="sn">${p.stock_no}</span>
        <span class="nm">${p.name}</span>${raw(stockBadge(p))}<span class="pr">${num(p.price)}</span></button>`).join('')
      : `<div class="muted empty">${q ? 'Niets gevonden.' : 'Typ een stocknummer of naam, of kies een categorie.'}</div>`;
    $$('#kCats .chip', root).forEach(c => c.classList.toggle('active', c.dataset.c === catFilter && !q));
  }
  function renderCats() {
    const cats = [...new Set(sellable().map(p => p.category))];
    $('#kCats', root).innerHTML = cats.map(c => html`<button class="chip" data-c="${c}">${c}</button>`).join('');
    $$('#kCats .chip', root).forEach(c => c.onclick = () => { catFilter = catFilter === c.dataset.c ? null : c.dataset.c; search.value = ''; hi = 0; renderResults(); search.focus(); });
  }
  search.addEventListener('input', () => { hi = 0; renderResults(); });
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, shown.length - 1); renderResults(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); renderResults(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      let q = search.value.trim(), qty = 1;
      const m = q.match(/^(\d+)\s*[*x]\s*(.+)$/i);
      if (m) { qty = +m[1]; q = m[2].trim(); }
      const exact = sellable().find(p => p.stock_no.toLowerCase() === q.toLowerCase());
      const p = exact || shown[hi];
      if (p) { add(p, qty); search.value = ''; catFilter = null; renderResults(); }
      else if (q) toast('Onbekend stocknummer: ' + q, 'error');
    }
  });
  resultsEl.addEventListener('click', e => {
    const b = e.target.closest('.res'); if (!b) return;
    add(shown[+b.dataset.i], 1); search.focus();
  });

  // ---------- bon ----------
  function add(p, qty = 1) {
    const ex = cart.find(c => c.stock_no === p.stock_no);
    if (ex) ex.qty += qty; else cart.push({ stock_no: p.stock_no, name: p.name, price: p.price, qty, track_stock: p.track_stock, min_stock: p.min_stock || 0 });
    renderCart(p.stock_no);
  }
  function stockAfter(c) {
    const p = S.catalog.find(x => x.stock_no === c.stock_no);
    return (p?.qty ?? 0) - cart.filter(x => x.stock_no === c.stock_no).reduce((a, x) => a + x.qty, 0);
  }
  function renderCart(flash) {
    const tb = $('#kCart', root);
    tb.innerHTML = cart.length ? cart.map((c, i) => {
      const after = c.track_stock ? stockAfter(c) : null;
      const low = c.track_stock && after <= c.min_stock;
      return html`<tr class="${low ? 'low' : ''} ${c.stock_no === flash ? 'flash' : ''}">
        <td class="sn">${c.stock_no}</td>
        <td>${c.name}${raw(low ? html`<div class="low-text">⚠ Voorraad na verkoop: ${after}</div>` : '')}</td>
        <td class="r">${num(c.price)}</td>
        <td class="c"><div class="qty"><button data-a="-" data-i="${i}">−</button><input data-q="${i}" value="${c.qty}" inputmode="numeric"><button data-a="+" data-i="${i}">+</button></div></td>
        <td class="r b">${num(c.price * c.qty)}</td>
        <td><button class="icon-btn" data-a="x" data-i="${i}" title="Verwijderen">✕</button></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty muted">Nog geen artikelen. Zoek hierboven of scan een barcode.</td></tr>';
    S.dirty = cart.length > 0;
    renderResults();
    recalc();
    saveDraft();
  }
  $('#kCart', root).addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = +b.dataset.i, c = cart[i];
    if (b.dataset.a === '+') c.qty++;
    else if (b.dataset.a === '-') { c.qty--; if (c.qty <= 0) cart.splice(i, 1); }
    else cart.splice(i, 1);
    renderCart();
  });
  $('#kCart', root).addEventListener('change', e => {
    const inp = e.target.closest('input[data-q]'); if (!inp) return;
    const v = parseInt(inp.value, 10), i = +inp.dataset.q;
    if (!(v > 0)) cart.splice(i, 1); else cart[i].qty = Math.min(v, 9999);
    renderCart();
  });

  // ---------- bedragen ----------
  function amounts() {
    const subtotal = round2(cart.reduce((a, c) => a + c.price * c.qty, 0));
    const dv = parseAmount($('#kDisc', root).value);
    let discount = 0;
    if (dv > 0) discount = $('#kDiscType', root).value === 'pct' ? round2(subtotal * Math.min(dv, 100) / 100) : round2(Math.min(dv, subtotal));
    const total = round2(subtotal - discount);
    let paid = total;
    if (partial) { const p = parseAmount($('#kPaid', root).value); paid = isNaN(p) ? 0 : round2(Math.min(Math.max(p, 0), total)); }
    const recvRaw = $('#kRecv', root).value.trim();
    const recv = method === 'cash' && recvRaw ? parseAmount(recvRaw) : null;
    return { subtotal, discount, total, paid, recv, change: recv != null && !isNaN(recv) ? round2(recv - paid) : 0 };
  }
  function recalc() {
    const a = amounts();
    $('#kSub', root).textContent = srd(a.subtotal);
    $('#kDiscAmt', root).textContent = a.discount ? '− ' + srd(a.discount) : srd(0);
    $('#kTotal', root).textContent = srd(a.total);
    $('#kOpen', root).textContent = srd(a.total - a.paid);
    $('#kChange', root).textContent = srd(Math.max(a.change, 0));
    $('#kChange', root).classList.toggle('neg', a.change < 0);
    $('#kCashBox', root).hidden = method !== 'cash';
    $('#kPartialBox', root).hidden = !partial;
    $$('#kMethods button', root).forEach(b => b.classList.toggle('active', b.dataset.m === method));
    const due = a.paid;
    const quick = [due, ...[50, 100, 200, 500, 1000, 2000].filter(v => v > due)].slice(0, 5);
    $('#kQuick', root).innerHTML = due > 0 ? quick.map((v, i) => `<button class="btn small" data-v="${v}">${i === 0 ? 'Gepast' : num(v)}</button>`).join('') : '';
    const isOrder = isOrderish();
    $('#kOrderBadge', root).hidden = !isOrder;
    $('#kCustHint', root).textContent = isOrder || partial ? '(verplicht)' : '(optioneel)';
  }
  function isOrderish() {
    return !!$('#kPDate', root).value || $('#kDoor', root).value !== st || $('#kAfh', root).value !== st || $('#kVan', root).value !== st;
  }
  ['#kDisc', '#kPaid', '#kRecv'].forEach(s => $(s, root).addEventListener('input', recalc));
  ['#kDiscType', '#kPDate', '#kPTime', '#kVan', '#kDoor', '#kAfh'].forEach(s => $(s, root).addEventListener('change', () => { recalc(); saveDraft(); }));
  $('#kQuick', root).addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { $('#kRecv', root).value = num(+b.dataset.v); recalc(); } });
  $$('#kMethods button', root).forEach(b => b.onclick = () => { method = b.dataset.m; recalc(); });
  $('#kPartial', root).onchange = e => { partial = e.target.checked; if (partial) setTimeout(() => $('#kPaid', root).focus(), 20); recalc(); };

  // ---------- klant ----------
  const cName = $('#kCName', root), cPhone = $('#kCPhone', root);
  const custSource = q => {
    q = q.toLowerCase();
    return S.customers.filter(c => c.name.toLowerCase().includes(q) || (c.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '§'));
  };
  const custRender = c => html`<b>${c.name}</b> <span class="muted">${c.phone || ''}</span>`;
  const custPick = c => { customerId = c.id; cName.value = c.name; cPhone.value = c.phone || ''; saveDraft(); };
  attachSuggest(cName, { source: custSource, render: custRender, pick: custPick, minChars: 2 });
  attachSuggest(cPhone, { source: custSource, render: custRender, pick: custPick, minChars: 3 });
  [cName, cPhone].forEach(i => i.addEventListener('input', () => { customerId = null; }));

  // ---------- afrekenen ----------
  async function checkout(print) {
    if (busy) return;
    if (!cart.length) return toast('De bon is leeg.', 'error');
    const a = amounts();
    const name = cName.value.trim(), phone = cPhone.value.trim();
    const orderish = isOrderish();
    if ((orderish || a.paid < a.total) && !name) {
      toast('Vul de naam van de klant in (nodig voor ophaalorders en aanbetalingen).', 'error', 5000);
      $('#kOrder', root).open = orderish; cName.focus(); return;
    }
    if (partial && isNaN(parseAmount($('#kPaid', root).value || '0'))) return toast('Vul een geldig bedrag in bij "Nu betaald".', 'error');
    if (method === 'cash' && a.recv != null && (isNaN(a.recv) || a.recv < a.paid)) {
      toast('Het ontvangen bedrag is lager dan het te betalen bedrag.', 'error'); $('#kRecv', root).focus(); return;
    }
    const who = await requireStaff();
    if (who === null) return;
    const pd = $('#kPDate', root).value, pt = $('#kPTime', root).value;
    const pickup = pd ? new Date(`${pd}T${pt || '12:00'}:00`).toISOString() : null;
    const sale = {
      client_id: uuid(), sold_at: new Date().toISOString(), staff: who,
      customer_id: customerId, customer_name: name || null, customer_phone: phone || null,
      lines: cart.map(c => ({ stock_no: c.stock_no, qty: c.qty, price: c.price })),
      discount: a.discount, payment_method: a.paid > 0 ? method : null, paid: a.paid,
      cash_received: method === 'cash' ? (a.recv ?? a.paid) : null,
      pickup_at: pickup, route_van: $('#kVan', root).value, route_door: $('#kDoor', root).value, route_afh: $('#kAfh', root).value,
      comment: $('#kComment', root).value.trim() || null
    };
    busy = true; $('#kPay', root).disabled = true;
    let result = null, provisional = null;
    try {
      result = await call('pos_submit_sale', { p_sale: sale });
    } catch (e) {
      if (isNet(e)) {
        provisional = provisionalNo();
        await enqueue('pos_submit_sale', sale, provisional);
      } else { busy = false; $('#kPay', root).disabled = false; return alertBox('Niet opgeslagen', e.message); }
    }
    busy = false; $('#kPay', root).disabled = false;

    // voorraad lokaal bijwerken zodat waarschuwingen kloppen
    for (const c of cart) { const p = S.catalog.find(x => x.stock_no === c.stock_no); if (p && p.track_stock) p.qty = (p.qty ?? 0) - c.qty; }
    const shownSale = result ? result.sale : {
      ...sale, store_code: st, subtotal: a.subtotal, total: a.total, change_given: a.change,
      lines: cart.map(c => ({ stock_no: c.stock_no, name: c.name, unit_price: c.price, qty: c.qty, line_total: c.price * c.qty }))
    };
    if (print) printHtml(saleReceipt(S.store, shownSale, { provisional }));
    if (result && result.warnings?.length) warnStock(result.warnings);
    const changeAmt = method === 'cash' && a.recv != null ? a.change : 0;
    const lastStore = S.store;
    reset();
    await modal({ title: provisional ? 'Offline opgeslagen' : 'Afgerekend',
      body: html`<div class="done">
        <div class="done-no">${provisional ? 'Voorlopig nr ' + provisional : 'Transactie ' + shownSale.trans_no}</div>
        ${raw(changeAmt > 0 ? html`<div class="done-change">Wisselgeld <b>${srd(changeAmt)}</b></div>` : '')}
        ${raw(a.paid < a.total ? html`<div class="done-open">Nog te betalen bij afhalen: <b>${srd(a.total - a.paid)}</b></div>` : '')}
        ${raw(a.discount > 0 ? '<p class="muted">Deze korting verschijnt bij Ophaalorders tot de beheerder hem heeft goedgekeurd.</p>' : '')}
        ${raw(provisional ? '<p class="muted">Geen internet. De verkoop is op deze computer bewaard en wordt automatisch verstuurd.</p>' : '')}
      </div>`,
      buttons: [{ label: 'Bon (opnieuw) printen', value: 'print' }, { label: 'Volgende klant', kind: 'primary', value: 'ok', default: true }]
    }).then(v => { if (v === 'print') printHtml(saleReceipt(lastStore, shownSale, { provisional, copy: print })); });
    search.focus();
  }

  function reset() {
    cart = []; customerId = null; partial = false; method = methods[0]; catFilter = null;
    ['#kCName', '#kCPhone', '#kPDate', '#kComment', '#kDisc', '#kPaid', '#kRecv', '#kSearch'].forEach(s => $(s, root).value = '');
    $('#kPTime', root).value = ''; $('#kDiscType', root).value = 'pct'; $('#kPartial', root).checked = false;
    ['#kVan', '#kDoor', '#kAfh'].forEach(s => $(s, root).value = st);
    $('#kOrder', root).open = false;
    renderCart();
  }
  $('#kPay', root).onclick = () => checkout(true);
  $('#kPayNoPrint', root).onclick = () => checkout(false);
  $('#kClear', root).onclick = async () => { if (!cart.length || await confirmBox('Bon leegmaken', 'Alle artikelen en gegevens van deze bon wissen?', 'Leegmaken', 'danger')) reset(); };

  root.addEventListener('keydown', e => {
    if (document.querySelector('.modal-back')) return;
    if (e.key === 'F2') { e.preventDefault(); search.focus(); search.select(); }
    else if (e.key === 'F9') { e.preventDefault(); checkout(true); }
    else if (e.key === 'F10') { e.preventDefault(); checkout(false); }
    else if (e.key === 'Escape' && !e.target.closest('.suggest')) { e.preventDefault(); $('#kClear', root).click(); }
  });
  document.addEventListener('keydown', e => {   // F2/F9 ook als focus niet in het kassascherm staat
    if (root.hidden || document.querySelector('.modal-back') || root.contains(e.target)) return;
    if (e.key === 'F2') { e.preventDefault(); search.focus(); }
  });

  // ---------- concept bewaren (bij stroomuitval of per ongeluk sluiten) ----------
  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => local.store.set('draft_' + st, cart.length ? {
      cart, customerId, name: cName.value, phone: cPhone.value, pdate: $('#kPDate', root).value, ptime: $('#kPTime', root).value,
      van: $('#kVan', root).value, door: $('#kDoor', root).value, afh: $('#kAfh', root).value, comment: $('#kComment', root).value
    } : null), 300);
  }
  $('#kComment', root).addEventListener('input', saveDraft);
  (async () => {
    const d = await local.store.get('draft_' + st, null);
    if (d && d.cart?.length) {
      cart = d.cart; customerId = d.customerId; cName.value = d.name || ''; cPhone.value = d.phone || '';
      $('#kPDate', root).value = d.pdate || ''; $('#kPTime', root).value = d.ptime || '';
      $('#kVan', root).value = d.van || st; $('#kDoor', root).value = d.door || st; $('#kAfh', root).value = d.afh || st;
      $('#kComment', root).value = d.comment || '';
      if (d.pdate || d.comment || d.door !== st || d.afh !== st) $('#kOrder', root).open = true;
      toast('De vorige, nog niet afgerekende bon is teruggezet.', 'info', 5000);
    }
    renderCart();
  })();

  renderCats();
  renderCart();
  return {
    show() { setTimeout(() => search.focus(), 30); },
    catalogChanged() { renderCats(); renderCart(); },
    // vanuit Ophaalorders: niets nodig
  };
}
