// ─── Umsatzsteuer je Bestellung ──────────────────────────────────
// Der Steuerberater muss jede einzelne Bestellung den Steuersätzen für Speisen
// (heute 7 %) und Getränke (heute 19 %) zuordnen können. Diese Datei rechnet das
// aus - ohne Datenbank, ohne .env, ohne Mailversand (Tests: test/umsatzsteuer.test.js).
//
// Alle Regeln stehen hier an EINER Stelle:
//
//   1. Getränk ist, was in Menue/menu.json in der Kategorie mit der id
//      GETRAENKE_KATEGORIE steht oder in _listen.getraenke. Alles andere ist
//      Speise. Es gibt bewusst keine zweite, handgepflegte Liste.
//      Bestellpositionen tragen nur name, price (Stückpreis inkl. Extras), qty und
//      extraDetails[{name, price}]. Zugeordnet wird über den Namen, wie beim
//      Ausverkauft-Schalter über den NAMENSANFANG: "Bowl (Menü)" ist eine Bowl,
//      "Açaí-Bowl Classic" eine Açaí-Bowl (Name + Größe, siehe baukasten.js).
//   2. Menü (Bowl oder Wrap "(Menü)" mit Getränk, Aufpreis laut Karte; das Getränk
//      steht als extraDetail "Getränk: <Name>"): Der Positionspreis wird im
//      Verhältnis der Einzelverkaufspreise geteilt - Einzelpreis des Getränks laut
//      Karte zu Einzelpreis des Gerichts samt seiner übrigen Aufpreise
//      (= Positionspreis ohne den Menü-Aufpreis). Getränkeanteil 19 %, Rest 7 %.
//   3. Liefergebühr und Servicegebühr sind Nebenleistungen und folgen der
//      Hauptleistung: Sie werden im Verhältnis der Warenumsätze der Bestellung auf
//      die Steuersätze verteilt. Ein Rabatt (discount) ebenso.
//   4. Alle Preise sind brutto. Netto = Brutto / (1 + Satz), Steuer = Brutto - Netto,
//      je Bestellung und Steuersatz kaufmännisch auf Cent gerundet. Brutto Speisen +
//      Brutto Getränke ergibt immer exakt order.total (ein Rundungscent geht an den
//      größeren Anteil). Weicht total von Positionen + Gebühren - Rabatt ab, steht
//      der Unterschied im Feld `abweichung` - nichts wird versteckt.
//   5. Eine Position, die sich nicht zuordnen lässt (Name nicht in der Karte, etwa
//      eine alte Bestellung nach einer Kartenänderung), zählt als Speise und steht
//      in `unklar`. Die Berichte nennen Anzahl und Bestellnummern solcher Fälle.
//   6. Kleinunternehmer: UST_MODUS=kleinunternehmer (Standard: regel). Dann weisen
//      Berichte und Mails keine Umsatzsteuer aus, sondern KLEINUNTERNEHMER_HINWEIS.
//   7. Eine Bestellung wird mit den Sätzen ihres Bestelldatums (Europe/Berlin)
//      gerechnet. Ein späterer Satzwechsel ist ein neuer Eintrag in STEUERSAETZE.
//
// Die Ergebnisfelder heißen wie vom Steuerberater gewünscht brutto7 … ust19.
// Genau genommen ist "7" der Anteil zum Speisen-Satz und "19" der zum Getränke-Satz;
// welche Prozente das für eine Bestellung waren, steht in `saetze`. Die Summen
// (summieren) gruppieren zusätzlich nach den echten Prozentsätzen (nachSatz).
'use strict';

const fs = require('fs');

// ── Regel 7: Steuersätze mit Stichtag ────────────────────────────
// gueltigAb ist ein Berliner Kalendertag (einschließlich). Neuer Satz = neue Zeile,
// nach Datum aufsteigend. Bestellungen vor dem ersten Stichtag rechnen mit der
// ersten Zeile (Abholung und Lieferung von Speisen waren auch vorher schon 7 %;
// den Laden gibt es erst seit November 2026).
const STEUERSAETZE = [
  // Seit 01.01.2026 gilt für Speisen in der Gastronomie dauerhaft 7 %,
  // Getränke bleiben beim Regelsatz 19 %.
  { gueltigAb: '2026-01-01', speisen: 7, getraenke: 19 },
];
const UST_STICHTAG = STEUERSAETZE[0].gueltigAb;

// ── Regel 1: woran ein Getränk erkannt wird ──────────────────────
const GETRAENKE_KATEGORIE = 'getraenke';   // kategorien[].id in menu.json
const GETRAENKE_LISTE     = 'getraenke';   // _listen.getraenke in menu.json

// ── Regel 2: woran ein Menü erkannt wird (baukasten.js) ──────────
const MENUE_NAMENSZUSATZ = /\(Menü\)\s*$/;          // "Bowl (Menü)"
const MENUE_GETRAENK     = /^\s*Getränk:\s*(.+)$/;  // extraDetail "Getränk: Coca-Cola Zero"

// ── Regel 6: Kleinunternehmer ────────────────────────────────────
const UST_MODI = ['regel', 'kleinunternehmer'];
const KLEINUNTERNEHMER_HINWEIS = 'Kein Ausweis von Umsatzsteuer (§ 19 UStG)';

// Version der gespeicherten Aufteilung (Feld umsatzsteuer an der Bestellung)
const VERSION = 1;

// ─── kleine Helfer ───────────────────────────────────────────────
// Euro → Cent ohne Gleitkomma-Rauschen (2.9*100 = 290.00000000000003)
function cent(eur) {
  const n = Number(eur);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number((n * 100).toFixed(6)));
}
// Kaufmännisch runden (ab ,5 weg von null); das kleine Epsilon fängt
// Gleitkomma-Reste wie 274,49999999 ab, die eigentlich 274,5 sind.
function rund(x) {
  return Math.sign(x) * Math.floor(Math.abs(x) + 0.5 + 1e-9);
}
const euro = c => c / 100;

function berlinTag(datum) {
  const d = datum instanceof Date ? datum : new Date(datum);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });   // YYYY-MM-DD
}

// Regel 7: Satzpaar für ein Bestelldatum
function saetzeAm(datum) {
  const tag = berlinTag(datum || new Date()) || berlinTag(new Date());
  let gilt = STEUERSAETZE[0];
  for (const s of STEUERSAETZE) if (s.gueltigAb <= tag) gilt = s;
  return { speisen: gilt.speisen, getraenke: gilt.getraenke };
}

function ustModus(env) {
  const m = String((env && env.UST_MODUS) || 'regel').trim().toLowerCase();
  return UST_MODI.includes(m) ? m : 'regel';
}

// Namen vergleichbar machen: Unicode einheitlich, Leerraum zusammengefasst,
// Groß/klein egal, Allergen-Kürzel am Ende weg (wie cleanName in server.js).
function norm(name) {
  return String(name == null ? '' : name)
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s[A-Z0-9](,[A-Z0-9])+$/, '')
    .toLowerCase();
}

// ─── Karte ───────────────────────────────────────────────────────
// Aus menu.json ein Nachschlageverzeichnis bauen.
function karteAusMenu(menu) {
  const artikel = [];
  const nummern = new Set();
  const kategorien = (menu && Array.isArray(menu.kategorien)) ? menu.kategorien : [];
  for (const kat of kategorien) {
    const getraenk = kat && kat.id === GETRAENKE_KATEGORIE;
    for (const it of (kat && kat.items) || []) {
      if (!it || !it.name) continue;
      if (it.num) nummern.add(String(it.num).toLowerCase());
      artikel.push({
        name: it.name, key: norm(it.name),
        art: getraenk ? 'getraenk' : 'speise',
        preis: typeof it.preis === 'number' ? it.preis : null,
        menueAufpreis: typeof it.menue === 'number' ? it.menue : null,
      });
    }
  }
  const liste = (menu && menu._listen && menu._listen[GETRAENKE_LISTE]) || [];
  for (const name of liste) {
    const key = norm(name);
    const da = artikel.find(a => a.key === key);
    if (da) da.art = 'getraenk';
    else artikel.push({ name, key, art: 'getraenk', preis: null, menueAufpreis: null });
  }
  return { artikel, nummern };
}

// Karte aus der Datei, neu gelesen nur wenn sich die Datei geändert hat.
// Wirft nie: Ist die Datei kaputt, bleibt der letzte gute Stand; gab es nie
// einen, kommt eine leere Karte (dann ist jede Position "nicht eindeutig").
const karteCache = new Map();   // pfad -> { mtimeMs, karte }
function karteLaden(pfad) {
  const alt = karteCache.get(pfad);
  try {
    const mtimeMs = fs.statSync(pfad).mtimeMs;
    if (alt && alt.mtimeMs === mtimeMs) return alt.karte;
    const karte = karteAusMenu(JSON.parse(fs.readFileSync(pfad, 'utf8')));
    if (!karte.artikel.length) throw new Error('keine Artikel');
    karteCache.set(pfad, { mtimeMs, karte });
    return karte;
  } catch (e) {
    console.error('Umsatzsteuer: Speisekarte nicht lesbar:', e.message);
    return alt ? alt.karte : { artikel: [], nummern: new Set() };
  }
}

// Positionsname → Kartenartikel. Erst exakt, dann der längste Kartenname, mit dem
// der Positionsname beginnt (danach Leerzeichen oder Klammer). Eine führende
// Artikelnummer ("G1 Coca-Cola Original", openQuickAdd in index.html) zählt nicht mit.
function finde(karte, name) {
  if (!karte || !karte.artikel || !karte.artikel.length) return null;
  let n = norm(name);
  const erstes = n.split(' ')[0];
  if (n.includes(' ') && karte.nummern && karte.nummern.has(erstes)) n = n.slice(erstes.length + 1);
  if (!n) return null;
  let best = null;
  for (const a of karte.artikel) {
    if (a.key === n) return a;
    if (n.startsWith(a.key) && /[ (]/.test(n.charAt(a.key.length))) {
      if (!best || a.key.length > best.key.length) best = a;
    }
  }
  return best;
}

// Eine Position → { speisen, getraenke } in Cent (Gleitkomma erlaubt, gerundet
// wird erst je Bestellung) und ggf. ein Eintrag für `unklar`.
function positionAufteilen(pos, karte) {
  const p = pos || {};
  const q = Number(p.qty);
  const menge = Number.isFinite(q) && q >= 0 ? q : 1;
  const zeile = cent(p.price) * menge;
  const name = String(p.name || '').trim() || '(ohne Namen)';
  const ergebnis = (speisen, getraenke, grund) =>
    ({ zeile, speisen, getraenke, unklar: grund ? { name, grund } : null });
  if (zeile === 0) return ergebnis(0, 0, null);

  const treffer = finde(karte, name);
  if (!treffer) return ergebnis(zeile, 0, 'nicht in der Speisekarte, als Speise gerechnet');
  const extras = Array.isArray(p.extraDetails) ? p.extraDetails : [];
  const getrExtra = extras.find(e => e && MENUE_GETRAENK.test(String(e.name || '')));
  const istMenue = MENUE_NAMENSZUSATZ.test(name) || !!getrExtra;

  if (treffer.art === 'getraenk') return ergebnis(0, zeile, null);
  if (!istMenue) return ergebnis(zeile, 0, null);

  // Regel 2: Menü im Verhältnis der Einzelverkaufspreise teilen
  const getrName = getrExtra ? String(getrExtra.name).match(MENUE_GETRAENK)[1] : '';
  const getr = getrName ? finde(karte, getrName) : null;
  if (!getr || getr.art !== 'getraenk' || !(getr.preis > 0)) {
    return ergebnis(zeile, 0, getrName
      ? `Menü-Getränk "${getrName}" ohne Einzelpreis in der Karte, ganz als Speise gerechnet`
      : 'Menü ohne erkennbares Getränk, ganz als Speise gerechnet');
  }
  const aufpreis = cent(getrExtra.price) || cent(treffer.menueAufpreis);
  const gericht = cent(p.price) - aufpreis;              // Gericht samt übriger Aufpreise
  if (gericht <= 0) return ergebnis(zeile, 0, 'Menüpreis nicht plausibel, ganz als Speise gerechnet');
  const getraenkEinzeln = cent(getr.preis);
  const getraenke = zeile * getraenkEinzeln / (getraenkEinzeln + gericht);
  return ergebnis(zeile - getraenke, getraenke, null);
}

// ─── Regel 1-5: eine Bestellung aufteilen ────────────────────────
function aufteilen(order, karte) {
  const o = order || {};
  const saetze = saetzeAm(o.createdAt || new Date());
  const unklar = [];
  let waren = 0, speisen = 0, getraenke = 0;
  for (const pos of Array.isArray(o.items) ? o.items : []) {
    const r = positionAufteilen(pos, karte);
    waren += r.zeile; speisen += r.speisen; getraenke += r.getraenke;
    if (r.unklar) unklar.push(r.unklar);
  }

  const liefer  = cent(o.deliveryFee);
  const service = cent(o.serviceFee);
  const rabatt  = cent(o.discount);
  const rechnerisch = waren + liefer + service - rabatt;
  const totalDa = o.total !== null && o.total !== undefined && o.total !== '' && Number.isFinite(Number(o.total));
  const total = totalDa ? cent(o.total) : rechnerisch;

  // Regel 3: Gebühren und Rabatt im Verhältnis der Warenumsätze. Weil alle drei
  // demselben Verhältnis folgen, ist der Getränkeanteil am Gesamtbetrag genau der
  // Getränkeanteil an den Waren. Gerechnet wird auf order.total, damit die Summe
  // immer stimmt; eine Abweichung steht trotzdem unten im Ergebnis.
  let anteilGetraenke = 0;
  if (waren > 0) anteilGetraenke = Math.min(1, Math.max(0, getraenke / waren));
  else if (total !== 0) unklar.push({ name: '(keine Warenpositionen)', grund: 'Betrag ohne Waren, als Speise gerechnet' });

  // Regel 4: je Satz runden, Rundungsrest an den größeren Anteil
  let b19 = rund(total * anteilGetraenke);
  let b7  = rund(total * (1 - anteilGetraenke));
  const rest = total - b7 - b19;
  if (rest) { if (Math.abs(b19) > Math.abs(b7)) b19 += rest; else b7 += rest; }
  const n7  = rund(b7  * 100 / (100 + saetze.speisen));
  const n19 = rund(b19 * 100 / (100 + saetze.getraenke));

  return {
    version: VERSION,
    orderNum: o.orderNum,
    saetze,
    brutto7: euro(b7),  netto7: euro(n7),  ust7: euro(b7 - n7),
    brutto19: euro(b19), netto19: euro(n19), ust19: euro(b19 - n19),
    unklar,
    // total minus (Positionen + Gebühren - Rabatt); 0 = alles stimmig
    abweichung: euro(total - rechnerisch),
    totalFehlt: !totalDa,
  };
}

// Gespeicherte Aufteilung (Feld umsatzsteuer an der Bestellung) verwenden, wenn sie
// vollständig ist und zum total passt; sonst jetzt nachrechnen. Wirft nie - ein
// Bericht darf an keiner alten Bestellung scheitern.
function ausBestellung(order, karte) {
  const o = order || {};
  try {
    const g = o.umsatzsteuer;
    const felder = ['brutto7', 'netto7', 'ust7', 'brutto19', 'netto19', 'ust19'];
    if (g && g.version === VERSION && felder.every(f => Number.isFinite(g[f]))
        && g.saetze && Number.isFinite(g.saetze.speisen) && Number.isFinite(g.saetze.getraenke)
        && Number.isFinite(Number(o.total)) && cent(g.brutto7) + cent(g.brutto19) === cent(o.total)) {
      return {
        version: g.version, orderNum: o.orderNum,
        saetze: { speisen: g.saetze.speisen, getraenke: g.saetze.getraenke },
        brutto7: g.brutto7, netto7: g.netto7, ust7: g.ust7,
        brutto19: g.brutto19, netto19: g.netto19, ust19: g.ust19,
        unklar: Array.from(g.unklar || [], u => ({ name: u.name, grund: u.grund })),
        abweichung: Number(g.abweichung) || 0, totalFehlt: false, gespeichert: true,
      };
    }
    return aufteilen(o, karte);
  } catch (e) {
    console.error(`Umsatzsteuer #${o.orderNum}: Aufteilung fehlgeschlagen:`, e.message);
    const s = saetzeAm(new Date());
    const b = cent(o.total);
    const n = rund(b * 100 / (100 + s.speisen));
    return { version: VERSION, orderNum: o.orderNum, saetze: s,
      brutto7: euro(b), netto7: euro(n), ust7: euro(b - n), brutto19: 0, netto19: 0, ust19: 0,
      unklar: [{ name: '(ganze Bestellung)', grund: 'Aufteilung fehlgeschlagen, als Speise gerechnet' }],
      abweichung: 0, totalFehlt: false };
  }
}

// Summen über viele Bestellungen - aus den bereits gerundeten Einzelwerten,
// damit Einzelzeilen und Summenzeile im Bericht exakt zusammenpassen.
function summieren(ergebnisse) {
  const f = ['brutto7', 'netto7', 'ust7', 'brutto19', 'netto19', 'ust19'];
  const c = Object.fromEntries(f.map(k => [k, 0]));
  const satz = {};   // Prozent -> { brutto, netto, ust } in Cent
  const add = (p, b, n, u) => {
    if (!satz[p]) satz[p] = { brutto: 0, netto: 0, ust: 0 };
    satz[p].brutto += b; satz[p].netto += n; satz[p].ust += u;
  };
  const unklarBestellungen = [], abweichungen = [];
  let anzahl = 0;
  for (const r of ergebnisse || []) {
    if (!r) continue;
    anzahl++;
    for (const k of f) c[k] += cent(r[k]);
    add(r.saetze.speisen,   cent(r.brutto7),  cent(r.netto7),  cent(r.ust7));
    add(r.saetze.getraenke, cent(r.brutto19), cent(r.netto19), cent(r.ust19));
    if (r.unklar && r.unklar.length) unklarBestellungen.push(r.orderNum);
    if (cent(r.abweichung) !== 0 || r.totalFehlt) abweichungen.push({ orderNum: r.orderNum, betrag: r.abweichung, totalFehlt: !!r.totalFehlt });
  }
  const nachSatz = Object.keys(satz).map(Number).sort((a, b) => a - b)
    .map(p => ({ satz: p, brutto: euro(satz[p].brutto), netto: euro(satz[p].netto), ust: euro(satz[p].ust) }));
  return {
    anzahl,
    ...Object.fromEntries(f.map(k => [k, euro(c[k])])),
    brutto: euro(c.brutto7 + c.brutto19),
    netto:  euro(c.netto7 + c.netto19),
    ust:    euro(c.ust7 + c.ust19),
    nachSatz,
    unklarBestellungen,
    abweichungen,
  };
}

// Alle Bestellungen eines Berichts auswerten, nach Bestellzeit sortiert.
function auswerten(orders, karte, modus) {
  const sortiert = [...(orders || [])].sort((a, b) =>
    (new Date(a.createdAt) - new Date(b.createdAt)) || ((a.orderNum || 0) - (b.orderNum || 0)));
  const eintraege = sortiert.map(order => ({ order, ust: ausBestellung(order, karte) }));
  return { modus: UST_MODI.includes(modus) ? modus : 'regel', eintraege, summe: summieren(eintraege.map(e => e.ust)) };
}

// ─── Ausgabe ─────────────────────────────────────────────────────
const zahl = n => (Number(n) || 0).toFixed(2).replace('.', ',');
const eur  = n => zahl(n) + ' €';

// Zeile für Bestätigungsmail an den Gast und Eingangsmail ans Restaurant
function mailZeile(ust, modus) {
  if (modus === 'kleinunternehmer') return KLEINUNTERNEHMER_HINWEIS;
  const s = ust.saetze;
  return `Enthaltene Umsatzsteuer: ${s.speisen} % ${eur(ust.ust7)}, ${s.getraenke} % ${eur(ust.ust19)}`;
}

// Spaltenköpfe: die echten Prozente, solange alle Bestellungen dasselbe Satzpaar
// haben (heute immer), sonst die Bezeichnung des Anteils.
function satzBeschriftung(eintraege) {
  const paare = new Set((eintraege || []).map(e => `${e.ust.saetze.speisen}/${e.ust.saetze.getraenke}`));
  if (paare.size > 1) return { s: 'Speisen', g: 'Getränke' };
  const s = paare.size ? (eintraege[0].ust.saetze) : saetzeAm(new Date());
  return { s: `${s.speisen} %`, g: `${s.getraenke} %` };
}

const ZAHLART = { bar: 'Bar', stripe: 'Online (Stripe)', karte: 'EC-Karte', paypal: 'PayPal' };
const STATUS  = { pending: 'neu', confirmed: 'bestätigt', preparing: 'in Zubereitung', ready: 'fertig',
                  delivered: 'abgeschlossen', cancelled: 'storniert', awaiting_payment: 'wartet auf Zahlung' };
const ZAHLSTATUS = { paid: 'bezahlt', unpaid: 'offen', pending: 'ausstehend', refunded: 'erstattet' };
const zahlartText = o => ZAHLART[o.payment] || o.payment || '';
const artText     = o => (o.mode === 'lieferung' ? 'Lieferung' : 'Abholung');
const datumText   = d => new Date(d).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
const zeitText    = d => new Date(d).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });

// Hinweistext je Bestellung (unklar / Abweichung), für CSV und PDF
function hinweisText(ust) {
  const t = [];
  if (ust.unklar && ust.unklar.length) {
    t.push('nicht eindeutig zugeordnet: ' + ust.unklar.map(u => `${u.name} (${u.grund})`).join(', '));
  }
  if (ust.totalFehlt) t.push('Gesamtbetrag fehlt, aus Positionen gerechnet');
  else if (cent(ust.abweichung) !== 0) {
    t.push(`Gesamtbetrag weicht um ${ust.abweichung > 0 ? '+' : ''}${eur(ust.abweichung)} von Positionen + Gebühren - Rabatt ab`);
  }
  return t.join('; ');
}

// CSV für den Steuerberater: Semikolon, UTF-8 mit BOM, Dezimalkomma,
// eine Zeile je Bestellung und eine Summenzeile.
function csvUmsaetze(auswertung) {
  const { eintraege, summe, modus } = auswertung;
  const klein = modus === 'kleinunternehmer';
  const zelle = v => {
    const s = String(v == null ? '' : v);
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const b = satzBeschriftung(eintraege);
  const kopf = ['Nr.', 'Datum', 'Uhrzeit', 'Art', 'Zahlart', 'Brutto gesamt',
    ...(klein ? [] : [`Brutto ${b.s}`, `Netto ${b.s}`, `USt ${b.s}`, `Brutto ${b.g}`, `Netto ${b.g}`, `USt ${b.g}`]),
    'Liefergebühr', 'Servicegebühr', 'Status', 'Zahlstatus', 'Hinweis'];
  const zeilen = [kopf];
  let liefer = 0, service = 0, brutto = 0;
  for (const { order: o, ust } of eintraege) {
    liefer += cent(o.deliveryFee); service += cent(o.serviceFee); brutto += cent(ust.brutto7) + cent(ust.brutto19);
    zeilen.push([o.orderNum, datumText(o.createdAt), zeitText(o.createdAt), artText(o), zahlartText(o),
      zahl(ust.brutto7 + ust.brutto19),
      ...(klein ? [] : [zahl(ust.brutto7), zahl(ust.netto7), zahl(ust.ust7), zahl(ust.brutto19), zahl(ust.netto19), zahl(ust.ust19)]),
      zahl(o.deliveryFee), zahl(o.serviceFee), STATUS[o.status] || o.status || '', ZAHLSTATUS[o.paymentStatus] || o.paymentStatus || '',
      hinweisText(ust)]);
  }
  zeilen.push([`Summe (${summe.anzahl} Bestellungen)`, '', '', '', '', zahl(euro(brutto)),
    ...(klein ? [] : [zahl(summe.brutto7), zahl(summe.netto7), zahl(summe.ust7), zahl(summe.brutto19), zahl(summe.netto19), zahl(summe.ust19)]),
    zahl(euro(liefer)), zahl(euro(service)), '', '',
    klein ? KLEINUNTERNEHMER_HINWEIS
      : (summe.unklarBestellungen.length ? `${summe.unklarBestellungen.length} Bestellung(en) nicht eindeutig zugeordnet` : '')]);
  return '﻿' + zeilen.map(z => z.map(zelle).join(';')).join('\r\n') + '\r\n';
}

// Dateiname Umsaetze_<Monat>_<Jahr>.csv, Umlaute umschrieben (März → Maerz)
function csvDateiname(monat) {
  const t = String(monat).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  return `Umsaetze_${t}.csv`;
}

// Methode in wenigen Sätzen - Fußnote im Monatsbericht
const METHODE_TEXT =
  'Getränke (laut Speisekarte, Kategorie Getränke) mit dem Regelsatz, alle übrigen Artikel als Speisen mit dem ermäßigten Satz; '
  + 'maßgeblich sind die Sätze am Bestelltag. Menüs (Gericht mit Getränk) werden im Verhältnis der Einzelverkaufspreise von Getränk und Gericht geteilt. '
  + 'Liefer- und Servicegebühr sowie Rabatte folgen als Nebenleistung dem Verhältnis der Warenumsätze der jeweiligen Bestellung. '
  + 'Netto und Steuer sind je Bestellung und Steuersatz auf Cent gerundet, die Summen aus diesen Einzelwerten gebildet. '
  + 'Zuordnung automatisch aus der Speisekarte – bitte mit dem Steuerberater abstimmen.';

module.exports = {
  STEUERSAETZE, UST_STICHTAG, GETRAENKE_KATEGORIE, GETRAENKE_LISTE, UST_MODI, KLEINUNTERNEHMER_HINWEIS,
  METHODE_TEXT, VERSION,
  saetzeAm, ustModus, karteAusMenu, karteLaden, finde, aufteilen, ausBestellung, summieren, auswerten,
  mailZeile, satzBeschriftung, hinweisText, csvUmsaetze, csvDateiname,
  zahlartText, artText, datumText, zeitText, cent,
};
