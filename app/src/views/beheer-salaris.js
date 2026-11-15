// Beheer > Salaris: loonafrekening per betaaldag (15e / 26e), zaterdagen-overzicht, vakantiegeld
import { adminCall } from '../app.js';
import { html, raw, $, $$, toast, modal, alertBox, confirmBox, num, fmtDate, isoDay, STORE_NAMES } from '../lib.js';
import { PAY_METHOD, MONTHS, money, moneyIn, nextPayDate, savePayslipPdf } from '../salaris.js';
import { dnum } from '../verlof.js';

let mode = 'loon', payDate = null, satRange = null, hpYear = new Date().getFullYear();

export async function salarisSection(main) {
  const rerender = () => salarisSection(main);
  main.innerHTML = html`<div class="view-head"><h1>Salaris</h1></div>
    <div class="seg big" id="sMode"><button data-m="loon">Loonafrekening</button><button data-m="zat">Zaterdagen</button><button data-m="vg">Vakantiegeld</button></div>
    <div id="sBody"><p class="muted">Laden…</p></div>`;
  $$('#sMode button', main).forEach(b => { b.classList.toggle('active', b.dataset.m === mode); b.onclick = () => { mode = b.dataset.m; rerender(); }; });
  const body = $('#sBody', main);
  if (mode === 'loon') return loon(body, rerender);
  if (mode === 'zat') return zaterdagen(body, rerender);
  return vakantiegeld(body, rerender);
}

// ================= loonafrekening =================
async function loon(body, rerender, refresh = false) {
  payDate = payDate || nextPayDate();
  const r = await adminCall('pos_admin_payroll', { p_pay_date: payDate, p_refresh: refresh });
  const list = r.payslips;
  const y = +payDate.slice(0, 4), m = +payDate.slice(5, 7), day = +payDate.slice(8, 10);
  const sum = f => list.filter(f).reduce((a, p) => a + Number(p.net), 0);
  const conc = list.filter(p => p.status === 'concept').length;
  body.innerHTML = html`
    <div class="year-nav pay-nav"><button class="btn small" data-pm="-1">‹</button><b>${MONTHS[m - 1]} ${y}</b><button class="btn small" data-pm="1">›</button>
      <div class="seg small-seg"><button data-pd="15" class="${day === 15 ? 'active' : ''}">15e</button><button data-pd="26" class="${day === 26 ? 'active' : ''}">26e</button></div>
      <span class="muted">Betaaldag ${fmtDate(payDate)}</span></div>
    ${raw(list.length ? html`
      <div class="cards small">
        <div class="stat"><div class="stat-n">SRD ${num(sum(() => true))}</div><div>totaal netto (${list.length} personen)</div></div>
        <div class="stat"><div class="stat-n">SRD ${num(sum(p => p.payment_method === 'contant'))}</div><div>contant</div></div>
        <div class="stat"><div class="stat-n">SRD ${num(sum(p => p.payment_method === 'bank'))}</div><div>per bank</div></div>
        <div class="stat ${conc ? 'warn' : 'good'}"><div class="stat-n">${conc}</div><div>${conc ? 'nog niet vastgezet' : 'alles vastgezet'}</div></div>
      </div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Naam</th><th>Winkel</th><th>Periode</th><th>Regels</th><th>Betaalwijze</th><th class="r">Netto</th><th>Status</th><th></th></tr></thead><tbody>
        ${raw(list.map(p => html`<tr><td class="b">${p.name}</td><td>${STORE_NAMES[p.store_code]}</td><td class="small">${fmtDate(p.period_from)} t/m ${fmtDate(p.period_to)}</td>
          <td class="small">${raw(p.lines.map(l => html`${l.label}: ${num(l.amount)}`).join('<br>'))}</td>
          <td>${PAY_METHOD[p.payment_method]}${raw(p.payment_method === 'bank' && p.bank_account ? html`<div class="muted small">${p.bank_name || ''} ${p.bank_account}</div>` : '')}</td>
          <td class="r b">${num(p.net)}</td>
          <td>${raw(p.status === 'vast' ? '<span class="tag green">vastgezet</span>' : '<span class="tag amber">concept</span>')}</td>
          <td class="actions"><button class="btn small" data-open="${p.id}">${p.status === 'vast' ? 'Bekijken' : 'Wijzigen'}</button><button class="btn small ghost" data-pdf="${p.id}">PDF</button></td></tr>`).join(''))}
      </tbody></table></div>
      <div class="btn-row">${raw(conc ? '<button class="btn primary" id="sFinAll">Alle concepten vastzetten</button><button class="btn" id="sRefresh">Concepten opnieuw berekenen</button>' : '')}
        <button class="btn ghost" id="sCsv">Exporteren (CSV)</button></div>
      <p class="muted small">Een concept wordt berekend uit het dossier: vast salaris (bij twee keer per maand de helft), of dagloon × gewerkte dagen uit Bezetting.
        Op de 26e komen de vervoerstoelage, voorschotten en aflossingen erbij; op 26 augustus ook het vakantiegeld. U kunt elk bedrag aanpassen en regels toevoegen.
        Vastzetten boekt de voorschotten en aflossingen af. "Opnieuw berekenen" vervangt alleen concepten (uw wijzigingen daarin gaan dan verloren).</p>`
      : html`<p class="muted">Niemand om te betalen op ${fmtDate(payDate)}. Vul bij Personeel &amp; verlof in het dossier (klik op een naam) het salaris of dagloon in.${day === 15 ? ' Op de 15e worden alleen mensen betaald die twee keer per maand loon krijgen.' : ''}</p>`)}`;

  $$('[data-pm]', body).forEach(b => b.onclick = () => {
    let mm = m + +b.dataset.pm, yy = y; if (mm < 1) { mm = 12; yy--; } if (mm > 12) { mm = 1; yy++; }
    payDate = `${yy}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`; rerender();
  });
  $$('[data-pd]', body).forEach(b => b.onclick = () => { payDate = payDate.slice(0, 8) + b.dataset.pd; rerender(); });
  body.onclick = async e => {
    const o = e.target.closest('[data-open]'), pdf = e.target.closest('[data-pdf]');
    if (o && await editPayslip(list.find(p => p.id === +o.dataset.open))) rerender();
    if (pdf) savePayslipPdf(list.find(p => p.id === +pdf.dataset.pdf));
  };
  if ($('#sFinAll', body)) $('#sFinAll', body).onclick = async () => {
    if (!(await confirmBox('Alles vastzetten', `${conc} loonstrook(en) van ${fmtDate(payDate)} vastzetten? Voorschotten en aflossingen worden dan afgeboekt.`, 'Vastzetten'))) return;
    try { for (const p of list.filter(x => x.status === 'concept')) await adminCall('pos_admin_payslip_finalize', { p_id: p.id }); toast('Vastgezet.', 'ok'); }
    catch (err) { alertBox('Niet gelukt', err.message); }
    rerender();
  };
  if ($('#sRefresh', body)) $('#sRefresh', body).onclick = async () => {
    if (!(await confirmBox('Opnieuw berekenen', 'Alle concepten van deze betaaldag opnieuw berekenen uit de dossiers en Bezetting? Wat u in de concepten heeft aangepast, gaat verloren. Vastgezette loonstroken blijven zoals ze zijn.', 'Opnieuw berekenen'))) return;
    await loon(body, rerender, true);
  };
  $('#sCsv', body) && ($('#sCsv', body).onclick = () => csv(`loon_${payDate}.csv`,
    [['Naam', 'Winkel', 'Betaaldatum', 'Periode van', 'Periode tot', 'Betaalwijze', 'Bank', 'Rekening', 'Netto SRD', 'Status'],
     ...list.map(p => [p.name, STORE_NAMES[p.store_code], fmtDate(p.pay_date), fmtDate(p.period_from), fmtDate(p.period_to), PAY_METHOD[p.payment_method], p.bank_name || '', p.bank_account || '', dec(p.net), p.status])]));
}

async function editPayslip(p) {
  const locked = p.status === 'vast';
  let lines = p.lines.map(l => ({ ...l }));
  const total = () => lines.reduce((a, l) => a + (money(l.amount) || 0), 0);
  const rowsHtml = () => lines.map((l, i) => html`<tr>
      <td>${raw(locked ? html`${l.label}` : html`<input data-i="${i}" data-k="label" value="${l.label}" maxlength="120">`)}</td>
      <td class="r">${raw(locked ? num(l.amount) : html`<input class="amt" data-i="${i}" data-k="amount" inputmode="decimal" value="${moneyIn(l.amount)}">`)}</td>
      <td>${raw(locked ? '' : html`<button class="icon-btn" data-x="${i}" title="Regel weghalen">✕</button>`)}</td></tr>`).join('');
  const res = await modal({ title: `Loonstrook ${p.name} · ${fmtDate(p.pay_date)}`, wide: true,
    body: html`<p class="muted">Periode ${fmtDate(p.period_from)} t/m ${fmtDate(p.period_to)} · ${STORE_NAMES[p.store_code]}
        ${raw(locked ? ' · <span class="tag green">vastgezet</span>' : ' · <span class="tag amber">concept</span>')}</p>
      <table class="tbl compact slip-tbl"><thead><tr><th>Omschrijving</th><th class="r">Bedrag SRD</th><th></th></tr></thead><tbody id="pRows">${raw(rowsHtml())}</tbody>
        <tfoot><tr class="sum"><td>Netto uit te betalen</td><td class="r" id="pNet">${num(total())}</td><td></td></tr></tfoot></table>
      ${raw(locked ? '' : html`<div class="btn-row"><button class="btn small" id="pAdd">+ Regel</button><button class="btn small" id="pAddMin">+ Inhouding</button></div>
        <p class="muted small">Inhoudingen (voorschot, aflossing) zijn negatief. Een regel weghalen betekent dat het voorschot of de aflossing open blijft voor een volgende keer.</p>`)}
      <label>Betaalwijze <select id="pMethod" ${locked ? 'disabled' : ''}>${raw(Object.entries(PAY_METHOD).map(([k, v]) => `<option value="${k}" ${k === p.payment_method ? 'selected' : ''}>${v}</option>`).join(''))}</select></label>`,
    onOpen: r => {
      if (locked) return;
      const redraw = () => { $('#pRows', r).innerHTML = rowsHtml(); $('#pNet', r).textContent = num(total()); };
      $('#pRows', r).addEventListener('input', e => { const t = e.target; if (t.dataset.i === undefined) return; lines[+t.dataset.i][t.dataset.k] = t.dataset.k === 'amount' ? t.value : t.value; $('#pNet', r).textContent = num(total()); });
      $('#pRows', r).addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) { lines.splice(+x.dataset.x, 1); redraw(); } });
      $('#pAdd', r).onclick = () => { lines.push({ code: 'extra', label: '', amount: '' }); redraw(); $$('#pRows input[data-k="label"]', r).pop()?.focus(); };
      $('#pAddMin', r).onclick = () => { lines.push({ code: 'inhouding', label: '', amount: '-' }); redraw(); $$('#pRows input[data-k="label"]', r).pop()?.focus(); };
    },
    buttons: locked
      ? [{ label: 'Heropenen', value: 'reopen' }, { label: 'PDF', value: 'pdf' }, { label: 'Sluiten', kind: 'primary', value: null, default: true }]
      : [{ label: 'Verwijderen', kind: 'danger', value: 'delete' }, { label: 'PDF (concept)', value: 'pdf' }, { label: 'Opslaan', value: 'save' }, { label: 'Opslaan en vastzetten', kind: 'primary', value: 'final', default: true }],
    validate: (r, v) => {
      if (locked || v === 'delete' || v === 'reopen') return;
      if (lines.some(l => !(Number.isFinite(money(l.amount))))) { toast('Vul bij elke regel een bedrag in.', 'error'); return false; }
      p._method = $('#pMethod', r).value;
    } });
  if (!res) return false;
  try {
    if (res === 'reopen') {
      if (!(await confirmBox('Heropenen', 'Deze loonstrook weer als concept openen? Voorschotten en aflossingen worden teruggezet tot u opnieuw vastzet.', 'Heropenen'))) return false;
      await adminCall('pos_admin_payslip_reopen', { p_id: p.id }); toast('Weer een concept.', 'ok'); return true;
    }
    if (res === 'delete') {
      if (!(await confirmBox('Verwijderen', `Deze concept-loonstrook van ${p.name} verwijderen? Bij "Concepten opnieuw berekenen" wordt hij opnieuw gemaakt.`, 'Verwijderen', 'danger'))) return false;
      await adminCall('pos_admin_payslip_delete', { p_id: p.id }); return true;
    }
    let cur = p;
    if (!locked) cur = await adminCall('pos_admin_payslip_save', { p_id: p.id, p_lines: lines.map(l => ({ ...l, amount: money(l.amount) })), p_payment_method: p._method });
    if (res === 'final') { cur = await adminCall('pos_admin_payslip_finalize', { p_id: p.id }); toast('Vastgezet.', 'ok'); }
    else if (res === 'save') toast('Opgeslagen.', 'ok');
    if (res === 'pdf') savePayslipPdf(cur);
    return !locked;
  } catch (err) { alertBox('Niet gelukt', err.message); return true; }
}

// ================= zaterdagen =================
async function zaterdagen(body, rerender) {
  if (!satRange) { const d = new Date(); satRange = [isoDay(new Date(d.getFullYear(), d.getMonth(), 1)), isoDay(new Date(d.getFullYear(), d.getMonth() + 1, 0))]; }
  const list = await adminCall('pos_admin_saturdays', { p_from: satRange[0], p_to: satRange[1] });
  const tot = list.reduce((a, x) => a + Number(x.total), 0);
  body.innerHTML = html`<div class="filters range"><input type="date" id="zFrom" value="${satRange[0]}"> t/m <input type="date" id="zTo" value="${satRange[1]}">
      <button class="btn small primary" id="zGo">Toon</button><button class="btn small ghost" id="zCsv">Exporteren (CSV)</button></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Naam</th><th>Winkel</th><th class="r">Zaterdagen</th><th>Welke</th><th class="r">Per zaterdag</th><th class="r">Te betalen</th></tr></thead><tbody>
      ${raw(list.map(x => html`<tr class="${Number(x.days) ? '' : 'inactive'}"><td class="b">${x.name}</td><td>${STORE_NAMES[x.store_code]}</td><td class="r">${dnum(x.days)}</td>
        <td class="small">${x.dates.map(d => fmtDate(d.day) + (Number(d.fraction) === 0.5 ? ' (½)' : '') + (d.store_code !== x.store_code ? ' ' + STORE_NAMES[d.store_code] : '')).join(', ')}</td>
        <td class="r">${raw(x.saturday_amount == null ? '<span class="warn-text">niet ingevuld</span>' : num(x.saturday_amount))}</td><td class="r b">${num(x.total)}</td></tr>`).join(''))}
      <tr class="sum"><td colspan="5">Totaal</td><td class="r">${num(tot)}</td></tr></tbody></table></div>
    <p class="muted small">Alleen een overzicht: dit wordt niet op de loonstrook verrekend. Uit Bezetting; een halve zaterdag telt half. Het bedrag per zaterdag stelt u in het dossier in.</p>`;
  $('#zGo', body).onclick = () => { satRange = [$('#zFrom', body).value, $('#zTo', body).value]; rerender(); };
  $('#zCsv', body).onclick = () => csv(`zaterdagen_${satRange[0]}_${satRange[1]}.csv`,
    [['Naam', 'Winkel', 'Zaterdagen', 'Data', 'Per zaterdag SRD', 'Te betalen SRD'],
     ...list.map(x => [x.name, STORE_NAMES[x.store_code], dec(x.days), x.dates.map(d => fmtDate(d.day)).join(' '), dec(x.saturday_amount ?? ''), dec(x.total)])]);
}

// ================= vakantiegeld =================
async function vakantiegeld(body, rerender) {
  const list = await adminCall('pos_admin_holiday_pay', { p_year: hpYear });
  const tot = list.reduce((a, x) => a + Number(x.amount), 0);
  body.innerHTML = html`<div class="year-nav"><button class="btn small" data-y="-1">‹ ${hpYear - 1}</button><b>${hpYear}</b><button class="btn small" data-y="1">${hpYear + 1} ›</button></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Naam</th><th>Winkel</th><th class="r">Dagloon</th><th class="r">Vakantiedagen ${hpYear}</th><th class="r">Vakantiegeld</th></tr></thead><tbody>
      ${raw(list.map(x => html`<tr><td class="b">${x.name}</td><td>${STORE_NAMES[x.store_code]}</td>
        <td class="r">${raw(x.day_wage == null ? '<span class="warn-text">niet ingevuld</span>' : num(x.day_wage))}</td><td class="r">${dnum(x.days)}</td><td class="r b">${num(x.amount)}</td></tr>`).join(''))}
      <tr class="sum"><td colspan="4">Totaal</td><td class="r">${num(tot)}</td></tr></tbody></table></div>
    <p class="muted small">Vakantiegeld = dagloon × vakantiedagen ÷ 2. Het komt vanzelf op de loonstrook van 26 augustus ${hpYear}.</p>`;
  $$('[data-y]', body).forEach(b => b.onclick = () => { hpYear += +b.dataset.y; rerender(); });
}

// ================= hulp =================
const dec = v => String(v ?? '').replace('.', ',');
function csv(name, rows) {
  const text = '﻿' + rows.map(l => l.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; a.click();
}
