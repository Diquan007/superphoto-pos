// Personeelsdossier (alleen beheerder): gegevens, salaris en bank, voorschotten en leningen, loonstroken
import { adminCall, refreshCatalog } from '../app.js';
import { html, raw, $, $$, toast, modal, alertBox, confirmBox, num, fmtDate, isoDay, STORE_NAMES } from '../lib.js';
import { FULL_WEEK, WD_SHORT } from '../verlof.js';
import { PAY_METHOD, PAY_TYPE, SCHEDULE, money, moneyIn, savePayslipPdf } from '../salaris.js';

const TABS = [['gegevens', 'Gegevens'], ['salaris', 'Salaris & bank'], ['geld', 'Voorschotten & leningen'], ['stroken', 'Loonstroken']];

export async function openDossier(emp, ov) {
  let d = await adminCall('pos_admin_employee_details', { p_id: emp.id });
  let tab = 'gegevens', changed = false;
  const wd = d.workdays || FULL_WEEK;
  const opt = (obj, v) => Object.entries(obj).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');

  const body = html`
    <div class="seg dossier-tabs">${raw(TABS.map(([k, l]) => `<button type="button" data-tab="${k}">${l}</button>`).join(''))}</div>
    <div data-pane="gegevens"><div class="grid2">
      <label>Naam<input id="dName" maxlength="50" value="${d.name}"></label>
      <label>Winkel<select id="dStore"><option value="MAH" ${d.store_code === 'MAH' ? 'selected' : ''}>Mahony</option><option value="IND" ${d.store_code === 'IND' ? 'selected' : ''}>Indira</option></select></label>
      <label>Functie<input id="dJob" maxlength="80" value="${d.job_title || ''}" placeholder="bijv. verkoper, fotograaf"></label>
      <label>Telefoon<input id="dPhone" maxlength="40" inputmode="tel" value="${d.phone || ''}"></label>
      <label class="span2">Adres<input id="dAddress" maxlength="200" value="${d.address || ''}"></label>
      <label>Geboortedatum<input type="date" id="dBirth" value="${d.birth_date || ''}"></label>
      <label>In dienst sinds<input type="date" id="dStart" value="${d.start_date || ''}"></label></div>
      <div class="small">Vaste werkdagen</div>
      <div class="wd-pick">${raw([1, 2, 3, 4, 5, 6, 7].map(n => html`<label><input type="checkbox" data-wd="${n}" ${wd.includes(n) ? 'checked' : ''}> ${WD_SHORT[n]}</label>`).join(''))}</div>
      <label class="check"><input type="checkbox" id="dActive" ${d.active ? 'checked' : ''}> Zichtbaar (in de kassa, bij Bezetting en bij Mijn verlof)</label>
      <label>Opmerkingen<textarea id="dNotes" rows="3" maxlength="2000">${d.notes || ''}</textarea></label>
    </div>
    <div data-pane="salaris" hidden><div class="grid2">
      <label>Soort loon<select id="dPayType">${raw(opt(PAY_TYPE, d.pay_type || 'vast'))}</select></label>
      <label>Wanneer betalen<select id="dSched">${raw(opt(SCHEDULE, d.pay_schedule || 'twee'))}</select></label>
      <label data-only="vast">Basissalaris per maand (SRD)<input id="dBase" inputmode="decimal" value="${moneyIn(d.base_salary)}"></label>
      <label>Dagloon (SRD)<input id="dDay" inputmode="decimal" value="${moneyIn(d.day_wage)}"></label>
      <label>Vervoerstoelage per maand (SRD)<input id="dTransport" inputmode="decimal" value="${moneyIn(d.transport)}"></label>
      <label>Extra per gewerkte zaterdag (SRD)<input id="dSat" inputmode="decimal" value="${moneyIn(d.saturday_amount)}"></label>
      <label>Betaalwijze<select id="dMethod">${raw(opt(PAY_METHOD, d.payment_method || 'contant'))}</select></label><span></span>
      <label data-bank>Bank<input id="dBank" maxlength="60" value="${d.bank_name || ''}" placeholder="bijv. DSB, Hakrinbank, Finabank"></label>
      <label data-bank>Rekeningnummer<input id="dAccount" maxlength="40" value="${d.bank_account || ''}"></label>
      <label data-bank class="span2">Ten name van<input id="dHolder" maxlength="80" value="${d.bank_holder || ''}" placeholder="als dat anders is dan de naam"></label></div>
      <p class="muted small">Vast salaris: bij twee keer per maand de helft op de 15e en de helft op de 26e. Dagloon: dagloon × gewerkte dagen uit Bezetting (halve dag telt half).
        Op de 26e komen de vervoerstoelage, voorschotten en aflossingen erbij. Vakantiegeld op 26 augustus: dagloon × vakantiedagen ÷ 2 (vul daarom ook bij vast salaris het dagloon in).
        Het zaterdagbedrag wordt niet verrekend; het staat in het overzicht Zaterdagen.</p>
    </div>
    <div data-pane="geld" hidden></div>
    <div data-pane="stroken" hidden></div>`;

  const moneyPane = () => {
    const open = d.advances.filter(a => !a.payslip_id), openSum = open.reduce((x, a) => x + Number(a.amount), 0);
    return html`<h3>Voorschotten <span class="muted small">${open.length ? `· SRD ${num(openSum)} nog te verrekenen op de 26e` : ''}</span></h3>
      ${raw(d.advances.length ? html`<table class="tbl compact"><tr><th>Datum</th><th class="r">Bedrag</th><th>Opmerking</th><th>Status</th><th></th></tr>
        ${raw(d.advances.map(a => html`<tr><td>${fmtDate(a.date)}</td><td class="r">${num(a.amount)}</td><td class="small">${a.note || ''}</td>
          <td>${raw(a.payslip_id ? html`<span class="tag green">verrekend ${fmtDate(a.pay_date)}</span>` : '<span class="tag amber">open</span>')}</td>
          <td class="actions">${raw(a.payslip_id ? '' : html`<button class="btn small ghost danger-text" data-del-adv="${a.id}">Verwijder</button>`)}</td></tr>`).join(''))}</table>` : '<p class="muted small">Geen voorschotten.</p>')}
      <div class="money-add"><input type="date" data-n="advDate" value="${isoDay()}"><input data-n="advAmount" inputmode="decimal" placeholder="Bedrag"><input data-n="advNote" placeholder="Opmerking"><button class="btn small" data-add="voorschot">+ Voorschot</button></div>
      <h3>Leningen</h3>
      ${raw(d.loans.length ? d.loans.map(l => html`<div class="loan ${Number(l.rest) > 0 ? '' : 'done'}"><div><b>SRD ${num(l.amount)}</b> op ${fmtDate(l.date)} · aflossing SRD ${num(l.installment)} per maand
          ${raw(l.note ? html` · <span class="muted">${l.note}</span>` : '')}</div>
        <div>${raw(Number(l.rest) > 0 ? html`Nog open: <b>SRD ${num(l.rest)}</b>` : '<span class="tag green">afgelost</span>')}
          ${raw(l.payments.length ? html` <span class="muted small">· ${l.payments.length} aflossing(en): ${l.payments.map(p => fmtDate(p.date) + ' ' + num(p.amount)).join(', ')}</span>` : '')}</div>
        <div class="btn-row">${raw(Number(l.rest) > 0 ? html`<button class="btn small" data-extra="${l.id}">Los aflossen</button>` : '')}
          ${raw(!l.payments.some(p => p.payslip_id) ? html`<button class="btn small ghost danger-text" data-del-loan="${l.id}">Verwijder</button>` : '')}</div></div>`).join('') : '<p class="muted small">Geen leningen.</p>')}
      <div class="money-add"><input type="date" data-n="loanDate" value="${isoDay()}"><input data-n="loanAmount" inputmode="decimal" placeholder="Bedrag lening"><input data-n="loanInst" inputmode="decimal" placeholder="Aflossing per maand"><input data-n="loanNote" placeholder="Opmerking"><button class="btn small" data-add="lening">+ Lening</button></div>
      <p class="muted small">Voorschotten gaan in hun geheel van de loonstrook van de 26e af. De aflossing van een lening komt elke 26e op de loonstrook, tot de lening is afgelost.</p>`;
  };
  const stripPane = () => d.payslips.length
    ? html`<table class="tbl compact"><tr><th>Betaaldatum</th><th>Status</th><th>Betaalwijze</th><th class="r">Netto</th><th></th></tr>
      ${raw(d.payslips.map(p => html`<tr><td>${fmtDate(p.pay_date)}</td><td>${raw(p.status === 'vast' ? '<span class="tag green">vastgezet</span>' : '<span class="tag amber">concept</span>')}</td>
        <td>${PAY_METHOD[p.payment_method]}</td><td class="r b">${num(p.net)}</td><td class="actions"><button class="btn small" data-pdf="${p.id}">PDF</button></td></tr>`).join(''))}</table>
      <p class="muted small">Loonstroken maakt en wijzigt u bij Beheer → Salaris.</p>`
    : '<p class="muted">Nog geen loonstroken. Die maakt u bij Beheer → Salaris.</p>';

  const res = await modal({ title: 'Dossier ' + d.name, wide: true, body,
    onOpen: r => {
      const show = t => { tab = t; $$('[data-tab]', r).forEach(b => b.classList.toggle('active', b.dataset.tab === t)); $$('[data-pane]', r).forEach(p => p.hidden = p.dataset.pane !== t); };
      const drawMoney = () => { $('[data-pane="geld"]', r).innerHTML = moneyPane(); };
      const drawStrips = () => { $('[data-pane="stroken"]', r).innerHTML = stripPane(); };
      const reload = async () => { d = await adminCall('pos_admin_employee_details', { p_id: emp.id }); drawMoney(); drawStrips(); changed = true; };
      const sync = () => {
        $$('[data-only="vast"]', r).forEach(x => x.hidden = $('#dPayType', r).value !== 'vast');
        $$('[data-bank]', r).forEach(x => x.hidden = $('#dMethod', r).value !== 'bank');
      };
      $$('[data-tab]', r).forEach(b => b.onclick = () => show(b.dataset.tab));
      $('#dPayType', r).onchange = sync; $('#dMethod', r).onchange = sync; sync();
      drawMoney(); drawStrips(); show('gegevens');
      $('[data-pane="geld"]', r).onclick = async e => {
        const pane = e.currentTarget, v = n => $(`[data-n="${n}"]`, pane).value.trim();
        const add = e.target.closest('[data-add]'), da = e.target.closest('[data-del-adv]'), dl = e.target.closest('[data-del-loan]'), ex = e.target.closest('[data-extra]');
        try {
          if (add && add.dataset.add === 'voorschot') {
            if (!(money(v('advAmount')) > 0)) return toast('Vul het bedrag van het voorschot in.', 'error');
            await adminCall('pos_admin_money_save', { p: { kind: 'voorschot', employee_id: emp.id, date: v('advDate'), amount: money(v('advAmount')), note: v('advNote') } });
            toast('Voorschot opgeslagen.', 'ok'); await reload();
          }
          if (add && add.dataset.add === 'lening') {
            if (!(money(v('loanAmount')) > 0) || !(money(v('loanInst')) > 0)) return toast('Vul het bedrag en de aflossing per maand in.', 'error');
            await adminCall('pos_admin_money_save', { p: { kind: 'lening', employee_id: emp.id, date: v('loanDate'), amount: money(v('loanAmount')), installment: money(v('loanInst')), note: v('loanNote') } });
            toast('Lening opgeslagen.', 'ok'); await reload();
          }
          if (da && await confirmBox('Voorschot verwijderen', 'Dit voorschot verwijderen?', 'Verwijderen', 'danger')) {
            await adminCall('pos_admin_money_delete', { p_kind: 'voorschot', p_id: +da.dataset.delAdv }); await reload();
          }
          if (dl && await confirmBox('Lening verwijderen', 'Deze lening met alle losse aflossingen verwijderen?', 'Verwijderen', 'danger')) {
            await adminCall('pos_admin_money_delete', { p_kind: 'lening', p_id: +dl.dataset.delLoan }); await reload();
          }
          if (ex) {
            const loan = d.loans.find(l => l.id === +ex.dataset.extra);
            const amt = await modal({ title: 'Los aflossen', body: html`<p>Nog open: SRD ${num(loan.rest)}</p><label>Bedrag (SRD)<input id="xAmt" inputmode="decimal"></label><label>Opmerking<input id="xNote" placeholder="bijv. contant terugbetaald"></label>`,
              buttons: [{ label: 'Annuleren', value: null }, { label: 'Opslaan', kind: 'primary', default: true, value: rr => ({ a: money($('#xAmt', rr).value), n: $('#xNote', rr).value.trim() }) }] });
            if (amt && amt.a > 0) { await adminCall('pos_admin_money_save', { p: { kind: 'aflossing', loan_id: loan.id, amount: amt.a, note: amt.n } }); toast('Aflossing opgeslagen.', 'ok'); await reload(); }
          }
        } catch (err) { alertBox('Niet gelukt', err.message); }
      };
      $('[data-pane="stroken"]', r).onclick = async e => {
        const b = e.target.closest('[data-pdf]'); if (!b) return;
        savePayslipPdf(await adminCall('pos_admin_payslip', { p_id: +b.dataset.pdf }));
      };
    },
    buttons: [{ label: 'Verwijderen', kind: 'danger', value: 'delete' }, { label: 'Sluiten', value: null }, { label: 'Opslaan', kind: 'primary', default: true, value: r => collect(r) }],
    validate: (r, v) => {
      if (v === 'delete') return;
      const c = collect(r);
      if (!c.emp.name) { toast('Vul een naam in.', 'error'); return false; }
      if (!c.emp.workdays.length) { toast('Kies minstens één werkdag.', 'error'); return false; }
      for (const [k, l] of [['base_salary', 'basissalaris'], ['day_wage', 'dagloon'], ['transport', 'vervoerstoelage'], ['saturday_amount', 'zaterdagbedrag']]) {
        if (c.det[k] !== '' && !(c.det[k] >= 0)) { toast(`Controleer het ${l}.`, 'error'); return false; }
      }
      if (c.det.pay_type === 'vast' && !(c.det.base_salary > 0)) { toast('Vul het basissalaris in (tabblad Salaris & bank).', 'error'); return false; }
      if (c.det.pay_type === 'dagloon' && !(c.det.day_wage > 0)) { toast('Vul het dagloon in (tabblad Salaris & bank).', 'error'); return false; }
    } });

  function collect(r) {
    const m = id => { const s = $(id, r).value.trim(); return s === '' ? '' : money(s); };
    return {
      emp: { id: emp.id, name: $('#dName', r).value.trim(), store_code: $('#dStore', r).value, active: $('#dActive', r).checked,
             workdays: $$('[data-wd]', r).filter(i => i.checked).map(i => +i.dataset.wd) },
      det: { id: emp.id, job_title: $('#dJob', r).value, phone: $('#dPhone', r).value, address: $('#dAddress', r).value,
             birth_date: $('#dBirth', r).value, start_date: $('#dStart', r).value, notes: $('#dNotes', r).value,
             pay_type: $('#dPayType', r).value, pay_schedule: $('#dSched', r).value, base_salary: m('#dBase'), day_wage: m('#dDay'),
             transport: m('#dTransport'), saturday_amount: m('#dSat'), payment_method: $('#dMethod', r).value,
             bank_name: $('#dBank', r).value, bank_account: $('#dAccount', r).value, bank_holder: $('#dHolder', r).value }
    };
  }

  if (res === 'delete') return (await deleteEmployee(d, ov)) || changed;
  if (!res) return changed;
  try {
    await adminCall('pos_admin_employee_upsert', { p: res.emp });
    await adminCall('pos_admin_employee_details_save', { p: res.det });
    toast('Dossier opgeslagen.', 'ok'); refreshCatalog();
    return true;
  } catch (err) { alertBox('Niet opgeslagen', err.message); return changed; }
}

export async function deleteEmployee(e, ov) {
  const nLeave = ov ? ov.leave.filter(l => l.employee_id === e.id).length : 0;
  const ok = await confirmBox('Medewerker verwijderen',
    `${e.name} definitief verwijderen? Al het verlof, alle gewerkte dagen, loonstroken, voorschotten en leningen van ${e.name} worden ook gewist${nLeave ? ` (alleen al dit jaar ${nLeave} keer verlof)` : ''}. Dit kan niet ongedaan worden gemaakt.\n\nWerkt ${e.name} alleen niet meer? Kies dan liever "Annuleren" en zet ${e.name} op onzichtbaar (vinkje "Zichtbaar" uit); dan blijft alles bewaard.`,
    'Definitief verwijderen', 'danger');
  if (!ok) return false;
  try {
    await adminCall('pos_admin_employee_delete', { p_id: e.id });
    toast(`${e.name} is verwijderd.`, 'ok'); refreshCatalog();
    return true;
  } catch (err) { alertBox('Niet verwijderd', err.message); return false; }
}
