// Tabblad Bezetting: wie werkt er vandaag in Mahony en Indira, en wie heeft verlof.
// Per persoon: hele of halve dag, van/tot en een opmerking. Een halve dag in elke winkel mag.
// Wie vakantie heeft of ziek is, kan niet aangevinkt worden.
// De kassa vult VANDAAG in voor de eigen winkel. De zaterdag vult het personeel op de vrijdag
// ervoor in, voor beide winkels (en op de zaterdag zelf nog). Eerdere dagen staan vast;
// alleen de beheerder kan die nog wijzigen. Een winkel kan op zaterdag gesloten zijn (instelling beheerder).
import { S, call, adminCall, adminLogin, requireStaff, staff } from '../app.js';
import { local, html, raw, $, $$, toast, alertBox, confirmBox, isNet, fmtDate, fmtTime, STORE_NAMES } from '../lib.js';
import { KIND_NL, KIND_TAG, addDays, weekday, period, openMyLeave, shiftText } from '../verlof.js';

const PENDING = 'roster_pending';
const BLOCKING = ['vakantie', 'ziek'];        // met dit verlof kan iemand niet werken
const TIMES = (() => { const t = []; for (let m = 6 * 60; m <= 23 * 60; m += 15) t.push(`${String(m / 60 | 0).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); return t; })();

export function create(root) {
  let day = null;          // getoonde dag ('jjjj-mm-dd'); null = vandaag volgens de server
  let data = null;         // laatste antwoord van de database
  let offline = false;     // getoond uit de opslag van deze computer
  let edit = null;         // winkelcode die nu bewerkt wordt
  let picked = new Map();  // id -> {fraction, from, to, note}

  root.innerHTML = html`<div class="roster">
      <div class="view-head"><h1>Bezetting</h1>
        <div class="filters">
          <button class="btn" data-nav="-1">‹ Vorige dag</button>
          <input type="date" id="rDay">
          <button class="btn" data-nav="1">Volgende dag ›</button>
          <button class="btn" id="rToday">Vandaag</button>
          <button class="btn ghost" id="rMine">Mijn verlof bekijken</button>
        </div></div>
      <div id="rBody"><p class="muted">Laden…</p></div></div>`;

  const isAdmin = () => S.admin && Date.now() < S.admin.expires;
  const today = () => data?.today || localToday();
  const toEntries = p => p.entries || (p.ids || []).map(id => ({ id, fraction: 1 }));   // oude wachtrij-vorm

  async function load(d = day) {
    try {
      data = isAdmin() ? await adminCall('pos_admin_roster', { p_day: d }) : await call('pos_roster', { p_day: d });
      day = data.day; offline = false;
      if (data.day === data.today) await local.store.set('roster_today', data);
    } catch (e) {
      if (!isNet(e)) { $('#rBody', root).innerHTML = html`<p class="error-text">${e.message}</p>`; return; }
      const cached = await local.store.get('roster_today', null);
      if (cached && (!d || d === cached.day)) { data = cached; day = cached.day; offline = true; }
      else { $('#rBody', root).innerHTML = html`<p class="warn-text">Geen internet. Andere dagen zijn alleen online te zien.</p>`; return; }
    }
    edit = null;
    render();
  }

  // een werkende persoon als regel: naam, halve dag, tijden, opmerking
  function workerLine(w, st, leave) {
    const home = w.home || w.store_code;
    const lv = leave.get(w.id);
    return html`<li><b>${w.name}</b>
      ${raw(Number(w.fraction) === 0.5 ? ' <span class="tag amber">halve dag</span>' : '')}
      ${raw(home && home !== st ? html` <span class="tag">van ${STORE_NAMES[home]}</span>` : '')}
      ${raw(lv ? html` <span class="tag ${KIND_TAG[lv.kind]}">${KIND_NL[lv.kind].toLowerCase()}</span>` : '')}
      ${raw(w.time_from || w.time_to ? html` <span class="shift">${shiftText(w)}</span>` : '')}
      ${raw(w.note ? html`<div class="muted small">${w.note}</div>` : '')}</li>`;
  }

  function render() {
    $('#rDay', root).value = day;
    const pending = S.rosterPending && S.rosterPending.day === day ? S.rosterPending : null;
    const isToday = day === today();
    const leave = new Map(data.on_leave.map(l => [l.id, l]));
    const col = st => {
      if (edit === st) return editCol(st);
      const s = data.stores.find(x => x.code === st);
      if (s.closed && !s.workers.length) return html`<div class="store-col ${st} card closed-col">
        <h2>${STORE_NAMES[st]}</h2><p class="closed-note">Gesloten op zaterdag</p>
        <p class="muted small">${period(s.closed.date_from, s.closed.date_to)}${raw(s.closed.note ? html` · ${s.closed.note}` : '')}</p></div>`;
      const workers = pending && pending.store === st
        ? toEntries(pending).map(en => { const e = data.employees.find(x => x.id === en.id); return e && { ...e, home: e.store_code, fraction: en.fraction, time_from: en.from, time_to: en.to, note: en.note }; }).filter(Boolean)
        : s.workers;
      const total = workers.reduce((a, w) => a + Number(w.fraction || 1), 0);
      const canEdit = !s.closed && (isAdmin() ? day <= addDays(today(), 60) : ((isToday && st === S.store.code) || data.saturday_open));
      return html`<div class="store-col ${st} card">
        <h2>${STORE_NAMES[st]} <span class="muted small">${workers.length} ${workers.length === 1 ? 'persoon' : 'personen'}${raw(total !== workers.length ? ` · ${String(total).replace('.', ',')} dag` : '')}</span></h2>
        ${raw(workers.length ? html`<ul class="worker-list">${raw(workers.map(w => workerLine(w, st, leave)).join(''))}</ul>`
          : html`<p class="muted">${isToday || day > today() ? 'Nog niet ingevuld.' : 'Niets ingevuld.'}</p>`)}
        ${raw(pending && pending.store === st ? '<p class="warn-text small">Opgeslagen op deze computer. Wordt verstuurd zodra er internet is.</p>'
          : s.entered_at ? html`<p class="muted small">Ingevuld door ${s.entered_by || '?'} om ${fmtTime(s.entered_at)}${raw(fmtDate(s.entered_at) !== fmtDate(day) ? ' op ' + fmtDate(s.entered_at) : '')}</p>` : '')}
        ${raw(canEdit ? html`<button class="btn ${isToday && !workers.length ? 'primary big' : ''}" data-edit="${st}">${workers.length ? 'Wijzigen' : 'Invullen wie er werkt'}</button>` : '')}
      </div>`;
    };
    const locked = !isAdmin() && day < today();
    const friday = isToday && new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)).getDay() === 5;
    $('#rBody', root).innerHTML = html`
      <h2 class="roster-day">${weekday(day)} ${fmtDate(day)}${raw(isToday ? ' <span class="tag green">vandaag</span>' : '')}</h2>
      ${raw(offline ? '<p class="warn-text">Geen internet: dit is de laatst bekende stand op deze computer.</p>' : '')}
      ${raw(locked ? '<p class="muted small">Deze dag staat vast. Alleen de beheerder kan nog iets wijzigen. <button class="btn small ghost" id="rAdmin">Als beheerder wijzigen</button></p>' : '')}
      ${raw(isAdmin() ? '<p class="small admin-note">U bent ingelogd als beheerder en kunt elke dag wijzigen.</p>' : '')}
      ${raw(friday ? '<div class="sat-hint">Morgen is het zaterdag. Vul vandaag de bezetting van zaterdag in, voor beide winkels. <button class="btn small primary" data-nav="1">Naar zaterdag ›</button></div>' : '')}
      ${raw(data.saturday_open && !isToday && !isAdmin() ? '<p class="small sat-note">Zaterdag: u kunt de bezetting van beide winkels invullen.</p>' : '')}
      <div class="store-cols">${raw(col('MAH'))}${raw(col('IND'))}</div>
      <div class="card"><h2>Afwezig wegens verlof</h2>
        ${raw(data.on_leave.length ? html`<ul class="worker-list">${raw(data.on_leave.map(l => html`<li><b>${l.name}</b> <span class="muted">(${STORE_NAMES[l.store_code]})</span>
          <span class="tag ${KIND_TAG[l.kind]}">${KIND_NL[l.kind]}</span> <span class="muted small">${period(l.date_from, l.date_to)}</span></li>`).join(''))}</ul>`
          : '<p class="muted">Niemand.</p>')}</div>`;
    bindBody();
  }

  function editCol(st) {
    const other = data.stores.find(x => x.code !== st);
    const elsewhere = new Map(other.workers.map(w => [w.id, Number(w.fraction || 1)]));
    const leave = new Map(data.on_leave.map(l => [l.id, l]));
    const own = data.employees.filter(e => e.store_code === st), rest = data.employees.filter(e => e.store_code !== st);
    const timeSel = (id, f, v) => html`<select data-f="${f}" data-id="${id}"><option value="">--:--</option>${raw(TIMES.map(t => `<option ${t === v ? 'selected' : ''}>${t}</option>`).join(''))}</select>`;
    const row = e => {
      const away = elsewhere.get(e.id), lv = leave.get(e.id);
      const blocked = lv && BLOCKING.includes(lv.kind);
      const full = away === 1, onlyHalf = away === 0.5;
      const p = picked.get(e.id);
      const why = blocked ? html` <span class="tag ${KIND_TAG[lv.kind]}">${KIND_NL[lv.kind]}: kan niet</span>`
        : full ? html` <span class="tag">werkt hele dag bij ${STORE_NAMES[other.code]}</span>`
        : onlyHalf ? html` <span class="tag amber">halve dag bij ${STORE_NAMES[other.code]}</span>`
        : lv ? html` <span class="tag ${KIND_TAG[lv.kind]}">${KIND_NL[lv.kind]}</span>` : '';
      return html`<div class="worker-row ${p ? 'on' : ''} ${blocked || full ? 'disabled' : ''}">
        <label class="check worker-check"><input type="checkbox" data-id="${e.id}" ${p ? 'checked' : ''} ${blocked || full ? 'disabled' : ''}>
          <span>${e.name}</span>${raw(why)}</label>
        ${raw(p ? html`<div class="worker-detail">
          <div class="seg small-seg"><button type="button" data-frac="1" data-id="${e.id}" class="${p.fraction === 1 ? 'active' : ''}" ${onlyHalf ? 'disabled' : ''}>Hele dag</button><button type="button" data-frac="0.5" data-id="${e.id}" class="${p.fraction === 0.5 ? 'active' : ''}">Halve dag</button></div>
          <label class="tsel">Van ${raw(timeSel(e.id, 'from', p.from))}</label><label class="tsel">tot ${raw(timeSel(e.id, 'to', p.to))}</label>
          <input class="wnote" data-f="note" data-id="${e.id}" maxlength="200" placeholder="Opmerking (optioneel)" value="${p.note || ''}">
        </div>` : '')}
      </div>`;
    };
    return html`<div class="store-col ${st} card editing">
      <h2>${STORE_NAMES[st]}: wie werkt er?</h2>
      <div class="worker-rows">${raw(own.map(row).join(''))}</div>
      ${raw(rest.length ? html`<h3>Hier uit de andere winkel</h3><div class="worker-rows">${raw(rest.map(row).join(''))}</div>` : '')}
      <p class="muted small">Vakantie of ziek? Dan kan iemand niet aangevinkt worden. Een halve dag in elke winkel mag.</p>
      <div class="btn-row"><button class="btn primary" id="rSave">Opslaan</button><button class="btn ghost" id="rCancel">Annuleren</button></div>
    </div>`;
  }

  function bindBody() {
    $$('[data-edit]', root).forEach(b => b.onclick = () => {
      edit = b.dataset.edit;
      const pend = S.rosterPending && S.rosterPending.day === day && S.rosterPending.store === edit ? toEntries(S.rosterPending) : null;
      const cur = pend || data.stores.find(x => x.code === edit).workers.map(w => ({ id: w.id, fraction: Number(w.fraction || 1), from: w.time_from || '', to: w.time_to || '', note: w.note || '' }));
      picked = new Map(cur.map(c => [c.id, { fraction: Number(c.fraction || 1), from: c.from || '', to: c.to || '', note: c.note || '' }]));
      render();
    });
    const adm = $('#rAdmin', root); if (adm) adm.onclick = async () => { if (await adminLogin()) load(day); };
    $$('#rBody [data-nav]', root).forEach(b => b.onclick = () => load(addDays(day, +b.dataset.nav)));
    const cancel = $('#rCancel', root); if (cancel) cancel.onclick = () => { edit = null; render(); };
    const ed = $('.store-col.editing', root);
    if (ed) {
      ed.onchange = e => {
        const t = e.target, id = +t.dataset.id; if (!id) return;
        if (t.type === 'checkbox') {
          if (t.checked) {
            const away = data.stores.find(x => x.code !== edit).workers.find(w => w.id === id);
            picked.set(id, { fraction: away ? 0.5 : 1, from: '', to: '', note: '' });
          } else picked.delete(id);
          render();
        } else if (picked.has(id)) picked.get(id)[t.dataset.f] = t.value;
      };
      ed.oninput = e => { const t = e.target; if (t.dataset.f === 'note' && picked.has(+t.dataset.id)) picked.get(+t.dataset.id).note = t.value; };
      ed.onclick = e => {
        const b = e.target.closest('[data-frac]'); if (!b || b.disabled) return;
        picked.get(+b.dataset.id).fraction = Number(b.dataset.frac);
        $$(`[data-frac][data-id="${b.dataset.id}"]`, ed).forEach(x => x.classList.toggle('active', x === b));
      };
    }
    const save = $('#rSave', root); if (save) save.onclick = () => saveEdit();
  }

  async function saveEdit() {
    const entries = [...picked].map(([id, p]) => ({ id, fraction: p.fraction, from: p.from || null, to: p.to || null, note: (p.note || '').trim() || null }));
    const bad = entries.find(x => x.from && x.to && x.to <= x.from);
    if (bad) return toast(`${data.employees.find(e => e.id === bad.id)?.name}: de eindtijd moet na de begintijd liggen.`, 'error');
    const special = data.on_leave.filter(l => picked.has(l.id) && !BLOCKING.includes(l.kind));
    if (special.length && !(await confirmBox('Verlof', `${special.map(l => `${l.name} heeft ${KIND_NL[l.kind].toLowerCase()}`).join(', ')}. Werkt ${special.length === 1 ? 'deze persoon' : 'iedereen'} toch?`, 'Ja, werkt toch'))) return;
    if (isAdmin()) {
      try { data = await adminCall('pos_admin_roster_save', { p_day: day, p_store: edit, p_entries: entries }); edit = null; toast('Opgeslagen.', 'ok'); render(); }
      catch (e) { alertBox('Niet opgeslagen', isNet(e) ? 'Geen internet.' : e.message); }
      return;
    }
    const who = await requireStaff(); if (who === null) return;
    const item = { day, store: edit, entries, staff: who || staff() };
    try {
      data = await call('pos_roster_save', { p_day: day, p_entries: entries, p_staff: item.staff, p_store: edit });
      await local.store.set('roster_today', data);
      edit = null; toast('Opgeslagen.', 'ok'); render();
    } catch (e) {
      if (!isNet(e)) return alertBox('Niet opgeslagen', e.message);
      S.rosterPending = item; await local.store.set(PENDING, item);
      edit = null; toast('Geen internet. Opgeslagen op deze computer; wordt later verstuurd.', 'info', 6000); render();
    }
  }

  // nog niet verstuurde bezetting (zonder internet ingevuld) versturen
  async function sync() {
    if (!S.rosterPending) S.rosterPending = await local.store.get(PENDING, null);
    const p = S.rosterPending; if (!p || !S.token) return;
    try {
      const r = await call('pos_roster_save', { p_day: p.day, p_entries: toEntries(p), p_staff: p.staff, p_store: p.store });
      S.rosterPending = null; await local.store.set(PENDING, null);
      await local.store.set('roster_today', r);
      toast('De bezetting van vandaag is verstuurd.', 'ok');
      if (day === p.day && !edit) { data = r; render(); }
    } catch (e) {
      if (isNet(e)) return;
      S.rosterPending = null; await local.store.set(PENDING, null);
      alertBox('Bezetting niet verstuurd', `De bezetting van ${fmtDate(p.day)} (zonder internet ingevuld) kon niet worden opgeslagen: ${e.message} Vraag de beheerder om het aan te passen.`);
    }
  }

  $$('[data-nav]', root).forEach(b => b.onclick = () => load(addDays(day || today(), +b.dataset.nav)));
  $('#rDay', root).onchange = e => { if (e.target.value) load(e.target.value); };
  $('#rToday', root).onclick = () => load(null);
  $('#rMine', root).onclick = () => openMyLeave();

  return {
    show() { load(day && day !== today() ? day : null); sync(); },
    sync
  };
}

function localToday() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
