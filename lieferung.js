// ─── Lieferung und "nur im Laden": Pruefung jeder Web-Bestellung ─────────
// Gilt fuer POST /api/orders (bar), /api/create-stripe-checkout und
// /api/create-paypal-order. Regeln (Abed, 17.11.2026 abends):
//
//  - Lieferung nach Fahrstrecke ab Wallstrasse 7: bis 2 km 1,50 €, bis 5 km
//    2,50 € (je Mindestbestellwert 20 €), bis 9 km 5,50 € (Mindestbestellwert
//    40 €), darueber keine Lieferung. Zahlen: liefergebiet.json -> liefergebiet.js.
//  - Zone, Liefergebuehr und Mindestbestellwert rechnet der Server SELBST aus der
//    Adresse. Was der Aufrufer als deliveryFee schickt, zaehlt nie.
//  - Abholung: keine Liefergebuehr, kein Mindestbestellwert.
//  - Açaí-Bowls (menu.json: nur_im_laden) sind online gar nicht bestellbar,
//    weder zur Lieferung noch zur Abholung - nur im Laden.
//
// Bewusst als reine Funktion in eigener Datei: server.js verbindet sich beim
// Laden mit der Datenbank, diese Datei laesst sich ohne alles testen
// (test/lieferung.test.js).

const TELEFON = '02561 8916861';
// Ortsteile von Ahaus: in liefergebiet.json ohne "(Ort)", wie Ahaus selbst
const ORTSTEILE = ['wullen', 'wessum', 'ottenstein', 'alstatte', 'graes'];

function euro(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}

function lieferFehlertexte(grenzeKm) {
  const km = String(grenzeKm).replace('.', ',');
  return {
    'strasse-fehlt':     'Bitte gib Straße und Hausnummer an.',
    'nr-fehlt':          'Bitte gib eine Hausnummer an.',
    'mehrdeutig':        'Diese Straße gibt es in mehreren Orten – bitte wähle den Ort aus der Liste.',
    'strasse-unbekannt': `Diese Straße kennen wir nicht oder sie liegt außerhalb unseres Liefergebiets (bis ${km} km Fahrstrecke). Ruf uns gern an: ${TELEFON}.`,
    'nr-unbekannt':      `Diese Hausnummer kennen wir nicht. Ruf uns bitte an: ${TELEFON}.`,
    'zu-weit':           `Diese Adresse liegt außerhalb unseres Liefergebiets – wir liefern bis ${km} km Fahrstrecke. Abholung ist natürlich möglich.`,
  };
}

const NUR_IM_LADEN_TEXT = 'Açaí-Bowls gibt es nur bei uns im Laden – online sind sie nicht bestellbar, '
  + 'weder zur Lieferung noch zur Abholung. Bitte nimm die Açaí-Bowl aus dem Warenkorb.';

/**
 * @param {object} o
 * @param {object} o.gebiet          Liefergebiet.erstelle(liefergebiet.json)
 * @param {string[]} o.nurImLadenNamen  Artikelnamen aus menu.json (nur_im_laden)
 */
function erstellePruefer({ gebiet, nurImLadenNamen }) {
  const namen = (nurImLadenNamen || []).filter(Boolean);
  // Im Warenkorb heisst es "Açaí-Bowl Classic" usw. - Vergleich per
  // Namensanfang, ohne Gross-/Kleinschreibung und auch ohne Akzente
  // ("Acai-Bowl"), damit eine umgeschriebene Bezeichnung nicht durchrutscht.
  const ohneAkzent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const vergleich = namen.map(ohneAkzent);
  const nurImLaden = name => vergleich.some(n => ohneAkzent(name).startsWith(n));
  const texte = lieferFehlertexte(gebiet.grenzeKm);

  // Warenwert ohne Gebuehren aus den Positionen. Weicht die mitgeschickte
  // Zwischensumme ab, zaehlt der kleinere Wert - so laesst sich der
  // Mindestbestellwert nicht mit einer hochgesetzten subtotal umgehen.
  function warenwert(body) {
    const items = Array.isArray(body.items) ? body.items : [];
    const ausPositionen = items.reduce((s, i) =>
      s + (Number(i && i.price) || 0) * (Number(i && i.qty) || 1), 0);
    const sub = Number(body.subtotal);
    return Number.isFinite(sub) ? Math.min(ausPositionen, sub) : ausPositionen;
  }

  /**
   * Prueft eine Web-Bestellung und setzt deliveryFee (und bei Lieferung die
   * nachgeschlagene Adresse) im body selbst.
   * @returns {{ fehler: string } | { ok: true, zone: object|null }}
   */
  function pruefe(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { fehler: 'Ungültige Bestellung.' };
    }
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.some(i => i && nurImLaden(i.name))) return { fehler: NUR_IM_LADEN_TEXT };

    if (body.mode !== 'lieferung') {
      body.deliveryFee = 0;          // Abholung: nie eine Liefergebuehr
      return { ok: true, zone: null };
    }

    const c = body.customer && typeof body.customer === 'object' ? body.customer : {};
    const strasse = typeof c.street === 'string' ? c.street : '';
    const ort = typeof c.city === 'string' ? c.city.trim() : '';
    // Die Seite schickt den Ort aus der Vorschlagsliste ("Heek"); Ahaus und
    // seine Ortsteile ("Ahaus-Wüllen", "Ottenstein") stehen ohne Zusatz.
    const inAhaus = !ort || /^ahaus\b/i.test(ort) || ORTSTEILE.includes(ohneAkzent(ort));
    const eingabe = !inAhaus && !/\(/.test(strasse) ? `${strasse} (${ort})` : strasse;
    const t = gebiet.finde(eingabe, typeof c.house === 'string' || typeof c.house === 'number' ? String(c.house) : '');
    if (t.status !== 'ok') return { fehler: texte[t.status] || 'Diese Adresse können wir leider nicht beliefern.' };

    const wert = warenwert(body);
    if (wert + 0.005 < t.mindestwert) {
      return { fehler: `Der Mindestbestellwert für Lieferung an diese Adresse beträgt ${euro(t.mindestwert)} `
        + `(Warenwert ohne Gebühren) – es fehlen noch ${euro(t.mindestwert - wert)}. Abholung geht ohne Mindestbestellwert.` };
    }

    body.deliveryFee = t.gebuehr;
    body.customer = { ...c, street: t.strasse, house: t.nr, city: t.ort };
    return { ok: true, zone: { nr: t.zone, bisKm: t.bisKm, gebuehr: t.gebuehr, mindestwert: t.mindestwert, meter: t.meter } };
  }

  return { pruefe, nurImLaden, warenwert };
}

module.exports = { erstellePruefer, NUR_IM_LADEN_TEXT, lieferFehlertexte };
