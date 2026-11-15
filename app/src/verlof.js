// Verlof: gedeelde hulpmiddelen en het scherm "Mijn verlof" voor personeel (alleen bekijken)
import { rpc, html, raw, $, $$, toast, modal, askPin, isNet, fmtDate, STORE_NAMES } from './lib.js';

export const KIND_NL = { vakantie: 'Vakantie', ziek: 'Ziek', bijzonder: 'Bijzonder verlof' };
export const KIND_TAG = { vakantie: 'amber', ziek: 'red', bijzonder: 'blue' };
export const KIND_LETTER = { vakantie: 'V', ziek: 'Z', bijzonder: 'B' };

// dagen weergeven: 5 / 5,5
export const dnum = n => { n = Number(n) || 0; return Number.isInteger(n) ? String(n) : String(n).replace('.', ','); };
export const days = n => dnum(n) + (Number(n) === 1 ? ' dag' : ' dagen');

// kalenderdag 'jjjj-mm-dd' naar Date (lokaal, zonder tijdzoneverschuiving)
export const dayDate = s => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const pad = n => String(n).padStart(2, '0');
export const dayStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (s, n) => { const d = dayDate(s); d.setDate(d.getDate() + n); return dayStr(d); };
const WEEKDAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
export const weekday = s => WEEKDAYS[dayDate(s).getDay()];
export const period = (f, t) => f === t ? fmtDate(f) : `${fmtDate(f)} t/m ${fmtDate(t)}`;

// werkdagen tussen twee data volgens de vaste werkdagen van de medewerker (1 = ma ... 7 = zo; standaard ma t/m za)
export const FULL_WEEK = [1, 2, 3, 4, 5, 6];
export function workdays(from, to, wd = FULL_WEEK) {
  if (!from || !to || to < from) return 0;
  let n = 0;
  for (let d = dayDate(from), end = dayDate(to); d <= end; d.setDate(d.getDate() + 1)) if (wd.includes(d.getDay() || 7)) n++;
  return n;
}
export const WD_SHORT = ['', 'ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
export const isPartTime = wd => !!wd && !FULL_WEEK.every(d => wd.includes(d));
export const wdText = wd => (wd || FULL_WEEK).map(d => WD_SHORT[d]).join(', ');
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

// alle gewerkte dagen onder elkaar, per maand
export function workedList(worked) {
  if (!worked.length) return '<p class="muted">Nog geen dagen.</p>';
  const byMonth = [];
  for (const w of worked) {
    const key = w.day.slice(0, 7);
    if (!byMonth.length || byMonth[byMonth.length - 1].key !== key) byMonth.push({ key, days: [] });
    byMonth[byMonth.length - 1].days.push(w);
  }
  return html`<div class="worked-box">${raw(byMonth.map(m => html`<div class="worked-month">
      <h4><span class="mn">${MONTHS[+m.key.slice(5, 7) - 1]}</span> ${m.key.slice(0, 4)} <span class="muted">· ${m.days.length} ${m.days.length === 1 ? 'dag' : 'dagen'}</span></h4>
      <ul class="worked-ul">${raw(m.days.map(w => html`<li><span class="wd">${WD_SHORT[dayDate(w.day).getDay() || 7]}</span> ${fmtDate(w.day)} <span class="muted">${STORE_NAMES[w.store_code]}</span></li>`).join(''))}</ul></div>`).join(''))}</div>`;
}

// Saldo-kaartjes (zelfde opbouw voor medewerker en beheerder)
export function balanceCards(b) {
  if (!b.set) return html`<p class="warn-text">Voor ${b.year} zijn nog geen vakantiedagen ingesteld.</p>`;
  const ziekTxt = Number(b.ziek)
    ? html`${dnum(b.ziek_doorbetaald)} van ${dnum(b.ziek_max_doorbetaald)} doorbetaald${raw(Number(b.ziek_van_verlof) ? html`<br><b class="error-text">${days(b.ziek_van_verlof)} van vakantie af</b>` : '')}`
    : html`nog ${dnum(b.ziek_max_doorbetaald)} doorbetaald`;
  return html`<div class="cards small leave-cards">
      <div class="stat big-stat ${Number(b.remaining) < 0 ? 'bad' : 'good'}"><div class="stat-n">${dnum(b.remaining)}</div><div>vakantiedagen over</div></div>
      <div class="stat"><div class="stat-n">${dnum(b.entitlement)}${raw(Number(b.carry_in) ? html` <small>+ ${dnum(b.carry_in)}</small>` : '')}</div><div>vakantiedagen ${b.year}${raw(Number(b.carry_in) ? ' + meegenomen' : '')}</div></div>
      <div class="stat"><div class="stat-n">${dnum(b.vakantie)}</div><div>vakantie opgenomen${raw(Number(b.vakantie_gepland) ? html`<br>waarvan ${dnum(b.vakantie_gepland)} gepland` : '')}</div></div>
      <div class="stat"><div class="stat-n">${dnum(b.ziek)}</div><div>ziek: ${raw(ziekTxt)}</div></div>
      <div class="stat"><div class="stat-n">${dnum(b.bijzonder)}</div><div>bijzonder verlof<br><span class="muted">telt niet mee</span></div></div>
    </div>`;
}

export function yearEndText(b) {
  if (!b.set) return '';
  return html`Als er op 31 december nog <b>${days(Math.max(0, b.remaining))}</b> over zijn, gaan er <b>${dnum(b.carry_out)}</b> mee naar ${b.year + 1}${raw(Number(b.payout) ? html` en worden er <b>${dnum(b.payout)}</b> uitbetaald` : '')}. Er gaan maximaal ${dnum(b.max_carry)} dagen mee.`;
}

export function leaveTable(list, { actions = false, names = null } = {}) {
  if (!list.length) return '<p class="muted">Geen verlof dit jaar.</p>';
  return html`<div class="table-wrap"><table class="tbl compact leave-tbl"><thead><tr>${raw(names ? '<th>Naam</th>' : '')}<th>Soort</th><th>Periode</th><th class="r">Dagen</th><th>Opmerking</th>${raw(actions ? '<th></th>' : '')}</tr></thead><tbody>
    ${raw(list.map(l => html`<tr>${raw(names ? html`<td class="b">${names[l.employee_id] || ''}</td>` : '')}
      <td><span class="tag ${KIND_TAG[l.kind]}">${KIND_NL[l.kind]}</span></td>
      <td>${period(l.date_from, l.date_to)}</td><td class="r">${dnum(l.days)}</td><td class="small">${l.note || ''}</td>
      ${raw(actions ? html`<td class="actions"><button class="btn small" data-ledit="${l.id}">Wijzig</button><button class="btn small ghost danger-text" data-ldel="${l.id}">Verwijder</button></td>` : '')}</tr>`).join(''))}
    </tbody></table></div>`;
}

// ================= Mijn verlof (personeel) =================
// Kies je naam, voer je eigen pincode in en bekijk je verlof. Niets te wijzigen.
export async function openMyLeave() {
  let names;
  try { names = await rpc('pos_staff_names'); }
  catch (e) { return toast(isNet(e) ? 'Geen internet. Uw verlof bekijken lukt alleen online.' : e.message, 'error', 6000); }
  if (!names.length) return toast('Er zijn nog geen medewerkers ingesteld.', 'error');

  const group = code => names.filter(n => n.store_code === code);
  const id = await modal({ title: 'Mijn verlof bekijken',
    body: html`<p class="muted">Kies uw naam. Daarna vraagt het programma uw eigen pincode.</p>
      ${raw(['MAH', 'IND'].map(c => group(c).length ? html`<h3>${STORE_NAMES[c]}</h3><div class="staff-grid">${raw(group(c).map(n =>
        html`<button class="btn big" data-id="${n.id}">${n.name}</button>`).join(''))}</div>` : '').join(''))}`,
    buttons: [{ label: 'Annuleren', value: null }],
    onOpen: (root, done) => $$('[data-id]', root).forEach(b => b.onclick = () => done(+b.dataset.id)) });
  if (!id) return;
  const person = names.find(n => n.id === id);
  if (!person.has_pin) return toast('Voor u is nog geen pincode ingesteld. Vraag het de beheerder.', 'error', 6000);

  let token;
  for (;;) {
    const pin = await askPin(person.name, 'Uw eigen pincode');
    if (!pin) return;
    try { token = (await rpc('pos_employee_login', { p_id: id, p_pin: pin })).token; break; }
    catch (e) { toast(isNet(e) ? 'Geen internet.' : e.message, 'error'); if (isNet(e) || /Te veel/.test(e.message)) return; }
  }

  let year = new Date().getFullYear(), data = null, idle;
  const load = async () => { data = await rpc('pos_my_leave', { p_token: token, p_year: year }); };
  try { await load(); } catch (e) { rpc('pos_logout', { p_token: token }).catch(() => {}); return toast(e.message, 'error'); }

  const body = () => {
    const b = data.balance, today = data.today;
    const past = data.leave.filter(l => l.date_from <= today), coming = data.leave.filter(l => l.date_from > today);
    return html`<div class="year-nav"><button class="btn small" data-y="-1">‹ ${year - 1}</button><b>${year}</b><button class="btn small" data-y="1">${year + 1} ›</button>
        <span class="muted">${STORE_NAMES[data.store_code]}</span></div>
      ${raw(balanceCards(b))}
      ${raw(b.set ? html`<p class="small muted">${raw(yearEndText(b))}</p>` : '')}
      ${raw(coming.length ? html`<h3>Gepland</h3>${raw(leaveTable(coming))}` : '')}
      <h3>Opgenomen</h3>${raw(leaveTable(past))}
      <h3>Gewerkt in ${year}: ${data.worked.length} ${data.worked.length === 1 ? 'dag' : 'dagen'}</h3>
      ${raw(workedList(data.worked))}
      <p class="small muted">Klopt er iets niet? Bespreek het met de beheerder. U kunt hier zelf niets wijzigen.</p>`;
  };
  await modal({ title: 'Verlof van ' + data.name, wide: true, body: body(),
    buttons: [{ label: 'Sluiten', kind: 'primary', value: null, default: true }],
    onOpen: (root, done) => {
      // na 2 minuten niets doen automatisch sluiten (de kassa-pc is van iedereen)
      const arm = () => { clearTimeout(idle); idle = setTimeout(() => done(null), 120000); };
      ['pointerdown', 'keydown', 'scroll'].forEach(ev => root.addEventListener(ev, arm, true));
      arm();
      root.addEventListener('click', async e => {
        const y = e.target.closest('[data-y]'); if (!y) return;
        year += +y.dataset.y;
        try { await load(); $('.modal-body', root).innerHTML = body(); }
        catch (err) { year -= +y.dataset.y; toast(isNet(err) ? 'Geen internet.' : err.message, 'error'); if (/Sessie/.test(err.message) || err.message === 'SESSIE_VERLOPEN') done(null); }
      });
    } });
  clearTimeout(idle);
  rpc('pos_logout', { p_token: token }).catch(() => {});
}
