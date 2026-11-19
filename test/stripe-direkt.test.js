// Tests fuer stripe-direkt.js (nur Direct Charges). Laufen ohne Datenbank,
// ohne .env und ohne Stripe: npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const sd     = require('../stripe-direkt');

const FIX = { sv: 0.99, grund: 150, domain: 0 };
const ALLES = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_DIREKT_KONTO: 'acct_laden', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_x' };

// ─── Einstellungen ───────────────────────────────────────────────

test('stripeKonfiguration: vollstaendig, teilweise, gar nicht', () => {
  const voll = sd.stripeKonfiguration(ALLES);
  assert.equal(voll.vollstaendig, true);
  assert.equal(voll.teilweise, false);
  assert.equal(voll.konto, 'acct_laden');
  assert.deepEqual(voll.fehlend, []);

  const teil = sd.stripeKonfiguration({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_DIREKT_KONTO: '  ' });
  assert.equal(teil.vollstaendig, false);
  assert.equal(teil.teilweise, true);
  assert.deepEqual(teil.fehlend, ['STRIPE_DIREKT_KONTO', 'STRIPE_CONNECT_WEBHOOK_SECRET']);

  const nichts = sd.stripeKonfiguration({});
  assert.equal(nichts.vollstaendig, false);
  assert.equal(nichts.teilweise, false);
  assert.equal(nichts.konto, null);
});

test('stripeKonfiguration gibt keine Geheimwerte heraus', () => {
  const text = JSON.stringify(sd.stripeKonfiguration(ALLES));
  assert.equal(text.includes('sk_test_x'), false);
  assert.equal(text.includes('whsec_x'), false);
});

test('Alte Variablen spielen keine Rolle', () => {
  // Plattformkonto-Weg (Connect-Konto, altes Webhook-Geheimnis, Stichtag) gibt es hier nicht
  const k = sd.stripeKonfiguration({ STRIPE_SECRET_KEY: 'sk', ['STRIPE_' + 'CONNECT_ACCOUNT']: 'acct_alt', STRIPE_WEBHOOK_SECRET: 'whsec_alt' });
  assert.equal(k.vollstaendig, false);
  assert.equal(k.konto, null);
});

// ─── Kein Checkout, keine Online-Zahlung ohne freigeschaltetes Konto ──

const bereit = async () => true;
const nicht  = async () => false;
const kaputt = async () => { throw new Error('Stripe weg'); };

test('direktKontoWaehlen: alles gesetzt und Konto freigeschaltet -> Konto', async () => {
  assert.equal(await sd.direktKontoWaehlen({ env: ALLES, istBereit: bereit }), 'acct_laden');
});

test('direktKontoWaehlen: Konto nicht freigeschaltet oder Stripe-Fehler -> keine Online-Zahlung', async () => {
  assert.equal(await sd.direktKontoWaehlen({ env: ALLES, istBereit: nicht }), null);
  assert.equal(await sd.direktKontoWaehlen({ env: ALLES, istBereit: kaputt }), null);
  assert.equal(await sd.direktKontoWaehlen({ env: ALLES, istBereit: () => { throw new Error('sync'); } }), null);
  assert.equal(await sd.direktKontoWaehlen({ env: ALLES, istBereit: async () => 'true' }), null);
});

test('direktKontoWaehlen: fehlt eine der drei Variablen, wird Stripe gar nicht gefragt', async () => {
  for (const weg of sd.STRIPE_VARIABLEN) {
    let gefragt = 0;
    const env = { ...ALLES }; delete env[weg];
    const r = await sd.direktKontoWaehlen({ env, istBereit: async () => { gefragt++; return true; } });
    assert.equal(r, null, weg);
    assert.equal(gefragt, 0, weg);
  }
  assert.equal(await sd.direktKontoWaehlen({ env: {}, istBereit: bereit }), null);
  assert.equal(await sd.direktKontoWaehlen({ env: undefined, istBereit: bereit }), null);
});

// ─── Zwischenspeicher fuer charges_enabled ──────────────────────

test('Kontopruefer: speichert das Ergebnis und fragt erst nach Ablauf neu', async () => {
  let jetzt = 0, aufrufe = 0, antwort = true;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => { aufrufe++; return antwort; }, ttlMs: 1000, uhr: () => jetzt });
  assert.equal(await istBereit('acct_1'), true);
  antwort = false;
  jetzt = 999;
  assert.equal(await istBereit('acct_1'), true);
  assert.equal(aufrufe, 1);
  jetzt = 1000;
  assert.equal(await istBereit('acct_1'), false);
  assert.equal(aufrufe, 2);
});

test('Kontopruefer: Standard-Speicherzeit ist 5 Minuten', async () => {
  let jetzt = 0, aufrufe = 0;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => { aufrufe++; return true; }, uhr: () => jetzt });
  await istBereit('acct_1');
  jetzt = 5 * 60 * 1000 - 1;
  await istBereit('acct_1');
  assert.equal(aufrufe, 1);
  jetzt = 5 * 60 * 1000;
  await istBereit('acct_1');
  assert.equal(aufrufe, 2);
});

test('Kontopruefer: ohne Konto false, Stripe wird nicht gefragt', async () => {
  let aufrufe = 0;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => { aufrufe++; return true; } });
  assert.equal(await istBereit(undefined), false);
  assert.equal(await istBereit(''), false);
  assert.equal(aufrufe, 0);
});

test('Kontopruefer: Fehler heisst nicht bereit, kurz gespeichert, nie geworfen', async () => {
  let jetzt = 0, aufrufe = 0, gemeldet = 0;
  const istBereit = sd.erstelleKontoPruefer({
    abrufen: async () => { aufrufe++; throw new Error('weg'); },
    ttlMs: 10000, fehlerTtlMs: 100, uhr: () => jetzt, melden: () => gemeldet++,
  });
  assert.equal(await istBereit('acct_1'), false);
  assert.equal(await istBereit('acct_1'), false);
  assert.equal(aufrufe, 1);
  jetzt = 100;
  assert.equal(await istBereit('acct_1'), false);
  assert.equal(aufrufe, 2);
  assert.equal(gemeldet, 2);
});

test('Kontopruefer: auch ein werfendes melden() bricht nichts', async () => {
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => { throw new Error('a'); }, melden: () => { throw new Error('b'); } });
  assert.equal(await istBereit('acct_1'), false);
});

test('Kontopruefer: synchroner Wurf in abrufen ist auch nur "nicht bereit"', async () => {
  const istBereit = sd.erstelleKontoPruefer({ abrufen: () => { throw new Error('kein Schluessel'); } });
  assert.equal(await istBereit('acct_1'), false);
});

test('Kontopruefer: nur charges_enabled === true zaehlt', async () => {
  for (const wert of [1, 'true', {}, undefined, null, false]) {
    const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => wert });
    assert.equal(await istBereit('acct_1'), false, String(wert));
  }
});

test('Kontopruefer: haengende Abfrage endet nach dem Zeitlimit als "nicht bereit"', async () => {
  const istBereit = sd.erstelleKontoPruefer({ abrufen: () => new Promise(() => {}), zeitlimitMs: 20 });
  const start = Date.now();
  assert.equal(await istBereit('acct_1'), false);
  assert.ok(Date.now() - start < 1000);
});

test('Kontopruefer: gleichzeitige Anfragen teilen sich eine Abfrage', async () => {
  let aufrufe = 0;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => { aufrufe++; await new Promise(r => setTimeout(r, 10)); return true; } });
  const r = await Promise.all([istBereit('acct_1'), istBereit('acct_1'), istBereit('acct_1')]);
  assert.deepEqual(r, [true, true, true]);
  assert.equal(aufrufe, 1);
});

test('Kontopruefer: nach gescheitertem Checkout (alsNichtBereitMerken) eine Fehlerspanne lang keine Online-Zahlung', async () => {
  let jetzt = 0;
  const istBereit = sd.erstelleKontoPruefer({ abrufen: async () => true, fehlerTtlMs: 50, uhr: () => jetzt });
  assert.equal(await sd.direktKontoWaehlen({ env: ALLES, istBereit }), 'acct_laden');
  istBereit.alsNichtBereitMerken('acct_laden');
  assert.equal(await sd.direktKontoWaehlen({ env: ALLES, istBereit }), null);
  jetzt = 50;
  assert.equal(await sd.direktKontoWaehlen({ env: ALLES, istBereit }), 'acct_laden');
});

// ─── Webhook: Ereignisfilter ─────────────────────────────────────

test('Ereignisfilter: nur das eigene Konto wird verarbeitet', () => {
  assert.equal(sd.ereignisFuerUns({ type: 'checkout.session.completed', account: 'acct_laden' }, 'acct_laden'), true);
});

test('Ereignisfilter: fremdes Konto der Plattform wird ignoriert', () => {
  assert.equal(sd.ereignisFuerUns({ type: 'checkout.session.completed', account: 'acct_fremd' }, 'acct_laden'), false);
});

test('Ereignisfilter: Ereignis ohne Konto (Plattform) wird ignoriert', () => {
  assert.equal(sd.ereignisFuerUns({ type: 'checkout.session.completed' }, 'acct_laden'), false);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: null }, 'acct_laden'), false);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: '' }, 'acct_laden'), false);
});

test('Ereignisfilter: ohne eigenes Konto wird nichts verarbeitet', () => {
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: 'acct_fremd' }, undefined), false);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: 'acct_fremd' }, ''), false);
  assert.equal(sd.ereignisFuerUns({ type: 'x' }, undefined), false);
  assert.equal(sd.ereignisFuerUns(null, 'acct_laden'), false);
  assert.equal(sd.ereignisFuerUns({ type: 'x', account: { id: 'acct_laden' } }, 'acct_laden'), false);
});

// ─── Echte Gebuehr ───────────────────────────────────────────────

test('gebuehrCentAusPaymentIntent', () => {
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: { fee: 58 } } }), 58);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: { fee: 0 } } }), 0);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: { fee: -1 } } }), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: { fee: 1.5 } } }), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: 'txn_1' } }), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: { balance_transaction: null } }), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent({ latest_charge: 'ch_1' }), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent({}), null);
  assert.equal(sd.gebuehrCentAusPaymentIntent(null), null);
});

test('istDirektBestellung', () => {
  assert.equal(sd.istDirektBestellung({ payment: 'stripe', stripeAccount: 'acct_laden' }), true);
  assert.equal(sd.istDirektBestellung({ payment: 'stripe' }), false);
  assert.equal(sd.istDirektBestellung({ payment: 'bar', stripeAccount: 'acct_laden' }), false);
  assert.equal(sd.istDirektBestellung(null), false);
});

// ─── Abrechnung ──────────────────────────────────────────────────

// Handbeispiel: 3 Online-Bestellungen mit bekannter Stripe-Gebuehr + 2 bar.
//   Online: 25,99 (Gebuehr 0,64) + 14,99 (0,47) + 38,49 (0,83) = 79,47 €, Gebuehren 1,94 €
//   Bar:    12,49 + 9,99                                         = 22,48 €
//   Gesamtumsatz                       79,47 + 22,48              = 101,95 €
//   Verbleibt auf dem Stripe-Konto     79,47 - 1,94               =  77,53 €
//   Servicegebuehr                     5 x 0,99                   =   4,95 €
//   Monat: FlueVate per SEPA           150,00 + 4,95              = 154,95 €
//          Ihnen bleiben               101,95 - 1,94 - 154,95     = -54,94 €
//   Woche: FlueVate per SEPA           4,95 (Grundgebuehr nur im Monat)
//          Ihnen bleiben               101,95 - 1,94 - 4,95       =  95,06 €
function handbeispiel() {
  return [
    { payment: 'stripe', total: 25.99, serviceFee: 0.99, stripeAccount: 'acct_laden', stripeGebuehrCent: 64 },
    { payment: 'stripe', total: 14.99, serviceFee: 0.99, stripeAccount: 'acct_laden', stripeGebuehrCent: 47 },
    { payment: 'stripe', total: 38.49, serviceFee: 0.99, stripeAccount: 'acct_laden', stripeGebuehrCent: 83 },
    { payment: 'bar',    total: 12.49, serviceFee: 0.99 },
    { payment: 'bar',    total:  9.99, serviceFee: 0.99 },
  ];
}

test('Abrechnung Handbeispiel Monat: 3 online mit bekannter Gebuehr + 2 bar', () => {
  const a = sd.berichtAbrechnung(handbeispiel(), true, FIX);
  assert.equal(a.n, 5); assert.equal(a.nOnline, 3); assert.equal(a.nLaden, 2);
  assert.equal(a.nOhneKonto, 0);
  assert.equal(a.umsatzOnline, 79.47);
  assert.equal(a.umsatzLaden, 22.48);
  assert.equal(a.brutto, 101.95);
  assert.equal(a.stripeGeb, 1.94);
  assert.equal(a.nStripeGebUnbekannt, 0);
  assert.equal(a.verbleibtStripe, 77.53);
  assert.equal(a.svc, 4.95);
  assert.equal(a.grund, 150);
  assert.equal(a.domain, 0);
  assert.equal(a.fluevate, 154.95);
  assert.equal(a.bleibt, -54.94);
});

test('Abrechnung Handbeispiel Woche: ohne Grundgebuehr', () => {
  const a = sd.berichtAbrechnung(handbeispiel(), false, FIX);
  assert.equal(a.grund, 0);
  assert.equal(a.fluevate, 4.95);
  assert.equal(a.bleibt, 95.06);
});

test('Abrechnung: kein alter Weg mehr - keine Ueberweisung, kein offener Betrag, keine Pauschale', () => {
  const a = sd.berichtAbrechnung(handbeispiel(), true, FIX);
  for (const k of ['ueberweisung', 'offen', 'gebuehren', 'nDirekt', 'umsatzDirekt']) assert.equal(k in a, false, k);
  assert.equal(typeof sd.stripePauschale, 'undefined');
});

test('Abrechnung: Stripe-Gebuehr noch unbekannt wird nicht geschaetzt', () => {
  const orders = handbeispiel();
  delete orders[2].stripeGebuehrCent;
  const a = sd.berichtAbrechnung(orders, true, FIX);
  assert.equal(a.stripeGeb, 1.11);
  assert.equal(a.nStripeGebUnbekannt, 1);
  assert.equal(a.verbleibtStripe, 78.36);
  assert.match(sd.stripeGebText(a), /bekannt für 2 von 3 Zahlungen/);
  assert.match(sd.stripeHinweis(a), /Bei einer Zahlung ist die Stripe-Gebühr noch nicht bekannt/);
  const keine = sd.berichtAbrechnung(orders.map(o => ({ ...o, stripeGebuehrCent: undefined })), true, FIX);
  assert.equal(sd.stripeGebWert(keine, n => '-' + n), 'noch nicht bekannt');
});

test('Abrechnung: nur Bar - keine Stripe-Zeilen', () => {
  const orders = handbeispiel().filter(o => o.payment === 'bar');
  const a = sd.berichtAbrechnung(orders, true, FIX);
  assert.equal(a.nOnline, 0);
  assert.equal(a.stripeGeb, 0);
  assert.equal(a.brutto, 22.48);
  assert.equal(a.fluevate, 151.98);
  assert.equal(a.bleibt, -129.5);
  const html = sd.abrechnungMailZeilen(a, FIX);
  assert.equal(html.includes('Stripe'), false);
  assert.match(html, /SEPA-Lastschrift/);
});

test('Abrechnung: leerer Zeitraum', () => {
  const a = sd.berichtAbrechnung([], true, FIX);
  assert.equal(a.n, 0); assert.equal(a.brutto, 0); assert.equal(a.fluevate, 150); assert.equal(a.bleibt, -150);
});

test('Abrechnung: Servicegebuehr 0 oder fehlend zaehlt als 0,99', () => {
  const a = sd.berichtAbrechnung([{ payment: 'bar', total: 10, serviceFee: 0 }, { payment: 'bar', total: 10 }], false, FIX);
  assert.equal(a.svc, 1.98);
});

test('Abrechnung: Stripe-Bestellung ohne Konto faellt auf, statt unter Bar zu verschwinden', () => {
  const a = sd.berichtAbrechnung([{ payment: 'stripe', total: 10, serviceFee: 0.99 }], false, FIX);
  assert.equal(a.nOnline, 1);
  assert.equal(a.nLaden, 0);
  assert.equal(a.nOhneKonto, 1);
  assert.match(sd.abrechnungOwnerText(a), /ohne gespeichertes Konto/);
});

test('Abrechnung: keine Rundungsreste bei vielen Bestellungen', () => {
  const orders = Array.from({ length: 1000 }, (_, i) => ({ payment: i % 3 ? 'bar' : 'stripe', total: 10.1, serviceFee: 0.99,
    ...(i % 3 ? {} : { stripeAccount: 'acct_laden', stripeGebuehrCent: 40 }) }));
  const a = sd.berichtAbrechnung(orders, true, FIX);
  for (const k of ['umsatzOnline', 'umsatzLaden', 'brutto', 'stripeGeb', 'verbleibtStripe', 'svc', 'fluevate', 'bleibt']) {
    assert.equal(Math.round(a[k] * 100) / 100, a[k], k);
  }
  assert.equal(a.svc, 990);
  assert.equal(a.stripeGeb, 133.6);
});

// ─── Texte ───────────────────────────────────────────────────────

test('Mailtexte Handbeispiel: neues Modell, keine Saetze des alten Wegs', () => {
  const a = sd.berichtAbrechnung(handbeispiel(), true, FIX);
  const html = sd.abrechnungMailZeilen(a, FIX);
  assert.match(html, /Online-Zahlung \(Ihr Stripe-Konto\)/);
  assert.match(html, /79,47 €/);
  assert.match(html, /1,94 €/);
  assert.match(html, /Verbleibt auf Ihrem Stripe-Konto/);
  assert.match(html, /77,53 €/);
  assert.match(html, /Grundgebühr, Servicegebühr 5 × 0,99 €/);
  assert.match(html, /per Rechnung und SEPA-Lastschrift/);
  assert.match(html, /154,95 €/);
  assert.match(html, /-54,94 €/);
  for (const alt of ['Überweisung', 'einbehalten', 'Offener Betrag', '1,5 %', 'Auszahlung']) {
    assert.equal(html.includes(alt), false, alt);
  }
  const owner = sd.abrechnungOwnerText(a);
  assert.match(owner, /Per Rechnung und SEPA-Lastschrift einziehen:<\/b> 154,95 € \(Grundgebühr 150,00 €, Servicegebühr 4,95 € \(5 Bestellungen\)\)/);
  assert.match(owner, /Eigenes Stripe-Konto des Ladens:<\/b> 79,47 € \(3 Zahlungen\), Stripe-Gebühren 1,94 €/);
  assert.equal(owner.includes('Überweisung'), false);
});

test('Wochentext verweist fuer die Grundgebuehr auf den Monatsbericht', () => {
  const woche = sd.berichtAbrechnung(handbeispiel(), false, FIX);
  assert.match(sd.fluevateHinweis(woche), /Grundgebühr steht im Monatsbericht/);
  const monat = sd.berichtAbrechnung(handbeispiel(), true, FIX);
  assert.equal(sd.fluevateHinweis(monat).includes('Monatsbericht'), false);
});

test('svcText', () => {
  assert.equal(sd.svcText(5, 4.95, 0.99), '5 × 0,99 €');
  assert.equal(sd.svcText(5, 4.00, 0.99), '5 Bestellungen');
});

// ─── gleichSicher ────────────────────────────────────────────────

test('gleichSicher', () => {
  assert.equal(sd.gleichSicher('abc', 'abc'), true);
  assert.equal(sd.gleichSicher('abc', 'abd'), false);
  assert.equal(sd.gleichSicher('abc', 'abcd'), false);
  assert.equal(sd.gleichSicher('', 'abc'), false);
  assert.equal(sd.gleichSicher(undefined, 'abc'), false);
  assert.equal(sd.gleichSicher('äöü', 'äöü'), true);
});

// PayPal liegt auf dem PayPal-Konto des Ladens, nicht in der Kasse (19.11.2026)
test('berichtAbrechnung: PayPal zählt nicht als Barzahlung in der Kasse', () => {
  const { berichtAbrechnung, abrechnungMailZeilen } = require('../stripe-direkt');
  const fix = { sv: 0.99, grund: 150, domain: 0 };
  const a = berichtAbrechnung([
    { payment: 'bar', total: 10, serviceFee: 0.99 },
    { payment: 'paypal', total: 20.5, serviceFee: 0.99 },
    { payment: 'paypal', total: 9.5, serviceFee: 0.99 },
  ], false, fix);
  assert.equal(a.nLaden, 1); assert.equal(a.umsatzLaden, 10);
  assert.equal(a.nPaypal, 2); assert.equal(a.umsatzPaypal, 30);
  assert.equal(a.brutto, 40);
  const html = abrechnungMailZeilen(a, fix);
  assert.match(html, /PayPal \(Ihr PayPal-Konto\)<\/b> \(2 Bestellungen\)/);
  assert.match(html, /Barzahlung in Ihrer Kasse \(1 Bestellungen\)/);
  const ohne = berichtAbrechnung([{ payment: 'bar', total: 10, serviceFee: 0.99 }], false, fix);
  assert.equal(ohne.nPaypal, 0);
  assert.doesNotMatch(abrechnungMailZeilen(ohne, fix), /PayPal/);
});
