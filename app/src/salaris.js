// Salaris: gedeelde hulpmiddelen (loonstrook als PDF, bedragen, betaaldagen)
import { local, esc, num, fmtDate, STORE_NAMES, toast } from './lib.js';

export const PAY_METHOD = { contant: 'Contant', bank: 'Bank' };
export const PAY_TYPE = { vast: 'Vast salaris (per maand)', dagloon: 'Dagloon (per gewerkte dag)' };
export const SCHEDULE = { twee: 'Twee keer per maand (15e en 26e)', een: 'Eén keer per maand (26e)' };
export const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

// '1.234,50' / '1234.5' / 1234.5 -> 1234.5
export function money(s) {
  if (typeof s === 'number') return s;
  s = String(s ?? '').trim().replace(/\s|SRD/gi, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}
export const moneyIn = v => v === null || v === undefined || v === '' ? '' : num(v);

// eerstvolgende betaaldag (15e of 26e) vanaf vandaag
export function nextPayDate(d = new Date()) {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  const iso = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  if (day <= 15) return iso(y, m, 15);
  if (day <= 26) return iso(y, m, 26);
  return m === 11 ? iso(y + 1, 0, 15) : iso(y, m + 1, 15);
}

export function payslipHtml(p) {
  const title = `Loonstrook ${p.name} ${fmtDate(p.pay_date)}`;
  const plus = p.lines.filter(l => Number(l.amount) >= 0), minus = p.lines.filter(l => Number(l.amount) < 0);
  const rows = list => list.map(l => `<tr><td>${esc(l.label)}</td><td class="r">${num(l.amount)}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: A4; margin: 18mm; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: #1f1d1a; font-size: 11pt; margin: 0; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1f7a4d; padding-bottom: 10px; margin-bottom: 18px; }
    h1 { font-size: 20pt; margin: 0; } .muted { color: #6b665e; } .small { font-size: 9.5pt; }
    table { width: 100%; border-collapse: collapse; } td, th { padding: 6px 8px; border-bottom: 1px solid #e2ddd5; text-align: left; vertical-align: top; }
    th { font-size: 9pt; text-transform: uppercase; letter-spacing: .04em; color: #6b665e; }
    .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .info td { border: 0; padding: 3px 8px 3px 0; } .info td:first-child { color: #6b665e; width: 130px; }
    .net td { font-weight: 700; font-size: 13pt; border-top: 2px solid #1f1d1a; border-bottom: 0; padding-top: 10px; }
    .sign { margin-top: 60px; display: flex; gap: 40px; } .sign div { flex: 1; border-top: 1px solid #1f1d1a; padding-top: 6px; }
    .concept { color: #b7791f; font-weight: 700; }
  </style></head><body>
    <div class="top"><div><h1>Loonstrook</h1><div class="muted">Super Photo ${esc(STORE_NAMES[p.store_code] || '')}</div></div>
      <div class="r"><b>Betaaldatum ${fmtDate(p.pay_date)}</b><br><span class="muted">Periode ${fmtDate(p.period_from)} t/m ${fmtDate(p.period_to)}</span>
      ${p.status === 'concept' ? '<br><span class="concept">CONCEPT</span>' : ''}</div></div>
    <table class="info"><tr><td>Naam</td><td><b>${esc(p.name)}</b></td></tr>
      ${p.job_title ? `<tr><td>Functie</td><td>${esc(p.job_title)}</td></tr>` : ''}
      <tr><td>Betaalwijze</td><td>${PAY_METHOD[p.payment_method] || ''}${p.payment_method === 'bank' && p.bank_account ? ` · ${esc(p.bank_name || '')} ${esc(p.bank_account)}${p.bank_holder ? ' t.n.v. ' + esc(p.bank_holder) : ''}` : ''}</td></tr></table>
    <br>
    <table><tr><th>Omschrijving</th><th class="r">SRD</th></tr>
      ${rows(plus)}
      ${minus.length ? `<tr><th colspan="2" style="padding-top:14px">Inhoudingen</th></tr>${rows(minus)}` : ''}
      <tr class="net"><td>Netto uit te betalen</td><td class="r">SRD ${num(p.net)}</td></tr></table>
    <div class="sign"><div class="small">Voor ontvangst (handtekening medewerker)</div><div class="small">Datum</div></div>
  </body></html>`;
}

export async function savePayslipPdf(p) {
  const r = await local.savePdf(payslipHtml(p), `Loonstrook ${p.name} ${fmtDate(p.pay_date)}.pdf`);
  if (r && r.ok && r.path) toast('Opgeslagen: ' + r.path, 'ok', 6000);
  else if (r && r.ok === false && r.reason !== 'cancelled') toast('PDF maken mislukt: ' + (r.reason || ''), 'error');
}
