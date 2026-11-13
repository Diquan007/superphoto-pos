// Tabblad Ophaalorders: open orders, restbetaling (1060), afhalen, korting laten goedkeuren
import { S, call, printHtml, requireStaff } from '../app.js';
import { html, raw, $, $$, srd, num, round2, parseAmount, toast, modal, alertBox, askPin, confirmBox,
         uuid, isNet, rpc, fmtDate, fmtDateTime, STORE_NAMES, METHOD_NAMES } from '../lib.js';
import { saleReceipt, balanceReceipt } from '../receipt.js';

export function create(root) {
  const st = S.store.code;
  let orders = [], filter = 'all', q = '';

  root.innerHTML = html`
    <div class="view-head">
      <h1>Ophaalorders</h1>
      <div class="filters">
        <input id="oSearch" placeholder="Zoek op transactienummer, naam of telefoon">
        <select id="oFilter">
          <option value="all">Alle open orders</option>
          <option value="afh">Afhalen op ${STORE_NAMES[st]}</option>
          <option value="door">Maken door ${STORE_NAMES[st]}</option>
          <option value="open">Met openstaand bedrag</option>
          <option value="today">Ophalen vandaag of eerder</option>
        </select>
        <button class="btn" id="oRefresh">Vernieuwen</button>
      </div>
    </div>
    <div class="table-wrap"><table class="tbl orders"><thead><tr>
      <th>Trans #</th><th>Datum</th><th>Klant</th><th>Artikelen</th><th>Ophalen</th><th>Route</th>
      <th class="r">Totaal</th><th class="r">Openstaand</th><th>Status</th><th></th></tr></thead>
      <tbody id="oBody"><tr><td colspan="10" class="muted empty">Laden…</td></tr></tbody></table></div>`;

  async function load() {
    try { orders = await call('pos_open_orders'); render(); }
    catch (e) {
      $('#oBody', root).innerHTML = html`<tr><td colspan="10" class="empty ${isNet(e) ? 'warn-text' : 'error-text'}">${isNet(e) ? 'Geen internet. Ophaalorders zijn alleen online te zien.' : e.message}</td></tr>`;
    }
  }

  function visible() {
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const s = q.toLowerCase();
    return orders.filter(o => {
      if (filter === 'afh' && o.route_afh !== st) return false;
      if (filter === 'door' && o.route_door !== st) return false;
      if (filter === 'open' && !(o.outstanding > 0)) return false;
      if (filter === 'today' && !(o.pickup_at && new Date(o.pickup_at) <= today)) return false;
      if (s && !(String(o.trans_no).includes(s) || (o.customer_name || '').toLowerCase().includes(s) ||
                 (o.customer_phone || '').replace(/\D/g, '').includes(s.replace(/\D/g, '') || '§'))) return false;
      return true;
    });
  }

  function render() {
    const list = visible();
    const now = new Date();
    $('#oBody', root).innerHTML = list.length ? list.map(o => {
      const late = o.pickup_at && new Date(o.pickup_at) < now && !o.picked_up;
      const tags = [];
      if (o.outstanding > 0) tags.push('<span class="tag red">Openstaand</span>');
      if (o.picked_up) tags.push('<span class="tag green">Afgehaald</span>');
      else if (o.pickup_at || o.route_afh !== o.route_van || o.route_door !== o.route_van) tags.push('<span class="tag">Wacht op afhalen</span>');
      if (o.discount > 0 && !o.discount_checked) tags.push(html`<span class="tag amber">Korting ${num(o.discount)} te controleren</span>`);
      return html`<tr class="${late ? 'late' : ''}">
        <td class="b">${o.trans_no}</td>
        <td>${fmtDate(o.sold_at)}</td>
        <td>${o.customer_name || '—'}<div class="muted small">${o.customer_phone || ''}</div></td>
        <td class="small">${raw(o.lines.map(l => html`${l.qty}× ${l.name}`).join('<br>'))}${raw(o.comment ? html`<div class="muted">${o.comment}</div>` : '')}</td>
        <td>${o.pickup_at ? fmtDateTime(o.pickup_at) : '—'}${raw(late ? '<div class="error-text small">te laat</div>' : '')}</td>
        <td class="small">${STORE_NAMES[o.route_van]} → ${STORE_NAMES[o.route_door]} → <b>${STORE_NAMES[o.route_afh]}</b></td>
        <td class="r">${num(o.total)}</td>
        <td class="r b ${o.outstanding > 0 ? 'error-text' : ''}">${num(o.outstanding)}</td>
        <td>${raw(tags.join(' '))}</td>
        <td class="actions">
          ${raw(o.outstanding > 0 ? `<button class="btn small primary" data-a="pay" data-t="${o.trans_no}">Restbetaling</button>` : '')}
          ${raw(!o.picked_up && !(o.outstanding > 0) ? `<button class="btn small" data-a="pick" data-t="${o.trans_no}">Afgehaald</button>` : '')}
          ${raw(o.discount > 0 && !o.discount_checked ? `<button class="btn small" data-a="disc" data-t="${o.trans_no}">Korting goedkeuren</button>` : '')}
          <button class="btn small ghost" data-a="print" data-t="${o.trans_no}">Bon</button>
        </td></tr>`;
    }).join('') : '<tr><td colspan="10" class="muted empty">Geen open orders.</td></tr>';
  }

  $('#oSearch', root).addEventListener('input', e => { q = e.target.value.trim(); render(); });
  $('#oFilter', root).onchange = e => { filter = e.target.value; render(); };
  $('#oRefresh', root).onclick = load;

  root.addEventListener('click', async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const o = orders.find(x => String(x.trans_no) === b.dataset.t); if (!o) return;
    if (b.dataset.a === 'pay') payBalance(o);
    if (b.dataset.a === 'pick') {
      if (!(await confirmBox('Afgehaald', `Order ${o.trans_no} van ${o.customer_name || 'klant'} is opgehaald?`, 'Ja, afgehaald'))) return;
      try { await call('pos_mark_picked_up', { p_trans_no: o.trans_no }); toast('Order afgehaald.', 'ok'); load(); }
      catch (err) { alertBox('Niet gelukt', err.message); }
    }
    if (b.dataset.a === 'disc') {
      const pin = await askPin('Korting goedkeuren', `Order ${o.trans_no}: korting ${srd(o.discount)} — beheerderspincode`);
      if (!pin) return;
      try { await call('pos_check_discount', { p_admin_pin: pin, p_trans_no: o.trans_no }); toast('Korting goedgekeurd.', 'ok'); load(); }
      catch (err) { toast(err.message, 'error'); }
    }
    if (b.dataset.a === 'print') printHtml(saleReceipt(S.store, o, { copy: true }));
  });

  async function payBalance(o) {
    const methods = S.store.payment_methods || ['cash'];
    const res = await modal({
      title: `Restbetaling order ${o.trans_no}`,
      body: html`<p>${o.customer_name || ''} ${o.customer_phone || ''}<br>Ordertotaal ${srd(o.total)} · openstaand <b>${srd(o.outstanding)}</b></p>
        <div class="grid2">
          <label>Bedrag SRD<input id="bAmt" inputmode="decimal" value="${num(o.outstanding)}"></label>
          <label>Betaalwijze<select id="bMethod">${raw(methods.map(m => html`<option value="${m}">${METHOD_NAMES[m]}</option>`).join(''))}</select></label>
          <label id="bRecvL">Ontvangen contant SRD<input id="bRecv" inputmode="decimal" placeholder="gepast"></label>
          <div class="change-line"><span>Wisselgeld</span><span id="bChange">SRD 0,00</span></div>
        </div>
        <label class="check"><input type="checkbox" id="bPick" checked> Klant neemt de order nu mee (afgehaald)</label>`,
      buttons: [{ label: 'Annuleren', value: null }, { label: 'Betalen + bon', kind: 'primary', default: true,
        value: r => ({ amount: parseAmount($('#bAmt', r).value), method: $('#bMethod', r).value,
                       recv: $('#bRecv', r).value.trim() ? parseAmount($('#bRecv', r).value) : null, pick: $('#bPick', r).checked }) }],
      onOpen: r => {
        const upd = () => {
          const a = parseAmount($('#bAmt', r).value), rc = parseAmount($('#bRecv', r).value);
          $('#bRecvL', r).hidden = $('#bMethod', r).value !== 'cash';
          $('#bChange', r).textContent = srd(rc > a ? rc - a : 0);
        };
        r.addEventListener('input', upd); r.addEventListener('change', upd); upd();
      },
      validate: r => {
        const a = parseAmount($('#bAmt', r).value);
        if (!(a > 0) || a > o.outstanding + 0.001) { toast('Het bedrag moet tussen 0 en ' + num(o.outstanding) + ' liggen.', 'error'); return false; }
        const rc = $('#bRecv', r).value.trim() ? parseAmount($('#bRecv', r).value) : null;
        if ($('#bMethod', r).value === 'cash' && rc != null && !(rc >= a)) { toast('Ontvangen bedrag is te laag.', 'error'); return false; }
      }
    });
    if (!res) return;
    const who = await requireStaff(); if (who === null) return;
    try {
      const r = await call('pos_pay_balance', { p_pay: {
        client_id: uuid(), ref_trans_no: o.trans_no, amount: round2(res.amount), payment_method: res.method,
        cash_received: res.method === 'cash' ? round2(res.recv ?? res.amount) : null, staff: who, mark_picked_up: res.pick } });
      printHtml(balanceReceipt(S.store, r.sale, r.order));
      toast(`Restbetaling opgeslagen als transactie ${r.sale.trans_no}.`, 'ok', 5000);
      if (res.pick && r.order.outstanding > 0) toast('Order nog niet volledig betaald, dus niet als afgehaald gemarkeerd.', 'error', 6000);
      load();
    } catch (err) {
      alertBox('Niet gelukt', isNet(err) ? 'Geen internet. Restbetalingen kunnen alleen online worden verwerkt.' : err.message);
    }
  }

  return { show: load };
}
