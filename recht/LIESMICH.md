# Rechtstexte Odi’s Bowl Ahaus

## Woher die Texte kommen

| Datei | Herkunft |
|---|---|
| `erecht24-impressum.html` | eRecht24 Premium, Projekt „Odis Bowl Ahaus“, Impressum-Generator, HTML-Export |
| `erecht24-datenschutz.html` | dto., Datenschutz-Generator (Abschnitte 1–6) |
| `erecht24-agb.html` | dto., „AGB für Online-Shops“ (Ziffern 1–11) |
| `ergaenzungen-impressum.html` | **eigene Ergänzung**: eRecht24-Siegel (`img/erecht24-siegel-impressum.png`) |
| `ergaenzungen-datenschutz.html` | **eigene Ergänzung**: Betrieb des Bestellsystems (FlueVate, Hetzner, MongoDB Atlas, Resend, GitHub Pages), Speicherung im Browser, Bestellabwicklung und Liefergebiet, Online-Zahlung über das eigene Stripe-Konto |
| `agb-ziffer-12.html` | **eigene Ergänzung**: AGB-Ziffer 12 „Ergänzende Bedingungen“ (Servicegebühr, Lieferzonen, Zahlungsarten, Vorbestellung, kein Widerrufsrecht, Açaí, Allergene) |

Die drei `erecht24-*.html` sind der Export, wie eRecht24 ihn liefert (Stand 19.11.2026). Nie von Hand
ändern: in eRecht24 neu erzeugen und die Datei ersetzen. Die Kopfzeile (Kommentar mit Projekt und Datum)
dabei wieder oben eintragen.

## Wo die Texte stehen

`einbauen.py` schreibt zwischen Markern, alles dazwischen wird bei jedem Lauf ersetzt:

| Datei | Marker | Inhalt |
|---|---|---|
| `index.html` | `/* RECHT:IMPRESSUM:START */` … `/* RECHT:IMPRESSUM:ENDE */` (ebenso `DATENSCHUTZ`, `AGB`) | `LEGAL.impressum/.datenschutz/.agb` fürs Modal |
| `impressum.html` | `<!-- RECHT:IMPRESSUM:START -->` … `ENDE` | eigene Seite |
| `datenschutz.html` | `<!-- RECHT:DATENSCHUTZ:START -->` … `ENDE` | eigene Seite |
| `account.html` | `<!-- RECHT:DATENSCHUTZ:START -->` … `ENDE` | `#datenschutzModal` im Kundenkonto |

`LEGAL.allergene` in `index.html` gehört nicht dazu und wird von Hand gepflegt.

## Neu einsetzen

```sh
python3 recht/einbauen.py            # einsetzen; ein zweiter Lauf ändert nichts
python3 recht/einbauen.py --pruefen  # nur prüfen, schreibt nichts; Rückgabe 1 bei Abweichung
```

`--pruefen` meldet je Stelle:
- `OK`/`ANDERS`: Ist der eRecht24-Wortlaut auf der Seite gleich dem Export? Verglichen wird der Text ohne
  Tags, Entities aufgelöst, eigene Ergänzungen herausgenommen.
- `ALT`: Die Stelle entspricht nicht dem, was ein Lauf jetzt schreiben würde (Export oder Ergänzung
  geändert und noch nicht eingesetzt, oder jemand hat von Hand im Bereich geändert).

Das Skript bricht mit einer Meldung ab (Rückgabe 2), wenn ein Marker fehlt oder doppelt ist oder ein
Abschnitt, hinter den eine Ergänzung gehört, im neuen Export nicht mehr vorkommt. Dann die Zeile
`<!-- EINFUEGEN ende-von="…" -->` in der Ergänzungsdatei an die neue Überschrift anpassen.

## Was das Skript am eRecht24-Text macht (nur Aufbereitung, kein Wortlaut)

- Überschriftenebenen: im Modal wird aus `h1`/`h2`/`h3`/`h4` → `h3`/`h3`/`h4`/fetter Absatz (Impressum:
  `h2` → `h4`), auf den eigenen Seiten bleibt die Datenschutzerklärung wie exportiert, im Impressum `h2` → `h3`.
- Inline-Stile fürs dunkle Modal (`--odis-akzent` in `index.html`, `--odis-rot` in `account.html`).
- Entities werden zu Zeichen (außer `&nbsp;`, `&shy;`, `&amp;`, `&lt;`, `&gt;`).
- E-Mail-Adressen werden zu `mailto:`-Links, externe Links bekommen `target="_blank"`.
- Leere Absätze (`<p>&nbsp;</p>`) fallen weg. Der Export hat nach AGB 2.5 einen losen Punkt zwischen zwei
  Blöcken (`</p>. <h2>`); er wird an den Absatz 2.5 angehängt („… Deutsch.“).
- In `index.html` steht das HTML in JS-Strings: `"`, `\` und Zeilenumbrüche sind maskiert, `</` als `<\/`
  und `<!--` als `<!--`, damit kein `</script>` den Skriptblock beendet.

## Eigene Ergänzungen

Stehen nur in den drei Ergänzungsdateien, nie im Skript. Jeder Block beginnt mit einer Zeile
`<!-- EINFUEGEN am-ende -->` oder `<!-- EINFUEGEN ende-von="2. Hosting" -->` (Anfang einer `<h2>`-Überschrift
des Exports; der Block kommt ans Ende dieses Abschnitts). Auf der Seite sind sie eingerahmt von
`<!-- eigene Ergänzung, nicht eRecht24 (recht/…) -->` und `<!-- Ende eigene Ergänzung -->`.

Ändert sich etwas, das dort steht (Servicegebühr, Lieferzonen in `liefergebiet.json`, Zahlarten in
`/api/config`, Öffnungszeiten in `oeffnungszeiten.js`, ein neuer Dienst oder Speicherschlüssel), die
Ergänzung im selben Zug anpassen und `einbauen.py` laufen lassen. Bei einem neuen Drittdienst zuerst prüfen,
ob er in den eRecht24-Generator gehört (dann neu erzeugen).

## Neuer Standort

Ordner `recht/` übernehmen, Exporte des neuen Projekts einsetzen, die drei Ergänzungsdateien an den Laden
anpassen, Marker einmal von Hand an die vier Stellen setzen, `einbauen.py` laufen lassen. Ablauf im
eRecht24-Konto: Skill `erecht24-rechtstexte`.
