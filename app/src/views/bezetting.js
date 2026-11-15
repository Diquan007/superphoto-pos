// Tabblad Bezetting: wie werkt er vandaag in Mahony en Indira, en wie heeft verlof.
// De kassa vult alleen VANDAAG in voor de eigen winkel. Eerdere dagen staan vast;
// alleen de beheerder kan die nog wijzigen.
import { S, call, adminCall, adminLogin, requireStaff, staff } from '../app.js';
import { local, html, raw, $, $$, toast, alertBox, confirmBox, isNet, fmtDate, fmtTime, STORE_NAMES } from '../lib.js';
import { KIND_NL, KIND_TAG, addDays, weekday, period, openMyLeave } from '../verlof.js';

const PENDING = 'roster_pending';

export function create(root) {
  let day = null;          // getoonde dag ('jjjj-mm-dd'); null = vandaag volgens de server
  let data = null;         // laatste antwoord van de database
  let offline = false;     // getoond uit de opslag van deze computer
  let edit = null;         // winkelcode die nu bewerkt wordt
  let picked = new Set();

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
  const today = () => data?.today || local_today();

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

  function render() {
    $('#rDay', root).value = day;
    const pending = S.rosterPending && S.rosterPending.day === day ? S.rosterPending : null;
    const isToday = day === today();
    const leaveIds = new Map(data.on_leave.map(l => [l.id, l]));
    const col = st => {
      const s = data.stores.find(x => x.code === st);
      const workers = pending && pending.store === st ? pending.ids.map(id => data.employees.find(e => e.id === id)).filter(Boolean) : s.workers;
      const canEdit = isAdmin() ? day <= addDays(today(), 60) : (isToday && st === S.store.code);
      if (edit === st) return editCol(st);
      return html`<div class="store-col ${st} card">
        <h2>${STORE_NAMES[st]} <span class="muted small">${workers.length} ${workers.length === 1 ? 'persoon' : 'personen'}</span></h2>
        ${raw(workers.length ? html`<ul class="worker-list">${raw(workers.map(w => html`<li><b>${w.name}</b>${raw(w.home && w.home !== st || w.store_code && w.store_code !== st ? html` <span class="tag">van ${STORE_NAMES[w.home || w.store_code]}</span>` : '')}${raw(leaveIds.has(w.id) ? html` <span class="tag ${KIND_TAG[leaveIds.get(w.id).kind]}">heeft ${KIND_NL[leaveIds.get(w.id).kind].toLowerCase()}</span>` : '')}</li>`).join(''))}</ul>`
          : html`<p class="muted">${isToday ? 'Nog niet ingevuld.' : day > today() ? 'Nog niet ingevuld.' : 'Niets ingevuld.'}</p>`)}
        ${raw(pending && pending.store === st ? '<p class="warn-text small">Opgeslagen op deze computer. Wordt verstuurd zodra er internet is.</p>'
          : s.entered_at ? html`<p class="muted small">Ingevuld door ${s.entered_by || '?'} om ${fmtTime(s.entered_at)}${raw(fmtDate(s.entered_at) !== fmtDate(day) ? ' op ' + fmtDate(s.entered_at) : '')}</p>` : '')}
        ${raw(canEdit ? html`<button class="btn ${isToday && !workers.length ? 'primary big' : ''}" data-edit="${st}">${workers.length ? 'Wijzigen' : 'Invullen wie er werkt'}</button>` : '')}
      </div>`;
    };
    const locked = !isAdmin() && day < today();
    $('#rBody', root).innerHTML = html`
      <h2 class="roster-day">${weekday(day)} ${fmtDate(day)}${raw(isToday ? ' <span class="tag green">vandaag</span>' : '')}</h2>
      ${raw(offline ? '<p class="warn-text">Geen internet: dit is de laatst bekende stand op deze computer.</p>' : '')}
      ${raw(locked ? '<p class="muted small">Deze dag staat vast. Alleen de beheerder kan nog iets wijzigen. <button class="btn small ghost" id="rAdmin">Als beheerder wijzigen</button></p>' : '')}
      ${raw(isAdmin() ? '<p class="small admin-note">U bent ingelogd als beheerder en kunt elke dag wijzigen.</p>' : '')}
      <div class="store-cols">${raw(col('MAH'))}${raw(col('IND'))}</div>
      <div class="card"><h2>Afwezig wegens verlof</h2>
        ${raw(data.on_leave.length ? html`<ul class="worker-list">${raw(data.on_leave.map(l => html`<li><b>${l.name}</b> <span class="muted">(${STORE_NAMES[l.store_code]})</span>
          <span class="tag ${KIND_TAG[l.kind]}">${KIND_NL[l.kind]}</span> <span class="muted small">${period(l.date_from, l.date_to)}</span></li>`).join(''))}</ul>`
          : '<p class="muted">Niemand.</p>')}</div>`;
    bindBody();
  }

  function editCol(st) {
    const s = data.stores.find(x => x.code === st);
    const other = data.stores.find(x => x.code !== st);
    const elsewhere = new Map(other.workers.map(w => [w.id, other.code]));
    const leave = new Map(data.on_leave.map(l => [l.id, l]));
    const own = data.employees.filter(e => e.store_code === st), rest = data.employees.filter(e => e.store_code !== st);
    const row = e => {
      const away = elsewhere.get(e.id), lv = leave.get(e.id);
      return html`<label class="check worker-check ${away ? 'disabled' : ''}"><input type="checkbox" data-id="${e.id}" ${picked.has(e.id) ? 'checked' : ''} ${away ? 'disabled' : ''}>
        <span>${e.name}</span>${raw(away ? html` <span class="tag">werkt bij ${STORE_NAMES[away]}</span>` : '')}${raw(lv ? html` <span class="tag ${KIND_TAG[lv.kind]}">${KIND_NL[lv.kind]}</span>` : '')}</label>`;
    };
    return html`<div class="store-col ${st} card editing">
      <h2>${STORE_NAMES[st]}: wie werkt er?</h2>
      <div class="worker-checks">${raw(own.map(row).join(''))}</div>
      ${raw(rest.length ? html`<h3>Vandaag hier uit de andere winkel</h3><div class="worker-checks">${raw(rest.map(row).join(''))}</div>` : '')}
      <div class="btn-row"><button class="btn primary" id="rSave">Opslaan</button><button class="btn ghost" id="rCancel">Annuleren</button></div>
    </div>`;
  }

  function bindBody() {
    $$('[data-edit]', root).forEach(b => b.onclick = () => {
      edit = b.dataset.edit;
      const pending = S.rosterPending && S.rosterPending.day === day && S.rosterPending.store === edit ? S.rosterPending.ids : null;
      picked = new Set(pending || data.stores.find(x => x.code === edit).workers.map(w => w.id));
      render();
    });
    const adm = $('#rAdmin', root); if (adm) adm.onclick = async () => { if (await adminLogin()) load(day); };
    const cancel = $('#rCancel', root); if (cancel) cancel.onclick = () => { edit = null; render(); };
    $$('.worker-checks input', root).forEach(i => i.onchange = () => { i.checked ? picked.add(+i.dataset.id) : picked.delete(+i.dataset.id); });
    const save = $('#rSave', root); if (save) save.onclick = () => saveEdit();
  }

  async function saveEdit() {
    const ids = [...picked];
    const onLeave = data.on_leave.filter(l => picked.has(l.id));
    if (onLeave.length && !(await confirmBox('Verlof', `${onLeave.map(l => `${l.name} heeft ${KIND_NL[l.kind].toLowerCase()}`).join(', ')}. Werkt ${onLeave.length === 1 ? 'deze persoon' : 'iedereen'} toch?`, 'Ja, werkt toch'))) return;
    if (isAdmin()) {
      try { data = await adminCall('pos_admin_roster_set', { p_day: day, p_store: edit, p_ids: ids }); edit = null; toast('Opgeslagen.', 'ok'); render(); }
      catch (e) { alertBox('Niet opgeslagen', isNet(e) ? 'Geen internet.' : e.message); }
      return;
    }
    const who = await requireStaff(); if (who === null) return;
    const item = { day, store: S.store.code, ids, staff: who || staff() };
    try {
      data = await call('pos_roster_set', { p_day: day, p_ids: ids, p_staff: item.staff });
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
    if (p.store !== S.store.code) return;
    try {
      const r = await call('pos_roster_set', { p_day: p.day, p_ids: p.ids, p_staff: p.staff });
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

function local_today() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
