// Umsatzsteuer je Bestellung (umsatzsteuer.js) und ihr Teil im Monatsbericht
// (berichte-pdf.js). Läuft ohne Datenbank und ohne .env: npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');
const Ust    = require('../umsatzsteuer');

// Kleine Testkarte im Aufbau von Menue/menu.json - feste Preise, damit die von
// Hand gerechneten Beispiele unten nicht von Kartenänderungen abhängen.
const KARTE = Ust.karteAusMenu({
  _listen: { getraenke: ['Coca-Cola Original', 'Coca-Cola Zero', 'Töftes Mineralwasser Still'] },
  kategorien: [
    { id: 'zusammenstellen', items: [
      { num: 'B1', name: 'Bowl', preis: 12.9, menue: 2 },
      { num: 'W1', name: 'Wrap', preis: 8.9, menue: 2 },
      { num: 'A1', name: 'Açaí-Bowl', groessen: { Classic: 7.9, Large: 8.9 } },
    ] },
    { id: 'getraenke', items: [
      { num: 'G1', name: 'Coca-Cola Original', preis: 2.9 },
      { num: 'G2', name: 'Coca-Cola Zero', preis: 2.9 },
      { num: 'G10', name: 'Töftes Mineralwasser Still', preis: 2.9 },
    ] },
  ],
});
const ECHTE_KARTE = Ust.karteAusMenu(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'Menue', 'menu.json'), 'utf8')));

const NOV = new Date('2026-11-19T12:00:00+01:00');
const pos = (name, price, qty = 1, extraDetails = []) => ({ name, price, qty, extraDetails });
const bowlMenue = (getraenk = 'Coca-Cola Zero', extra = 0) => pos('Bowl (Menü)', 12.9 + extra + 2, 1, [
  { name: 'Basic: Basmati-Reis', price: 0 },
  ...(extra ? [{ name: 'Gemüse & Obst: Mais, Gurken, Kimchi, Edamame, Paprika, Rotkohl', price: extra }] : []),
  { name: `Getränk: ${getraenk}`, price: 2 },
]);
// Bestellung wie der Server sie speichert: total = Waren + Gebühren - Rabatt
function bestellung(items, { deliveryFee = 0, serviceFee = 0.99, discount = 0, total, orderNum = 1001, createdAt = NOV } = {}) {
  const waren = items.reduce((s, i) => s + Math.round(i.price * 100) * i.qty, 0) / 100;
  const t = total !== undefined ? total : Math.round((waren + deliveryFee + serviceFee - discount) * 100) / 100;
  return { orderNum, createdAt, items, subtotal: waren, deliveryFee, serviceFee, discount, total: t, mode: deliveryFee ? 'lieferung' : 'abholung', payment: 'bar', status: 'delivered', paymentStatus: 'paid' };
}
const c = Ust.cent;
// Grundeigenschaften, die für jede Aufteilung gelten müssen
function pruefeStimmig(r, order) {
  assert.equal(c(r.brutto7) + c(r.brutto19), c(order.total), 'Brutto 7 + Brutto 19 = total');
  assert.equal(c(r.netto7) + c(r.ust7), c(r.brutto7), 'Netto + USt = Brutto (7)');
  assert.equal(c(r.netto19) + c(r.ust19), c(r.brutto19), 'Netto + USt = Brutto (19)');
  assert.equal(c(r.netto7), Math.round(c(r.brutto7) * 100 / 107), 'Netto 7 = Brutto / 1,07 kaufmännisch gerundet');
  assert.equal(c(r.netto19), Math.round(c(r.brutto19) * 100 / 119), 'Netto 19 = Brutto / 1,19 kaufmännisch gerundet');
  for (const k of ['brutto7', 'netto7', 'ust7', 'brutto19', 'netto19', 'ust19']) {
    assert.ok(Number.isInteger(Math.round(r[k] * 100)) && Math.abs(r[k] * 100 - Math.round(r[k] * 100)) < 1e-6, `${k} auf Cent`);
  }
}

test('reine Speisenbestellung: alles 7 %', () => {
  // 2 × Wrap 8,90 + Servicegebühr 0,99 = 18,79; 18,79 / 1,07 = 17,5607 → 17,56; USt 1,23
  const o = bestellung([pos('Wrap', 8.9, 2, [{ name: 'Basic: Krautsalat', price: 0 }])]);
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.deepEqual([r.brutto7, r.netto7, r.ust7, r.brutto19, r.netto19, r.ust19], [18.79, 17.56, 1.23, 0, 0, 0]);
  assert.deepEqual(r.unklar, []);
  assert.equal(r.abweichung, 0);
  assert.deepEqual(r.saetze, { speisen: 7, getraenke: 19 });
});

test('reine Getränkebestellung: alles 19 %, auch die Servicegebühr', () => {
  // 2 × Cola 2,90 + 0,99 = 6,79; 6,79 / 1,19 = 5,7059 → 5,71; USt 1,08
  const o = bestellung([pos('Coca-Cola Original', 2.9, 2)]);
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.deepEqual([r.brutto7, r.brutto19, r.netto19, r.ust19], [0, 6.79, 5.71, 1.08]);
});

test('gemischt: Gebühr im Verhältnis der Warenumsätze', () => {
  // Bowl 12,90 + Cola 2,90 = Waren 15,80; total 16,79.
  // Getränkeanteil 2,90/15,80 → 16,79 × 0,183544 = 3,0817 → 3,08; Speisen 13,71.
  // 13,71 / 1,07 = 12,8131 → 12,81 (USt 0,90); 3,08 / 1,19 = 2,5882 → 2,59 (USt 0,49)
  const o = bestellung([pos('Bowl', 12.9), pos('Coca-Cola Zero', 2.9)]);
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.deepEqual([r.brutto7, r.netto7, r.ust7, r.brutto19, r.netto19, r.ust19], [13.71, 12.81, 0.9, 3.08, 2.59, 0.49]);
});

test('Menü: Aufteilung im Verhältnis der Einzelverkaufspreise', () => {
  // Von Hand: Bowl (Menü) 14,90 = Bowl 12,90 + Menü-Aufpreis 2,00 (Getränk Coca-Cola Zero).
  // Einzelpreise: Gericht 12,90 (Positionspreis ohne Menü-Aufpreis), Getränk 2,90 → Summe 15,80.
  // Getränkeanteil der Position: 14,90 × 2,90 / 15,80 = 2,7348; Speisen 12,1652.
  // Mit Servicegebühr total 15,89; Getränkeanteil 2,90/15,80 = 0,183544
  //   Brutto 19 = 15,89 × 0,183544 = 2,9165 → 2,92;  Netto 2,92 / 1,19 = 2,4538 → 2,45; USt 0,47
  //   Brutto 7  = 15,89 - 2,92     = 12,97;          Netto 12,97 / 1,07 = 12,1215 → 12,12; USt 0,85
  const o = bestellung([bowlMenue('Coca-Cola Zero')]);
  assert.equal(o.total, 15.89);
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.deepEqual([r.brutto7, r.netto7, r.ust7, r.brutto19, r.netto19, r.ust19], [12.97, 12.12, 0.85, 2.92, 2.45, 0.47]);
  assert.deepEqual(r.unklar, []);
});

test('Menü mit übrigen Aufpreisen: die zählen zum Gericht', () => {
  // Bowl (Menü) 15,90 = 12,90 + Gemüse 1,00 + Menü 2,00 → Gericht 13,90, Getränk 2,90 (Summe 16,80)
  // ohne Gebühr (serviceFee 0): Brutto 19 = 15,90 × 2,90/16,80 = 2,7446 → 2,74; Brutto 7 = 13,16
  const o = bestellung([bowlMenue('Coca-Cola Zero', 1)], { serviceFee: 0 });
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.deepEqual([r.brutto7, r.brutto19], [13.16, 2.74]);
});

test('Menü mit Liefergebühr und Servicegebühr', () => {
  // Bowl (Menü) 15,90 (wie oben) + Liefergebühr 2,50 + Servicegebühr 0,99 = 19,39
  // Brutto 19 = 19,39 × 2,90/16,80 = 3,3471 → 3,35; Netto 3,35/1,19 = 2,8151 → 2,82; USt 0,53
  // Brutto 7  = 19,39 - 3,35 = 16,04;               Netto 16,04/1,07 = 14,9907 → 14,99; USt 1,05
  const o = bestellung([bowlMenue('Coca-Cola Zero', 1)], { deliveryFee: 2.5 });
  assert.equal(o.total, 19.39);
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.deepEqual([r.brutto7, r.netto7, r.ust7, r.brutto19, r.netto19, r.ust19], [16.04, 14.99, 1.05, 3.35, 2.82, 0.53]);
});

test('Rabatt wird wie die Gebühren im Warenverhältnis verteilt', () => {
  // Bowl 12,90 + Cola 2,90 - Rabatt 1,58 + 0,99 = 15,21
  // Brutto 19 = 15,21 × 2,90/15,80 = 2,7917 → 2,79; Brutto 7 = 12,42
  const o = bestellung([pos('Bowl', 12.9), pos('Coca-Cola Original', 2.9)], { discount: 1.58 });
  assert.equal(o.total, 15.21);
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.deepEqual([r.brutto7, r.brutto19], [12.42, 2.79]);
  assert.equal(r.abweichung, 0);
});

test('Mengen größer 1, auch beim Menü', () => {
  // 3 × Wrap (Menü) à 10,90 mit Wasser: Gericht 8,90, Getränk 2,90 (Summe 11,80); Zeile 32,70
  // + 2 × Cola 2,90 = 5,80; Waren 38,50; Getränke 32,70×2,90/11,80 + 5,80 = 8,0364 + 5,80 = 13,8364
  // total 39,49: Brutto 19 = 39,49 × 13,8364/38,50 = 14,1923 → 14,19; Brutto 7 = 25,30
  const menue = pos('Wrap (Menü)', 10.9, 3, [{ name: 'Basic: Krautsalat', price: 0 }, { name: 'Getränk: Töftes Mineralwasser Still', price: 2 }]);
  const o = bestellung([menue, pos('Coca-Cola Original', 2.9, 2)]);
  assert.equal(o.total, 39.49);
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.deepEqual([r.brutto7, r.brutto19], [25.3, 14.19]);
});

test('Zuordnung über den Namensanfang, Artikelnummer und Groß/klein egal', () => {
  assert.equal(Ust.finde(KARTE, 'Açaí-Bowl Classic').name, 'Açaí-Bowl');   // nicht "Bowl"
  assert.equal(Ust.finde(KARTE, 'Bowl (Menü)').name, 'Bowl');
  assert.equal(Ust.finde(KARTE, 'G1 Coca-Cola Original').art, 'getraenk');
  assert.equal(Ust.finde(KARTE, 'coca-cola  zero').name, 'Coca-Cola Zero');
  assert.equal(Ust.finde(KARTE, 'Bowlinger'), null);                         // kein Wortende
  assert.equal(Ust.finde(KARTE, 'Coca Cola 0,33 L'), null);                  // alte Vorlage, nicht in der Karte
});

test('echte Karte: jedes Getränk 19 %, Bowl/Wrap/Açaí 7 %, Menü wird geteilt', () => {
  const karte = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'Menue', 'menu.json'), 'utf8'));
  const getraenke = new Set([...(karte._listen.getraenke || []),
    ...karte.kategorien.filter(k => k.id === 'getraenke').flatMap(k => k.items.map(i => i.name))]);
  assert.ok(getraenke.size > 0);
  for (const name of getraenke) assert.equal(Ust.finde(ECHTE_KARTE, name)?.art, 'getraenk', name);
  for (const name of ['Bowl', 'Wrap', 'Açaí-Bowl Classic', 'Açaí-Bowl Large', 'Bowl (Menü)', 'Wrap (Menü)']) {
    assert.equal(Ust.finde(ECHTE_KARTE, name)?.art, 'speise', name);
  }
  for (const g of getraenke) {
    const o = bestellung([bowlMenue(g)]);
    const r = Ust.aufteilen(o, ECHTE_KARTE);
    pruefeStimmig(r, o);
    assert.deepEqual(r.unklar, [], g);
    assert.ok(r.brutto19 > 0 && r.brutto7 > r.brutto19, g);
  }
});

test('nicht zuordenbare Position: 7 % und als unklar markiert', () => {
  const o = bestellung([pos('Pizza Margherita', 8.5), pos('Coca-Cola Zero', 2.9)], { orderNum: 1077 });
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.equal(r.unklar.length, 1);
  assert.equal(r.unklar[0].name, 'Pizza Margherita');
  // Pizza zählt als Speise: Waren 11,40, Getränkeanteil 2,90/11,40; total 12,39 → 3,1518 → 3,15
  assert.equal(r.brutto19, 3.15);
  const s = Ust.summieren([r, Ust.aufteilen(bestellung([pos('Bowl', 12.9)], { orderNum: 1078 }), KARTE)]);
  assert.deepEqual(s.unklarBestellungen, [1077]);
  assert.match(Ust.hinweisText(r), /nicht eindeutig zugeordnet: Pizza Margherita/);
});

test('Menü mit Getränk, das nicht (mehr) in der Karte steht: ganz 7 % und unklar', () => {
  const o = bestellung([bowlMenue('Fanta')]);
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.equal(r.brutto19, 0);
  assert.match(r.unklar[0].grund, /Fanta/);
});

test('Abweichung zwischen total und Positionen wird ausgewiesen, Summe bleibt total', () => {
  const o = bestellung([pos('Bowl', 12.9), pos('Coca-Cola Zero', 2.9)], { total: 17.29 });   // rechnerisch 16,79
  const r = Ust.aufteilen(o, KARTE);
  pruefeStimmig(r, o);
  assert.equal(r.abweichung, 0.5);
  const s = Ust.summieren([r]);
  assert.deepEqual(s.abweichungen, [{ orderNum: 1001, betrag: 0.5, totalFehlt: false }]);
  assert.match(Ust.hinweisText(r), /weicht um \+0,50 €/);
});

test('Bestellung ohne items', () => {
  const leer = Ust.aufteilen({ orderNum: 5, total: 0 }, KARTE);
  assert.deepEqual([leer.brutto7, leer.brutto19, leer.ust7, leer.ust19], [0, 0, 0, 0]);
  assert.deepEqual(leer.unklar, []);
  const nurGebuehr = { orderNum: 6, items: [], serviceFee: 0.99, total: 0.99, createdAt: NOV };
  const r = Ust.aufteilen(nurGebuehr, KARTE);
  pruefeStimmig(r, nurGebuehr);
  assert.equal(r.brutto7, 0.99);
  assert.equal(r.unklar.length, 1);
  // gar nichts brauchbares: wirft nicht
  assert.doesNotThrow(() => Ust.ausBestellung(null, KARTE));
  assert.doesNotThrow(() => Ust.ausBestellung({ items: 'kaputt', total: 'x' }, null));
});

test('Rundung: viele zufällige, fest geseedete Bestellungen gehen auf den Cent auf', () => {
  let seed = 20261119;
  const zufall = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const wahl = a => a[Math.floor(zufall() * a.length)];
  const alle = [];
  for (let n = 0; n < 3000; n++) {
    const items = [];
    const k = 1 + Math.floor(zufall() * 5);
    for (let j = 0; j < k; j++) {
      const art = zufall();
      const qty = 1 + Math.floor(zufall() * 4);
      if (art < 0.3) items.push(pos('Coca-Cola Zero', 2.9, qty));
      else if (art < 0.6) items.push({ ...bowlMenue(wahl(['Coca-Cola Original', 'Töftes Mineralwasser Still']), Math.floor(zufall() * 7) * 0.5 + wahl([0, 1.37, 2.5])), qty });
      else items.push(pos(wahl(['Bowl', 'Wrap', 'Açaí-Bowl Large']), Math.round((7 + zufall() * 10) * 100) / 100, qty));
    }
    const o = bestellung(items, { orderNum: 2000 + n,
      deliveryFee: wahl([0, 1.5, 2.5, 5.5]), serviceFee: wahl([0, 0.99]), discount: wahl([0, 0, 0, 0.37, 1.99]) });
    const r = Ust.aufteilen(o, KARTE);
    pruefeStimmig(r, o);
    assert.equal(r.abweichung, 0);
    alle.push(r);
  }
  // Summe = Summe der gerundeten Einzelwerte, und Brutto gesamt = Summe aller totals
  const s = Ust.summieren(alle);
  const ct = f => alle.reduce((x, r) => x + c(r[f]), 0);
  for (const f of ['brutto7', 'netto7', 'ust7', 'brutto19', 'netto19', 'ust19']) assert.equal(c(s[f]), ct(f), f);
  assert.equal(c(s.brutto), ct('brutto7') + ct('brutto19'));
  assert.equal(s.anzahl, 3000);
});

test('Summen über mehrere Bestellungen, auch nach Steuersatz', () => {
  const a = Ust.aufteilen(bestellung([pos('Wrap', 8.9, 2)], { orderNum: 1 }), KARTE);          // 18,79 / 0
  const b = Ust.aufteilen(bestellung([pos('Coca-Cola Original', 2.9, 2)], { orderNum: 2 }), KARTE); // 0 / 6,79
  const m = Ust.aufteilen(bestellung([bowlMenue('Coca-Cola Zero')], { orderNum: 3 }), KARTE);    // 12,97 / 2,92
  const s = Ust.summieren([a, b, m]);
  assert.equal(s.anzahl, 3);
  assert.equal(s.brutto7, 31.76);
  assert.equal(s.brutto19, 9.71);
  assert.equal(s.netto7, 17.56 + 12.12);
  assert.equal(s.ust19, 1.08 + 0.47);
  assert.equal(s.brutto, 41.47);
  assert.deepEqual(s.nachSatz.map(x => x.satz), [7, 19]);
  assert.equal(s.nachSatz[0].brutto, s.brutto7);
  assert.equal(s.nachSatz[1].ust, s.ust19);
  assert.deepEqual(Ust.summieren([]).nachSatz, []);
});

test('Satz nach Bestelldatum: ein späterer Satzwechsel ist ein Eintrag', () => {
  assert.deepEqual(Ust.saetzeAm(new Date('2020-05-01')), { speisen: 7, getraenke: 19 });   // vor dem ersten Stichtag
  Ust.STEUERSAETZE.push({ gueltigAb: '2099-01-01', speisen: 10, getraenke: 20 });
  try {
    const neu = bestellung([pos('Bowl', 12.9), pos('Coca-Cola Zero', 2.9)], { createdAt: new Date('2099-01-01T00:30:00+01:00') });
    const alt = bestellung([pos('Bowl', 12.9), pos('Coca-Cola Zero', 2.9)], { createdAt: new Date('2098-12-31T23:30:00+01:00') });
    const rn = Ust.aufteilen(neu, KARTE), ra = Ust.aufteilen(alt, KARTE);
    assert.deepEqual(rn.saetze, { speisen: 10, getraenke: 20 });
    assert.deepEqual(ra.saetze, { speisen: 7, getraenke: 19 });
    assert.equal(c(rn.netto7), Math.round(c(rn.brutto7) * 100 / 110));
    const s = Ust.summieren([rn, ra]);
    assert.deepEqual(s.nachSatz.map(x => x.satz), [7, 10, 19, 20]);
  } finally { Ust.STEUERSAETZE.pop(); }
});

test('Kleinunternehmer: kein Steuerausweis, sondern § 19-Hinweis', () => {
  assert.equal(Ust.ustModus({}), 'regel');
  assert.equal(Ust.ustModus({ UST_MODUS: ' Kleinunternehmer ' }), 'kleinunternehmer');
  assert.equal(Ust.ustModus({ UST_MODUS: 'quatsch' }), 'regel');
  const r = Ust.aufteilen(bestellung([pos('Bowl', 12.9)]), KARTE);
  assert.equal(Ust.mailZeile(r, 'kleinunternehmer'), 'Kein Ausweis von Umsatzsteuer (§ 19 UStG)');
  assert.equal(Ust.mailZeile(r, 'regel'), 'Enthaltene Umsatzsteuer: 7 % 0,91 €, 19 % 0,00 €');
  const o = bestellung([pos('Bowl', 12.9)]);
  const csv = Ust.csvUmsaetze(Ust.auswerten([o], KARTE, 'kleinunternehmer'));
  assert.doesNotMatch(csv, /USt \d|Netto/);
  assert.match(csv, /§ 19 UStG/);
});

test('gespeicherte Aufteilung wird verwendet, unstimmige nachgerechnet', () => {
  const o = bestellung([pos('Bowl', 12.9), pos('Coca-Cola Zero', 2.9)]);
  const gespeichert = { ...Ust.aufteilen(o, KARTE), unklar: [{ name: 'X', grund: 'damals unklar' }] };
  const r = Ust.ausBestellung({ ...o, umsatzsteuer: gespeichert }, KARTE);
  assert.equal(r.gespeichert, true);
  assert.equal(r.unklar[0].name, 'X');      // der Stand vom Bestelltag zählt
  const kaputt = Ust.ausBestellung({ ...o, umsatzsteuer: { ...gespeichert, brutto7: 1 } }, KARTE);
  assert.equal(kaputt.gespeichert, undefined);
  pruefeStimmig(kaputt, o);
});

test('CSV: BOM, Semikolon, Dezimalkomma, Summenzeile passt zu den Zeilen', () => {
  const orders = [
    bestellung([bowlMenue('Coca-Cola Zero', 1)], { deliveryFee: 2.5, orderNum: 1101 }),
    bestellung([pos('Wrap', 8.9, 2), pos('Coca-Cola Original', 2.9)], { orderNum: 1100, createdAt: new Date('2026-11-02T18:05:00+01:00') }),
  ];
  const aus = Ust.auswerten(orders, KARTE, 'regel');
  assert.deepEqual(aus.eintraege.map(e => e.order.orderNum), [1100, 1101]);   // nach Bestellzeit
  const csv = Ust.csvUmsaetze(aus);
  assert.ok(csv.startsWith('﻿'));
  const zeilen = csv.slice(1).trim().split('\r\n').map(z => z.split(';'));
  assert.equal(zeilen.length, 4);
  assert.deepEqual(zeilen[0].slice(0, 12), ['Nr.', 'Datum', 'Uhrzeit', 'Art', 'Zahlart', 'Brutto gesamt',
    'Brutto 7 %', 'Netto 7 %', 'USt 7 %', 'Brutto 19 %', 'Netto 19 %', 'USt 19 %']);
  assert.deepEqual(zeilen[1].slice(0, 6), ['1100', '02.11.2026', '18:05', 'Abholung', 'Bar', '21,69']);
  const zahl = s => Math.round(Number(s.replace(',', '.')) * 100);
  for (let sp = 5; sp <= 12; sp++) {
    assert.equal(zahl(zeilen[3][sp]), zahl(zeilen[1][sp]) + zahl(zeilen[2][sp]), `Spalte ${zeilen[0][sp]}`);
  }
  assert.equal(zeilen[2][5], '19,39');
  assert.equal(zeilen[2][9], '3,35');
  assert.equal(Ust.csvDateiname('März 2026'), 'Umsaetze_Maerz_2026.csv');
  assert.equal(Ust.csvDateiname('November 2026'), 'Umsaetze_November_2026.csv');
});

test('umsatzsteuer gehört zu den Feldern, die nur der Server setzt', () => {
  const { GESPERRTE_FELDER, webBestellungAusRequest } = require('../bestellung');
  assert.ok(GESPERRTE_FELDER.includes('umsatzsteuer'));
  const { felder } = webBestellungAusRequest({ payment: 'bar', umsatzsteuer: { brutto7: 0 } });
  assert.equal('umsatzsteuer' in felder, false);
});

test('Monatsbericht-PDF und CSV lassen sich ohne Datenbank bauen', async () => {
  const Berichte = require('../berichte-pdf');
  const orders = [];
  for (let i = 0; i < 70; i++) {
    orders.push(bestellung(i % 3 ? [bowlMenue('Coca-Cola Original', i % 4)] : [pos('Wrap', 8.9), pos('Pizza alt', 7)],
      { orderNum: 1200 + i, deliveryFee: i % 2 ? 2.5 : 0, createdAt: new Date(Date.UTC(2026, 10, 1 + (i % 28), 12)) }));
  }
  for (const modus of ['regel', 'kleinunternehmer']) {
    const d = Berichte.monatsberichtDaten({ monat: 'November 2026', vonBis: '01.11.2026 – 30.11.2026', orders, stornos: [],
      ust: Ust.auswerten(orders, KARTE, modus) });
    const r = await Berichte.monatsberichtErstellen(d);
    assert.equal(r.monatsPdf.subarray(0, 4).toString(), '%PDF');
    assert.equal(r.csvName, 'Umsaetze_November_2026.csv');
    assert.equal(r.csv.subarray(0, 3).toString('hex'), 'efbbbf');   // UTF-8-BOM
  }
  // auch ein leerer Monat
  const leer = Berichte.monatsberichtDaten({ monat: 'Dezember 2026', vonBis: '–', orders: [], stornos: [], ust: Ust.auswerten([], KARTE, 'regel') });
  assert.equal((await Berichte.monatsberichtErstellen(leer)).monatsPdf.subarray(0, 4).toString(), '%PDF');
});
