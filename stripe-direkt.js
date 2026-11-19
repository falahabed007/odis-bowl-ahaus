// ═══════════════════════════════════════════════════════════════
// STRIPE: NUR DIRECT CHARGES (Odi's Bowl Ahaus, 17.11.2026)
// ═══════════════════════════════════════════════════════════════
// Jede Online-Zahlung entsteht direkt auf dem eigenen Stripe-Konto des Ladens
// (STRIPE_DIREKT_KONTO, ein mit der FlueVate-Plattform verbundenes Standard-
// Konto). Der Server nutzt den Plattform-Schluessel STRIPE_SECRET_KEY und gibt
// bei JEDEM Stripe-Aufruf zu einer Zahlung die Option { stripeAccount } mit
// ("Direct Charge"). Es gibt keine Plattformgebuehr in der Zahlung und keine
// Weiterleitung an ein anderes Konto. Stripe zieht seine Gebuehr beim Laden
// selbst ab. FlueVate rechnet Grundgebuehr (150 €/Monat) und Servicegebuehr
// (0,99 € je Bestellung) per Rechnung und SEPA-Lastschrift ab, ausserhalb
// dieses Repos.
//
// Anders als bei Amoura (Vorlage: Zweig stripe-direkt, 486a39f) gibt es hier
// KEINEN Rueckweg auf das Plattformkonto und keinen Stichtag: Ahaus hatte nie ein
// altes Konto. Ist das Direktkonto nicht bereit, gibt es keine Online-Zahlung,
// nur Barzahlung bei Abholung.
//
// Dieses Modul enthaelt nur, was sich ohne Express, Mongoose und Stripe rechnen
// laesst, damit es Tests ohne Datenbank gibt (node --test). Einzige Abhaengigkeit
// ist Nodes eigenes crypto.

const crypto = require('crypto');

// ─── Einstellungen ───────────────────────────────────────────────

// Die drei Variablen, ohne die es keine Online-Zahlung gibt.
const STRIPE_VARIABLEN = ['STRIPE_SECRET_KEY', 'STRIPE_DIREKT_KONTO', 'STRIPE_CONNECT_WEBHOOK_SECRET'];

// Was ist gesetzt? Liefert nie Geheimwerte, nur Ja/Nein, die Kontonummer und
// die Namen der fehlenden Variablen (fuer Startmeldung und Warnung).
function stripeKonfiguration(env = {}) {
  const gesetzt = n => typeof env[n] === 'string' && env[n].trim() !== '';
  const fehlend = STRIPE_VARIABLEN.filter(n => !gesetzt(n));
  return {
    konto:        gesetzt('STRIPE_DIREKT_KONTO') ? env.STRIPE_DIREKT_KONTO.trim() : null,
    vollstaendig: fehlend.length === 0,
    teilweise:    fehlend.length > 0 && fehlend.length < STRIPE_VARIABLEN.length,
    fehlend,
  };
}

// ─── Konto bereit? (charges_enabled, mit Zwischenspeicher) ───────

// Liefert eine Funktion istBereit(konto) -> Promise<boolean>. Sie fragt hoechstens
// alle `ttlMs` bei Stripe nach (Fehler: alle `fehlerTtlMs`), wartet nie laenger als
// `zeitlimitMs` und wirft nie: Jeder Fehler heisst "nicht bereit", also nur bar.
// `abrufen(konto)` muss true liefern, wenn charges_enabled === true ist.
function erstelleKontoPruefer({ abrufen, ttlMs = 5 * 60 * 1000, fehlerTtlMs = 60 * 1000,
                                zeitlimitMs = 4000, uhr = () => Date.now(), melden = () => {} }) {
  let speicher = null;   // { konto, bereit, bis }
  let laufend  = null;   // { konto, promise } - gleichzeitige Anfragen teilen sich eine Abfrage

  async function frageStripe(konto) {
    let timer;
    try {
      const ergebnis = await Promise.race([
        Promise.resolve().then(() => abrufen(konto)),
        new Promise((_, nein) => { timer = setTimeout(() => nein(new Error('Zeitlimit')), zeitlimitMs); }),
      ]);
      const bereit = ergebnis === true;
      speicher = { konto, bereit, bis: uhr() + ttlMs };
      return bereit;
    } catch (e) {
      try { melden(e); } catch { /* Melden darf nie stoeren */ }
      speicher = { konto, bereit: false, bis: uhr() + fehlerTtlMs };
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function istBereit(konto) {
    if (!konto) return false;
    if (speicher && speicher.konto === konto && uhr() < speicher.bis) return speicher.bereit;
    if (laufend && laufend.konto === konto) return laufend.promise;
    const promise = frageStripe(konto);
    laufend = { konto, promise };
    try { return await promise; } finally { if (laufend && laufend.promise === promise) laufend = null; }
  }
  // Nach einem gescheiterten Checkout: eine Minute lang keine Online-Zahlung anbieten,
  // danach fragt der Pruefer Stripe neu.
  istBereit.vergessen = () => { speicher = null; };
  istBereit.alsNichtBereitMerken = konto => { speicher = { konto, bereit: false, bis: uhr() + fehlerTtlMs }; };
  return istBereit;
}

// Entscheidung fuer Checkout und /api/config: das Direktkonto (acct_...), wenn alle
// drei Variablen gesetzt sind UND Stripe das Konto freigibt, sonst null (keine
// Online-Zahlung). Fragt Stripe nur, wenn alles gesetzt ist. Wirft nie.
async function direktKontoWaehlen({ env, istBereit }) {
  try {
    const k = stripeKonfiguration(env);
    if (!k.vollstaendig) return null;
    return (await istBereit(k.konto)) === true ? k.konto : null;
  } catch {
    return null;
  }
}

// ─── Webhook ─────────────────────────────────────────────────────

// Der Connect-Endpunkt bekommt die Ereignisse ALLER Laeden der Plattform. Verarbeitet
// wird nur, was oben `account` = eigenes Direktkonto traegt. Ereignisse ohne
// `account` (Plattformkonto) gibt es fuer diesen Laden nicht: Hier entsteht keine
// Zahlung auf der Plattform, also wird auch keine von dort verarbeitet.
function ereignisFuerUns(event, direktKonto) {
  if (!event || typeof event.account !== 'string' || !event.account) return false;
  return typeof direktKonto === 'string' && direktKonto !== '' && event.account === direktKonto;
}

// ─── Echte Stripe-Gebuehr ────────────────────────────────────────

// Aus einem PaymentIntent mit expand ['latest_charge.balance_transaction'] die
// Gebuehr in Cent. null, solange Stripe sie noch nicht kennt.
function gebuehrCentAusPaymentIntent(pi) {
  const bt = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge.balance_transaction : null;
  const fee = bt && typeof bt === 'object' ? bt.fee : undefined;
  return Number.isInteger(fee) && fee >= 0 ? fee : null;
}

// ─── Abrechnung ──────────────────────────────────────────────────

// Online-Bestellung auf dem eigenen Stripe-Konto des Ladens.
const istDirektBestellung = o => !!o && o.payment === 'stripe' && !!o.stripeAccount;

// Abrechnung fuer Wochen- und Monatsbericht. Hier gibt es nur zwei Arten:
//  - Online (Stripe): Umsatz liegt vollstaendig auf dem eigenen Stripe-Konto des
//    Ladens. Stripe zieht dort seine echte Gebuehr ab (nur gespeicherte Werte aus
//    stripeGebuehrCent, nichts geschaetzt; fehlende zaehlen als "noch nicht bekannt").
//  - PayPal: Umsatz liegt auf dem eigenen PayPal-Konto des Ladens. PayPal zieht dort
//    seine Gebuehr ab; sie ist dem System nicht bekannt und steht nicht im Bericht.
//  - alles andere (Bar, alte EC-Karte): liegt in der Kasse.
// FlueVate behaelt von keiner Zahlung etwas ein. Grundgebuehr (nur Monatsbericht),
// Domain und Servicegebuehr fuer ALLE Bestellungen werden per Rechnung und
// SEPA-Lastschrift eingezogen.
//
// Jede Online-Bestellung entsteht in diesem Laden auf dem Direktkonto (es gibt
// keinen anderen Weg in create-stripe-checkout). Eine Stripe-Bestellung ohne
// stripeAccount waere ein Fehler; sie wird mitgezaehlt und in nOhneKonto gemeldet,
// statt still unter "Bar" zu verschwinden.
//
// fix: { sv, grund, domain } - Standard-Servicegebuehr, Grundgebuehr, Domain.
function berichtAbrechnung(orders, mitFixkosten, fix) {
  const { sv, grund, domain } = fix;
  const r2     = n => Math.round(n * 100) / 100;
  const summe  = (liste, f) => r2(liste.reduce((s, o) => s + f(o), 0));
  const online = orders.filter(o => o.payment === 'stripe');
  const paypal = orders.filter(o => o.payment === 'paypal');
  const laden  = orders.filter(o => o.payment !== 'stripe' && o.payment !== 'paypal');
  const bekannt = online.filter(o => Number.isInteger(o.stripeGebuehrCent) && o.stripeGebuehrCent >= 0);
  const a = {
    n: orders.length, nOnline: online.length, nLaden: laden.length, nPaypal: paypal.length,
    nOhneKonto: online.filter(o => !istDirektBestellung(o)).length,
    umsatzOnline: summe(online, o => o.total || 0),
    umsatzLaden:  summe(laden,  o => o.total || 0),
    umsatzPaypal: summe(paypal, o => o.total || 0),
    // Ganze Cent addieren, erst am Ende in Euro: keine Rundungsreste
    stripeGeb: bekannt.reduce((s, o) => s + o.stripeGebuehrCent, 0) / 100,
    nStripeGebUnbekannt: online.length - bekannt.length,
    svc:    summe(orders, o => o.serviceFee || sv),
    grund:  mitFixkosten ? grund : 0,
    domain: mitFixkosten ? domain : 0,
  };
  a.brutto           = r2(a.umsatzOnline + a.umsatzLaden + a.umsatzPaypal);
  a.verbleibtStripe  = r2(a.umsatzOnline - a.stripeGeb);
  a.fluevate         = r2(a.grund + a.domain + a.svc);    // per Rechnung und SEPA-Lastschrift
  a.bleibt           = r2(a.brutto - a.stripeGeb - a.fluevate);
  return a;
}

// ─── Texte fuer PDF und Mail (eine Quelle) ───────────────────────

const eur = n => n.toFixed(2).replace('.', ',') + ' €';

// "41 × 0,99 €", solange jede Bestellung die Standardgebuehr traegt, sonst nur die Anzahl
const svcText = (n, betrag, sv) => Math.abs(betrag - n * sv) < 0.005 ? `${n} × ${eur(sv)}` : `${n} Bestellungen`;

function stripeGebText(a) {
  const bekannt = a.nOnline - a.nStripeGebUnbekannt;
  return a.nStripeGebUnbekannt && bekannt
    ? `Stripe-Gebühren  (bekannt für ${bekannt} von ${a.nOnline} Zahlungen)`
    : 'Stripe-Gebühren  (zieht Stripe dort selbst ab)';
}
// Wert der Gebuehrenzeile: "noch nicht bekannt", wenn Stripe keine einzige gemeldet hat
const stripeGebWert = (a, minus) => a.nStripeGebUnbekannt === a.nOnline ? 'noch nicht bekannt' : minus(a.stripeGeb);

function stripeHinweis(a) {
  const k = a.nStripeGebUnbekannt;
  return 'Online-Zahlungen gehen vollständig auf Ihr eigenes Stripe-Konto. Stripe zieht seine Gebühren dort selbst ab. '
    + 'FlueVate behält davon nichts ein.'
    + (k ? ` Bei ${k === 1 ? 'einer Zahlung' : k + ' Zahlungen'} ist die Stripe-Gebühr noch nicht bekannt. Sie fehlt in den Summen.` : '');
}

function paypalHinweis() {
  return 'PayPal-Zahlungen gehen vollständig auf Ihr eigenes PayPal-Konto. PayPal zieht seine Gebühren dort selbst ab; '
    + 'sie sind in diesem Bericht nicht enthalten. FlueVate behält davon nichts ein.';
}

function fluevateHinweis(a) {
  return 'Die Gebühren von FlueVate werden nicht von Ihren Einnahmen abgezogen, sondern per Rechnung und SEPA-Lastschrift eingezogen.'
    + (a.grund ? '' : ' Die monatliche Grundgebühr steht im Monatsbericht.');
}

// Tabellenzeilen fuer die Mail an Restaurant und Inhaber
function abrechnungMailZeilen(a, fix) {
  const td = 'style="padding:8px"', tdr = 'style="padding:8px;text-align:right"';
  const hinweis = t => `<tr><td colspan="2" style="padding:0 8px 8px;font-size:12px;color:#666">${t}</td></tr>`;
  const teile = [a.grund && 'Grundgebühr', a.domain && 'Domain', `Servicegebühr ${svcText(a.n, a.svc, fix.sv)}`].filter(Boolean).join(', ');
  return `<tr><td ${td}>Gesamtumsatz (Brutto)</td><td ${tdr}>${eur(a.brutto)}</td></tr>`
    + (a.nOnline
      ? `<tr style="background:#f5f5f5"><td ${td}><b>Online-Zahlung (Ihr Stripe-Konto)</b> (${a.nOnline} Bestellungen)</td><td ${tdr}><b>${eur(a.umsatzOnline)}</b></td></tr>`
      + `<tr><td ${td}>${stripeGebText(a).replace('  (', ' (')}</td><td ${tdr}>${stripeGebWert(a, eur)}</td></tr>`
      + `<tr style="background:#f5f5f5"><td ${td}>Verbleibt auf Ihrem Stripe-Konto</td><td ${tdr}>${eur(a.verbleibtStripe)}</td></tr>`
      + hinweis(stripeHinweis(a))
      : '')
    + (a.nPaypal
      ? `<tr style="background:#f5f5f5"><td ${td}><b>PayPal (Ihr PayPal-Konto)</b> (${a.nPaypal} Bestellungen)</td><td ${tdr}><b>${eur(a.umsatzPaypal)}</b></td></tr>`
      + hinweis(paypalHinweis())
      : '')
    + `<tr><td ${td}>Barzahlung in Ihrer Kasse (${a.nLaden} Bestellungen)</td><td ${tdr}>${eur(a.umsatzLaden)}</td></tr>`
    + `<tr style="background:#f5f5f5"><td ${td}><b>Gebühren FlueVate</b> (${teile}), per Rechnung und SEPA-Lastschrift</td><td ${tdr}><b>${eur(a.fluevate)}</b></td></tr>`
    + hinweis(fluevateHinweis(a))
    + `<tr style="background:#e8f5e9"><td style="padding:10px;font-weight:bold;color:#2e7d32;font-size:15px">Ihnen bleiben nach allen Gebühren</td><td style="padding:10px;text-align:right;font-weight:bold;color:#2e7d32;font-size:15px">${eur(a.bleibt)}</td></tr>`;
}

// Fliesstext fuer die Mail an Abed (was per SEPA einzuziehen ist)
function abrechnungOwnerText(a) {
  const teile = [a.grund && `Grundgebühr ${eur(a.grund)}`, a.domain && `Domain ${eur(a.domain)}`,
    `Servicegebühr ${eur(a.svc)} (${a.n} Bestellungen)`].filter(Boolean).join(', ');
  return `<b>Per Rechnung und SEPA-Lastschrift einziehen:</b> ${eur(a.fluevate)} (${teile})`
    + (a.nOnline ? `<br><b>Eigenes Stripe-Konto des Ladens:</b> ${eur(a.umsatzOnline)} (${a.nOnline} Zahlungen), `
      + `Stripe-Gebühren ${eur(a.stripeGeb)}${a.nStripeGebUnbekannt ? `, bei ${a.nStripeGebUnbekannt} noch unbekannt` : ''}` : '')
    + (a.nPaypal ? `<br><b>Eigenes PayPal-Konto des Ladens:</b> ${eur(a.umsatzPaypal)} (${a.nPaypal} Zahlungen), PayPal-Gebühren nicht bekannt` : '')
    + `<br><b>Bar in der Kasse:</b> ${eur(a.umsatzLaden)} (${a.nLaden} Bestellungen)`
    + (a.nOhneKonto ? `<br><b>Achtung:</b> ${a.nOhneKonto} Stripe-Bestellung(en) ohne gespeichertes Konto, bitte prüfen.` : '');
}

// ─── Hilfen ──────────────────────────────────────────────────────

// Zeitkonstanter Vergleich: ein normales === verraet ueber die Laufzeit,
// wie viele Zeichen am Anfang schon stimmen.
function gleichSicher(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  STRIPE_VARIABLEN, stripeKonfiguration, erstelleKontoPruefer, direktKontoWaehlen,
  ereignisFuerUns, gebuehrCentAusPaymentIntent, istDirektBestellung, berichtAbrechnung,
  svcText, stripeGebText, stripeGebWert, stripeHinweis, fluevateHinweis, paypalHinweis,
  abrechnungMailZeilen, abrechnungOwnerText, gleichSicher,
};
