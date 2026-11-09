// Tabblad Dagafsluiting (code 2000): kas tellen en DNP-teller invullen.
// Het personeel ziet niet wat er in de kas hoort te zitten (blind tellen); de beheerder ziet de verschillen.
import { S, call, printHtml, requireStaff, syncQueue } from '../app.js';
import { html, raw, $, srd, round2, parseAmount, toast, alertBox, confirmBox, uuid, isNet, fmtDateTime } from '../lib.js';
import { closeReceipt } from '../receipt.js';

export function create(root) {
  root.innerHTML = html`
    <div class="narrow">
      <h1>Dagafsluiting</h1>
      <p class="muted">Aan het eind van de dag: tel al het contante geld in de kassa en lees de teller van de DNP-printer af.</p>
      <div class="card" id="clInfo"><span class="muted">Laden…</span></div>
      <div class="card">
        <label>Geteld contant geld in de kassa (SRD)<input id="clCash" class="big-input" inputmode="decimal" placeholder="0,00"></label>
        <label>Stand van de DNP-teller (op de computer van de printer)<input id="clDnp" class="big-input" inputmode="numeric" placeholder="bijv. 104523"></label>
        <label>Opmerking (optioneel)<input id="clNote" maxlength="500"></label>
        <button class="btn primary big" id="clGo">Kassa afsluiten</button>
      </div>
    </div>`;

  async function info() {
    try {
      const r = await call('pos_close_info');
      $('#clInfo', root).innerHTML = html`Vorige afsluiting: <b>${r.last_closed_at ? fmtDateTime(r.last_closed_at) : 'nog nooit'}</b><br>
        Transacties sindsdien: <b>${r.transactions}</b>
        ${raw(S.queue.length ? html`<p class="warn-text">Er staan nog ${S.queue.length} offline bon(nen) klaar. Die worden eerst verstuurd.</p>` : '')}`;
    } catch (e) {
      $('#clInfo', root).innerHTML = html`<span class="${isNet(e) ? 'warn-text' : 'error-text'}">${isNet(e) ? 'Geen internet. Afsluiten kan alleen online.' : e.message}</span>`;
    }
  }

  $('#clGo', root).onclick = async () => {
    const cash = round2(parseAmount($('#clCash', root).value));
    const dnpRaw = $('#clDnp', root).value.replace(/[.\s]/g, '');
    const dnp = /^\d+$/.test(dnpRaw) ? Number(dnpRaw) : NaN;
    if (isNaN(cash) || cash < 0) return toast('Vul het getelde bedrag in (0 als er niets is).', 'error');
    if (isNaN(dnp)) return toast('Vul de stand van de DNP-teller in (alleen cijfers).', 'error');
    if (S.queue.length) {
      await syncQueue();
      if (S.queue.length) return alertBox('Nog niet alles verstuurd', 'Er staan nog offline bonnen die niet verstuurd konden worden. Zorg voor internet en probeer het opnieuw.');
    }
    const who = await requireStaff(); if (who === null) return;
    if (!(await confirmBox('Kassa afsluiten', `Geteld: ${srd(cash)}\nDNP-teller: ${dnp}\n\nKlopt dit?`, 'Afsluiten'))) return;
    const close = { client_id: uuid(), counted_cash: cash, dnp_counter: dnp, staff: who, note: $('#clNote', root).value.trim() || null };
    try {
      const r = await call('pos_close_day', { p_close: close });
      printHtml(closeReceipt(S.store, { ...close, closed_at: r.closed_at || new Date() }));
      ['#clCash', '#clDnp', '#clNote'].forEach(s => $(s, root).value = '');
      await alertBox('Dag afgesloten', 'De kassa is afgesloten. Leg de afsluitbon met het geld in de kluis.');
      info();
    } catch (e) {
      alertBox('Niet gelukt', isNet(e) ? 'Geen internet. Afsluiten kan alleen online.' : e.message);
    }
  };
  return { show: info };
}
