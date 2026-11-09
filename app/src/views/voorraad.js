// Tabblad Voorraad: overzicht voor personeel + meldingen (ontvangst, uit magazijn, nieuw artikel)
// Meldingen veranderen de voorraad pas als de beheerder ze goedkeurt.
import { S, call, requireStaff, refreshCatalog } from '../app.js';
import { html, raw, $, $$, num, parseAmount, toast, alertBox, attachSuggest, searchProducts, isNet,
         fmtDateTime, STORE_NAMES, LOCATION_NAMES } from '../lib.js';

const KIND = { receive: 'Ontvangen', transfer: 'Uit magazijn naar winkel', new_item: 'Nieuw artikel (zonder stocknummer)' };
const STATUS = { pending: '<span class="tag amber">Wacht op beheerder</span>', approved: '<span class="tag green">Goedgekeurd</span>', rejected: '<span class="tag red">Afgewezen</span>' };

export function create(root) {
  const st = S.store.code;
  let q = '', onlyLow = false, rows = [];

  root.innerHTML = html`
    <div class="split">
      <div class="split-main">
        <div class="view-head"><h1>Voorraad ${STORE_NAMES[st]}</h1>
          <div class="filters"><input id="vSearch" placeholder="Zoek stocknummer of naam">
            <label class="check"><input type="checkbox" id="vLow"> Alleen 0 of minder</label>
            <button class="btn" id="vRefresh">Vernieuwen</button></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Stock #</th><th>Artikel</th><th>Categorie</th>
          <th class="r">Prijs</th><th class="r">Winkel</th><th class="r">Magazijn</th></tr></thead><tbody id="vBody"></tbody></table></div>
      </div>
      <aside class="split-side">
        <div class="card">
          <h2>Melding aan beheerder</h2>
          <p class="muted small">Goederen ontvangen, iets uit het magazijn gehaald of een nieuw artikel binnen? Vul het hier in. De voorraad verandert pas als de beheerder het goedkeurt.</p>
          <div id="mRows"></div>
          <div class="btn-row"><button class="btn small" data-add="receive">+ Ontvangen</button>
            <button class="btn small" data-add="transfer">+ Uit magazijn</button>
            <button class="btn small" data-add="new_item">+ Nieuw artikel</button></div>
          <button class="btn primary big" id="mSend">Melding versturen</button>
        </div>
        <div class="card"><h2>Mijn meldingen (30 dagen)</h2><div id="mList" class="small"></div></div>
      </aside>
    </div>`;

  function renderStock() {
    const list = (q ? searchProducts(S.catalog, q) : S.catalog).filter(p => p.track_stock && (!onlyLow || (p.qty ?? 0) <= (p.min_stock || 0)));
    $('#vBody', root).innerHTML = list.length ? list.map(p => html`<tr class="${(p.qty ?? 0) <= (p.min_stock || 0) ? 'low' : ''}">
      <td class="sn">${p.stock_no}</td><td>${p.name}${raw(p.sellable ? '' : ' <span class="tag">verbruik</span>')}</td><td class="muted">${p.category}</td>
      <td class="r">${p.sellable ? num(p.price) : ''}</td><td class="r b">${p.qty ?? '—'}</td><td class="r">${p.qty_mag ?? '—'}</td></tr>`).join('')
      : '<tr><td colspan="6" class="muted empty">Niets gevonden.</td></tr>';
  }
  $('#vSearch', root).addEventListener('input', e => { q = e.target.value.trim(); renderStock(); });
  $('#vLow', root).onchange = e => { onlyLow = e.target.checked; renderStock(); };
  $('#vRefresh', root).onclick = async () => { await refreshCatalog(); renderStock(); loadMine(); };

  // ---------- meldingsregels ----------
  function locOptions(kind, value) {
    const opts = kind === 'transfer' ? ['MAH', 'IND'] : [st, 'MAG'].concat(st === 'MAH' ? ['IND'] : ['MAH']);
    return opts.map(c => `<option value="${c}" ${c === value ? 'selected' : ''}>${kind === 'transfer' ? 'naar ' : ''}${LOCATION_NAMES[c]}</option>`).join('');
  }
  function addRow(kind) {
    rows.push({ kind, stock_no: '', label: '', qty: '', location: kind === 'receive' ? st : kind === 'transfer' ? st : 'MAG', new_name: '', new_price: '', note: '' });
    renderRows();
    const inputs = $$('#mRows .mrow:last-child input', root); if (inputs[0]) inputs[0].focus();
  }
  function renderRows() {
    const box = $('#mRows', root);
    if (!rows.length) { box.innerHTML = '<p class="muted small">Kies hieronder wat u wilt melden.</p>'; return; }
    box.innerHTML = rows.map((r, i) => html`<div class="mrow" data-i="${i}">
      <div class="mrow-head"><b>${KIND[r.kind]}</b><button class="icon-btn" data-del="${i}">✕</button></div>
      ${raw(r.kind === 'new_item'
        ? html`<div class="grid2 tight"><input data-f="new_name" placeholder="Naam / omschrijving" value="${r.new_name}">
                 <input data-f="new_price" placeholder="Verkoopprijs SRD" inputmode="decimal" value="${r.new_price}"></div>`
        : html`<div class="sg-host"><input data-f="product" placeholder="Stocknummer of naam" value="${r.label}"></div>`)}
      <div class="grid2 tight"><input data-f="qty" placeholder="Aantal" inputmode="numeric" value="${r.qty}">
        <select data-f="location">${raw(locOptions(r.kind, r.location))}</select></div>
      <input data-f="note" placeholder="${r.kind === 'new_item' ? 'Leverancier, inkoopprijs, maat, kleur…' : 'Opmerking (optioneel)'}" value="${r.note}">
    </div>`).join('');
    $$('.mrow', box).forEach(el => {
      const i = +el.dataset.i, r = rows[i];
      $$('[data-f]', el).forEach(inp => {
        if (inp.dataset.f === 'product') {
          attachSuggest(inp, {
            source: s => searchProducts(S.catalog.filter(p => p.track_stock), s),
            render: p => html`<b>${p.stock_no}</b> ${p.name}`,
            pick: p => { r.stock_no = p.stock_no; r.label = `${p.stock_no} ${p.name}`; inp.value = r.label; }
          });
          inp.addEventListener('input', () => { r.stock_no = ''; r.label = inp.value; });
        } else {
          inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => { r[inp.dataset.f] = inp.value; });
        }
      });
    });
    $$('[data-del]', box).forEach(b => b.onclick = () => { rows.splice(+b.dataset.del, 1); renderRows(); });
  }
  $$('[data-add]', root).forEach(b => b.onclick = () => addRow(b.dataset.add));

  $('#mSend', root).onclick = async () => {
    if (!rows.length) return toast('Voeg eerst een regel toe.', 'error');
    const items = [];
    for (const r of rows) {
      const qty = parseInt(r.qty, 10);
      if (r.kind === 'new_item') {
        const price = parseAmount(r.new_price);
        if (!r.new_name.trim()) return toast('Vul de naam van het nieuwe artikel in.', 'error');
        if (!(price >= 0)) return toast('Vul de verkoopprijs van ' + r.new_name + ' in.', 'error');
        items.push({ kind: r.kind, new_name: r.new_name.trim(), new_price: price, qty: qty > 0 ? qty : 0, location: r.location, note: r.note });
      } else {
        if (!r.stock_no) {
          const exact = S.catalog.find(p => p.stock_no === r.label.trim());
          if (exact) r.stock_no = exact.stock_no; else return toast('Kies een artikel uit de lijst: ' + (r.label || '(leeg)'), 'error');
        }
        if (!(qty > 0)) return toast('Vul een aantal in.', 'error');
        items.push({ kind: r.kind, stock_no: r.stock_no, qty, location: r.location, note: r.note });
      }
    }
    const who = await requireStaff(); if (who === null) return;
    try {
      await call('pos_submit_proposals', { p_items: items, p_staff: who });
      toast('Melding verstuurd naar de beheerder.', 'ok');
      rows = []; renderRows(); loadMine();
    } catch (e) { alertBox('Niet verstuurd', isNet(e) ? 'Geen internet. Probeer het later opnieuw; uw regels blijven staan.' : e.message); }
  };

  async function loadMine() {
    try {
      const list = await call('pos_my_proposals');
      $('#mList', root).innerHTML = list.length ? `<table class="tbl compact">${list.map(p => html`<tr>
        <td>${fmtDateTime(p.created_at)}<div class="muted">${p.staff || ''}</div></td>
        <td>${KIND[p.kind]}: <b>${p.stock_no ? p.stock_no + ' ' + (p.product_name || '') : p.new_name}</b> × ${p.qty}<div class="muted">${LOCATION_NAMES[p.location] || ''}${p.result_note ? ' · ' + p.result_note : ''}</div></td>
        <td>${raw(STATUS[p.status])}</td></tr>`).join('')}</table>` : '<p class="muted">Nog geen meldingen.</p>';
    } catch (e) { $('#mList', root).innerHTML = html`<p class="muted">${isNet(e) ? 'Offline.' : e.message}</p>`; }
  }

  renderRows();
  return { show() { renderStock(); loadMine(); }, catalogChanged: renderStock };
}
