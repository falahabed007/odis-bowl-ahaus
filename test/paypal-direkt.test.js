// Tests fuer paypal-direkt.js. Laufen ohne Datenbank, ohne .env und ohne PayPal:
// PayPal ist eine vorgetaeuschte fetch-Funktion, die Datenbank ein Speicher im Arbeitsspeicher.
const test   = require('node:test');
const assert = require('node:assert/strict');
const pp     = require('../paypal-direkt');
const { erstelleKontoPruefer } = require('../stripe-direkt');

const LIVE = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'geheim', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_ENV: 'live' };
const stumm = { log() {}, warn() {}, error() {} };
const MIN = 60 * 1000;

// ─── Vorgetaeuschtes PayPal ──────────────────────────────────────
// orders: id -> { status, wert, waehrung, nr, einzugStatus }
function fakePaypal({ tokenOk = true, verify = 'SUCCESS', verifyWirft = false, verzoegerung = 0 } = {}) {
  const orders = new Map();
  const aufrufe = [];
  let einzuege = 0, naechste = 1;
  const antwort = (status, daten) => ({ ok: status < 300, status, text: async () => JSON.stringify(daten) });
  const ppOrder = (id, o) => ({
    id, status: o.status,
    purchase_units: [{ reference_id: String(o.nr), custom_id: String(o.nr),
      amount: { currency_code: 'EUR', value: o.betrag },
      ...(o.einzug ? { payments: { captures: [o.einzug] } } : {}) }],
    links: [{ rel: 'payer-action', href: `https://www.paypal.com/checkoutnow?token=${id}` }],
  });
  async function fetch(url, opt = {}) {
    aufrufe.push({ url, method: opt.method, headers: opt.headers || {}, body: opt.body });
    if (verzoegerung) await new Promise(r => setTimeout(r, verzoegerung));
    const u = new URL(url);
    if (u.host !== 'api-m.paypal.com') throw new Error('falscher Host ' + u.host);
    if (u.pathname === '/v1/oauth2/token') {
      return tokenOk ? antwort(200, { access_token: 'tok', expires_in: 32000 }) : antwort(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    }
    if (u.pathname === '/v1/notifications/verify-webhook-signature') {
      if (verifyWirft) return antwort(500, { name: 'INTERNAL_SERVICE_ERROR', message: 'kaputt' });
      return antwort(200, { verification_status: verify });
    }
    if (u.pathname === '/v2/checkout/orders' && opt.method === 'POST') {
      const b = JSON.parse(opt.body);
      const id = 'PP' + String(naechste++).padStart(8, '0');
      orders.set(id, { status: 'PAYER_ACTION_REQUIRED', betrag: b.purchase_units[0].amount.value, nr: b.purchase_units[0].custom_id });
      return antwort(201, ppOrder(id, orders.get(id)));
    }
    const m = u.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (m) {
      const o = orders.get(m[1]);
      if (!o) return antwort(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }], message: 'not found' });
      if (!m[2]) return antwort(200, ppOrder(m[1], o));
      if (o.status === 'COMPLETED') return antwort(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }], message: 'already' });
      if (o.status !== 'APPROVED') return antwort(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }], message: 'not approved' });
      if (o.ablehnen) return antwort(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }], message: 'declined' });
      einzuege++;
      o.status = 'COMPLETED';
      o.einzug = { id: 'CAP' + m[1], status: o.einzugStatus || 'COMPLETED',
                   amount: { currency_code: o.waehrung || 'EUR', value: o.bezahlt || o.betrag } };
      return antwort(201, ppOrder(m[1], o));
    }
    return antwort(404, { name: 'NOT_FOUND' });
  }
  return { fetch, orders, aufrufe, get einzuege() { return einzuege; },
    anlegen(id, felder) { orders.set(id, { status: 'APPROVED', betrag: '23.49', nr: 1001, ...felder }); } };
}

// ─── Speicher wie in server.js (atomar, nur aus awaiting_payment) ──
function fakeSpeicher(orders, { nachgeholt = false } = {}) {
  const db = new Map(orders.map(o => [o._id, o]));
  let buchungen = 0;
  return {
    db, get buchungen() { return buchungen; },
    async einbuchen(order, einzug) {
      const o = db.get(order._id);
      const offen = o && (o.status === 'awaiting_payment' || (o.status === 'cancelled' && o.zahlungAbgelaufen && o.paymentStatus === 'pending'));
      if (!offen) return null;
      Object.assign(o, { status: 'pending', paymentStatus: 'paid', paypalCaptureId: einzug.id, ...(nachgeholt ? { nachgeholt: true } : {}) });
      delete o.zahlungAbgelaufen;
      buchungen++;
      return { ...o };
    },
    async abschliessen(order) {
      const o = db.get(order._id);
      if (!o || o.status !== 'awaiting_payment') return false;
      Object.assign(o, { status: 'cancelled', zahlungAbgelaufen: true });
      return true;
    },
    finden: async id => { for (const o of db.values()) if (o.paypalOrderId === id) return { ...o }; return null; },
  };
}

const bestellung = (felder = {}) => ({ _id: 'o1', orderNum: 1001, payment: 'paypal', paymentStatus: 'pending',
  status: 'awaiting_payment', total: 23.49, paypalOrderId: 'PPAAAA0001', createdAt: new Date(), ...felder });

const kopf = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert',
  'paypal-transmission-id': 'tid', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-11-19T12:00:00Z' };
const ereignis = (typ, ppId) => typ.startsWith('CHECKOUT.ORDER.')
  ? { event_type: typ, resource: { id: ppId } }
  : { event_type: typ, resource: { id: 'CAP' + ppId, supplementary_data: { related_ids: { order_id: ppId } } } };

// ─── Schalter ────────────────────────────────────────────────────

test('Schalter: nur alle drei Variablen UND PAYPAL_ENV genau live', () => {
  const werte = { PAYPAL_CLIENT_ID: [undefined, '', 'cid'], PAYPAL_CLIENT_SECRET: [undefined, '  ', 'geheim'],
    PAYPAL_WEBHOOK_ID: [undefined, 'WH-1'], PAYPAL_ENV: [undefined, '', 'sandbox', 'LIVE', 'live ', 'production', 'live'] };
  let anzahl = 0, ein = 0;
  for (const a of werte.PAYPAL_CLIENT_ID) for (const b of werte.PAYPAL_CLIENT_SECRET)
    for (const c of werte.PAYPAL_WEBHOOK_ID) for (const d of werte.PAYPAL_ENV) {
      const env = {};
      if (a !== undefined) env.PAYPAL_CLIENT_ID = a;
      if (b !== undefined) env.PAYPAL_CLIENT_SECRET = b;
      if (c !== undefined) env.PAYPAL_WEBHOOK_ID = c;
      if (d !== undefined) env.PAYPAL_ENV = d;
      const k = pp.paypalKonfiguration(env);
      const soll = a === 'cid' && b === 'geheim' && c === 'WH-1' && d === 'live';
      assert.equal(k.vollstaendig, soll, JSON.stringify(env));
      assert.equal(k.zugang, a === 'cid' && b === 'geheim' && d === 'live', JSON.stringify(env));
      if (!soll) assert.ok(k.fehlend.length > 0);
      anzahl++; if (soll) ein++;
    }
  assert.equal(anzahl, 3 * 3 * 2 * 7);
  assert.equal(ein, 1);
  assert.equal(pp.paypalKonfiguration({}).teilweise, false);
  assert.equal(pp.paypalKonfiguration({ PAYPAL_ENV: 'sandbox' }).teilweise, true);
  assert.equal(JSON.stringify(pp.paypalKonfiguration(LIVE)).includes('geheim'), false, 'kein Geheimwert in der Ausgabe');
});

test('Schalter: Probe nur bei vollstaendiger Live-Einrichtung, Sandbox wird nie angesprochen', async () => {
  const kombis = [
    {}, { ...LIVE, PAYPAL_ENV: 'sandbox' }, { ...LIVE, PAYPAL_ENV: undefined }, { ...LIVE, PAYPAL_WEBHOOK_ID: '' },
    { ...LIVE, PAYPAL_CLIENT_SECRET: undefined }, { ...LIVE, PAYPAL_CLIENT_ID: '' }, { ...LIVE, PAYPAL_ENV: 'Live' },
  ];
  for (const env of kombis) {
    const f = fakePaypal();
    const istBereit = erstelleKontoPruefer({ abrufen: async () => { await pp.erstelleClient({ env, fetch: f.fetch }).token(); return true; } });
    assert.equal(await pp.paypalBereit({ env, istBereit }), false, JSON.stringify(env));
    assert.equal(f.aufrufe.length, 0, 'keine Anfrage an PayPal: ' + JSON.stringify(env));
  }
  const f = fakePaypal();
  const istBereit = erstelleKontoPruefer({ abrufen: async () => { await pp.erstelleClient({ env: LIVE, fetch: f.fetch }).token(); return true; } });
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit }), true);
  assert.equal(f.aufrufe.length, 1);
  assert.equal(f.aufrufe[0].url, 'https://api-m.paypal.com/v1/oauth2/token');
});

test('Client: ohne Live-Zugang keine einzige Anfrage, auch nicht fuer Einzug oder Erstattung', async () => {
  for (const env of [{ ...LIVE, PAYPAL_ENV: 'sandbox' }, { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'g' }, {}]) {
    const f = fakePaypal();
    const c = pp.erstelleClient({ env, fetch: f.fetch });
    await assert.rejects(c.token(), /nicht eingerichtet/);
    await assert.rejects(c.aufruf('/v2/payments/captures/X/refund', 'POST', 'tok', {}), /nicht eingerichtet/);
    assert.equal(f.aufrufe.length, 0);
  }
});

test('Schalter: fehlgeschlagene Probe -> aus; Zwischenspeicher 5 min / 1 min; Zeitlimit', async () => {
  let jetzt = 0;
  const f = fakePaypal({ tokenOk: false });
  const istBereit = erstelleKontoPruefer({ uhr: () => jetzt,
    abrufen: async () => { await pp.erstelleClient({ env: LIVE, fetch: f.fetch }).token(); return true; } });
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit }), false);
  assert.equal(f.aufrufe.length, 1);
  jetzt += 30 * 1000;
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit }), false);
  assert.equal(f.aufrufe.length, 1, 'Fehler 1 Minute zwischengespeichert');
  jetzt += 31 * 1000;
  const g = fakePaypal();   // PayPal geht wieder (neuer Pruefer, eigene Uhr)
  const istBereit2 = erstelleKontoPruefer({ uhr: () => jetzt,
    abrufen: async () => { await pp.erstelleClient({ env: LIVE, fetch: g.fetch }).token(); return true; } });
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: istBereit2 }), true);
  jetzt += 4 * MIN;
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: istBereit2 }), true);
  assert.equal(g.aufrufe.length, 1, 'Erfolg 5 Minuten zwischengespeichert');
  jetzt += 2 * MIN;
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: istBereit2 }), true);
  assert.equal(g.aufrufe.length, 2, 'nach 5 Minuten neu gefragt');

  // PayPal haengt: nach dem Zeitlimit aus, ohne zu werfen
  const langsam = erstelleKontoPruefer({ zeitlimitMs: 30, abrufen: () => new Promise(() => {}) });
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: langsam }), false);
  // Wirft der Pruefer selbst: aus
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: () => { throw new Error('x'); } }), false);
});

// ─── Bestellung anlegen ──────────────────────────────────────────

test('Bestellung fuer PayPal: gespeicherter Betrag, EUR, zwei Stellen, Rueckkehr- und Abbruchadresse', () => {
  const b = pp.bestellungFuerPaypal({ orderNum: 1042, total: 12.5, statusToken: 'abc_DEF', frontend: 'https://odis-ahaus.com', laden: 'Odi’s Bowl Ahaus' });
  assert.equal(b.intent, 'CAPTURE');
  assert.deepEqual(b.purchase_units[0].amount, { currency_code: 'EUR', value: '12.50' });
  assert.equal(b.purchase_units[0].custom_id, '1042');
  const x = b.payment_source.paypal.experience_context;
  assert.equal(x.return_url, 'https://odis-ahaus.com?order=1042&t=abc_DEF&paypal=1');
  assert.equal(x.cancel_url, 'https://odis-ahaus.com?payment=cancelled&paypal=1');
  assert.equal(x.user_action, 'PAY_NOW');
  assert.equal(pp.bestellungFuerPaypal({ orderNum: 1, total: 0.1 + 0.2, statusToken: 't', frontend: 'f', laden: 'l' }).purchase_units[0].amount.value, '0.30');
});

test('Freigabe-Link: nur https auf paypal.com', () => {
  assert.equal(pp.freigabeLink({ links: [{ rel: 'self', href: 'https://api-m.paypal.com/x' }, { rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=1' }] }), 'https://www.paypal.com/checkoutnow?token=1');
  assert.equal(pp.freigabeLink({ links: [{ rel: 'approve', href: 'https://www.paypal.com/checkoutnow?token=1' }] }), 'https://www.paypal.com/checkoutnow?token=1');
  assert.equal(pp.freigabeLink({ links: [{ rel: 'payer-action', href: 'https://boese.example/paypal.com/' }] }), null);
  assert.equal(pp.freigabeLink({}), null);
});

test('betragPruefen: Positionen muessen zur Zwischensumme passen', () => {
  const items = [{ name: 'Bowl', price: 11.9, qty: 2 }, { name: 'Cola', price: 2.9 }];
  assert.equal(pp.betragPruefen({ items, subtotal: 26.7, total: 28.69 }), null);
  assert.match(pp.betragPruefen({ items, subtotal: 5, total: 5.99 }), /geändert/);
  assert.match(pp.betragPruefen({ items: [], subtotal: 0, total: 0.99 }), /leer/);
  assert.match(pp.betragPruefen({ items: [{ price: -5, qty: 1 }, { price: 10, qty: 1 }], subtotal: 5, total: 5.99 }), /Ungültig/);
  assert.match(pp.betragPruefen({ items: [{ price: 5, qty: 0.5 }], subtotal: 2.5, total: 3.49 }), /Ungültig/);
  assert.match(pp.betragPruefen({ items: [{ price: 0, qty: 1 }], subtotal: 0, total: 0 }), /Bestellbetrag/);
});

test('istPaypalId: keine Objekte oder Sonderzeichen an Datenbank und PayPal', () => {
  assert.equal(pp.istPaypalId('5O190127TN364715T'), true);
  assert.equal(pp.istPaypalId({ $ne: null }), false);
  assert.equal(pp.istPaypalId('../../v1/x'), false);
  assert.equal(pp.istPaypalId(''), false);
});

// ─── Betragspruefung beim Einbuchen ──────────────────────────────

test('betragPasst: passt / zu wenig / falsche Waehrung', () => {
  assert.equal(pp.betragPasst({ wert: '23.49', waehrung: 'EUR' }, 23.49), true);
  assert.equal(pp.betragPasst({ wert: '23.5', waehrung: 'EUR' }, 23.5), true);
  assert.equal(pp.betragPasst({ wert: '23.48', waehrung: 'EUR' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: '0.01', waehrung: 'EUR' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: '23.50', waehrung: 'EUR' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: '23.49', waehrung: 'USD' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: '23.49' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: 'abc', waehrung: 'EUR' }, 23.49), false);
  assert.equal(pp.betragPasst(null, 23.49), false);
});

test('Abgleich: freigegeben -> eingezogen und eingebucht', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001');
  const s = fakeSpeicher([bestellung()]);
  const r = await pp.abgleichen({ order: bestellung(), client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.ergebnis, 'eingebucht');
  assert.equal(f.einzuege, 1);
  assert.equal(s.db.get('o1').paymentStatus, 'paid');
  assert.equal(s.db.get('o1').status, 'pending');
  assert.equal(s.db.get('o1').paypalCaptureId, 'CAPPPAAAA0001');
});

for (const [name, felder] of [['zu wenig bezahlt', { bezahlt: '20.00' }], ['falsche Waehrung', { waehrung: 'USD' }]]) {
  test(`Abgleich: ${name} -> NICHT eingebucht, laut gemeldet`, async () => {
    const f = fakePaypal(); f.anlegen('PPAAAA0001', felder);
    const s = fakeSpeicher([bestellung()]);
    const fehler = [];
    const r = await pp.abgleichen({ order: bestellung(), client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s,
      melden: { ...stumm, error: m => fehler.push(m) } });
    assert.equal(r.ergebnis, 'betrag');
    assert.equal(s.db.get('o1').status, 'awaiting_payment');
    assert.equal(s.db.get('o1').paymentStatus, 'pending');
    assert.equal(s.buchungen, 0);
    assert.match(fehler.join(' '), /NICHT eingebucht/);
    // Auch der Wachhund schliesst sie nicht ab (Geld ist geflossen, Mensch muss pruefen)
    const w = await pp.wachhundLauf({ orders: [bestellung({ createdAt: new Date(Date.now() - 90 * MIN) })],
      client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
    assert.deepEqual(w, { nachgeholt: [], abgeschlossen: [] });
    assert.equal(s.db.get('o1').status, 'awaiting_payment');
  });
}

test('Abgleich: Einzug PENDING bei PayPal -> nicht eingebucht, nicht abgeschlossen', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { einzugStatus: 'PENDING' });
  const s = fakeSpeicher([bestellung({ createdAt: new Date(Date.now() - 90 * MIN) })]);
  const r = await pp.abgleichen({ order: bestellung(), client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.ergebnis, 'wartet');
  const w = await pp.wachhundLauf({ orders: [{ ...s.db.get('o1') }], client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.deepEqual(w.abgeschlossen, []);
  assert.equal(s.db.get('o1').paymentStatus, 'pending');
});

test('Abgleich: PayPal-Bestellung gehoert zu einer anderen Nummer -> nichts gebucht', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { nr: 999, status: 'COMPLETED', einzug: { id: 'C', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '23.49' } } });
  const s = fakeSpeicher([bestellung()]);
  const r = await pp.abgleichen({ order: bestellung(), client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.ergebnis, 'fremd');
  assert.equal(s.buchungen, 0);
});

// ─── Kein doppeltes Einbuchen ────────────────────────────────────

test('Rueckkehr, Webhook und Wachhund gleichzeitig: ein Einzug, eine Buchung', async () => {
  for (const verzoegerung of [0, 3]) {
    const f = fakePaypal({ verzoegerung }); f.anlegen('PPAAAA0001');
    const alt = bestellung({ createdAt: new Date(Date.now() - 15 * MIN) });
    const s = fakeSpeicher([alt]);
    const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
    const ergebnisse = await Promise.all([
      pp.rueckkehrVerarbeiten({ body: { paypalOrderId: 'PPAAAA0001' }, env: LIVE, finden: s.finden, client, speicher: s, melden: stumm }),
      pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'), client, finden: s.finden, speicher: s, melden: stumm }),
      pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'), client, finden: s.finden, speicher: s, melden: stumm }),
      pp.wachhundLauf({ orders: [{ ...alt }], client, speicher: s, melden: stumm }),
      pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden, client, speicher: s, melden: stumm }),
    ]);
    assert.equal(f.einzuege, 1, 'PayPal zieht nur einmal ein');
    assert.equal(s.buchungen, 1, 'nur eine Buchung');
    assert.equal(ergebnisse[0].json.ok, true);
    assert.equal(ergebnisse[1].status, 200);
    assert.equal(s.db.get('o1').status, 'pending');
    // Spaete Wiederholung des Webhooks, nachdem die Kasse angenommen hat: bleibt, wie es ist
    s.db.get('o1').status = 'confirmed';
    const spaet = await pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'), client, finden: s.finden, speicher: s, melden: stumm });
    assert.equal(spaet.status, 200);
    assert.equal(s.db.get('o1').status, 'confirmed');
    assert.equal(s.buchungen, 1);
  }
});

// ─── Nie bezahlt: abschliessen ───────────────────────────────────

test('Wachhund: nie bezahlte PayPal-Bestellung wird nach einer Stunde abgeschlossen (kein Storno)', async () => {
  const f = fakePaypal();
  f.anlegen('PPAAAA0001', { status: 'PAYER_ACTION_REQUIRED' });
  f.anlegen('PPAAAA0002', { status: 'CREATED', nr: 1002 });
  const jung = bestellung({ createdAt: new Date(Date.now() - 30 * MIN) });
  const alt  = bestellung({ _id: 'o2', orderNum: 1002, paypalOrderId: 'PPAAAA0002', createdAt: new Date(Date.now() - 61 * MIN) });
  const weg  = bestellung({ _id: 'o3', orderNum: 1003, paypalOrderId: 'PPAAAA0003', createdAt: new Date(Date.now() - 61 * MIN) }); // bei PayPal unbekannt
  const s = fakeSpeicher([jung, alt, weg]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const w = await pp.wachhundLauf({ orders: [jung, alt, weg].map(o => ({ ...o })), client, speicher: s, melden: stumm });
  assert.deepEqual(w.abgeschlossen.sort(), [1002, 1003]);
  assert.equal(f.einzuege, 0);
  assert.equal(s.db.get('o1').status, 'awaiting_payment');
  for (const id of ['o2', 'o3']) {
    const o = s.db.get(id);
    assert.equal(o.status, 'cancelled');
    assert.equal(o.paymentStatus, 'pending', 'nie bezahlt: weder Kasse noch Umsatz noch Stornoliste');
    assert.equal(o.cancelReason, undefined);
  }
});

test('Wachhund: freigegeben, nicht eingezogen -> bis 2 h einziehen (nachgeholt), danach abschliessen ohne Einzug', async () => {
  const f = fakePaypal();
  f.anlegen('PPAAAA0001');
  f.anlegen('PPAAAA0002', { nr: 1002 });
  const frisch = bestellung({ createdAt: new Date(Date.now() - 12 * MIN) });
  const zuAlt  = bestellung({ _id: 'o2', orderNum: 1002, paypalOrderId: 'PPAAAA0002', createdAt: new Date(Date.now() - 121 * MIN) });
  const s = fakeSpeicher([frisch, zuAlt], { nachgeholt: true });
  const w = await pp.wachhundLauf({ orders: [{ ...frisch }, { ...zuAlt }], client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(w.nachgeholt.length, 1);
  assert.equal(w.nachgeholt[0].nachgeholt, true);
  assert.deepEqual(w.abgeschlossen, [1002]);
  assert.equal(f.einzuege, 1, 'die zu alte Freigabe wird nie eingezogen');
  assert.equal(s.db.get('o2').paymentStatus, 'pending');
});

test('Wachhund: juenger als 10 Minuten unberuehrt; ohne PayPal-Zugang erst nach einem Tag abschliessen', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001');
  const s = fakeSpeicher([bestellung({ createdAt: new Date(Date.now() - 5 * MIN) })]);
  await pp.wachhundLauf({ orders: [{ ...s.db.get('o1') }], client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(f.aufrufe.length, 0);
  assert.equal(s.db.get('o1').status, 'awaiting_payment');

  const t = fakeSpeicher([bestellung({ createdAt: new Date(Date.now() - 23 * 60 * MIN) }),
                          bestellung({ _id: 'o2', orderNum: 1002, createdAt: new Date(Date.now() - 25 * 60 * MIN) })]);
  const w = await pp.wachhundLauf({ orders: [...t.db.values()].map(o => ({ ...o })), client: null, speicher: t, melden: stumm });
  assert.deepEqual(w.abgeschlossen, [1002]);
  assert.equal(t.db.get('o1').status, 'awaiting_payment');
});

test('Wachhund wirft nie: PayPal nicht erreichbar -> uebersprungen, nichts abgeschlossen', async () => {
  const s = fakeSpeicher([bestellung({ createdAt: new Date(Date.now() - 90 * MIN) })]);
  const client = pp.erstelleClient({ env: LIVE, fetch: async () => { throw new Error('Netz weg'); } });
  const w = await pp.wachhundLauf({ orders: [{ ...s.db.get('o1') }], client, speicher: s, melden: stumm });
  assert.deepEqual(w, { nachgeholt: [], abgeschlossen: [] });
  assert.equal(s.db.get('o1').status, 'awaiting_payment');
});

// ─── Rueckkehr des Gastes ────────────────────────────────────────

test('Rueckkehr: abgelaufene Bestellung wird nie mehr eingezogen', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001');   // Gast hat nach Ablauf doch noch freigegeben
  const s = fakeSpeicher([bestellung({ status: 'cancelled', zahlungAbgelaufen: true })]);
  const r = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden,
    client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.abgelaufen, true);
  assert.equal(f.einzuege, 0);
  assert.equal(s.db.get('o1').status, 'cancelled');
});

test('Rueckkehr: Einzug lief beim Abschliessen gerade noch durch -> trotzdem eingebucht', async () => {
  const f = fakePaypal();
  f.anlegen('PPAAAA0001', { status: 'COMPLETED', einzug: { id: 'CAPX', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '23.49' } } });
  const s = fakeSpeicher([bestellung({ status: 'cancelled', zahlungAbgelaufen: true })]);
  const r = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden,
    client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.json.ok, true);
  assert.equal(s.db.get('o1').status, 'pending');
  assert.equal(s.db.get('o1').paymentStatus, 'paid');
});

test('Rueckkehr: abgelehnte Zahlungsquelle -> Hinweis, Bestellung sofort abgeschlossen', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { ablehnen: true });
  const s = fakeSpeicher([bestellung()]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const r = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden, client, speicher: s, melden: stumm });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.abgelehnt, true);
  assert.equal(s.db.get('o1').status, 'cancelled');
  assert.equal(s.db.get('o1').paymentStatus, 'pending');
});

test('Rueckkehr: noch nicht freigegeben, ungueltige ID, unbekannt, ohne Live-Zugang', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { status: 'PAYER_ACTION_REQUIRED' });
  const s = fakeSpeicher([bestellung()]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const a = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden, client, speicher: s, melden: stumm });
  assert.deepEqual([a.status, a.json.ok, a.json.abgelaufen], [200, false, undefined]);
  assert.equal(s.db.get('o1').status, 'awaiting_payment');
  assert.equal((await pp.rueckkehrVerarbeiten({ body: { token: { $ne: null } }, env: LIVE, finden: s.finden, client, speicher: s })).status, 400);
  assert.equal((await pp.rueckkehrVerarbeiten({ body: { token: 'PPZZZZ9999' }, env: LIVE, finden: s.finden, client, speicher: s })).status, 404);
  const g = fakePaypal(); g.anlegen('PPAAAA0001');
  const sb = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: { ...LIVE, PAYPAL_ENV: 'sandbox' }, finden: s.finden,
    client: pp.erstelleClient({ env: { ...LIVE, PAYPAL_ENV: 'sandbox' }, fetch: g.fetch }), speicher: s });
  assert.equal(sb.status, 503);
  assert.equal(g.aufrufe.length, 0);
  assert.equal(s.buchungen, 0);
});

// ─── Webhook ─────────────────────────────────────────────────────

test('Webhook: ohne gueltige Signatur wird nichts eingebucht', async () => {
  const f = fakePaypal({ verify: 'FAILURE' }); f.anlegen('PPAAAA0001');
  const s = fakeSpeicher([bestellung()]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const r = await pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'), client, finden: s.finden, speicher: s, melden: stumm });
  assert.equal(r.status, 400);
  assert.equal(f.einzuege, 0);
  assert.equal(s.buchungen, 0);
  // Ohne Signatur-Kopfzeilen wird PayPal gar nicht erst gefragt
  const g = fakePaypal(); g.anlegen('PPAAAA0001');
  const r2 = await pp.webhookVerarbeiten({ env: LIVE, headers: { 'paypal-auth-algo': 'x' }, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'),
    client: pp.erstelleClient({ env: LIVE, fetch: g.fetch }), finden: s.finden, speicher: s, melden: stumm });
  assert.equal(r2.status, 400);
  assert.equal(g.aufrufe.length, 0);
  assert.equal(s.buchungen, 0);
});

test('Webhook: ohne PAYPAL_WEBHOOK_ID oder ohne live -> 503, nichts eingebucht, keine Anfrage', async () => {
  for (const env of [{ ...LIVE, PAYPAL_WEBHOOK_ID: '' }, { ...LIVE, PAYPAL_ENV: 'sandbox' }]) {
    const f = fakePaypal(); f.anlegen('PPAAAA0001');
    const s = fakeSpeicher([bestellung()]);
    const r = await pp.webhookVerarbeiten({ env, headers: kopf, event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'),
      client: pp.erstelleClient({ env, fetch: f.fetch }), finden: s.finden, speicher: s, melden: stumm });
    assert.equal(r.status, 503);
    assert.equal(f.aufrufe.length, 0);
    assert.equal(s.buchungen, 0);
  }
});

test('Webhook: Antworten - eigene Fehler erneut, fremde Ereignisse nicht endlos', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001');
  const s = fakeSpeicher([bestellung()]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const w = (event, extra = {}) => pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event, client, finden: s.finden, speicher: s, melden: stumm, ...extra });
  // unbekanntes Ereignis
  assert.deepEqual(await w({ event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: {} }), { status: 200, json: { received: true, ignoriert: true } });
  // Bestellung aus einem anderen Shop desselben PayPal-Kontos
  assert.equal((await w(ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPFREMD0001'))).json.ignoriert, true);
  // Datenbank gestoert -> 500 (PayPal stellt erneut zu)
  assert.equal((await w(ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'), { finden: async () => { throw new Error('DB weg'); } })).status, 500);
  // Signaturpruefung bei PayPal gerade nicht moeglich -> 503
  const g = fakePaypal({ verifyWirft: true });
  assert.equal((await pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'),
    client: pp.erstelleClient({ env: LIVE, fetch: g.fetch }), finden: s.finden, speicher: s, melden: stumm })).status, 503);
  assert.equal(s.buchungen, 0);
  // gueltig -> eingezogen und eingebucht
  const ok = await w(ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'));
  assert.equal(ok.status, 200);
  assert.equal(s.db.get('o1').paymentStatus, 'paid');
  // Die Signaturpruefung bekam die Webhook-ID und das Ereignis
  const v = f.aufrufe.find(a => a.url.endsWith('/verify-webhook-signature'));
  assert.equal(JSON.parse(v.body).webhook_id, 'WH-1');
  assert.equal(JSON.parse(v.body).transmission_sig, 'sig');
});

test('Webhook: Betrag passt nicht -> 200 (Wiederholung hilft nicht), aber nicht eingebucht', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { bezahlt: '1.00' });
  const s = fakeSpeicher([bestellung()]);
  const r = await pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'),
    client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), finden: s.finden, speicher: s, melden: stumm });
  assert.equal(r.status, 200);
  assert.equal(s.buchungen, 0);
  assert.equal(s.db.get('o1').paymentStatus, 'pending');
});

test('Anlegen ueber den Client: Request-Id und gespeicherter Betrag gehen an PayPal', async () => {
  const f = fakePaypal();
  const c = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const o = await c.bestellungAnlegen(pp.bestellungFuerPaypal({ orderNum: 1001, total: 23.49, statusToken: 't', frontend: 'https://odis-ahaus.com', laden: 'L' }), 'odis-1001-t');
  assert.equal(pp.istPaypalId(o.id), true);
  assert.equal(pp.freigabeLink(o), `https://www.paypal.com/checkoutnow?token=${o.id}`);
  const post = f.aufrufe.find(a => a.url.endsWith('/v2/checkout/orders'));
  assert.equal(post.headers['PayPal-Request-Id'], 'odis-1001-t');
  assert.equal(JSON.parse(post.body).purchase_units[0].amount.value, '23.49');
  assert.ok(f.aufrufe.every(a => a.url.startsWith('https://api-m.paypal.com/')));
});

test('Webhook-Ereignisse fuer die PayPal-App', () => {
  assert.deepEqual(pp.WEBHOOK_EREIGNISSE, ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED']);
  assert.equal(pp.ppOrderIdAusEreignis(ereignis('CHECKOUT.ORDER.APPROVED', 'PPX0000001')), 'PPX0000001');
  assert.equal(pp.ppOrderIdAusEreignis(ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPX0000001')), 'PPX0000001');
});
