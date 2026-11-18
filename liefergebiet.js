/*
 * Liefergebiet nach Fahrstrecke: Strasse + Hausnummer -> Meter -> Zone
 * (Liefergebuehr und Mindestbestellwert je Zone).
 *
 * Bestellseite und Server laden diese eine Datei, damit beide dieselbe Gebuehr
 * und denselben Mindestbestellwert rechnen. Die Strecken stehen in
 * liefergebiet.json (erzeugt mit liefergebiet/erzeugen.py) - beim Bestellen
 * geht keine Adresse an einen fremden Dienst.
 *
 * Ahaus (Abed, 17.11.2026), ab Wallstrasse 7:
 *   bis 2 km        1,50 € Liefergebuehr, Mindestbestellwert 20 €
 *   ueber 2 - 5 km  2,50 €,                Mindestbestellwert 20 €
 *   ueber 5 - 9 km  5,50 €,                Mindestbestellwert 40 €
 *   ueber 9 km      keine Lieferung
 * Die Zahlen stehen in liefergebiet.json (zonen), geschrieben von erzeugen.py.
 *
 *   const gebiet = Liefergebiet.erstelle(datenAusLiefergebietJson);
 *   gebiet.finde('Wallstr.', '7')
 *     -> { status: 'ok', strasse: 'Wallstraße', ort: 'Ahaus', nr: '7', meter: 10,
 *          geschaetzt: false, zone: 1, bisKm: 2, gebuehr: 1.5, mindestwert: 20 }
 *
 * status: 'ok' | 'zu-weit' | 'strasse-fehlt' | 'strasse-unbekannt'
 *         | 'mehrdeutig' | 'nr-fehlt' | 'nr-unbekannt'
 *
 * Datenform je Strasse (sparsam, siehe erzeugen.py), Strecken in einheit_m (10 m):
 *   { "1": 31, "3": 32, "12a": 40 }   je Hausnummer
 *   [ 412, 1, 57 ]                    ganze Strasse in einer Zone:
 *                                     [laengste Strecke, kleinste Nr., groesste Nr.]
 * zu_weit: { "Högerstraße": 1034 }    Strassen ganz jenseits der letzten Zone
 *                                     (kuerzeste Strecke, abgerundet) -> 'zu-weit'
 */
(function (wurzel, bauen) {
  if (typeof module === 'object' && module.exports) module.exports = bauen();
  else wurzel.Liefergebiet = bauen();
})(typeof self !== 'undefined' ? self : this, function () {
  const HAUPTORT = 'Ahaus';
  // Eine unbekannte Hausnummer wird nur geschaetzt, wenn eine bekannte auf
  // derselben Strasse hoechstens so weit entfernt ist.
  const NR_SPIELRAUM = 10;

  // "Wallstr.", "Wall Strasse" und "wallstraße" sollen dieselbe Strasse
  // finden. Leerzeichen, Bindestriche und Punkte fallen weg.
  function normStrasse(s) {
    return String(s || '').toLowerCase()
      .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .replace(/str\.?(?=[\s(]|$)/g, 'strasse')
      .replace(/[\s.\-]+/g, '');
  }

  // "12 A" -> { zahl: 12, zusatz: 'a' }; "12-14" zaehlt als 12
  function zerlegeNr(s) {
    const m = String(s || '').toLowerCase().replace(/\s+/g, '').match(/^(\d+)([a-z]?)/);
    return m ? { zahl: Number(m[1]), zusatz: m[2] } : null;
  }

  // "Hauptstraße (Heek)" -> { strasse: 'Hauptstraße', ort: 'Heek' }
  function zerlegeSchluessel(k) {
    const m = k.match(/^(.*?)\s*\(([^)]+)\)$/);
    return m ? { strasse: m[1], ort: m[2] } : { strasse: k, ort: HAUPTORT };
  }

  function erstelle(daten) {
    const einheit = Number(daten.einheit_m) || 1;
    const zonen = daten.zonen.slice().sort((a, b) => a.bis_km - b.bis_km)
      .map((z, i) => Object.assign({}, z, { nr: i + 1 }));
    const grenze = zonen[zonen.length - 1].bis_km * 1000;
    const strassen = daten.strassen;
    const zuWeit = daten.zu_weit || {};
    const genau = new Map();    // "hauptstrasse(heek)" -> Schluessel
    const ohneOrt = new Map();  // "hauptstrasse" -> [Schluessel, ...]
    Object.keys(strassen).concat(Object.keys(zuWeit)).forEach(k => {
      if (genau.has(normStrasse(k))) return;
      genau.set(normStrasse(k), k);
      const basis = normStrasse(zerlegeSchluessel(k).strasse);
      if (!ohneOrt.has(basis)) ohneOrt.set(basis, []);
      ohneOrt.get(basis).push(k);
    });

    // Zone zu einer Strecke in Metern; null = ueber der letzten Grenze.
    // Grenzen einschliesslich: genau 2000 m ist noch "bis 2 km".
    function zoneFuer(meter) {
      return zonen.find(z => meter <= z.bis_km * 1000) || null;
    }

    function schluesselFuer(eingabe) {
      const n = normStrasse(eingabe);
      if (genau.has(n)) return { k: genau.get(n) };
      const treffer = ohneOrt.get(n) || [];
      // Ohne Ortsangabe gewinnt Ahaus; eine Strasse, die es nur in einem
      // Nachbarort gibt, wird auch ohne "(Ort)" gefunden.
      // Eine lieferbare Strasse geht einer gleichnamigen ganz zu weiten vor.
      const imHauptort = treffer.find(k => zerlegeSchluessel(k).ort === HAUPTORT);
      if (imHauptort) return { k: imHauptort };
      const lieferbar = treffer.filter(k => k in strassen);
      if (lieferbar.length === 1) return { k: lieferbar[0] };
      if (lieferbar.length > 1) return { mehrdeutig: lieferbar };
      if (treffer.length) return { k: treffer[0] };
      return {};
    }

    // Hausnummer nicht in den Kartendaten (Neubau, "12b"): die Nachbarn auf
    // derselben Strasse nehmen, und zwar die weitere von beiden - im Zweifel
    // eher die hoehere Zone. Liegt die Nummer weit ausserhalb der bekannten,
    // wird nicht geraten.
    function schaetze(nummern, zahl) {
      const bekannt = Object.keys(nummern)
        .map(n => ({ z: zerlegeNr(n), wert: nummern[n] }))
        .filter(b => b.z)
        .map(b => ({ zahl: b.z.zahl, wert: b.wert }))
        .sort((a, b) => a.zahl - b.zahl);
      const unten = bekannt.filter(b => b.zahl <= zahl).pop();
      const oben = bekannt.find(b => b.zahl >= zahl);
      if (!unten && !oben) return null;
      if (!unten && oben.zahl - zahl > NR_SPIELRAUM) return null;
      if (!oben && zahl - unten.zahl > NR_SPIELRAUM) return null;
      return Math.max(unten ? unten.wert : 0, oben ? oben.wert : 0);
    }

    function finde(strasseEingabe, nrEingabe) {
      if (!String(strasseEingabe || '').trim()) return { status: 'strasse-fehlt' };
      const s = schluesselFuer(strasseEingabe);
      if (s.mehrdeutig) {
        return { status: 'mehrdeutig', vorschlaege: s.mehrdeutig };
      }
      if (!s.k) return { status: 'strasse-unbekannt' };
      const { strasse, ort } = zerlegeSchluessel(s.k);
      const nr = zerlegeNr(nrEingabe);
      if (!nr) return { status: 'nr-fehlt', strasse, ort };
      const nrText = String(nrEingabe).trim();
      if (!(s.k in strassen)) {
        return { status: 'zu-weit', strasse, ort, nr: nrText, meter: zuWeit[s.k] * einheit, geschaetzt: true };
      }
      const eintrag = strassen[s.k];
      let wert, geschaetzt = false;
      if (Array.isArray(eintrag)) {
        // Ganze Strasse in einer Zone: jede Nummer im bekannten Bereich
        // (plus Spielraum) bekommt die laengste Strecke dieser Strasse.
        const [laengste, kleinste, groesste] = eintrag;
        if (nr.zahl < kleinste - NR_SPIELRAUM || nr.zahl > groesste + NR_SPIELRAUM) {
          return { status: 'nr-unbekannt', strasse, ort, nr: nrText };
        }
        wert = laengste;
        geschaetzt = nr.zahl < kleinste || nr.zahl > groesste;
      } else {
        wert = eintrag[nr.zahl + nr.zusatz];
        if (wert === undefined) wert = eintrag[String(nr.zahl)];
        if (wert === undefined) {
          wert = schaetze(eintrag, nr.zahl);
          geschaetzt = true;
          if (wert === null) return { status: 'nr-unbekannt', strasse, ort, nr: nrText };
        }
      }
      const meter = wert * einheit;
      const basis = { strasse, ort, nr: nrText, meter, geschaetzt };
      if (meter > grenze) return Object.assign({ status: 'zu-weit' }, basis);
      const z = zoneFuer(meter);
      return Object.assign({ status: 'ok', zone: z.nr, bisKm: z.bis_km,
        gebuehr: z.gebuehr, mindestwert: z.mindestwert }, basis);
    }

    // Fuer die Vorschlagsliste im Adressfeld: Ahaus ohne Zusatz, Nachbarorte
    // mit "(Ort)".
    const vorschlaege = Object.keys(strassen).sort((a, b) => a.localeCompare(b, 'de'));

    return {
      HAUPTORT,
      finde,
      zoneFuer,
      vorschlaege,
      zonen,
      grenzeKm: grenze / 1000,
      // kleinster Mindestbestellwert (fuer Hinweise, bevor die Adresse steht)
      mindestwertAb: Math.min.apply(null, zonen.map(z => z.mindestwert)),
    };
  }

  return { erstelle, HAUPTORT, normStrasse, zerlegeNr };
});
