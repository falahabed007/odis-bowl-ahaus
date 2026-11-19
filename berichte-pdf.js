// ─── Berichte als PDF (Wochen- und Monatsbericht, Umsatzsteuer) ──
// Aus server.js herausgelöst (19.11.2026), damit sich die Berichte ohne
// Datenbank, ohne Server und ohne Mailversand bauen lassen - etwa für ein
// Beispiel-PDF oder einen Test. server.js holt die Bestellungen, ruft hier rein
// und verschickt das Ergebnis. Layout und Zahlen sind unverändert übernommen;
// neu sind nur die Umsatzsteuer-Abschnitte (umsatzsteuer.js rechnet).
'use strict';

const PDFDocument  = require('pdfkit');
const stripeDirekt = require('./stripe-direkt');
const Ust          = require('./umsatzsteuer');

// PDF-Generator Helper
function generatePdf(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    doc.end();
  });
}

// ─── PDF Layout-Helpers ───────────────────────────────────────────────────
const PDF_M  = 50;
const PDF_W  = 495;
const PDF_PW = 595;
const PDF_FT = 790; // Unterkante fuer Tabellenzeilen. Der Textbereich endet bei page.height-50 = 791,9;
                    // reicht eine Zeile darueber, bricht pdfkit selbst um und jede Zelle landet auf eigener Seite.
const PDF_SV = 0.99;
const PDF_BASE = 150; // monatliche Grundgebühr (Fixmodell: 150 € + Servicegebühr/Bestellung, Abed 17.11.2026)
const PDF_DOMAIN = 0; // monatliche Domain-Kosten, separat ueber Lexware (Abed, 01.11.2026)
const pdfFmt = n => n.toFixed(2).replace('.', ',') + ' €';

function pdfColorBox(doc, title, sub, color = '#0a1e47', h = 70) {
  doc.rect(0, 0, PDF_PW, h).fill(color);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#fff').text(title, PDF_M, 18);
  if (sub) doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.75)').text(sub, PDF_M, 44);
  doc.y = h + 12;
}

function pdfHr(doc, color = '#ddd', lw = 0.5) {
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M + PDF_W, doc.y).strokeColor(color).lineWidth(lw).stroke();
  doc.y += lw + 3;
}

function pdfKacheln(doc, items) {
  const kW = Math.floor((PDF_W - (items.length - 1) * 8) / items.length);
  const top = doc.y;
  items.forEach(([label, value, color], i) => {
    const x = PDF_M + i * (kW + 8);
    doc.rect(x, top, kW, 46).fill(color);
    doc.font('Helvetica').fontSize(7.5).fillColor('#ffffff', 0.75).text(label, x + 8, top + 8, { width: kW - 12 }); // pdfkit kennt kein rgba()
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff', 1).text(value, x + 8, top + 22, { width: kW - 12 });
  });
  doc.y = top + 54;
}

function pdfTableRow(doc, cells, shade, bold = false) {
  const top = doc.y;
  if (shade) doc.rect(PDF_M, top, PDF_W, 20).fill('#f5f7fa');
  cells.forEach(([txt, x, w, align]) => {
    const opts = align ? { width: w, align } : { width: w };
    (bold ? doc.font('Helvetica-Bold') : doc.font('Helvetica'))
      .fontSize(9.5).fillColor('#222').text(txt, x, top + 5, opts);
  });
  doc.y = top + 20;
}

// Ohne Gastnamen: Die Berichte gehen per Mail an Inhaber und teils an den Steuerberater, dafuer reicht die
// Bestellnummer (Datenminimierung, Abed 01.11.2026). Name und Kontaktdaten stehen nur in der App.
function pdfKundenliste(doc, orders) {
  function drawGroup(label, color, list) {
    if (!list.length) return;
    // Gruppenkopf + Spaltenkopf + erste Zeilen zusammenhalten
    if (doc.y > PDF_FT - 90) { doc.addPage(); doc.y = PDF_M; }
    const gy = doc.y;
    doc.rect(PDF_M, gy, PDF_W, 22).fill(color);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text(label, PDF_M + 8, gy + 6, { width: PDF_W - 16 });
    doc.y = gy + 22 + 2;
    const hy = doc.y;
    doc.rect(PDF_M, hy, PDF_W, 16).fill('#eaeef3');
    [['#', PDF_M+2, 30, 'left'], ['Datum', PDF_M+34, 40, 'left'],
     ['Art', PDF_M+76, 80, 'left'], ['Betrag', PDF_M+2, PDF_W-4, 'right']
    ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(8).fillColor('#444').text(h, x, hy+4, { width:w, align:a }));
    doc.y = hy + 16 + 2;
    let sub = 0;
    list.forEach((o, i) => {
      // letzte Zeile nicht ohne ihre Summenzeile (20 pt) auf der alten Seite lassen
      if (doc.y > PDF_FT - (i === list.length - 1 ? 44 : 24)) { doc.addPage(); doc.y = PDF_M; }
      const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
      const modeStr = o.mode === 'lieferung' ? 'Lieferung' : 'Abholung';
      const ry = doc.y;
      if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 18).fill('#fafafa');
      doc.font('Helvetica').fontSize(9).fillColor('#222')
        .text(`${o.orderNum}`, PDF_M+2,   ry+4, { width:30 })
        .text(date,            PDF_M+34,  ry+4, { width:40 })
        .text(modeStr,         PDF_M+76,  ry+4, { width:80 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#222')
        .text(pdfFmt(o.total||0), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
      doc.y = ry + 18;
      sub += (o.total||0);
    });
    if (doc.y > PDF_FT - 24) { doc.addPage(); doc.y = PDF_M; }
    const sy = doc.y;
    doc.rect(PDF_M, sy, PDF_W, 20).fill(color + '28');
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Summe ${label}:`, PDF_M+8, sy+5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(pdfFmt(sub), PDF_M+2, sy+5, { width:PDF_W-4, align:'right' });
    doc.y = sy + 20 + 10;
  }
  drawGroup('Barzahlung', '#0a1e47', orders.filter(o => o.payment === 'bar'));
  drawGroup('Online-Zahlung (Ihr Stripe-Konto)', '#276749', orders.filter(o => o.payment === 'stripe'));
  drawGroup('Online-Zahlung (PayPal)', '#003087', orders.filter(o => o.payment === 'paypal'));
  drawGroup('EC-Karte', '#555555', orders.filter(o => o.payment === 'karte'));
}

// Stornierte Bestellungen des Zeitraums - fuer den Nachweis gegenueber Inhaber und Steuerberater (Abed, 25.10.2026).
// Zaehlen nicht zum Umsatz und nicht zu den Gebuehren, stehen aber vollstaendig im Bericht. Steht keine im Zeitraum,
// sagt der Bericht das ausdruecklich, statt den Abschnitt wegzulassen. Abgebrochene Online-Zahlungen (nie bezahlt,
// Stripe setzt sie auf cancelled) sind keine Stornos und bleiben draussen (Abed, 25.10.).
function pdfStornoliste(doc, alle) {
  const stornos = alle.filter(o => !(['stripe','paypal'].includes(o.payment) && !['paid','refunded'].includes(o.paymentStatus)));
  if (doc.y > PDF_FT - 90) { doc.addPage(); doc.y = PDF_M; }
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('STORNIERUNGEN', PDF_M, doc.y);
  doc.y += 12;
  if (!stornos.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#555').text('Keine stornierten Bestellungen im Zeitraum.', PDF_M + 8, doc.y);
    doc.y += 18;
    return;
  }
  const zeit = d => new Date(d).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' }).replace(',', '');
  const zahlart = o => ({ bar:'Bar', karte:'EC-Karte', stripe:'Online', paypal:'PayPal' }[o.payment] || o.payment || '–')
    + (o.paymentStatus === 'refunded' ? ', erstattet' : '');
  const kurz = (s, n) => s.length > n ? s.substring(0, n - 1) + '…' : s; // eine Zeile je Storno, sonst ueberlappt die Summe
  const grund = o => kurz(o.cancelReason || '–', 40);
  const spalten = [['#', PDF_M+2, 30, 'left'], ['Bestellt', PDF_M+34, 62, 'left'], ['Storniert', PDF_M+98, 62, 'left'],
    ['Zahlart', PDF_M+162, 80, 'left'], ['Grund', PDF_M+244, 199, 'left'], ['Betrag', PDF_M+2, PDF_W-4, 'right']];
  const kopf = () => {
    const hy = doc.y;
    doc.rect(PDF_M, hy, PDF_W, 16).fill('#f3e3e3');
    spalten.forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(8).fillColor('#5a2a2a').text(h, x, hy+4, { width:w, align:a }));
    doc.y = hy + 16 + 2;
  };
  kopf();
  let summe = 0;
  stornos.forEach((o, i) => {
    if (doc.y > PDF_FT - (i === stornos.length - 1 ? 44 : 24)) { doc.addPage(); doc.y = PDF_M; kopf(); }
    const ry = doc.y;
    if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 18).fill('#fafafa');
    doc.font('Helvetica').fontSize(8).fillColor('#222')
      .text(`${o.orderNum}`,                PDF_M+2,   ry+5, { width:30, lineBreak:false })
      .text(zeit(o.createdAt),                PDF_M+34,  ry+5, { width:62, lineBreak:false })
      .text(zeit(o.updatedAt || o.createdAt), PDF_M+98,  ry+5, { width:62, lineBreak:false })
      .text(zahlart(o),                       PDF_M+162, ry+5, { width:80, lineBreak:false, ellipsis:true })
      .text(grund(o),                         PDF_M+244, ry+5, { width:199, lineBreak:false, ellipsis:true });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#222')
      .text(pdfFmt(o.total||0), PDF_M+2, ry+5, { width:PDF_W-4, align:'right', lineBreak:false });
    doc.y = ry + 18;
    summe += (o.total||0);
  });
  if (doc.y > PDF_FT - 24) { doc.addPage(); doc.y = PDF_M; }
  const sy = doc.y;
  doc.save().fillOpacity(0.16).rect(PDF_M, sy, PDF_W, 20).fill('#9b2c2c').restore();
  doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Summe storniert (${stornos.length}, nicht im Umsatz):`, PDF_M+8, sy+5);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(pdfFmt(summe), PDF_M+2, sy+5, { width:PDF_W-4, align:'right' });
  doc.y = sy + 20 + 10;
}

// Abrechnung in Wochen- und Monatsbericht (Modell ab 17.11.2026, nur Direct Charges): Online-Zahlungen liegen
// vollstaendig auf dem eigenen Stripe-Konto des Ladens, Stripe zieht dort seine echte Gebuehr ab (gespeichert in
// stripeGebuehrCent, nichts geschaetzt). FlueVate behaelt nichts ein: Grundgebuehr (nur Monatsbericht), Domain und
// Servicegebuehr fuer alle Bestellungen gehen per Rechnung und SEPA-Lastschrift. Es gibt hier keine Auszahlung
// ueber Stripe, keine Ueberweisung an den Laden und keine Pauschale fuer Stripe-Gebuehren.
// Die Rechnung und die Mailtexte stehen in stripe-direkt.js (mit Tests).
const ABRECHNUNG_FIX = { sv: PDF_SV, grund: PDF_BASE, domain: PDF_DOMAIN };
function berichtAbrechnung(orders, mitFixkosten) {
  return stripeDirekt.berichtAbrechnung(orders, mitFixkosten, ABRECHNUNG_FIX);
}
const svcText = (n, betrag) => stripeDirekt.svcText(n, betrag, PDF_SV);

function pdfAbrechnung(doc, a) {
  let zebra = false;
  const zeile = (text, wert, bold = false) => {
    if (bold) doc.rect(PDF_M, doc.y, PDF_W, 20).fill('#e6ecf3');
    pdfTableRow(doc, [[text, PDF_M+8, PDF_W-110, 'left'], [wert, PDF_M+2, PDF_W-4, 'right']], zebra && !bold, bold);
    zebra = !zebra;
  };
  const block = titel => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#666').text(titel, PDF_M, doc.y + 8, { width: PDF_W });
    doc.y += 3; zebra = false;
  };
  const hinweis = text => {
    doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(text, PDF_M+8, doc.y + 4, { width: PDF_W-16 });
    doc.y += 2;
  };
  const minus = n => '– ' + pdfFmt(n); // Helvetica (WinAnsi) hat kein U+2212
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
  block('UMSATZ');
  zeile(`Barzahlung  (${a.nLaden} Bestellungen)`, pdfFmt(a.umsatzLaden));
  if (a.nOnline) zeile(`Online-Zahlung (Ihr Stripe-Konto)  (${a.nOnline} Bestellungen)`, pdfFmt(a.umsatzOnline));
  zeile('Gesamtumsatz', pdfFmt(a.brutto), true);
  if (a.nOnline) {
    // Das Geld liegt schon beim Laden; Stripe zieht seine Gebuehr dort ab
    if (doc.y > PDF_FT - 150) { doc.addPage(); doc.y = PDF_M; }
    block('IHR EIGENES STRIPE-KONTO');
    zeile(`Online-Umsatz  (${a.nOnline} Bestellungen)`, pdfFmt(a.umsatzOnline));
    zeile(stripeDirekt.stripeGebText(a), stripeDirekt.stripeGebWert(a, minus));
    zeile('Verbleibt auf Ihrem Stripe-Konto', pdfFmt(a.verbleibtStripe), true);
    hinweis(stripeDirekt.stripeHinweis(a));
  }
  if (doc.y > PDF_FT - 150) { doc.addPage(); doc.y = PDF_M; }
  block('GEBÜHREN FLUEVATE – PER RECHNUNG UND SEPA-LASTSCHRIFT');
  if (a.grund)  zeile('Grundgebühr (monatlich)', pdfFmt(a.grund));
  if (a.domain) zeile('Domain (monatlich)', pdfFmt(a.domain));
  zeile(`Servicegebühr  (${svcText(a.n, a.svc)})`, pdfFmt(a.svc));
  zeile('Wird per Rechnung und SEPA-Lastschrift eingezogen', pdfFmt(a.fluevate), true);
  hinweis(stripeDirekt.fluevateHinweis(a));
  block('BARZAHLUNG – LIEGT IN IHRER KASSE');
  zeile(`${a.nLaden} Bestellungen`, pdfFmt(a.umsatzLaden), true);
  doc.y += 8;
  const ay = doc.y;
  doc.rect(PDF_M, ay, PDF_W, 28).fill('#e8f5e9');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Ihnen bleiben nach allen Gebühren', PDF_M+10, ay+8, { width: PDF_W*0.65 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(a.bleibt), PDF_M+2, ay+8, { width: PDF_W-4, align: 'right' });
  doc.y = ay + 28 + 3;
  doc.font('Helvetica').fontSize(7.5).fillColor('#888')
    .text(`Kasse ${pdfFmt(a.umsatzLaden)}`
      + (a.nOnline ? ` + Stripe-Konto ${pdfFmt(a.verbleibtStripe)}` : '')
      + ` – Lastschrift FlueVate ${pdfFmt(a.fluevate)}`, PDF_M+10, doc.y, { width: PDF_W-20 });
  doc.y += 14;
}

// Dieselben Zahlen fuer die Mail an Inhaber (Tabellenzeilen) und an Abed (Fliesstext)
const abrechnungMailZeilen = a => stripeDirekt.abrechnungMailZeilen(a, ABRECHNUNG_FIX);
const abrechnungOwnerText  = a => stripeDirekt.abrechnungOwnerText(a);

function pdfBarRechnung(doc, barOrders, barStats, zeitraum) {
  if (!barOrders.length) return;
  doc.addPage(); doc.y = PDF_M;
  doc.rect(0, 0, PDF_PW, 50).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#fff').text('Bar-Zahlungen – Übersicht', PDF_M, 14);
  doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.7)').text(`FlueVate Online-Bestellsystem  ·  ${zeitraum}`, PDF_M, 33);
  doc.y = 62;
  const addrY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Anbieter:', PDF_M, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Abed Rachman Falah · FlueVate', PDF_M, addrY+12).text('Zur Goldbrede 30, 59269 Beckum', PDF_M, addrY+22);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Restaurant:', PDF_M+270, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Odi’s Bowl Ahaus', PDF_M+270, addrY+12).text('Wallstraße 7, 48683 Ahaus', PDF_M+270, addrY+22);
  doc.y = addrY + 38;
  doc.font('Helvetica').fontSize(8.5).fillColor('#888').text(`Zeitraum: ${zeitraum}`, PDF_M, doc.y);
  doc.y += 12;
  const hy = doc.y;
  doc.rect(PDF_M, hy, PDF_W, 16).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('Interne Übersicht – keine Rechnung. Nur Barzahlungen. Die Servicegebühren werden per Rechnung und SEPA-Lastschrift eingezogen.', PDF_M+6, hy+4, { width:PDF_W-12 });
  doc.y = hy + 16 + 6;
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const th = doc.y;
  doc.rect(PDF_M, th, PDF_W, 16).fill('#1a1a2e');
  [['#', PDF_M+2, 34, 'left'], ['Datum', PDF_M+38, 40, 'left'], ['Art', PDF_M+80, 170, 'left'],
   ['Umsatz', PDF_M+252, 64, 'right'], ['Servicegebühr', PDF_M+318, 118, 'right'], ['Gesamt', PDF_M+2, PDF_W-4, 'right']
  ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(h, x, th+4, { width:w, align:a }));
  doc.y = th + 16;
  barOrders.forEach((o, i) => {
    if (doc.y > PDF_FT - 20) { doc.addPage(); doc.y = PDF_M; }
    const sf   = o.serviceFee || PDF_SV;
    const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
    const art  = o.mode === 'lieferung' ? 'Lieferung' : 'Abholung';
    const ry = doc.y;
    if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 16).fill('#f8f9fc');
    doc.font('Helvetica').fontSize(8.5).fillColor('#222')
      .text(`${o.orderNum}`, PDF_M+2,  ry+4, { width:34 })
      .text(date,            PDF_M+38, ry+4, { width:40 })
      .text(art,             PDF_M+80, ry+4, { width:168 })
      .text(pdfFmt(o.total), PDF_M+252, ry+4, { width:64,  align:'right' })
      .text(pdfFmt(sf),      PDF_M+318, ry+4, { width:118, align:'right' });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1a1a2e').text(pdfFmt(sf), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
    doc.y = ry + 16;
  });
  // Summenblock (Linie, Servicegebuehren, Summe, Hinweis, ca. 80 pt) zusammenhalten
  if (doc.y > PDF_FT - 80) { doc.addPage(); doc.y = PDF_M; }
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const s1y = doc.y;
  doc.rect(PDF_M, s1y, PDF_W, 18).fill('#f0f4f8');
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Servicegebühren', PDF_M+8, s1y+5).text(`${barOrders.length} × ${pdfFmt(PDF_SV)}`, PDF_M+200, s1y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barSvc), PDF_M+2, s1y+5, { width:PDF_W-4, align:'right' });
  doc.y = s1y + 18 + 4;
  const gy = doc.y;
  doc.rect(PDF_M, gy, PDF_W, 30).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text('Summe Servicegebühren (Bar)', PDF_M+10, gy+9, { width:PDF_W*0.6 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffd700').text(pdfFmt(barStats.barBetrag), PDF_M+2, gy+8, { width:PDF_W-4, align:'right' });
  doc.y = gy + 30 + 8;
}

// Baut das Wochenbericht-PDF. Einzige Quelle fuer das Layout.
function buildWochenberichtPdf(doc, d) {
  const { kw, jahr, vonBis, orders, brutto, svcFees, auszahlung,
          barOrders, barSvc, barNetto, barBetrag } = d;

  pdfColorBox(doc, `Wochenbericht KW ${kw} / ${jahr}`, `Odi’s Bowl Ahaus  ·  ${vonBis}`, '#0a1e47');
  pdfKacheln(doc, [
    ['Bestellungen gesamt', `${orders.length}`,                                                   '#1a1a2e'],
    ['Davon Bar',           `${barOrders.length}`,                                                '#2c5282'],
    ['Davon Online',        `${orders.filter(o=>['stripe','paypal'].includes(o.payment)).length}`,'#276749'],
    ['Brutto-Umsatz',       pdfFmt(brutto),                                                       '#744210'],
  ]);
  doc.moveDown(0.4);
  pdfHr(doc);
  pdfAbrechnung(doc, berichtAbrechnung(orders, false));
  doc.y += 6;
  // Umsatzsteuer: nur die Summentabelle, die Einzelaufstellung steht im Monatsbericht
  if (d.ust) { pdfHr(doc, '#bbb'); pdfUstSumme(doc, d.ust, { hinweis: 'Aufstellung je Bestellung im Monatsbericht.' }); doc.y += 4; }
  pdfHr(doc, '#bbb');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('BESTELLLISTE', PDF_M, doc.y);
  doc.y += 12;
  pdfKundenliste(doc, orders);
  if (barOrders.length > 0) {
    pdfBarRechnung(doc, barOrders, { barSvc, barNetto, barBetrag }, vonBis);
  }
  // y=820 liegt unter dem Textbereich (791,9) - Rand kurz auf 0, sonst haengt pdfkit eine leere Seite an
  const _mb = doc.page.margins.bottom; doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(7).fillColor('#bbb')
    .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Wochenbericht KW ${kw} / ${jahr}`, PDF_M, doc.page.height - 28, { width: doc.page.width - 2 * PDF_M, align: 'center', lineBreak: false });
  doc.page.margins.bottom = _mb;
}

function getWeekNum(d) {
  const dt = new Date(d); dt.setHours(0,0,0,0);
  dt.setDate(dt.getDate()+3-(dt.getDay()+6)%7);
  const w1 = new Date(dt.getFullYear(),0,4);
  return 1+Math.round(((dt-w1)/86400000-3+(w1.getDay()+6)%7)/7);
}

// Baut den kompletten Monatsbericht. Einzige Quelle fuer das Layout -
// Cron und manueller Endpunkt rufen beide hier rein.
function buildMonatsberichtPdf(doc, d) {
  const { monat, vonBis, orders, brutto, svcFees, auszahlung,
          barOrdersM, barSvcM, barNettoM, barBetragM, weekRows, stornos = [] } = d;

  pdfColorBox(doc, `Monatsbericht ${monat}`, `Odi’s Bowl Ahaus  ·  ${vonBis}`, '#0a1e47');
  pdfKacheln(doc, [
    ['Bestellungen gesamt', `${orders.length}`,                                                   '#1a1a2e'],
    ['Davon Bar',           `${barOrdersM.length}`,                                               '#2c5282'],
    ['Davon Online',        `${orders.filter(o=>['stripe','paypal'].includes(o.payment)).length}`,'#276749'],
    ['Brutto-Umsatz',       pdfFmt(brutto),                                                       '#744210'],
  ]);
  doc.moveDown(0.4);
  pdfHr(doc);
  pdfAbrechnung(doc, berichtAbrechnung(orders, true));
  doc.y += 6;
  if (doc.y > PDF_FT - (weekRows.length * 20 + 40)) { doc.addPage(); doc.y = PDF_M; }
  pdfHr(doc, '#bbb');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('WOCHENÜBERSICHT', PDF_M, doc.y);
  doc.y += 14;
  // Spalte 1 endet bei PDF_M+8+70 = 128, Spalte 2 startet bei PDF_M+90 = 140.
  weekRows.forEach(([kw2, w], i) => {
    pdfTableRow(doc, [
      [`KW ${kw2}`,           PDF_M+8,  70,        'left'],
      [`${w.n} Bestellungen`, PDF_M+90, PDF_W-170, 'left'],
      [pdfFmt(w.brutto),      PDF_M+2,  PDF_W-4,   'right'],
    ], i % 2 === 1);
  });
  doc.y += 8;
  if (doc.y > PDF_FT - 130) { doc.addPage(); doc.y = PDF_M; }
  pdfHr(doc, '#bbb');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('BESTELLLISTE', PDF_M, doc.y);
  doc.y += 12;
  pdfKundenliste(doc, orders);
  pdfHr(doc, '#bbb');
  pdfStornoliste(doc, stornos);
  // Umsatzsteuer je Bestellung fuer den Steuerberater (eigene Seiten im Querformat)
  if (d.ust) pdfUmsatzsteuer(doc, d.ust, { monat, vonBis });
  if (barOrdersM.length > 0) {
    pdfBarRechnung(doc, barOrdersM, { barSvc: barSvcM, barNetto: barNettoM, barBetrag: barBetragM }, vonBis);
  }
  // y=820 liegt unter dem Textbereich (791,9) - Rand kurz auf 0, sonst haengt pdfkit eine leere Seite an
  const _mb = doc.page.margins.bottom; doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(7).fillColor('#bbb')
    .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Monatsbericht ${monat}`, PDF_M, doc.page.height - 28, { width: doc.page.width - 2 * PDF_M, align: 'center', lineBreak: false });
  doc.page.margins.bottom = _mb;
}
// ═══════════════════════════════════════════════════════════════
// UMSATZSTEUER (Regeln und Rechnung: umsatzsteuer.js)
// ═══════════════════════════════════════════════════════════════

// Beschriftung eines Steuersatzes: "7 %  Speisen" / "19 %  Getränke"
function ustSatzText(p, eintraege) {
  const s = eintraege && eintraege.length ? eintraege[eintraege.length - 1].ust.saetze : Ust.saetzeAm(new Date());
  return `${p} %` + (p === s.speisen ? '  Speisen' : p === s.getraenke ? '  Getränke' : '');
}

// (a) Summentabelle: Brutto, Netto, USt je Steuersatz und gesamt, darunter
// ausdruecklich die nicht eindeutig zugeordneten Bestellungen und Abweichungen.
// Fuer Tages-, Wochen- und Monatsbericht. opt: m, w, ft (Unterkante), neueSeite, hinweis.
function pdfUstSumme(doc, ust, opt = {}) {
  const m = opt.m ?? PDF_M, w = opt.w ?? PDF_W, ft = opt.ft ?? PDF_FT;
  const neueSeite = opt.neueSeite || (() => { doc.addPage(); doc.y = PDF_M; });
  const { summe, modus, eintraege } = ust;
  if (doc.y > ft - 150) neueSeite();
  const ty = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e')
    .text(opt.titel || 'UMSATZSTEUER (in den Beträgen enthalten)', m, ty, { width: w, lineBreak: false });
  doc.y = ty + 16;

  if (modus === 'kleinunternehmer') {
    const hy = doc.y;
    doc.rect(m, hy, w, 22).fill('#fef9e7');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#7a5c00').text(Ust.KLEINUNTERNEHMER_HINWEIS, m + 8, hy + 7, { width: w - 16, lineBreak: false });
    doc.y = hy + 22 + 8; doc.x = m;
    return;
  }

  // Spalten: Bezeichnung links, drei Betragsspalten rechtsbuendig
  const sp = [[m + 8, w - 340, 'left'], [m + w - 326, 100, 'right'], [m + w - 216, 100, 'right'], [m + w - 106, 100, 'right']];
  const zeile = (werte, { kopf = false, fett = false, grund = null } = {}) => {
    const y = doc.y, h = kopf ? 16 : 18;
    if (grund) doc.rect(m, y, w, h).fill(grund);
    werte.forEach((t, i) => {
      const [x, bw, a] = sp[i];
      doc.font(kopf || fett ? 'Helvetica-Bold' : 'Helvetica').fontSize(kopf ? 8 : 9)
        .fillColor(kopf ? '#444' : '#222').text(t, x, y + (kopf ? 4 : 5), { width: bw, align: a, lineBreak: false });
    });
    doc.y = y + h;
  };
  zeile(['Steuersatz', 'Brutto', 'Netto', 'Umsatzsteuer'], { kopf: true, grund: '#eaeef3' });
  const saetze = summe.nachSatz.length ? summe.nachSatz
    : (() => { const s = Ust.saetzeAm(new Date()); return [s.speisen, s.getraenke].map(satz => ({ satz, brutto: 0, netto: 0, ust: 0 })); })();
  saetze.forEach((r, i) => zeile([ustSatzText(r.satz, eintraege), pdfFmt(r.brutto), pdfFmt(r.netto), pdfFmt(r.ust)],
    { grund: i % 2 ? '#f5f7fa' : null }));
  zeile([`Gesamt  (${summe.anzahl} Bestellungen)`, pdfFmt(summe.brutto), pdfFmt(summe.netto), pdfFmt(summe.ust)],
    { fett: true, grund: '#e6ecf3' });

  // Hinweise - fliessender Text, darf umbrechen
  const hinweis = (text, farbe = '#666') => {
    doc.font('Helvetica').fontSize(7.5).fillColor(farbe);
    if (doc.y + doc.heightOfString(text, { width: w - 16 }) + 4 > ft) neueSeite();
    doc.text(text, m + 8, doc.y + 4, { width: w - 16 });
  };
  const u = summe.unklarBestellungen;
  if (u.length) {
    hinweis(`Nicht eindeutig zugeordnet (als Speisen mit dem ermäßigten Satz gerechnet): ${u.length} Bestellung${u.length > 1 ? 'en' : ''} – Nr. ${u.join(', ')}. Bitte prüfen.`, '#9b2c2c');
  } else if (summe.anzahl) {
    hinweis('Alle Positionen eindeutig aus der Speisekarte zugeordnet.');
  }
  if (summe.abweichungen.length) {
    hinweis('Gesamtbetrag weicht von Positionen + Gebühren - Rabatt ab (aufgeteilt wurde der tatsächliche Gesamtbetrag): '
      + summe.abweichungen.map(a => `Nr. ${a.orderNum} (${a.totalFehlt ? 'Gesamtbetrag fehlt' : (a.betrag > 0 ? '+' : '') + pdfFmt(a.betrag)})`).join(', ') + '.', '#9b2c2c');
  }
  if (opt.hinweis) hinweis(opt.hinweis);
  doc.y += 6; doc.x = m;
}

// Umsatzsteuer-Teil des Monatsberichts: eigene Seiten im Querformat mit
// (a) Summentabelle, (b) jeder Bestellung des Zeitraums, (c) Methode als Fussnote.
// Spaltenkoepfe stehen auf jeder Seite.
function pdfUmsatzsteuer(doc, ust, { monat, vonBis }) {
  const { eintraege, summe, modus } = ust;
  const quer = () => { doc.addPage({ size: 'A4', layout: 'landscape', margin: PDF_M }); doc.y = PDF_M; doc.x = PDF_M; };
  quer();
  const m = PDF_M, PW = doc.page.width, w = PW - 2 * PDF_M;
  const ft = doc.page.height - PDF_M - 2;   // 543: darunter bricht pdfkit selbst um

  doc.rect(0, 0, PW, 50).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#fff').text('Umsatzsteuer je Bestellung', m, 13, { lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor('#ffffff', 0.75)
    .text(`Odi’s Bowl Ahaus  ·  ${monat}  ·  ${vonBis}  ·  ohne stornierte Bestellungen`, m, 33, { lineBreak: false });
  doc.fillOpacity(1);
  doc.y = 64;

  pdfUstSumme(doc, ust, { m, w: 480, ft, neueSeite: quer, titel: 'SUMMEN NACH STEUERSATZ' });
  if (modus === 'kleinunternehmer') return;

  // (b) Liste jeder Bestellung
  const b = Ust.satzBeschriftung(eintraege);
  const geld = 7, gx = m + 242, gw = (w - 242) / geld;
  const spalten = [
    ['Nr.', m + 3, 42, 'left'], ['Datum', m + 47, 66, 'left'], ['Art', m + 115, 52, 'left'], ['Zahlart', m + 169, 71, 'left'],
    ...['Brutto gesamt', `Brutto ${b.s}`, `Netto ${b.s}`, `USt ${b.s}`, `Brutto ${b.g}`, `Netto ${b.g}`, `USt ${b.g}`]
      .map((t, i) => [t, gx + i * gw, gw - 4, 'right']),
  ];
  const H = 14;
  const kopf = () => {
    const hy = doc.y;
    doc.rect(m, hy, w, 17).fill('#1a1a2e');
    doc.rect(gx + gw, hy, 3 * gw, 17).fill('#2c5282');        // Speisen-Satz
    doc.rect(gx + 4 * gw, hy, 3 * gw, 17).fill('#276749');    // Getraenke-Satz
    spalten.forEach(([t, x, bw, a]) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(t, x, hy + 5, { width: bw, align: a, lineBreak: false }));
    doc.y = hy + 17;
  };
  const zelle = (werte, y, fett) => werte.forEach((t, i) => {
    const [, x, bw, a] = spalten[i];
    doc.font(fett ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor('#222')
      .text(t, x, y + 4, { width: bw, align: a, lineBreak: false, ellipsis: true });
  });
  const z = n => (Number(n) || 0).toFixed(2).replace('.', ',');
  const kurzDatum = d => new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');

  if (doc.y > ft - 80) quer();
  const ly = doc.y + 4;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ALLE BESTELLUNGEN DES ZEITRAUMS', m, ly, { lineBreak: false });
  doc.y = ly + 16;
  kopf();
  if (!eintraege.length) {
    doc.font('Helvetica').fontSize(8.5).fillColor('#555').text('Keine Bestellungen im Zeitraum.', m + 8, doc.y + 4, { lineBreak: false });
    doc.y += H + 4;
  }
  eintraege.forEach(({ order: o, ust: u }, i) => {
    if (doc.y > ft - (i === eintraege.length - 1 ? H + 20 : H)) { quer(); kopf(); }
    const ry = doc.y;
    if (i % 2 === 0) doc.rect(m, ry, w, H).fill('#f5f7fa');
    const marke = (u.unklar && u.unklar.length ? ' *' : '') + (Ust.cent(u.abweichung) !== 0 || u.totalFehlt ? ' !' : '');
    zelle([`${o.orderNum ?? '–'}${marke}`, kurzDatum(o.createdAt), Ust.artText(o),
      Ust.zahlartText(o) + (o.paymentStatus === 'refunded' ? ', erstattet' : ''),
      z(u.brutto7 + u.brutto19), z(u.brutto7), z(u.netto7), z(u.ust7), z(u.brutto19), z(u.netto19), z(u.ust19)], ry, false);
    doc.y = ry + H;
  });
  // Summenzeile: aus denselben gerundeten Einzelwerten wie die Zeilen darueber
  if (doc.y > ft - 20) { quer(); kopf(); }
  const sy = doc.y;
  doc.rect(m, sy, w, 18).fill('#e6ecf3');
  zelle(['', '', '', '', z(summe.brutto), z(summe.brutto7), z(summe.netto7), z(summe.ust7),
    z(summe.brutto19), z(summe.netto19), z(summe.ust19)], sy + 2, true);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#222')
    .text(`Summe (${summe.anzahl} Bestellungen)`, m + 3, sy + 6, { width: 160, lineBreak: false });
  doc.y = sy + 18 + 8;

  // (c) Methode und Legende
  const fuss = 'Beträge in Euro, brutto = einschließlich Umsatzsteuer. * = mindestens eine Position nicht eindeutig zugeordnet '
    + '(als Speise gerechnet), ! = Gesamtbetrag weicht von Positionen + Gebühren - Rabatt ab (aufgeteilt wurde der tatsächliche Gesamtbetrag). '
    + 'Methode: ' + Ust.METHODE_TEXT;
  doc.font('Helvetica').fontSize(7.5).fillColor('#555');
  if (doc.y + doc.heightOfString(fuss, { width: w }) > ft) quer();
  doc.text(fuss, m, doc.y, { width: w });
  doc.x = m;
}

// ═══════════════════════════════════════════════════════════════
// MONATSBERICHT: Kennzahlen, PDF und CSV aus den Bestellungen
// ═══════════════════════════════════════════════════════════════
// Rein rechnerisch - die Abfrage und der Versand stehen in server.js
// (monatsberichtVersenden). ust = Ust.auswerten(orders, karte, modus).
function monatsberichtDaten({ monat, vonBis, orders, stornos = [], ust }) {
  const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
  const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const auszahlung = brutto - svcFees;
  const a          = berichtAbrechnung(orders, true);
  const barOrdersM = orders.filter(o => o.payment === 'bar');
  const barSvcM    = barOrdersM.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const barNettoM  = barOrdersM.reduce((s,o) => s+(o.total||0), 0) - barSvcM;
  const barBetragM = barSvcM;
  const weeksMap = {};
  orders.forEach(o => {
    const kw2 = getWeekNum(new Date(o.createdAt));
    if (!weeksMap[kw2]) weeksMap[kw2] = { n: 0, brutto: 0 };
    weeksMap[kw2].n++;
    weeksMap[kw2].brutto += o.total || 0;
  });
  const weekRows = Object.entries(weeksMap).sort((x, y) => +x[0] - +y[0]);
  return { monat, vonBis, orders, stornos, brutto, svcFees, auszahlung, a,
           barOrdersM, barSvcM, barNettoM, barBetragM, weekRows, ust };
}

async function monatsberichtErstellen(d) {
  const monatsPdf = await generatePdf(doc => buildMonatsberichtPdf(doc, d));
  return {
    monatsPdf,
    pdfName: `${d.monat.replace(' ','_')}_Odi’s Bowl Ahaus_Monatsbericht.pdf`,
    csv:     Buffer.from(Ust.csvUmsaetze(d.ust), 'utf8'),
    csvName: Ust.csvDateiname(d.monat),
  };
}

module.exports = {
  generatePdf, PDF_SV, pdfFmt,
  berichtAbrechnung, abrechnungMailZeilen, abrechnungOwnerText,
  buildWochenberichtPdf, buildMonatsberichtPdf, getWeekNum,
  pdfUstSumme, pdfUmsatzsteuer, monatsberichtDaten, monatsberichtErstellen,
};
