#!/usr/bin/env python3
"""Setzt die eRecht24-Rechtstexte samt eigener Ergaenzungen in die Seite ein.

    python3 recht/einbauen.py            einsetzen (zweiter Lauf aendert nichts)
    python3 recht/einbauen.py --pruefen  nur pruefen, nichts schreiben (Rueckgabe 1 bei Abweichung)

Quellen (alle unter recht/):
    erecht24-impressum.html     + ergaenzungen-impressum.html
    erecht24-datenschutz.html   + ergaenzungen-datenschutz.html
    erecht24-agb.html           + agb-ziffer-12.html

Ziele (zwischen Markern, siehe ZIELE unten):
    index.html     LEGAL.impressum / LEGAL.datenschutz / LEGAL.agb (Modal, JS-Strings)
    impressum.html, datenschutz.html (eigene Seiten)
    account.html   #datenschutzModal (Datenschutzerklaerung im Kundenkonto)

Der eRecht24-Wortlaut wird nicht veraendert. Das Skript bereitet nur das HTML auf:
Ueberschriftenebenen, Inline-Stile fuer das dunkle Modal, Entities als Zeichen,
mailto-Links fuer E-Mail-Adressen, target="_blank" fuer externe Links, leere Absaetze
weg, Leerraum zwischen Bloecken weg. Eine einzelne Zeichenfolge zwischen zwei Bloecken
(der Export hat "</p>. <h2>" nach AGB 2.5) wird an den vorigen Absatz angehaengt.

Nur Python-Standardbibliothek.
"""

import argparse
import difflib
import html
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

RECHT = Path(__file__).resolve().parent
WURZEL = RECHT.parent

# Quelle je Text: eRecht24-Export und Datei mit eigenen Ergaenzungen
QUELLEN = {
    'impressum':   ('erecht24-impressum.html',   'ergaenzungen-impressum.html'),
    'datenschutz': ('erecht24-datenschutz.html', 'ergaenzungen-datenschutz.html'),
    'agb':         ('erecht24-agb.html',         'agb-ziffer-12.html'),
}

# Titel im Kopf des Modals in index.html (LEGAL.<text>.title)
MODAL_TITEL = {
    'impressum':   'Impressum',
    'datenschutz': 'Datenschutzerkl&auml;rung',
    'agb':         'AGB &amp; Widerrufsbelehrung',
}

# Ueberschriftenebenen: Export-Ebene -> Ausgabe. 'h3oben' = erste Ueberschrift im Modal,
# 'pstark' = fetter Absatz (vierte Ebene im Modal).
EBENEN = {
    ('modal', 'impressum'):   {'h1': 'h3oben', 'h2': 'h4', 'h3': 'h4', 'h4': 'pstark'},
    ('modal', 'agb'):         {'h1': 'h3oben', 'h2': 'h3', 'h3': 'h4', 'h4': 'pstark'},
    ('modal', 'datenschutz'): {'h1': 'h3oben', 'h2': 'h3', 'h3': 'h4', 'h4': 'pstark'},
    ('seite', 'impressum'):   {'h1': 'h1', 'h2': 'h3', 'h3': 'h4', 'h4': 'h4'},
    ('seite', 'datenschutz'): {'h1': 'h1', 'h2': 'h2', 'h3': 'h3', 'h4': 'h4'},
}

# Darstellungen: Modal in index.html (Attribute in ' wegen der JS-Strings in "),
# Modal in account.html, eigene Seiten (Stile stehen dort im <style>).
DARSTELLUNG = {
    'modal_index':   {'art': 'modal', 'q': "'", 'farbe': 'var(--odis-akzent)'},
    'modal_account': {'art': 'modal', 'q': '"', 'farbe': 'var(--odis-rot)'},
    'seite':         {'art': 'seite', 'q': '"', 'farbe': None},
}

# Ziele: Datei, Marker-Name, Text, Darstellung, Form ('html' oder 'js')
ZIELE = [
    ('index.html',       'IMPRESSUM',   'impressum',   'modal_index',   'js'),
    ('index.html',       'DATENSCHUTZ', 'datenschutz', 'modal_index',   'js'),
    ('index.html',       'AGB',         'agb',         'modal_index',   'js'),
    ('impressum.html',   'IMPRESSUM',   'impressum',   'seite',         'html'),
    ('datenschutz.html', 'DATENSCHUTZ', 'datenschutz', 'seite',         'html'),
    ('account.html',     'DATENSCHUTZ', 'datenschutz', 'modal_account', 'html'),
]

ERG_ANFANG = 'eigene Ergänzung, nicht eRecht24'
ERG_ENDE = 'Ende eigene Ergänzung'

LEER = {'br', 'img', 'hr', 'wbr'}
BLOCK = {'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'}
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')


class Abbruch(Exception):
    pass


# ─── Einlesen ────────────────────────────────────────────────────

class Element:
    def __init__(self, tag, attrs):
        self.tag, self.attrs, self.kinder = tag, list(attrs), []


class Kommentar(str):
    pass


class Leser(HTMLParser):
    """Baut einen kleinen Baum. Entities werden zu Zeichen (convert_charrefs)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.wurzel = Element('#wurzel', [])
        self.stapel = [self.wurzel]

    def handle_starttag(self, tag, attrs):
        el = Element(tag, [(k, v if v is not None else '') for k, v in attrs])
        self.stapel[-1].kinder.append(el)
        if tag not in LEER:
            self.stapel.append(el)

    def handle_startendtag(self, tag, attrs):
        self.stapel[-1].kinder.append(Element(tag, [(k, v if v is not None else '') for k, v in attrs]))

    def handle_endtag(self, tag):
        if tag in LEER:
            return
        for i in range(len(self.stapel) - 1, 0, -1):
            if self.stapel[i].tag == tag:
                del self.stapel[i:]
                return
        # schliessendes Tag ohne Gegenstueck: ignorieren

    def handle_data(self, data):
        self.stapel[-1].kinder.append(data)

    def handle_comment(self, data):
        self.stapel[-1].kinder.append(Kommentar(data.strip()))


def lesen(pfad):
    if not pfad.exists():
        raise Abbruch(f'Quelle fehlt: {pfad.relative_to(WURZEL)}')
    leser = Leser()
    leser.feed(pfad.read_text(encoding='utf-8'))
    leser.close()
    return leser.wurzel.kinder


def text_von(knoten):
    if isinstance(knoten, Kommentar):
        return ''
    if isinstance(knoten, str):
        return knoten
    return ''.join(text_von(k) for k in knoten.kinder)


def ist_leer(el):
    """Absatz ohne Inhalt (z. B. <p>&nbsp;</p>)"""
    def hat_bild(e):
        return any(isinstance(k, Element) and (k.tag == 'img' or hat_bild(k)) for k in e.kinder)
    if hat_bild(el):
        return False
    return not text_von(el).replace('\xa0', ' ').strip()


def bloecke(knoten, quelle):
    """Oberste Ebene: Leerraum und Kommentare weg, leere Absaetze weg, lose Zeichen
    zwischen Bloecken an den vorigen Block haengen."""
    aus = []
    for k in knoten:
        if isinstance(k, Kommentar):
            continue
        if isinstance(k, str):
            rest = re.sub(r'[ \t\r\n]+', ' ', k).strip()
            if not rest:
                continue
            if aus and isinstance(aus[-1], Element):
                aus[-1].kinder.append(rest)
            else:
                p = Element('p', [])
                p.kinder.append(rest)
                aus.append(p)
            continue
        if k.tag == 'p' and ist_leer(k):
            continue
        aus.append(k)
    return aus


def ergaenzungen(pfad):
    """Teilt die Ergaenzungsdatei an den Zeilen <!-- EINFUEGEN ... --> in Bloecke.
    Liefert [(wo, bloecke)], wo = ('am-ende', None) oder ('ende-von', 'Ueberschrift')."""
    teile, aktuell = [], None
    for k in lesen(pfad):
        if isinstance(k, Kommentar) and k.startswith('EINFUEGEN'):
            m = re.fullmatch(r'EINFUEGEN\s+(?:(am-ende)|ende-von="([^"]+)")', k)
            if not m:
                raise Abbruch(f'{pfad.name}: unbekannte Anweisung <!-- {k} -->')
            aktuell = (('am-ende', None) if m.group(1) else ('ende-von', m.group(2)), [])
            teile.append(aktuell)
            continue
        if aktuell is None:
            if isinstance(k, Element):
                raise Abbruch(f'{pfad.name}: Inhalt vor der ersten <!-- EINFUEGEN ... -->-Zeile')
            continue
        aktuell[1].append(k)
    if not teile:
        raise Abbruch(f'{pfad.name}: keine <!-- EINFUEGEN ... -->-Zeile gefunden')
    return [(wo, bloecke(kn, pfad.name)) for wo, kn in teile]


def norm_ueberschrift(s):
    return re.sub(r'\s+', ' ', s.replace('\xad', '').replace('\xa0', ' ')).strip()


def dokument(text):
    """eRecht24-Bloecke mit den eigenen Ergaenzungen an ihrer Stelle.
    Ergaenzungen sind von Kommentaren eingerahmt."""
    export, erg = QUELLEN[text]
    doc = bloecke(lesen(RECHT / export), export)
    if not doc or not (isinstance(doc[0], Element) and doc[0].tag == 'h1'):
        raise Abbruch(f'{export}: beginnt nicht mit <h1> - ist das ein eRecht24-Export?')
    einfuegen = []   # (Position, Bloecke), Positionen im unveraenderten doc
    for wo, teil in ergaenzungen(RECHT / erg):
        rahmen = ([Kommentar(f'{ERG_ANFANG} (recht/{erg})')] + teil + [Kommentar(ERG_ENDE)])
        if wo[0] == 'am-ende':
            einfuegen.append((len(doc), rahmen))
            continue
        ziel = norm_ueberschrift(wo[1])
        treffer = [i for i, b in enumerate(doc) if isinstance(b, Element) and b.tag == 'h2'
                   and norm_ueberschrift(text_von(b)).startswith(ziel)]
        if len(treffer) != 1:
            gefunden = [norm_ueberschrift(text_von(b)) for b in doc if isinstance(b, Element) and b.tag == 'h2']
            raise Abbruch(f'{erg}: Abschnitt "{wo[1]}" im Export {export} '
                          f'{"nicht" if not treffer else "mehrfach"} gefunden. '
                          f'Vorhanden: {"; ".join(gefunden)}')
        naechste = next((j for j in range(treffer[0] + 1, len(doc))
                         if isinstance(doc[j], Element) and doc[j].tag == 'h2'), len(doc))
        einfuegen.append((naechste, rahmen))
    # von hinten einsetzen, damit die Positionen stimmen; gleiche Position in Dateireihenfolge
    for pos, rahmen in sorted(einfuegen, key=lambda e: e[0], reverse=True):
        doc[pos:pos] = rahmen
    return doc


# ─── Ausgeben ────────────────────────────────────────────────────

def esc_text(s):
    s = s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return s.replace('\xa0', '&nbsp;').replace('\xad', '&shy;')


def esc_attr(s, q):
    s = s.replace('&', '&amp;').replace('<', '&lt;')
    return s.replace(q, '&#39;' if q == "'" else '&quot;')


class Schreiber:
    def __init__(self, text, darstellung):
        d = DARSTELLUNG[darstellung]
        self.art, self.q, self.farbe = d['art'], d['q'], d['farbe']
        self.ebenen = EBENEN[(self.art, text)]
        self.erste = True

    def attrs(self, paare):
        return ''.join(f' {k}={self.q}{esc_attr(v, self.q)}{self.q}' for k, v in paare)

    def stil(self, paare, stil):
        if stil and not any(k == 'style' for k, _ in paare):
            return [('style', stil)] + list(paare)
        return list(paare)

    def text(self, s, in_link):
        s = re.sub(r'[ \t\r\n]+', ' ', s)
        if in_link:
            return esc_text(s)
        aus, pos = [], 0
        for m in EMAIL.finditer(s):
            aus.append(esc_text(s[pos:m.start()]))
            href = [('href', 'mailto:' + m.group(0))]
            aus.append(f'<a{self.attrs(self.stil(href, self.link_stil()))}>{esc_text(m.group(0))}</a>')
            pos = m.end()
        aus.append(esc_text(s[pos:]))
        return ''.join(aus)

    def link_stil(self):
        return f'color:{self.farbe};word-break:break-word' if self.art == 'modal' else None

    def innen(self, el, in_link=False):
        teile = []
        for k in el.kinder:
            if isinstance(k, Kommentar):
                continue
            if isinstance(k, str) and el.tag in ('ul', 'ol') and not k.strip():
                continue   # Leerraum zwischen Listenpunkten
            if isinstance(k, str):
                teile.append(self.text(k, in_link))
            else:
                teile.append(self.element(k, in_link))
        s = ''.join(teile)
        s = re.sub(r' *<br> *', '<br>', s)
        return s.strip(' ') if el.tag in BLOCK else s

    def element(self, el, in_link=False):
        tag, paare = el.tag, list(el.attrs)
        modal = self.art == 'modal'
        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            ziel = self.ebenen.get(tag, tag)
            if ziel == 'h3oben' and not self.erste:
                ziel = 'h3'
            self.erste = False
            inhalt = self.innen(el)
            if modal:
                c = self.farbe
                if ziel == 'h3oben':
                    return f'<h3{self.attrs([("style", f"color:{c};margin:0 0 10px;overflow-wrap:anywhere")])}>{inhalt}</h3>'
                if ziel == 'h3':
                    return f'<h3{self.attrs([("style", f"color:{c};margin:22px 0 10px;overflow-wrap:anywhere")])}>{inhalt}</h3>'
                if ziel == 'h4':
                    return f'<h4{self.attrs([("style", f"color:{c};margin:16px 0 6px;font-size:.92rem;overflow-wrap:anywhere")])}>{inhalt}</h4>'
                return f'<p{self.attrs([("style", "margin:14px 0 4px")])}><strong>{inhalt}</strong></p>'
            return f'<{ziel}>{inhalt}</{ziel}>'
        if tag == 'a':
            href = dict(paare).get('href', '')
            if re.match(r'https?://', href) and 'target' not in dict(paare):
                paare += [('target', '_blank'), ('rel', 'noopener noreferrer')]
            if modal:
                paare = self.stil(paare, self.link_stil())
            return f'<a{self.attrs(paare)}>{self.innen(el, True)}</a>'
        if tag in ('ul', 'ol') and modal:
            paare = self.stil(paare, 'margin:6px 0 8px 18px;line-height:1.85')
        if tag in LEER:
            return f'<{tag}{self.attrs(paare)}>'
        return f'<{tag}{self.attrs(paare)}>{self.innen(el, in_link)}</{tag}>'

    def bloecke(self, doc):
        aus = []
        for b in doc:
            if isinstance(b, Kommentar):
                aus.append(f'<!-- {b} -->')
            else:
                aus.append(self.element(b))
        return aus




# ─── Ziele ───────────────────────────────────────────────────────

def js_string(s):
    """HTML als JS-String in "…": json.dumps maskiert " \\ und Zeilenumbrueche; dazu
    </ (sonst endet </script> den Skriptblock) und <!-- (Skript-Parser des Browsers)."""
    j = json.dumps(s, ensure_ascii=False)
    j = j.replace('</', '<\\/').replace('<!--', '\\u003C!--')
    return j.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')


def erzeugen(text, darstellung, form, docs):
    teile = Schreiber(text, darstellung).bloecke(docs[text])
    export, erg = QUELLEN[text]
    if form == 'html':
        kopf = (f'<!-- Erzeugt von recht/einbauen.py aus recht/{export} (eRecht24) und '
                f'recht/{erg} (eigene Ergänzung). Nicht von Hand ändern. -->')
        return '\n'.join([kopf] + teile)
    zeilen = [f'// Erzeugt von recht/einbauen.py aus recht/{export} (eRecht24) und recht/{erg} '
              f'(eigene Ergänzung). Nicht von Hand ändern.',
              f'LEGAL.{text} = {{',
              f'  title: {json.dumps(MODAL_TITEL[text], ensure_ascii=False)},']
    for i, t in enumerate(teile):
        zeilen.append(('  text:  ' if i == 0 else '       + ') + js_string(t))
    zeilen.append('};')
    return '\n'.join(zeilen)


def marker(form, name):
    if form == 'js':
        return f'/* RECHT:{name}:START */', f'/* RECHT:{name}:ENDE */'
    return f'<!-- RECHT:{name}:START -->', f'<!-- RECHT:{name}:ENDE -->'


def bereich(inhalt, datei, form, name):
    """(Anfang, Ende) des Bereichs zwischen den Markern, ohne die Marker selbst."""
    start, ende = marker(form, name)
    for m in (start, ende):
        n = inhalt.count(m)
        if n != 1:
            raise Abbruch(f'{datei}: Marker {m} {"fehlt" if n == 0 else f"steht {n}-mal da"}. '
                          f'Er muss genau einmal vorkommen (siehe recht/LIESMICH.md).')
    a = inhalt.index(start) + len(start)
    e = inhalt.index(ende)
    if e < a:
        raise Abbruch(f'{datei}: {ende} steht vor {start}.')
    return a, e


# ─── Pruefen: Wortlaut gegen den Export ──────────────────────────

def nur_text(h):
    """Text ohne Tags, Entities aufgeloest, Leerraum vereinheitlicht."""
    h = re.sub(r'<!--.*?-->', ' ', h, flags=re.S)
    h = re.sub(r'<[^>]+>', ' ', h)
    h = html.unescape(h).replace('\xa0', ' ').replace('\xad', '')
    h = re.sub(r'\s+', ' ', h)
    h = re.sub(r' ([.,;:!?)])', r'\1', h)
    return h.replace('( ', '(').strip()


def ohne_ergaenzungen(h):
    return re.sub(r'<!-- ' + re.escape(ERG_ANFANG) + r'.*?<!-- ' + re.escape(ERG_ENDE) + r' -->',
                  ' ', h, flags=re.S)


def html_aus_bereich(stueck, form):
    if form == 'html':
        return stueck
    # JS: die Stringteile hinter text: bzw. + einlesen
    teile = re.findall(r'^\s*(?:text:|\+)\s*("(?:[^"\\]|\\.)*")\s*$', stueck, flags=re.M)
    return ''.join(json.loads(t) for t in teile)


def unterschied(soll, ist):
    a, b = soll.split(' '), ist.split(' ')
    zeilen = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == 'equal':
            continue
        zeilen.append(f'      Export: …{" ".join(a[max(0, i1 - 4):i2 + 4])}…')
        zeilen.append(f'      Seite:  …{" ".join(b[max(0, j1 - 4):j2 + 4])}…')
        if len(zeilen) >= 8:
            break
    return '\n'.join(zeilen)


# ─── Ablauf ──────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description='eRecht24-Texte und eigene Ergänzungen einsetzen.')
    ap.add_argument('--pruefen', action='store_true',
                    help='nichts schreiben, nur melden, ob die Seite zum Export passt')
    args = ap.parse_args()

    docs = {t: dokument(t) for t in QUELLEN}
    export_text = {t: nur_text((RECHT / QUELLEN[t][0]).read_text(encoding='utf-8')) for t in QUELLEN}

    # Erst alles erzeugen und alle Marker pruefen, dann schreiben: bricht etwas ab,
    # bleibt keine Datei halb geaendert.
    dateien = {}
    for datei, name, text, darstellung, form in ZIELE:
        pfad = WURZEL / datei
        if datei not in dateien:
            if not pfad.exists():
                raise Abbruch(f'Zieldatei fehlt: {datei}')
            dateien[datei] = pfad.read_text(encoding='utf-8')
        bereich(dateien[datei], datei, form, name)

    fehler = 0
    neu = dict(dateien)
    for datei, name, text, darstellung, form in ZIELE:
        a, e = bereich(neu[datei], datei, form, name)
        soll = '\n' + erzeugen(text, darstellung, form, docs) + '\n'
        ist = neu[datei][a:e]
        stelle = f'{datei} [{name}]'
        if args.pruefen:
            # 1. Wortlaut der eRecht24-Teile gegen den Export
            eingebaut = nur_text(ohne_ergaenzungen(html_aus_bereich(ist, form)))
            if eingebaut == export_text[text]:
                print(f'OK      {stelle}: eRecht24-Wortlaut wie im Export ({QUELLEN[text][0]})')
            else:
                fehler += 1
                print(f'ANDERS  {stelle}: eRecht24-Wortlaut weicht vom Export ab ({QUELLEN[text][0]})')
                print(unterschied(export_text[text], eingebaut))
            # 2. Stand insgesamt (Export, Ergaenzungen, Aufbereitung) wie ein frischer Lauf
            if ist != soll:
                fehler += 1
                print(f'ALT     {stelle}: entspricht nicht dem, was ein Einbau-Lauf jetzt schreiben würde '
                      f'(Ergänzung oder Export geändert, oder von Hand bearbeitet)')
        else:
            neu[datei] = neu[datei][:a] + soll + neu[datei][e:]

    if args.pruefen:
        print('Ergebnis: alles passt.' if not fehler else f'Ergebnis: {fehler} Abweichung(en).')
        return 1 if fehler else 0

    for datei, inhalt in neu.items():
        if inhalt != dateien[datei]:
            (WURZEL / datei).write_text(inhalt, encoding='utf-8')
            print(f'geschrieben   {datei}')
        else:
            print(f'unverändert   {datei}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Abbruch as e:
        print(f'ABBRUCH: {e}', file=sys.stderr)
        sys.exit(2)
