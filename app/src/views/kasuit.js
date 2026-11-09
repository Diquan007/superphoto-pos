// Tabblad Kas uit (code 1646 Boodschappen): geld uit de kas voor aankopen
import { S, call, enqueue, provisionalNo, printHtml, requireStaff } from '../app.js';
import { html, $, srd, round2, parseAmount, toast, alertBox, confirmBox, uuid, isNet } from '../lib.js';
import { cashOutReceipt } from '../receipt.js';

export function create(root) {
  root.innerHTML = html`
    <div class="narrow">
      <h1>Kas uit</h1>
      <p class="muted">Geld uit de kassa halen voor boodschappen of andere aankopen (code 1646). Bewaar het aankoopbonnetje bij de kasbon.</p>
      <div class="card">
        <label>Bedrag SRD<input id="coAmt" class="big-input" inputmode="decimal" placeholder="0,00"></label>
        <label>Waarvoor?<input id="coDesc" maxlength="200" placeholder="Bijv. schoonmaakmiddel, water, taxi"></label>
        <label class="check"><input type="checkbox" id="coPrint" checked> Kasbon printen (om te ondertekenen)</label>
        <button class="btn primary big" id="coGo">Geld uit kas opslaan</button>
      </div>
    </div>`;

  $('#coGo', root).onclick = async () => {
    const amount = round2(parseAmount($('#coAmt', root).value));
    const desc = $('#coDesc', root).value.trim();
    if (!(amount > 0)) return toast('Vul een bedrag in.', 'error');
    if (!desc) return toast('Vul in waarvoor het geld is.', 'error');
    const who = await requireStaff(); if (who === null) return;
    if (!(await confirmBox('Kas uit', `${srd(amount)} uit de kas voor "${desc}"?`, 'Opslaan'))) return;
    const out = { client_id: uuid(), sold_at: new Date().toISOString(), amount, description: desc, staff: who };
    let sale, provisional = null;
    try { sale = (await call('pos_cash_out', { p_out: out })).sale; }
    catch (e) {
      if (!isNet(e)) return alertBox('Niet opgeslagen', e.message);
      provisional = provisionalNo();
      await enqueue('pos_cash_out', out, provisional);
      sale = { ...out, total: -amount, comment: desc };
    }
    if ($('#coPrint', root).checked) printHtml(cashOutReceipt(S.store, sale, provisional));
    toast(provisional ? `Offline opgeslagen (${provisional}).` : `Opgeslagen als transactie ${sale.trans_no}.`, 'ok', 5000);
    $('#coAmt', root).value = ''; $('#coDesc', root).value = '';
  };
  return { show() { setTimeout(() => $('#coAmt', root).focus(), 30); } };
}
