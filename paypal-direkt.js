// ═══════════════════════════════════════════════════════════════
// PAYPAL DIREKT (Odi's Bowl Ahaus, 19.11.2026)
// ═══════════════════════════════════════════════════════════════
// PayPal laeuft NICHT ueber Stripe (das geht mit Direct Charges nicht), sondern
// direkt ueber die REST-App im eigenen PayPal-Geschaeftskonto des Ladens: Das Geld
// geht direkt auf sein PayPal-Konto. Orders v2, intent CAPTURE, ohne SDK.
//
// Der Schalter: PayPal gilt erst als eingerichtet, wenn PAYPAL_CLIENT_ID,
// PAYPAL_CLIENT_SECRET und PAYPAL_WEBHOOK_ID gesetzt sind, PAYPAL_ENV genau `live`
// ist UND eine Probe-Anmeldung bei PayPal (Token holen) gelingt. Mit Sandbox-Daten
// kann auf dieser Seite nie "bezahlt" werden: Ohne PAYPAL_ENV=live gibt es keinen
// einzigen PayPal-Aufruf, weder Bestellung noch Einzug noch Webhook.
//
// Geld bewegt sich bei intent CAPTURE erst mit dem Einzug (capture), und den
// macht nur dieser Server. Deshalb:
//  - eingezogen wird nur, solange die Bestellung hier auf `awaiting_payment` steht;
//    eine abgelaufene (nie bezahlte) Bestellung wird nie mehr eingezogen;
//  - eingebucht wird nur, wenn PayPal den Einzug als COMPLETED meldet und Betrag und
//    Waehrung genau zur gespeicherten Bestellung passen;
//  - Einbuchen ist atomar und nur aus `awaiting_payment` heraus (server.js), Rueckkehr,
//    Webhook und Wachhund koennen also gleichzeitig laufen, ohne doppelt zu buchen.
//    PayPal selbst nimmt fuer eine Bestellung nur einen Einzug an.
//
// Dieses Modul enthaelt nur, was sich ohne Express, Mongoose und echtes PayPal
// rechnen laesst. PayPal-Aufrufe gehen ueber eine injizierbare fetch-Funktion,
// die Datenbank ueber ein injiziertes `speicher`-Objekt (test/paypal-direkt.test.js).

const LIVE_BASIS = 'https://api-m.paypal.com';
const PAYPAL_VARIABLEN = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'];

// Fristen fuer Wachhund und Aufraeumen (alle 5 Minuten, server.js)
const FRISTEN = {
  // Erst danach greift der Wachhund ein; vorher laufen Rueckkehr und Webhook.
  wachhundMinuten: 10,
  // Nie bezahlt (bei PayPal nicht freigegeben): nach einer Stunde abgeschlossen wie
  // eine abgelaufene Stripe-Zahlung. Stripe schliesst seine Zahlseite nach 31 Minuten.
  abbruchMinuten: 60,
  // Freigegeben, aber nie eingezogen: nur bis 2 Stunden nach der Bestellung noch
  // einziehen (wie WACHHUND_HOECHSTENS_STUNDEN bei Stripe). Danach wartet kein Gast
  // mehr; die Bestellung wird abgeschlossen, ohne dass Geld fliesst.
  einziehenHoechstensStunden: 2,
  // PayPal nicht (mehr) eingerichtet: ohne Rueckfrage abschliessen, aber erst nach
  // einem Tag. Eingezogen werden kann ohne Zugang ohnehin nichts.
  ohneZugangStunden: 24,
  // Aeltere Bestellungen fasst der Wachhund nicht mehr an.
  hoechstensTage: 7,
};

// ─── Schalter ────────────────────────────────────────────────────

// Was ist gesetzt? Nie Geheimwerte, nur Ja/Nein und die fehlenden Namen.
//  zugang:       Client-ID und Secret gesetzt und PAYPAL_ENV=live -> Einziehen,
//                Abgleichen und Erstatten fuer bestehende Bestellungen
//  vollstaendig: zusaetzlich PAYPAL_WEBHOOK_ID -> neue Bestellungen und Webhook
function paypalKonfiguration(env = {}) {
  const gesetzt = n => typeof env[n] === 'string' && env[n].trim() !== '';
  const live = env.PAYPAL_ENV === 'live';
  const fehlend = PAYPAL_VARIABLEN.filter(n => !gesetzt(n));
  if (!live) fehlend.push('PAYPAL_ENV=live');
  const irgendwas = PAYPAL_VARIABLEN.some(gesetzt) || (typeof env.PAYPAL_ENV === 'string' && env.PAYPAL_ENV !== '');
  return {
    live,
    zugang:       live && gesetzt('PAYPAL_CLIENT_ID') && gesetzt('PAYPAL_CLIENT_SECRET'),
    vollstaendig: fehlend.length === 0,
    teilweise:    irgendwas && fehlend.length > 0,
    fehlend,
    clientId:     gesetzt('PAYPAL_CLIENT_ID') ? env.PAYPAL_CLIENT_ID.trim() : null,
  };
}

// Entscheidung fuer /api/config und create-paypal-order: true nur, wenn alles gesetzt
// ist UND die Probe-Anmeldung gelingt. istBereit kommt aus
// stripeDirekt.erstelleKontoPruefer (Zwischenspeicher 5 min / Fehler 1 min, 4 s
// Zeitlimit). Fragt PayPal nur, wenn alles gesetzt ist. Wirft nie.
async function paypalBereit({ env, istBereit }) {
  try {
    const k = paypalKonfiguration(env);
    if (!k.vollstaendig) return false;
    return (await istBereit(k.clientId)) === true;
  } catch {
    return false;
  }
}

// ─── PayPal-Aufrufe ──────────────────────────────────────────────

class PaypalFehler extends Error {
  constructor(text, { status, name } = {}) {
    super(text);
    this.status = status;     // HTTP-Status von PayPal
    this.paypalName = name;   // z. B. ORDER_ALREADY_CAPTURED, RESOURCE_NOT_FOUND
  }
}

// Client fuer genau ein env. Wirft bei jedem Aufruf, wenn kein Live-Zugang gesetzt
// ist - die Sandbox wird nie angesprochen.
function erstelleClient({ env, fetch: holen = globalThis.fetch, zeitlimitMs = 15000 }) {
  async function anfrage(url, optionen) {
    const k = paypalKonfiguration(env);
    if (!k.zugang) throw new PaypalFehler('PayPal nicht eingerichtet (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=live)');
    const r = await holen(url, { ...optionen, signal: AbortSignal.timeout(zeitlimitMs) });
    const text = await r.text();
    let daten = {};
    try { daten = text ? JSON.parse(text) : {}; } catch { daten = { message: text.slice(0, 200) }; }
    return { r, daten };
  }

  async function token() {
    const id = String(env.PAYPAL_CLIENT_ID || '').trim(), geheim = String(env.PAYPAL_CLIENT_SECRET || '').trim();
    const { r, daten } = await anfrage(`${LIVE_BASIS}/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${Buffer.from(`${id}:${geheim}`).toString('base64')}`,
                 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok || !daten.access_token) {
      throw new PaypalFehler('PayPal Auth: ' + (daten.error_description || daten.error || r.status), { status: r.status, name: daten.error });
    }
    return daten.access_token;
  }

  // Wie das frühere paypalApi(path, method, token, body) in server.js
  async function aufruf(pfad, methode, zugangsToken, body, { requestId, vollstaendig } = {}) {
    const headers = { 'Authorization': `Bearer ${zugangsToken}`, 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    if (vollstaendig) headers['Prefer'] = 'return=representation';
    const { r, daten } = await anfrage(`${LIVE_BASIS}${pfad}`, {
      method: methode, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) {
      const name = daten.name || (Array.isArray(daten.details) && daten.details[0] && daten.details[0].issue) || undefined;
      const issue = Array.isArray(daten.details) && daten.details[0] && daten.details[0].issue;
      throw new PaypalFehler(`PayPal API ${pfad}: ${daten.message || daten.error_description || r.status}${issue ? ' (' + issue + ')' : ''}`,
        { status: r.status, name: issue || name });
    }
    return daten;
  }

  async function bestellungLesen(ppOrderId, t) {
    return aufruf(`/v2/checkout/orders/${encodeURIComponent(ppOrderId)}`, 'GET', t || await token());
  }
  async function einziehen(ppOrderId, t) {
    return aufruf(`/v2/checkout/orders/${encodeURIComponent(ppOrderId)}/capture`, 'POST', t || await token(), {}, { vollstaendig: true });
  }
  async function bestellungAnlegen(body, requestId) {
    return aufruf('/v2/checkout/orders', 'POST', await token(), body, { requestId, vollstaendig: true });
  }
  async function signaturPruefen(daten) {
    return aufruf('/v1/notifications/verify-webhook-signature', 'POST', await token(), daten);
  }
  return { token, aufruf, bestellungLesen, einziehen, bestellungAnlegen, signaturPruefen };
}

// ─── Bestellung anlegen ──────────────────────────────────────────

// PayPal-Bestellnummern sind kurze Zeichenketten aus Grossbuchstaben und Ziffern.
// Alles andere (auch Objekte wie {"$ne": null}) wird nie an Datenbank oder PayPal gereicht.
const istPaypalId = id => typeof id === 'string' && /^[A-Za-z0-9-]{6,64}$/.test(id);

const cent = n => Math.round(Number(n) * 100);
const euroText = n => (cent(n) / 100).toFixed(2);

// Prueft den Warenkorb einer PayPal-Bestellung, bevor ein Betrag an PayPal geht.
// total ist der Betrag, den der Server speichert (wie bei Stripe aus subtotal und
// Gebuehren gerechnet). Bei PayPal wird genau dieser Betrag eingezogen - anders als bei
// Stripe gibt es keine Einzelposten, die PayPal selbst summiert. Damit eine
// heruntergesetzte subtotal nicht billiger macht, muss sie zu den Positionen passen.
function betragPruefen({ items, subtotal, total }) {
  if (!Array.isArray(items) || !items.length) return 'Der Warenkorb ist leer.';
  const kaputt = i => !i || typeof i !== 'object' || !(Number(i.price) >= 0)
    || (i.qty !== undefined && !(Number.isInteger(Number(i.qty)) && Number(i.qty) >= 1));
  if (items.some(kaputt)) return 'Ungültiger Warenkorb. Bitte lade die Seite neu.';
  const ausPositionen = items.reduce((s, i) => s + cent((Number(i && i.price) || 0) * (Number(i && i.qty) || 1)), 0);
  if (!Number.isFinite(Number(subtotal)) || Math.abs(ausPositionen - cent(subtotal)) > 1) {
    return 'Der Warenkorb hat sich geändert. Bitte lade die Seite neu und versuche es erneut.';
  }
  if (!Number.isFinite(Number(total)) || cent(total) <= 0) return 'Ungültiger Bestellbetrag.';
  return null;
}

// Rumpf fuer POST /v2/checkout/orders. Betrag = gespeicherter Gesamtbetrag, EUR, zwei
// Nachkommastellen. reference_id/custom_id = Bestellnummer (wird beim Einbuchen geprueft).
function bestellungFuerPaypal({ orderNum, total, statusToken, frontend, laden }) {
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: String(orderNum),
      custom_id:    String(orderNum),
      description:  `${laden} Bestellung #${orderNum}`,
      amount: { currency_code: 'EUR', value: euroText(total) },
    }],
    payment_source: { paypal: { experience_context: {
      brand_name:          laden,
      locale:              'de-DE',
      user_action:         'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      // Nur Zahlarten, die sofort bestaetigt werden (kein eCheck mit Tagen Wartezeit)
      payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
      // PayPal haengt an beide Adressen ?token=<PayPal-Bestellnummer> an
      return_url: `${frontend}?order=${orderNum}&t=${statusToken}&paypal=1`,
      cancel_url: `${frontend}?payment=cancelled&paypal=1`,
    } } },
  };
}

// Freigabe-Link aus der Antwort (payment_source: payer-action, frueher: approve)
function freigabeLink(ppOrder) {
  const l = ((ppOrder && ppOrder.links) || []).find(x => x && (x.rel === 'payer-action' || x.rel === 'approve'));
  return l && typeof l.href === 'string' && /^https:\/\/([a-z0-9-]+\.)*paypal\.com\//.test(l.href) ? l.href : null;
}

// ─── Zahlung auswerten ───────────────────────────────────────────

// Der Einzug einer PayPal-Bestellung (Antwort von GET oder capture). Bei mehreren
// zaehlt der abgeschlossene.
function einzugAus(ppOrder) {
  const pu = ppOrder && Array.isArray(ppOrder.purchase_units) ? ppOrder.purchase_units[0] : null;
  const caps = pu && pu.payments && Array.isArray(pu.payments.captures) ? pu.payments.captures : [];
  const c = caps.find(x => x && x.status === 'COMPLETED') || caps[0];
  if (!c) return null;
  return {
    id: c.id, status: c.status,
    wert: c.amount ? c.amount.value : undefined,
    waehrung: c.amount ? c.amount.currency_code : undefined,
  };
}

// Gehoert die PayPal-Bestellung zu dieser Bestellung? (custom_id/reference_id)
function gehoertZu(ppOrder, order) {
  const pu = ppOrder && Array.isArray(ppOrder.purchase_units) ? ppOrder.purchase_units[0] : null;
  if (!pu) return false;
  const nr = String(order.orderNum);
  return pu.custom_id === nr || pu.reference_id === nr;
}

// Passt der bei PayPal bezahlte Betrag genau zur gespeicherten Bestellung?
function betragPasst(einzug, total) {
  if (!einzug || einzug.waehrung !== 'EUR') return false;
  if (typeof einzug.wert !== 'string' || !/^\d+(\.\d{1,2})?$/.test(einzug.wert)) return false;
  return cent(einzug.wert) === cent(total) && cent(total) > 0;
}

// ─── Abgleich: das eine Verfahren fuer Rueckkehr, Webhook und Wachhund ──
//
// Fragt PayPal nach dem Stand, zieht eine freigegebene Zahlung ein (nur wenn
// `einziehenErlaubt`), und bucht ein, wenn der Einzug abgeschlossen ist und Betrag und
// Waehrung passen. speicher.einbuchen(order, einzug) muss atomar sein und nur aus
// `awaiting_payment` (oder einer gerade abgelaufenen Bestellung, s. server.js) heraus
// buchen; es liefert die gebuchte Bestellung oder null.
//
// Ergebnis: { ergebnis, order?, ppStatus? } mit ergebnis
//  'eingebucht'  - jetzt gebucht (dieser Aufruf)
//  'schon'       - war schon gebucht (anderer Weg kam zuerst)
//  'offen'       - bei PayPal (noch) nicht bezahlt; ppStatus sagt, in welchem Stand
//  'wartet'      - Einzug liegt bei PayPal auf PENDING (Geld noch nicht da)
//  'betrag'      - bezahlt, aber Betrag/Waehrung passen nicht: NICHT eingebucht
//  'fremd'       - PayPal-Bestellung gehoert nicht zu dieser Bestellung
async function abgleichen({ order, client, speicher, einziehenErlaubt = true, melden = console }) {
  if (!order || !istPaypalId(order.paypalOrderId)) return { ergebnis: 'fremd' };
  const t = await client.token();
  let pp;
  try {
    pp = await client.bestellungLesen(order.paypalOrderId, t);
  } catch (e) {
    if (e.status === 404) return { ergebnis: 'offen', ppStatus: 'NICHT_GEFUNDEN' };
    throw e;
  }
  if (!gehoertZu(pp, order)) {
    melden.error(`🚨 PayPal: Bestellung ${order.paypalOrderId} gehoert nicht zu #${order.orderNum} - nichts gebucht`);
    return { ergebnis: 'fremd' };
  }

  let einzug = einzugAus(pp);
  let ppStatus = pp.status;
  if (pp.status === 'APPROVED' && !einzug && einziehenErlaubt && order.status === 'awaiting_payment') {
    try {
      const antwort = await client.einziehen(order.paypalOrderId, t);
      einzug = einzugAus(antwort);
      ppStatus = antwort.status || ppStatus;
    } catch (e) {
      // Zahlungsquelle abgelehnt: kein Geld geflossen. Der Aufrufer schliesst ab.
      if (e.paypalName === 'INSTRUMENT_DECLINED') return { ergebnis: 'offen', ppStatus: 'EINZUG_DECLINED' };
      // Ein anderer Weg (Rueckkehr, Webhook, Wachhund) hat schon eingezogen.
      if (e.paypalName !== 'ORDER_ALREADY_CAPTURED') throw e;
    }
    if (!einzug || einzug.wert === undefined) {
      const neu = await client.bestellungLesen(order.paypalOrderId, t);
      einzug = einzugAus(neu);
      ppStatus = neu.status;
    }
  }

  if (einzug && einzug.status === 'COMPLETED') {
    if (!betragPasst(einzug, order.total)) {
      melden.error(`🚨 PayPal: #${order.orderNum} bezahlt ${einzug.wert} ${einzug.waehrung}, erwartet ${euroText(order.total)} EUR`
        + ` - NICHT eingebucht (Einzug ${einzug.id}). Bitte im PayPal-Konto des Ladens pruefen.`);
      return { ergebnis: 'betrag', ppStatus };
    }
    const gebucht = await speicher.einbuchen(order, einzug);
    return gebucht ? { ergebnis: 'eingebucht', order: gebucht, ppStatus } : { ergebnis: 'schon', ppStatus };
  }
  if (einzug && einzug.status === 'PENDING') return { ergebnis: 'wartet', ppStatus };
  return { ergebnis: 'offen', ppStatus: einzug ? `EINZUG_${einzug.status}` : ppStatus };
}

// Einzug bei PayPal abgelehnt oder gescheitert: endgueltig, es floss kein Geld
const abgelehnt = ppStatus => /^EINZUG_(DECLINED|FAILED)$/.test(ppStatus || '');

// ─── Rueckkehr des Gastes (POST /api/paypal-capture) ─────────────

// Liefert { status, json } fuer die Route.
async function rueckkehrVerarbeiten({ body, env, finden, client, speicher, melden = console }) {
  if (!paypalKonfiguration(env).zugang) {
    return { status: 503, json: { ok: false, message: 'PayPal ist derzeit nicht verfügbar.' } };
  }
  const id = body && (body.paypalOrderId || body.token);
  if (!istPaypalId(id)) return { status: 400, json: { ok: false, message: 'paypalOrderId fehlt' } };
  const order = await finden(id);
  if (!order) return { status: 404, json: { ok: false, message: 'Bestellung nicht gefunden' } };
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
    return { status: 200, json: { ok: true, orderNum: order.orderNum } };
  }
  // Abgelaufen oder storniert: nie mehr einziehen. War der Einzug gerade noch
  // durchgelaufen (Wettlauf mit dem Aufraeumen), bucht abgleichen ihn trotzdem ein.
  const r = await abgleichen({ order, client, speicher, einziehenErlaubt: order.status === 'awaiting_payment', melden });
  if (r.ergebnis === 'eingebucht' || r.ergebnis === 'schon') {
    return { status: 200, json: { ok: true, orderNum: order.orderNum } };
  }
  if (order.status !== 'awaiting_payment') {
    return { status: 200, json: { ok: false, abgelaufen: true, orderNum: order.orderNum,
      message: 'Diese PayPal-Zahlung ist abgelaufen, es wurde nichts abgebucht. Bitte bestelle erneut.' } };
  }
  if (r.ergebnis === 'offen' && abgelehnt(r.ppStatus)) {
    // Sofort abschliessen: Der Gast erfaehrt "nichts abgebucht" und bestellt vielleicht
    // neu - dann darf der Wachhund diese Bestellung nie mehr einziehen.
    await speicher.abschliessen(order);
    return { status: 200, json: { ok: false, abgelehnt: true, orderNum: order.orderNum,
      message: 'PayPal hat die Zahlung abgelehnt, es wurde nichts abgebucht. Bitte versuche es erneut oder wähle eine andere Zahlungsart.' } };
  }
  return { status: 200, json: { ok: false, orderNum: order.orderNum, message: 'Noch nicht bezahlt' } };
}

// ─── Webhook (POST /api/paypal-webhook) ──────────────────────────

// Ereignisse, die der Laden in seiner PayPal-App abonnieren muss
const WEBHOOK_EREIGNISSE = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED'];
// Weitere, die nur einen Abgleich ausloesen, falls sie doch abonniert sind
const WEBHOOK_ABGLEICH = new Set([...WEBHOOK_EREIGNISSE, 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED']);

// PayPal-Bestellnummer aus dem Ereignis
function ppOrderIdAusEreignis(event) {
  const r = event && event.resource;
  if (!r) return null;
  if (String(event.event_type).startsWith('CHECKOUT.ORDER.')) return r.id;
  return r.supplementary_data && r.supplementary_data.related_ids ? r.supplementary_data.related_ids.order_id : null;
}

// Antworten (PayPal stellt bei allem ausser 2xx erneut zu, bis zu 3 Tage lang):
//  503 eigene Einrichtung fehlt / Pruefung bei PayPal gerade nicht moeglich -> erneut
//  500 eigener Fehler beim Verarbeiten (Datenbank, PayPal-Abfrage)           -> erneut
//  400 Signatur ungueltig oder Kopfzeilen fehlen (nicht von PayPal)
//  200 verarbeitet, oder fremdes/unbekanntes Ereignis bzw. unbekannte Bestellung
//      (eine Wiederholung aendert daran nichts)
async function webhookVerarbeiten({ env, headers = {}, event, client, finden, speicher, jetzt = new Date(), melden = console }) {
  const k = paypalKonfiguration(env);
  if (!k.vollstaendig) {
    melden.error('PayPal-Webhook: PayPal nicht vollstaendig eingerichtet (' + k.fehlend.join(', ') + ') - nichts eingebucht');
    return { status: 503, json: { message: 'PayPal nicht eingerichtet' } };
  }
  const kopf = n => (typeof headers[n] === 'string' ? headers[n] : '');
  const pflicht = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (pflicht.some(n => !kopf(n)) || !event || typeof event !== 'object' || Array.isArray(event)) {
    melden.warn('PayPal-Webhook: ohne Signatur-Kopfzeilen - abgewiesen');
    return { status: 400, json: { message: 'invalid signature' } };
  }
  let pruefung;
  try {
    pruefung = await client.signaturPruefen({
      auth_algo: kopf('paypal-auth-algo'), cert_url: kopf('paypal-cert-url'),
      transmission_id: kopf('paypal-transmission-id'), transmission_sig: kopf('paypal-transmission-sig'),
      transmission_time: kopf('paypal-transmission-time'),
      webhook_id: env.PAYPAL_WEBHOOK_ID.trim(), webhook_event: event,
    });
  } catch (e) {
    melden.error('PayPal-Webhook: Signaturpruefung nicht moeglich:', e.message);
    return { status: 503, json: { message: 'Signaturpruefung nicht moeglich' } };
  }
  if (!pruefung || pruefung.verification_status !== 'SUCCESS') {
    melden.warn('PayPal-Webhook: ungueltige Signatur - nichts eingebucht');
    return { status: 400, json: { message: 'invalid signature' } };
  }

  if (!WEBHOOK_ABGLEICH.has(event.event_type)) return { status: 200, json: { received: true, ignoriert: true } };
  const id = ppOrderIdAusEreignis(event);
  if (!istPaypalId(id)) return { status: 200, json: { received: true, ignoriert: true } };
  try {
    const order = await finden(id);
    if (!order) return { status: 200, json: { received: true, ignoriert: true } };   // nicht aus diesem Laden
    const alterMs = jetzt - new Date(order.createdAt || jetzt);
    const r = await abgleichen({ order, client, speicher, melden,
      einziehenErlaubt: alterMs <= FRISTEN.einziehenHoechstensStunden * 3600 * 1000 });
    if (r.ergebnis === 'eingebucht') melden.log(`💳 Bezahlt (PayPal, Webhook): #${order.orderNum} → wartet auf Bestätigung`);
    return { status: 200, json: { received: true } };
  } catch (e) {
    melden.error('PayPal-Webhook Verarbeitung fehlgeschlagen:', e.message);
    return { status: 500, json: { message: 'Verarbeitung fehlgeschlagen' } };
  }
}

// ─── Wachhund und Aufraeumen (alle 5 Minuten) ────────────────────

// Fuer jede PayPal-Bestellung auf `awaiting_payment`, die aelter als
// FRISTEN.wachhundMinuten ist:
//  - bei PayPal bezahlt -> einbuchen (nachgeholt, Alarm wie bei Stripe)
//  - bei PayPal freigegeben (APPROVED), juenger als 2 h -> einziehen und einbuchen
//  - nie bezahlt und aelter als FRISTEN.abbruchMinuten -> abschliessen wie eine
//    abgelaufene Stripe-Zahlung (cancelled, kein Storno, keine Mail)
//  - ohne PayPal-Zugang erst nach FRISTEN.ohneZugangStunden abschliessen
// speicher.abschliessen(order) muss atomar und nur aus `awaiting_payment` heraus setzen.
// Liefert { nachgeholt: [orders], abgeschlossen: [orderNums] }. Wirft nie.
async function wachhundLauf({ orders, client, speicher, jetzt = new Date(), fristen = FRISTEN, melden = console }) {
  const nachgeholt = [], abgeschlossen = [];
  for (const order of orders || []) {
    try {
      const alterMin = (jetzt - new Date(order.createdAt)) / 60000;
      if (alterMin < fristen.wachhundMinuten) continue;
      if (!client) {
        if (alterMin >= fristen.ohneZugangStunden * 60 && await speicher.abschliessen(order)) {
          abgeschlossen.push(order.orderNum);
          melden.warn(`PayPal nicht eingerichtet: #${order.orderNum} nie bezahlt, abgeschlossen`);
        }
        continue;
      }
      const einziehenErlaubt = alterMin <= fristen.einziehenHoechstensStunden * 60;
      const r = await abgleichen({ order, client, speicher, einziehenErlaubt, melden });
      if (r.ergebnis === 'eingebucht') {
        nachgeholt.push(r.order);
        melden.error(`🚨 PayPal-Wachhund: #${order.orderNum} war bezahlt und unsichtbar - jetzt auf pending`);
        continue;
      }
      if (r.ergebnis !== 'offen') {
        if (r.ergebnis === 'wartet') melden.warn(`PayPal: #${order.orderNum} Einzug wartet bei PayPal (PENDING)`);
        continue;   // schon, wartet, betrag, fremd: nicht abschliessen
      }
      // Nie bezahlt. APPROVED bleibt offen, solange noch eingezogen werden darf;
      // ein abgelehnter Einzug ist endgueltig und wird sofort abgeschlossen.
      const darfAbschliessen = abgelehnt(r.ppStatus)
        || (alterMin >= fristen.abbruchMinuten && !(r.ppStatus === 'APPROVED' && einziehenErlaubt));
      if (darfAbschliessen && await speicher.abschliessen(order)) {
        abgeschlossen.push(order.orderNum);
        melden.log(`PayPal: #${order.orderNum} nie bezahlt (${r.ppStatus}), abgeschlossen`);
      }
    } catch (e) {
      melden.warn(`PayPal-Wachhund uebersprungen #${order && order.orderNum}: ${e.message}`);
    }
  }
  return { nachgeholt, abgeschlossen };
}

module.exports = {
  LIVE_BASIS, PAYPAL_VARIABLEN, FRISTEN, WEBHOOK_EREIGNISSE, PaypalFehler,
  paypalKonfiguration, paypalBereit, erstelleClient,
  istPaypalId, betragPruefen, bestellungFuerPaypal, freigabeLink,
  einzugAus, gehoertZu, betragPasst, abgleichen,
  rueckkehrVerarbeiten, webhookVerarbeiten, ppOrderIdAusEreignis, wachhundLauf,
};
