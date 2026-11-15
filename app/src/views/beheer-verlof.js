// Beheer > Personeel & verlof: saldo per medewerker, verlof invoeren, maandoverzicht
import { adminCall, refreshCatalog } from '../app.js';
import { html, raw, $, $$, toast, modal, alertBox, confirmBox, askPin, fmtDate, STORE_NAMES } from '../lib.js';
import { KIND_NL, KIND_TAG, KIND_LETTER, dnum, days, workdays, balanceCards, yearEndText, leaveTable, dayDate, dayStr,
         FULL_WEEK, WD_SHORT, isPartTime, wdText } from '../verlof.js';

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const WD = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const parseDays = s => Number(String(s ?? '').trim().replace(',', '.'));

let mode = 'saldo', year = new Date().getFullYear(), month = new Date().getMonth() + 1, filterEmp = '', showHidden = false;

export async function verlofSection(main) {
  const rerender = () => verlofSection(main);
  main.innerHTML = html`<div class="view-head"><h1>Personeel &amp; verlof</h1>
      <div class="filters"><button class="btn" id="vEmpNew">+ Medewerker</button><button class="btn primary" id="vNew">+ Verlof invoeren</button></div></div>
    <div class="seg big" id="vMode"><button data-m="saldo">Saldo per medewerker</button><button data-m="maand">Maandoverzicht</button></div>
    <div id="vBody"><p class="muted">Laden…</p></div>`;
  $$('#vMode button', main).forEach(b => { b.classList.toggle('active', b.dataset.m === mode); b.onclick = () => { mode = b.dataset.m; rerender(); }; });
  const body = $('#vBody', main);
  let ov = await adminCall('pos_admin_leave_overview', { p_year: year });
  $('#vNew', main).onclick = async () => { if (await editLeave(null, ov.employees)) rerender(); };
  $('#vEmpNew', main).onclick = async () => { if (await editEmployee(null)) rerender(); };
  if (mode === 'saldo') return saldo(body, ov, rerender);
  return maand(body, ov, rerender);
}

// ================= saldo =================
function saldo(body, ov, rerender) {
  const names = Object.fromEntries(ov.employees.map(e => [e.id, e.name]));
  const hiddenCount = ov.employees.filter(e => !e.active).length;
  const shown = ov.employees.filter(e => e.active || showHidden);
  const list = filterEmp ? ov.leave.filter(l => String(l.employee_id) === filterEmp) : ov.leave;
  const row = e => {
    const b = e.balance;
    return html`<tr class="${e.active ? '' : 'inactive'}">
      <td><button class="name-btn" data-emp="${e.id}" title="Naam, winkel, werkdagen, zichtbaar of verwijderen">${e.name} <span class="pen">✎</span></button>${raw(!e.active ? ' <span class="tag">onzichtbaar</span>' : '')}${raw(isPartTime(e.workdays) ? html`<br><span class="tag blue" title="Vaste werkdagen">parttime: ${wdText(e.workdays)}</span>` : '')}</td><td>${STORE_NAMES[e.store_code]}</td>
      <td class="r">${b.set ? dnum(b.entitlement) : html`<span class="warn-text">—</span>`}</td>
      <td class="r">${dnum(b.carry_in)}</td>
      <td class="r">${dnum(b.vakantie)}${raw(Number(b.vakantie_gepland) ? html`<br><span class="muted small">${dnum(b.vakantie_gepland)} gepland</span>` : '')}</td>
      <td class="r">${dnum(b.ziek)}${raw(Number(b.ziek_van_verlof) ? html`<br><span class="error-text small">${dnum(b.ziek_van_verlof)} van vakantie af</span>` : '')}</td>
      <td class="r">${dnum(b.bijzonder)}</td>
      <td class="r b ${Number(b.remaining) < 0 ? 'error-text' : ''}">${dnum(b.remaining)}</td>
      <td class="r">${dnum(b.carry_out)}</td><td class="r">${dnum(b.payout)}</td>
      <td class="r">${e.worked}</td>
      <td class="c">${raw(e.has_pin ? '✓' : '<span class="warn-text">geen</span>')}</td>
      <td class="actions"><button class="btn small" data-add="${e.id}">+ Verlof</button><button class="btn small ghost" data-set="${e.id}">Dagen &amp; pin</button></td></tr>`;
  };
  body.innerHTML = html`
    <div class="year-nav"><button class="btn small" data-y="-1">‹ ${year - 1}</button><b>${year}</b><button class="btn small" data-y="1">${year + 1} ›</button>
      <button class="btn small ghost" id="vCsv">Exporteren (CSV)</button></div>
    <div class="table-wrap"><table class="tbl leave-sum"><thead><tr><th>Naam</th><th>Winkel</th><th class="r">Vakantie-<br>dagen</th><th class="r">Mee-<br>genomen</th>
      <th class="r">Vakantie<br>opgenomen</th><th class="r">Ziek</th><th class="r">Bijzonder</th><th class="r">Over</th>
      <th class="r">Naar ${year + 1}</th><th class="r">Uit te<br>betalen</th><th class="r">Gewerkt</th><th class="c">Pincode</th><th></th></tr></thead>
      <tbody>${raw(shown.length ? shown.map(row).join('') : '<tr><td colspan="13" class="muted empty">Nog geen medewerkers. Klik op + Medewerker.</td></tr>')}</tbody></table></div>
    ${raw(hiddenCount ? html`<label class="check small"><input type="checkbox" id="vHidden" ${showHidden ? 'checked' : ''}> Toon onzichtbare medewerkers (${hiddenCount})</label>` : '')}
    <p class="muted small">Over = vakantiedagen + meegenomen − vakantie − ziektedagen boven de ${dnum(ov.employees[0]?.balance.ziek_max_doorbetaald ?? 5)} doorbetaalde.
      "Naar ${year + 1}" en "Uit te betalen" gaan uit van de stand nu; aan het eind van het jaar is dat de afrekening (maximaal ${dnum(ov.employees[0]?.balance.max_carry ?? 3)} dagen mee).
      Een jaar zonder eigen instelling neemt het aantal vakantiedagen van het vorige jaar over.</p>
    <div class="view-head"><h2>Verlof ${year}</h2><div class="filters"><select id="vEmp"><option value="">Iedereen</option>
      ${raw(ov.employees.map(e => html`<option value="${e.id}" ${String(e.id) === filterEmp ? 'selected' : ''}>${e.name}</option>`).join(''))}</select></div></div>
    ${raw(leaveTable(list, { actions: true, names }))}`;

  $$('[data-y]', body).forEach(b => b.onclick = () => { year += +b.dataset.y; rerender(); });
  $('#vEmp', body).onchange = e => { filterEmp = e.target.value; rerender(); };
  $('#vCsv', body).onclick = () => exportCsv(ov);
  if ($('#vHidden', body)) $('#vHidden', body).onchange = e => { showHidden = e.target.checked; rerender(); };
  body.onclick = async e => {
    const add = e.target.closest('[data-add]'), set = e.target.closest('[data-set]'), emp = e.target.closest('[data-emp]');
    if (emp && await editEmployee(ov.employees.find(x => x.id === +emp.dataset.emp), ov)) rerender();
    const ed = e.target.closest('[data-ledit]'), del = e.target.closest('[data-ldel]');
    if (add && await editLeave({ employee_id: +add.dataset.add }, ov.employees)) rerender();
    if (set && await settings(ov.employees.find(x => x.id === +set.dataset.set))) rerender();
    if (ed && await editLeave(ov.leave.find(l => l.id === +ed.dataset.ledit), ov.employees)) rerender();
    if (del) {
      const l = ov.leave.find(x => x.id === +del.dataset.ldel);
      if (!(await confirmBox('Verlof verwijderen', `${KIND_NL[l.kind]} van ${names[l.employee_id]} (${fmtDate(l.date_from)}${l.date_to !== l.date_from ? ' t/m ' + fmtDate(l.date_to) : ''}, ${days(l.days)}) verwijderen?`, 'Verwijderen', 'danger'))) return;
      await adminCall('pos_admin_leave_delete', { p_id: l.id }); toast('Verwijderd.', 'ok'); rerender();
    }
  };
}

function exportCsv(ov) {
  const lines = [['Naam', 'Winkel', 'Jaar', 'Vakantiedagen', 'Meegenomen', 'Vakantie opgenomen', 'Waarvan gepland', 'Ziek', 'Ziek doorbetaald', 'Ziek van vakantie af', 'Bijzonder', 'Over', 'Naar volgend jaar', 'Uit te betalen', 'Dagen gewerkt']];
  for (const e of ov.employees) {
    const b = e.balance;
    lines.push([e.name, STORE_NAMES[e.store_code], ov.year, b.entitlement, b.carry_in, b.vakantie, b.vakantie_gepland, b.ziek, b.ziek_doorbetaald, b.ziek_van_verlof, b.bijzonder, b.remaining, b.carry_out, b.payout, e.worked].map(v => typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v).replace('.', ',') : v));
  }
  const csv = '﻿' + lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `verlof_${ov.year}.csv`; a.click();
}

// ================= verlof invoeren / wijzigen =================
async function editLeave(l, employees) {
  const isNew = !l || !l.id;
  l = { kind: 'vakantie', date_from: '', date_to: '', days: '', note: '', ...(l || {}) };
  const active = employees.filter(e => e.active || e.id === l.employee_id);
  const wdOf = id => employees.find(e => e.id === +id)?.workdays || FULL_WEEK;
  let daysTouched = !isNew;
  const res = await modal({ title: isNew ? 'Verlof invoeren' : 'Verlof wijzigen',
    body: html`<div class="grid2">
      <label>Medewerker<select id="lEmp"><option value="">— kies —</option>${raw(active.map(e => html`<option value="${e.id}" ${e.id === l.employee_id ? 'selected' : ''}>${e.name} (${STORE_NAMES[e.store_code]})</option>`).join(''))}</select></label>
      <label>Soort<select id="lKind">${raw(Object.entries(KIND_NL).map(([k, v]) => `<option value="${k}" ${k === l.kind ? 'selected' : ''}>${v}</option>`).join(''))}</select></label>
      <label>Van<input type="date" id="lFrom" value="${l.date_from}"></label>
      <label>Tot en met<input type="date" id="lTo" value="${l.date_to}"></label>
      <label>Aantal dagen<input id="lDays" inputmode="decimal" value="${l.days === '' ? '' : dnum(l.days)}"></label>
      <div><p class="muted small" id="lHint"></p></div>
      <label class="span2">Opmerking<input id="lNote" maxlength="200" value="${l.note || ''}" placeholder="Bijv. besproken op 3 maart"></label></div>
      <p class="small" id="lKindHint"></p>`,
    onOpen: r => {
      const upd = () => {
        const wd = wdOf($('#lEmp', r).value);
        const n = workdays($('#lFrom', r).value, $('#lTo', r).value, wd);
        if (!daysTouched && $('#lFrom', r).value) $('#lDays', r).value = n || '';
        $('#lHint', r).textContent = $('#lFrom', r).value ? `${n} werkdag${n === 1 ? '' : 'en'} (${wdText(wd)}) in deze periode. Pas het aantal aan als dat anders is, bijv. bij een halve dag of een feestdag.` : '';
        const k = $('#lKind', r).value;
        $('#lKindHint', r).innerHTML = k === 'vakantie' ? 'Gaat af van de vakantiedagen.'
          : k === 'ziek' ? 'De eerste 5 ziektedagen per jaar worden doorbetaald. Daarna gaan ze af van de vakantiedagen.'
          : 'Wordt alleen vastgelegd en gaat niet af van de vakantiedagen.';
      };
      $('#lFrom', r).onchange = () => { const f = $('#lFrom', r).value, t = $('#lTo', r).value; if (f && (!t || t < f)) $('#lTo', r).value = f; upd(); }; $('#lTo', r).onchange = upd; $('#lKind', r).onchange = upd; $('#lEmp', r).onchange = upd;
      $('#lDays', r).oninput = () => { daysTouched = true; };
      upd();
    },
    buttons: [{ label: 'Annuleren', value: null }, { label: 'Opslaan', kind: 'primary', default: true, value: r => ({
      id: l.id || null, employee_id: +$('#lEmp', r).value, kind: $('#lKind', r).value,
      date_from: $('#lFrom', r).value, date_to: $('#lTo', r).value, days: parseDays($('#lDays', r).value), note: $('#lNote', r).value.trim() }) }],
    validate: async r => {
      if (!$('#lEmp', r).value) { toast('Kies een medewerker.', 'error'); return false; }
      if (!$('#lFrom', r).value || !$('#lTo', r).value) { toast('Vul de periode in.', 'error'); return false; }
      if (!(parseDays($('#lDays', r).value) > 0)) { toast('Vul het aantal dagen in.', 'error'); return false; }
    } });
  if (!res) return false;
  try {
    const r = await adminCall('pos_admin_leave_save', { p: res });
    const b = r.balance, name = employees.find(e => e.id === res.employee_id)?.name;
    toast(`Opgeslagen. ${name} heeft in ${b.year} nog ${days(b.remaining)} vakantie over.`, 'ok', 6000);
    if (Number(b.remaining) < 0) alertBox('Let op', `${name} heeft nu ${days(Math.abs(b.remaining))} méér vakantie opgenomen dan beschikbaar.`);
    return true;
  } catch (e) { alertBox('Niet opgeslagen', e.message); return false; }
}

// ================= vakantiedagen, meegenomen dagen en pincode =================
async function settings(e) {
  const b = e.balance;
  const res = await modal({ title: `${e.name}: vakantiedagen en pincode ${year}`,
    body: html`${raw(balanceCards(b))}
      ${raw(b.set ? html`<p class="small muted">${raw(yearEndText(b))}</p>` : '')}
      <div class="grid2">
        <label>Vakantiedagen in ${year}<input id="eDays" inputmode="decimal" value="${b.set ? dnum(b.entitlement) : ''}" placeholder="bijv. 18"></label>
        <label>Meegenomen uit ${year - 1}<input id="eCarry" inputmode="decimal" value="${b.set && !b.carry_auto ? dnum(b.carry_in) : ''}" placeholder="leeg = automatisch (${dnum(b.carry_auto ? b.carry_in : 0)})"></label>
      </div>
      <p class="muted small">Laat "meegenomen" leeg om het automatisch uit ${year - 1} te berekenen (maximaal ${dnum(b.max_carry)} dagen). Vul het alleen in voor het eerste jaar of als u het anders hebt afgesproken.</p>
      <h3>Pincode om eigen verlof te bekijken</h3>
      <p class="small">${raw(e.has_pin ? 'Er is een pincode ingesteld.' : '<span class="warn-text">Nog geen pincode: deze medewerker kan het eigen verlof nog niet bekijken.</span>')}
        <button class="btn small" id="ePin">${e.has_pin ? 'Nieuwe pincode instellen' : 'Pincode instellen'}</button> <span id="ePinState" class="ok-text"></span></p>`,
    onOpen: r => {
      $('#ePin', r).onclick = async () => {
        const a = await askPin('Pincode ' + e.name, 'Kies een pincode (4–8 cijfers)'); if (!a) return;
        const c = await askPin('Herhaal', 'Voer dezelfde pincode nog eens in'); if (!c) return;
        if (a !== c) return toast('De pincodes zijn niet gelijk.', 'error');
        r.dataset.pin = a; $('#ePinState', r).textContent = 'Nieuwe pincode wordt opgeslagen bij "Opslaan".';
      };
    },
    buttons: [{ label: 'Annuleren', value: null }, { label: 'Opslaan', kind: 'primary', default: true, value: r => ({
      id: e.id, year, days: parseDays($('#eDays', r).value), carry_in: $('#eCarry', r).value.trim() === '' ? '' : parseDays($('#eCarry', r).value), pin: r.dataset.pin || '' }) }],
    validate: r => {
      if (!(parseDays($('#eDays', r).value) >= 0) || $('#eDays', r).value.trim() === '') { toast('Vul het aantal vakantiedagen in.', 'error'); return false; }
      if ($('#eCarry', r).value.trim() !== '' && !(parseDays($('#eCarry', r).value) >= 0)) { toast('Meegenomen dagen: vul een getal in of laat het leeg.', 'error'); return false; }
    } });
  if (!res) return false;
  try { await adminCall('pos_admin_employee_save', { p: res }); toast('Opgeslagen.', 'ok'); return true; }
  catch (err) { alertBox('Niet opgeslagen', err.message); return false; }
}

// ================= maandoverzicht =================
async function maand(body, ov, rerender) {
  const m = await adminCall('pos_admin_leave_month', { p_year: year, p_month: month });
  const n = dayDate(m.to).getDate();
  const dayList = Array.from({ length: n }, (_, i) => dayStr(new Date(year, month - 1, i + 1)));
  const cell = {};   // `${emp}|${day}` -> {kind, store}
  for (const l of m.leave) for (const d of dayList) if (d >= l.date_from && d <= l.date_to) (cell[l.employee_id + '|' + d] ||= {}).kind = l.kind;
  for (const a of m.attendance) (cell[a.employee_id + '|' + a.day] ||= {}).store = a.store_code;
  const emps = m.employees;
  const count = (st, d) => m.attendance.filter(a => a.day === d && a.store_code === st).length;

  body.innerHTML = html`
    <div class="year-nav"><button class="btn small" data-mn="-1">‹</button><b>${MONTHS[month - 1]} ${year}</b><button class="btn small" data-mn="1">›</button></div>
    <div class="legend small"><span class="mcell work-MAH">M</span> werkt in Mahony <span class="mcell work-IND">I</span> werkt in Indira
      <span class="mcell lv-vakantie">V</span> vakantie <span class="mcell lv-ziek">Z</span> ziek <span class="mcell lv-bijzonder">B</span> bijzonder verlof
      <span class="muted">· klik op een vakje om verlof in te voeren</span></div>
    <div class="table-wrap month-wrap"><table class="month-grid"><thead><tr><th class="mname"></th>
      ${raw(dayList.map(d => { const dd = dayDate(d); return html`<th class="${dd.getDay() === 0 ? 'sun' : ''} ${d === m.today ? 'today' : ''}">${WD[dd.getDay()]}<br>${dd.getDate()}</th>`; }).join(''))}
      <th class="r">Gewerkt</th></tr></thead><tbody>
      ${raw(['MAH', 'IND'].map(st => html`<tr class="mgroup"><td colspan="${n + 2}">${STORE_NAMES[st]}</td></tr>
        ${raw(emps.filter(e => e.store_code === st).map(e => html`<tr><td class="mname">${e.name}</td>
          ${raw(dayList.map(d => {
            const c = cell[e.id + '|' + d] || {}, dd = dayDate(d);
            const off = !(e.workdays || FULL_WEEK).includes(dd.getDay() || 7);
            const cls = [dd.getDay() === 0 ? 'sun' : '', d === m.today ? 'today' : '', c.kind ? 'lv-' + c.kind : c.store ? 'work-' + c.store : off ? 'off' : ''].join(' ');
            const txt = c.kind ? KIND_LETTER[c.kind] + (c.store ? '!' : '') : c.store ? c.store[0] : '';
            const tip = [c.kind ? KIND_NL[c.kind] : '', c.store ? 'werkte in ' + STORE_NAMES[c.store] : ''].filter(Boolean).join(', ');
            return html`<td class="mcell ${cls}" data-e="${e.id}" data-d="${d}" title="${e.name} ${fmtDate(d)}${tip ? ': ' + tip : ''}">${txt}</td>`;
          }).join(''))}
          <td class="r">${m.attendance.filter(a => a.employee_id === e.id).length}</td></tr>`).join(''))}`).join(''))}
      <tr class="msum"><td class="mname">Aantal in Mahony</td>${raw(dayList.map(d => html`<td class="c">${count('MAH', d) || ''}</td>`).join(''))}<td></td></tr>
      <tr class="msum"><td class="mname">Aantal in Indira</td>${raw(dayList.map(d => html`<td class="c">${count('IND', d) || ''}</td>`).join(''))}<td></td></tr>
      </tbody></table></div>
    <p class="muted small">Gearceerd = geen vaste werkdag (parttime). Een uitroepteken (bijv. V!) betekent: verlof ingevoerd, maar die dag ook als werkend ingevuld. De bezetting zelf wijzigt u in het tabblad Bezetting.</p>`;

  $$('[data-mn]', body).forEach(b => b.onclick = () => {
    month += +b.dataset.mn;
    if (month < 1) { month = 12; year--; } if (month > 12) { month = 1; year++; }
    rerender();
  });
  $$('.month-grid td[data-e]', body).forEach(td => td.onclick = async () => {
    const emp = +td.dataset.e, d = td.dataset.d;
    const existing = ov.year === year ? ov.leave.find(l => l.employee_id === emp && d >= l.date_from && d <= l.date_to) : null;
    const ok = existing ? await editLeave(existing, ov.employees)
      : await editLeave({ employee_id: emp, date_from: d, date_to: d }, ov.employees);
    if (ok) rerender();
  });
}

// ================= medewerker toevoegen, wijzigen, onzichtbaar maken, verwijderen =================
async function editEmployee(e, ov) {
  const isNew = !e;
  e = e || { name: '', store_code: 'MAH', workdays: FULL_WEEK, active: true };
  const wd = e.workdays || FULL_WEEK;
  const res = await modal({ title: isNew ? 'Nieuwe medewerker' : `${e.name} bewerken`,
    body: html`<div class="grid2">
        <label>Naam<input id="mName" maxlength="50" value="${e.name}" placeholder="Voornaam"></label>
        <label>Winkel<select id="mStore"><option value="MAH">Mahony</option><option value="IND">Indira</option></select></label></div>
      <div class="small">Vaste werkdagen</div>
      <div class="wd-pick">${raw([1, 2, 3, 4, 5, 6, 7].map(d => html`<label><input type="checkbox" data-wd="${d}" ${wd.includes(d) ? 'checked' : ''}> ${WD_SHORT[d]}</label>`).join(''))}</div>
      <p class="muted small">Voor parttimers: vink alleen de dagen aan dat iemand normaal werkt. Bij het invoeren van verlof telt het programma dan alleen die dagen.</p>
      ${raw(isNew ? html`<label>Vakantiedagen in ${year}<input id="mDays" inputmode="decimal" placeholder="bijv. 18 (parttime minder)"></label>
        <p class="muted small">Een pincode om het eigen verlof te bekijken stelt u daarna in met "Dagen &amp; pin".</p>`
        : html`<label class="check"><input type="checkbox" id="mActive" ${e.active ? 'checked' : ''}> Zichtbaar (in de kassa, bij Bezetting en bij Mijn verlof)</label>
        <p class="muted small">Onzichtbaar maken is voor iemand die (tijdelijk) niet meer werkt: het verlof en de gewerkte dagen blijven bewaard en u kunt de persoon later weer zichtbaar maken.</p>`)}`,
    onOpen: r => { $('#mStore', r).value = e.store_code; },
    buttons: [...(isNew ? [] : [{ label: 'Verwijderen', kind: 'danger', value: 'delete' }]),
      { label: 'Annuleren', value: null },
      { label: isNew ? 'Toevoegen' : 'Opslaan', kind: 'primary', default: true, value: r => ({
        id: e.id || null, name: $('#mName', r).value.trim(), store_code: $('#mStore', r).value,
        workdays: $$('[data-wd]', r).filter(i => i.checked).map(i => +i.dataset.wd),
        active: isNew ? true : $('#mActive', r).checked,
        year, days: isNew ? String(parseDays($('#mDays', r).value)) : '' }) }],
    validate: (r, v) => {
      if (v === 'delete') return;
      if (!$('#mName', r).value.trim()) { toast('Vul een naam in.', 'error'); return false; }
      if (!$$('[data-wd]', r).some(i => i.checked)) { toast('Kies minstens één werkdag.', 'error'); return false; }
      if (isNew && !(parseDays($('#mDays', r).value) >= 0 && $('#mDays', r).value.trim() !== '')) { toast('Vul het aantal vakantiedagen in.', 'error'); return false; }
    } });
  if (!res) return false;
  if (res === 'delete') return deleteEmployee(e, ov);
  try {
    await adminCall('pos_admin_employee_upsert', { p: res });
    toast(isNew ? `${res.name} is toegevoegd.` : 'Opgeslagen.', 'ok');
    refreshCatalog();
    return true;
  } catch (err) { alertBox('Niet opgeslagen', err.message); return false; }
}

async function deleteEmployee(e, ov) {
  const nLeave = ov ? ov.leave.filter(l => l.employee_id === e.id).length : 0;
  const ok = await confirmBox('Medewerker verwijderen',
    `${e.name} definitief verwijderen? Al het verlof (alle jaren) en alle gewerkte dagen van ${e.name} worden ook gewist${nLeave ? ` (alleen al dit jaar ${nLeave} keer verlof)` : ''}. Dit kan niet ongedaan worden gemaakt.\n\nWerkt ${e.name} alleen niet meer? Kies dan liever "Annuleren" en zet ${e.name} op onzichtbaar; dan blijft alles bewaard.`,
    'Definitief verwijderen', 'danger');
  if (!ok) return false;
  try {
    await adminCall('pos_admin_employee_delete', { p_id: e.id });
    toast(`${e.name} is verwijderd.`, 'ok'); refreshCatalog();
    return true;
  } catch (err) { alertBox('Niet verwijderd', err.message); return false; }
}
