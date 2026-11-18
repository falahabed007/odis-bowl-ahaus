// Lieferung nach Fahrstrecke und "Açaí nur im Laden" (liefergebiet.js,
// lieferung.js). Läuft ohne Datenbank und ohne .env: npm test
//
// Regeln (Abed, 17.11.2026 abends), ab Wallstraße 7:
//   bis 2 km 1,50 € / MBW 20 €, über 2 bis 5 km 2,50 € / MBW 20 €,
//   über 5 bis 9 km 5,50 € / MBW 40 €, über 9 km keine Lieferung.
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const Liefergebiet = require('../liefergebiet');
const { erstellePruefer } = require('../lieferung');

const WURZEL = path.join(__dirname, '..');
const echteDaten = JSON.parse(fs.readFileSync(path.join(WURZEL, 'liefergebiet.json'), 'utf8'));
const menu = JSON.parse(fs.readFileSync(path.join(WURZEL, 'Menue', 'menu.json'), 'utf8'));

// Kleines Liefergebiet mit Strecken genau auf und knapp hinter den Grenzen.
// Einheit 1 m, damit "knapp darüber" 1 m sein kann.
function testDaten() {
  return {
    einheit_m: 1,
    zonen: echteDaten.zonen,
    strassen: {
      'Grenzweg':      { '1': 2000, '2': 2001, '3': 5000, '4': 5001, '5': 9000, '6': 9001 },
      'Innenstraße':   [400, 1, 40],                 // ganze Straße in Zone 1
      'Feldweg':       [8700, 10, 20],               // ganze Straße in Zone 3
      'Dorfstraße (Heek)': { '1': 8800, '3': 9200 },
      'Hauptstraße':   { '1': 1500 },
      'Hauptstraße (Legden)': { '1': 8900 },
    },
    zu_weit: { 'Högerstraße': 1060 },
  };
}
const gebiet = Liefergebiet.erstelle(testDaten());
const pruefer = erstellePruefer({ gebiet, nurImLadenNamen: ['Açaí-Bowl'] });

function bestellung(mode, warenwert, adresse = {}, extra = {}) {
  return {
    items: [{ name: 'Bowl', price: warenwert, qty: 1, extraDetails: [], note: '' }],
    subtotal: warenwert, deliveryFee: 0, serviceFee: 0.99, mode, payment: 'bar',
    customer: { first: 'Max', last: 'Muster', email: 'max@example.org', phone: '0123',
                street: '', house: '', city: '', ...adresse },
    ...extra,
  };
}
const adr = (street, house, city = 'Ahaus') => ({ street, house, city });

// ── Zonen ────────────────────────────────────────────────────────

test('liefergebiet.json trägt die beschlossenen Zonen', () => {
  assert.deepEqual(echteDaten.zonen, [
    { bis_km: 2, gebuehr: 1.5, mindestwert: 20 },
    { bis_km: 5, gebuehr: 2.5, mindestwert: 20 },
    { bis_km: 9, gebuehr: 5.5, mindestwert: 40 },
  ]);
  const g = Liefergebiet.erstelle(echteDaten);
  assert.equal(g.grenzeKm, 9);
  assert.equal(g.mindestwertAb, 20);
});

test('Zonengrenzen: genau 2,0 / 5,0 / 9,0 km und knapp darüber', () => {
  const z = m => { const r = gebiet.zoneFuer(m); return r && r.nr; };
  assert.equal(z(0), 1);
  assert.equal(z(2000), 1);
  assert.equal(z(2001), 2);
  assert.equal(z(5000), 2);
  assert.equal(z(5001), 3);
  assert.equal(z(9000), 3);
  assert.equal(gebiet.zoneFuer(9001), null);
});

test('finde: Hausnummern genau auf und knapp hinter den Grenzen', () => {
  const f = nr => gebiet.finde('Grenzweg', nr);
  assert.deepEqual([f('1').status, f('1').zone, f('1').gebuehr, f('1').mindestwert], ['ok', 1, 1.5, 20]);
  assert.deepEqual([f('2').zone, f('2').gebuehr, f('2').mindestwert], [2, 2.5, 20]);
  assert.deepEqual([f('3').zone, f('3').gebuehr], [2, 2.5]);
  assert.deepEqual([f('4').zone, f('4').gebuehr, f('4').mindestwert], [3, 5.5, 40]);
  assert.deepEqual([f('5').status, f('5').zone, f('5').gebuehr], ['ok', 3, 5.5]);
  assert.equal(f('6').status, 'zu-weit');
  assert.equal(f('6').meter, 9001);
});

test('finde: ganze Straße in einer Zone, Nummernbereich mit Spielraum', () => {
  assert.equal(gebiet.finde('Innenstr.', '7').zone, 1);
  assert.equal(gebiet.finde('innen strasse', '50').status, 'ok');        // 40 + 10 Spielraum
  assert.equal(gebiet.finde('Innenstraße', '51').status, 'nr-unbekannt');
  assert.equal(gebiet.finde('Feldweg', '1').zone, 3);                     // 10 - 9
  assert.equal(gebiet.finde('Feldweg', '1').mindestwert, 40);
});

test('finde: Nachbarort, zu weite und unbekannte Straßen', () => {
  assert.equal(gebiet.finde('Hauptstraße', '1').ort, 'Ahaus');            // Ahaus gewinnt
  assert.equal(gebiet.finde('Hauptstraße (Legden)', '1').zone, 3);
  assert.equal(gebiet.finde('Dorfstraße', '1').ort, 'Heek');               // nur in Heek
  assert.equal(gebiet.finde('Dorfstraße (Heek)', '3').status, 'zu-weit');
  assert.equal(gebiet.finde('Högerstraße', '17').status, 'zu-weit');      // ganz über 9 km
  assert.equal(gebiet.finde('Gibtsnichtweg', '1').status, 'strasse-unbekannt');
  assert.equal(gebiet.finde('', '1').status, 'strasse-fehlt');
  assert.equal(gebiet.finde('Grenzweg', '').status, 'nr-fehlt');
});

test('echte Daten: Stichproben Innenstadt, Wüllen, Ottenstein, Alstätte', () => {
  const g = Liefergebiet.erstelle(echteDaten);
  const laden = g.finde('Wallstraße', '7');
  assert.equal(laden.status, 'ok'); assert.equal(laden.zone, 1);
  assert.equal(g.finde('Wüllener Straße', '1').status, 'ok');
  assert.equal(g.finde('Vredener Straße', '1').zone, 3);                   // Ottenstein
  assert.equal(g.finde('Högerstraße', '17').status, 'zu-weit');            // Alstätte
  assert.equal(g.finde('Gibtsnichtweg', '1').status, 'strasse-unbekannt');
});

// ── Mindestbestellwert je Zone ──────────────────────────────────

test('Mindestbestellwert Zone 1 und 2: 19,99 € abgelehnt, 20,00 € angenommen', () => {
  for (const nr of ['1', '2', '3']) {
    assert.match(pruefer.pruefe(bestellung('lieferung', 19.99, adr('Grenzweg', nr))).fehler, /Mindestbestellwert.*20,00 €/);
    assert.equal(pruefer.pruefe(bestellung('lieferung', 20.00, adr('Grenzweg', nr))).ok, true, nr);
  }
});

test('Mindestbestellwert Zone 3: 39,99 € abgelehnt, 40,00 € angenommen', () => {
  for (const nr of ['4', '5']) {
    const r = pruefer.pruefe(bestellung('lieferung', 39.99, adr('Grenzweg', nr)));
    assert.match(r.fehler, /Mindestbestellwert.*40,00 €/);
    assert.match(r.fehler, /0,01 €/);
    assert.equal(pruefer.pruefe(bestellung('lieferung', 40.00, adr('Grenzweg', nr))).ok, true, nr);
  }
});

test('Mindestbestellwert zählt Positionen × Menge, eine hochgesetzte subtotal hilft nicht', () => {
  const b = bestellung('lieferung', 10, adr('Grenzweg', '1'));
  b.items = [{ name: 'Bowl', price: 10, qty: 2 }];
  b.subtotal = 20;
  assert.equal(pruefer.pruefe(b).ok, true);
  const gemogelt = bestellung('lieferung', 5, adr('Grenzweg', '1'));
  gemogelt.subtotal = 50;
  assert.match(pruefer.pruefe(gemogelt).fehler, /Mindestbestellwert/);
});

// ── Ablehnungen ──────────────────────────────────────────────────

test('Lieferung über 9 km wird abgelehnt', () => {
  const r = pruefer.pruefe(bestellung('lieferung', 100, adr('Grenzweg', '6')));
  assert.match(r.fehler, /außerhalb unseres Liefergebiets.*9 km/);
  assert.match(pruefer.pruefe(bestellung('lieferung', 100, adr('Högerstraße', '17'))).fehler, /außerhalb/);
  assert.match(pruefer.pruefe(bestellung('lieferung', 100, adr('Dorfstraße', '3', 'Heek'))).fehler, /außerhalb/);
});

test('unbekannte Adresse, fehlende Hausnummer und unbekannte Nummer werden abgelehnt', () => {
  assert.match(pruefer.pruefe(bestellung('lieferung', 100, adr('Gibtsnichtweg', '1'))).fehler, /kennen wir nicht/);
  assert.match(pruefer.pruefe(bestellung('lieferung', 100, adr('Grenzweg', ''))).fehler, /Hausnummer/);
  assert.match(pruefer.pruefe(bestellung('lieferung', 100, adr('Innenstraße', '99'))).fehler, /Hausnummer/);
  assert.match(pruefer.pruefe(bestellung('lieferung', 100, adr('', ''))).fehler, /Straße und Hausnummer/);
  // ohne customer-Objekt
  const ohne = bestellung('lieferung', 100); delete ohne.customer;
  assert.ok(pruefer.pruefe(ohne).fehler);
  // seltsame Typen werfen nicht
  assert.ok(pruefer.pruefe(bestellung('lieferung', 100, { street: { $ne: 1 }, house: ['1'] })).fehler);
  assert.ok(pruefer.pruefe(undefined).fehler);
  assert.ok(pruefer.pruefe([]).fehler);
});

test('Açaí wird abgelehnt - bei Lieferung UND bei Abholung', () => {
  for (const mode of ['lieferung', 'abholung']) {
    for (const name of ['Açaí-Bowl Classic', 'Açaí-Bowl Large', 'Acai-Bowl Classic', 'açaí-bowl']) {
      const b = bestellung(mode, 50, adr('Grenzweg', '1'));
      b.items.push({ name, price: 8.9, qty: 1 });
      const r = pruefer.pruefe(b);
      assert.match(r.fehler || '', /nur bei uns im Laden/, `${mode}: ${name}`);
    }
  }
});

test('Abholung: kein Mindestbestellwert, keine Liefergebühr', () => {
  const b = bestellung('abholung', 2.9, {}, { deliveryFee: 5.5 });
  assert.equal(pruefer.pruefe(b).ok, true);
  assert.equal(b.deliveryFee, 0);
});

test('Server übernimmt keine Liefergebühr vom Aufrufer', () => {
  for (const geschickt of [0, 0.01, 99, -5, '1.5', undefined]) {
    const b = bestellung('lieferung', 50, adr('Grenzweg', '4'), { deliveryFee: geschickt });
    assert.equal(pruefer.pruefe(b).ok, true);
    assert.equal(b.deliveryFee, 5.5, String(geschickt));
  }
  const nah = bestellung('lieferung', 50, adr('Grenzweg', '1'), { deliveryFee: 5.5 });
  pruefer.pruefe(nah);
  assert.equal(nah.deliveryFee, 1.5);
});

test('Lieferadresse wird auf die nachgeschlagene Schreibweise gesetzt', () => {
  const b = bestellung('lieferung', 50, { street: 'innenstr.', house: ' 7 ', city: 'Ahaus-Wüllen' });
  assert.equal(pruefer.pruefe(b).ok, true);
  assert.deepEqual([b.customer.street, b.customer.house, b.customer.city], ['Innenstraße', '7', 'Ahaus']);
  assert.equal(b.customer.first, 'Max');
  const heek = bestellung('lieferung', 50, { street: 'Dorfstraße', house: '1', city: 'Heek' });
  assert.equal(pruefer.pruefe(heek).ok, true);
  assert.equal(heek.customer.city, 'Heek');
  assert.equal(heek.deliveryFee, 5.5);
});

// ── Gleiche Zahlen überall ───────────────────────────────────────

test('menu.json: genau die Açaí-Bowl ist nur im Laden, die Seite kennt denselben Namen', () => {
  const namen = menu.kategorien.flatMap(k => k.items || []).filter(i => i.nur_im_laden).map(i => i.name);
  assert.deepEqual(namen, ['Açaí-Bowl']);
  const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf8');
  assert.ok(html.includes("let NUR_IM_LADEN_NAMEN = ['Açaí-Bowl'];"));
});

test('index.html: Infoblock und Bühne zeigen die Zahlen aus liefergebiet.json', () => {
  const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf8');
  const eur = n => n.toFixed(2).replace('.', ',') + ' €';
  const block = html.slice(html.indexOf('<table class="odis-zonen"'), html.indexOf('</table>', html.indexOf('<table class="odis-zonen"')));
  assert.equal((block.match(/<tr><th scope="row">/g) || []).length, echteDaten.zonen.length);
  let von = 0;
  for (const z of echteDaten.zonen) {
    const zeile = `<tr><th scope="row">${von ? `über ${von} bis ` : 'bis '}${z.bis_km} km</th><td>${eur(z.gebuehr)}</td><td>${z.mindestwert} €</td></tr>`;
    assert.ok(block.includes(zeile), zeile);
    von = z.bis_km;
  }
  assert.ok(html.includes(`bis ${echteDaten.zonen.at(-1).bis_km} km ab ${eur(echteDaten.zonen[0].gebuehr)}`));
});

test('server.js prüft in allen öffentlichen Bestellwegen und meldet Lieferung in /api/config', () => {
  const src = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const route = (name) => {
    const a = src.indexOf(`app.post('${name}'`);
    assert.ok(a > 0, name);
    return src.slice(a, src.indexOf('\napp.', a + 10));
  };
  for (const r of ['/api/orders', '/api/create-stripe-checkout', '/api/create-paypal-order']) {
    const teil = route(r);
    const pruefung = teil.indexOf('if (lieferungAbgelehnt(req, res)) return;');
    assert.ok(pruefung > 0, r);
    assert.ok(pruefung < teil.indexOf('new Order('), r + ': Prüfung vor dem Anlegen');
  }
  assert.match(src, /nurAbholung: false,/);
  assert.doesNotMatch(src, /NUR_ABHOLUNG\b/);
});
