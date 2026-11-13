// Bonnen voor de thermische printers (80 mm Mahony, 58 mm Indira)
import { esc, num, fmtDateTime, METHOD_NAMES, STORE_NAMES } from './lib.js';

function frame(store, inner) {
  const w = store.receipt_width_mm || 80;
  const narrow = w < 70;
  const content = narrow ? 48 : 72;   // bedrukbare breedte in mm
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: ${w}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { width: ${w}mm; padding: 2mm ${(w - content) / 2}mm 4mm; font: ${narrow ? 10.5 : 12}px/1.3 'Consolas','Courier New',monospace; }
    .c { text-align: center; } .b { font-weight: 700; } .big { font-size: ${narrow ? 15 : 18}px; }
    .hr { border-top: 1px dashed #000; margin: 4px 0; }
    .row { display: flex; justify-content: space-between; gap: 4px; }
    .row span:last-child { text-align: right; white-space: nowrap; }
    .item { margin: 2px 0; } .sub { padding-left: 6px; }
    .note { margin-top: 3px; white-space: pre-wrap; word-break: break-word; }
  </style></head><body>
    <div class="c b big">Super Photo</div>
    <div class="c">${esc(store.address || '')}</div>
    <div class="c">Tel: ${esc(store.phone || '')}</div>
    <div class="hr"></div>${inner}</body></html>`;
}
const row = (l, r, cls = '') => `<div class="row ${cls}"><span>${esc(l)}</span><span>${esc(r)}</span></div>`;

function head(sale, provisional) {
  return (provisional
      ? row('Voorlopig nr:', provisional) + '<div class="note">Offline opgeslagen. Het transactienummer volgt.</div>'
      : row('Trans. nr:', String(sale.trans_no))) +
    row('Datum:', fmtDateTime(sale.sold_at || new Date()));
}

// Verkoopbon / ophaalbon
export function saleReceipt(store, sale, { provisional = null, copy = false } = {}) {
  let s = head(sale, provisional);
  if (copy) s += '<div class="c b">*** KOPIE ***</div>';
  if (sale.voided) s += '<div class="c b">*** VERVALLEN ***</div>';
  if (sale.customer_name) s += row('Klant:', sale.customer_name + (sale.customer_phone ? ' ' + sale.customer_phone : ''));
  if (sale.pickup_at) s += row('Ophalen:', fmtDateTime(sale.pickup_at), 'b');
  if (sale.route_afh && sale.route_afh !== sale.store_code) s += row('Afhalen op:', STORE_NAMES[sale.route_afh] || sale.route_afh, 'b');
  if (sale.route_door && sale.route_door !== sale.store_code) s += row('Gemaakt door:', STORE_NAMES[sale.route_door] || sale.route_door);
  s += '<div class="hr"></div>';
  for (const l of sale.lines || []) {
    s += `<div class="item">${esc(l.stock_no ? l.stock_no + ' ' : '')}${esc(l.name)}</div>`;
    s += row(`  ${l.qty} x ${num(l.unit_price ?? l.price)}`, num(l.line_total ?? (l.qty * (l.unit_price ?? l.price))), 'sub');
  }
  s += '<div class="hr"></div>';
  if (Number(sale.discount) > 0) {
    s += row('Subtotaal', num(sale.subtotal));
    s += row('Korting', '-' + num(sale.discount));
  }
  s += row('TOTAAL SRD', num(sale.total), 'b big');
  if (Number(sale.paid) > 0) s += row('Betaald (' + (METHOD_NAMES[sale.payment_method] || '') + ')', num(sale.paid));
  if (sale.cash_received != null && sale.payment_method === 'cash') {
    s += row('Contant ontvangen', num(sale.cash_received));
    s += row('Wisselgeld', num(sale.change_given ?? (sale.cash_received - sale.paid)));
  }
  const open = Number(sale.total) - Number(sale.paid);
  if (open > 0.004 && sale.outstanding === undefined) s += row('Nog te betalen', num(open), 'b');
  else if (Number(sale.outstanding) > 0.004) s += row('Nog te betalen', num(sale.outstanding), 'b');
  if (sale.comment) s += `<div class="note">${esc(sale.comment)}</div>`;
  s += '<div class="hr"></div>';
  if (sale.staff) s += `<div class="c">Geholpen door: ${esc(sale.staff)}</div>`;
  s += '<div class="c" style="margin-top:6px">Bedankt voor uw bezoek!</div>';
  if (sale.pickup_at || open > 0.004) s += '<div class="c">Bewaar deze bon voor het afhalen.</div>';
  return frame(store, s);
}

// Bon voor restbetaling (1060 Saldo)
export function balanceReceipt(store, pay, order) {
  let s = head(pay);
  s += row('Betreft order:', String(order.trans_no), 'b');
  if (order.customer_name) s += row('Klant:', order.customer_name);
  s += '<div class="hr"></div>';
  s += row('Ordertotaal', num(order.total));
  s += row('Eerder betaald', num(Number(order.total) - Number(order.outstanding) - Number(pay.paid)));
  s += row('Nu betaald (' + (METHOD_NAMES[pay.payment_method] || '') + ')', num(pay.paid), 'b big');
  if (pay.cash_received != null && pay.payment_method === 'cash') {
    s += row('Contant ontvangen', num(pay.cash_received));
    s += row('Wisselgeld', num(pay.change_given));
  }
  s += row('Nog te betalen', num(order.outstanding), 'b');
  s += '<div class="hr"></div>';
  if (pay.staff) s += `<div class="c">Geholpen door: ${esc(pay.staff)}</div>`;
  s += '<div class="c" style="margin-top:6px">Bedankt voor uw bezoek!</div>';
  return frame(store, s);
}

// Kasbon voor geld uit de kas (1646)
export function cashOutReceipt(store, sale, provisional) {
  let s = '<div class="c b">KAS UIT</div>' + head(sale, provisional);
  s += '<div class="hr"></div>';
  s += `<div class="note">${esc(sale.comment || '')}</div>`;
  s += row('Bedrag SRD', num(-Number(sale.total)), 'b big');
  s += '<div class="hr"></div>';
  s += row('Door:', sale.staff || '');
  s += '<div style="margin-top:14px">Handtekening:</div><div style="border-bottom:1px solid #000;height:22px"></div>';
  return frame(store, s);
}

// Afsluitbon (alleen wat het personeel heeft ingevuld)
export function closeReceipt(store, c) {
  let s = '<div class="c b">DAGAFSLUITING</div>';
  s += row('Winkel:', STORE_NAMES[store.code] || store.code);
  s += row('Datum:', fmtDateTime(c.closed_at));
  s += row('Door:', c.staff || '');
  s += '<div class="hr"></div>';
  s += row('Geteld contant SRD', num(c.counted_cash), 'b');
  s += row('Stand DNP-teller', String(c.dnp_counter), 'b');
  if (c.note) s += `<div class="note">${esc(c.note)}</div>`;
  s += '<div style="margin-top:14px">Handtekening:</div><div style="border-bottom:1px solid #000;height:22px"></div>';
  return frame(store, s);
}

export function testReceipt(store) {
  return frame(store, row('Testbon', fmtDateTime(new Date())) +
    `<div class="note">Printer werkt. Breedte: ${store.receipt_width_mm} mm</div>` +
    row('1234567890123456789012345678901234567890', '') + '<div class="hr"></div>' + row('TOTAAL SRD', num(1234.5), 'b big'));
}
