# Erzeugt liefergebiet.json: Fahrstrecke vom Laden zu jeder Adresse im Umkreis.
#
#   python3 -I liefergebiet/erzeugen.py                          # holt Adressen + Strecken neu
#   python3 -I liefergebiet/erzeugen.py --speichern strecken.json  # ... und hebt die Rohdaten auf
#   python3 -I liefergebiet/erzeugen.py strecken.json            # nur aus einem frueheren Lauf
#
# Adressen: OpenStreetMap ueber Overpass (alle Hausnummern im Umkreis von 9,5 km
# Luftlinie - die Fahrstrecke ist nie kuerzer als die Luftlinie, so ist jede
# Adresse bis 9 km Fahrstrecke sicher dabei). Strecken: OSRM-Table mit dem Auto,
# eine Quelle (der Laden) und 99 Ziele je Anfrage. Beides laeuft nur hier, beim
# Erzeugen - beim Bestellen geht keine Kundenadresse an einen fremden Dienst.
# Beide Dienste bekommen einen neutralen User-Agent ohne Namen und Kontakt.
#
# Gespeichert werden nur Strassen, an denen mindestens eine Adresse innerhalb
# der groessten Zone liegt; deren Hausnummern aber vollstaendig, damit eine
# Hausnummer jenseits von 9 km als "zu weit" erkannt wird und nicht als
# unbekannt. Strassen im Umkreis, die ganz jenseits von 9 km liegen (etwa in
# Alstaette), stehen nur mit ihrer kuerzesten Strecke unter zu_weit - so sagt
# die Seite "zu weit" statt "Strasse unbekannt".
#
# Sparsame Form (Ahaus hat bis 9 km ein Vielfaches der Adressen von Oelde bis
# 5 km): Je Hausnummer steht die Strecke in ZEHN METERN (Ganzzahl, auf volle
# 10 m AUFgerundet - so rutscht keine Adresse in eine guenstigere Zone als die
# gemessene Strecke). Eine Strasse, deren Hausnummern alle in derselben Zone
# liegen, steht nur als [laengste Strecke, kleinste Nr., groesste Nr.]: Fuer
# Gebuehr und Mindestbestellwert zaehlt nur die Zone, und mit dem Nummernbereich
# erkennt liefergebiet.js weiter eine Hausnummer weit ausserhalb als unbekannt.
import json, math, re, sys, time, urllib.parse, urllib.request
from collections import defaultdict

# Wallstrasse 7, 48683 Ahaus (Gebaeude per Nominatim-Geokodierung, 17.11.2026)
LADEN = (52.0752784, 7.0059007)
UMKREIS_M = 9500
HAUPTORT = 'Ahaus'
# Lieferregeln (Abed, 17.11.2026): Gebuehr und Mindestbestellwert (Warenwert
# ohne Gebuehren) je Zone; ueber 9 km keine Lieferung.
ZONEN = [
    {'bis_km': 2, 'gebuehr': 1.5, 'mindestwert': 20.0},
    {'bis_km': 5, 'gebuehr': 2.5, 'mindestwert': 20.0},
    {'bis_km': 9, 'gebuehr': 5.5, 'mindestwert': 40.0},
]
UA = {'User-Agent': 'liefergebiet-erzeugen/1.0'}
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
ZIEL = __file__.rsplit('/', 1)[0] + '/../liefergebiet.json'

# Adressen ohne addr:city: Ort ueber die Postleitzahl, sonst der Ort der
# naechstgelegenen Adresse mit Ortsangabe.
PLZ_ORT = {'48683': 'Ahaus', '48739': 'Legden', '48619': 'Heek', '48703': 'Stadtlohn',
           '48691': 'Vreden', '48599': 'Gronau', '48624': 'Schöppingen',
           '48720': 'Rosendahl', '48712': 'Gescher'}
ORT_GLEICH = {'Heek-Ahle': 'Heek'}


def adressen():
    q = f'''[out:json][timeout:180];
(node["addr:housenumber"]["addr:street"](around:{UMKREIS_M},{LADEN[0]},{LADEN[1]});
 way["addr:housenumber"]["addr:street"](around:{UMKREIS_M},{LADEN[0]},{LADEN[1]}););
out center tags;'''
    daten = urllib.parse.urlencode({'data': q}).encode()
    # Der Hauptserver ist oft ausgelastet (502/504): mehrmals versuchen, auch beim Spiegel.
    for versuch in range(6):
        server = OVERPASS[versuch % len(OVERPASS)]
        try:
            req = urllib.request.Request(server, data=daten, headers=UA)
            el = json.load(urllib.request.urlopen(req, timeout=300))['elements']
            break
        except Exception as ex:
            print(f'Overpass {server}: {ex} - neuer Versuch', file=sys.stderr)
            time.sleep(10 + versuch * 10)
    else:
        sys.exit('Overpass nicht erreichbar')
    pts = []
    for e in el:
        t = e['tags']
        lat = e.get('lat') or e['center']['lat']; lon = e.get('lon') or e['center']['lon']
        ort = t.get('addr:city') or PLZ_ORT.get(t.get('addr:postcode', ''), '')
        pts.append({'ort': ORT_GLEICH.get(ort, ort), 'teil': t.get('addr:suburb') or '',
                    'str': t['addr:street'], 'nr': t['addr:housenumber'], 'lat': lat, 'lon': lon})
    mit_ort = [p for p in pts if p['ort']]
    for p in pts:
        if not p['ort']:
            p['ort'] = min(mit_ort, key=lambda q: (q['lat'] - p['lat']) ** 2
                           + ((q['lon'] - p['lon']) * 0.62) ** 2)['ort']
    return pts


def strecken(pts):
    for i in range(0, len(pts), 99):
        teil = pts[i:i + 99]
        coords = ';'.join(f'{lon:.6f},{lat:.6f}' for lat, lon in
                          [LADEN] + [(p['lat'], p['lon']) for p in teil])
        url = f'https://router.project-osrm.org/table/v1/driving/{coords}?sources=0&annotations=distance'
        for versuch in range(5):
            try:
                r = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
                if r.get('code') == 'Ok': break
            except Exception as ex:
                r = {'code': str(ex)}
            time.sleep(3 + versuch * 3)
        else:
            sys.exit(f'OSRM bricht bei Adresse {i} ab: {r.get("code")}')
        for p, m in zip(teil, r['distances'][0][1:]):
            p['m'] = None if m is None else round(m)
        time.sleep(1.1)   # oeffentlicher Server: hoechstens eine Anfrage je Sekunde
    return pts


def schluessel(p):
    # Ahaus (mit Wuellen, Wessum, Ottenstein, Alstaette, Graes) ist der
    # Normalfall; eine Strasse in einem Nachbarort traegt ihn im Namen, damit
    # sie nicht mit einer gleichnamigen in Ahaus zusammenfaellt.
    return p['str'] if p['ort'] in (HAUPTORT, '') else f"{p['str']} ({p['ort']})"


def zone(meter):
    return next((i for i, z in enumerate(ZONEN) if meter <= z['bis_km'] * 1000), len(ZONEN))


def main():
    args = sys.argv[1:]
    speichern = None
    if args[:1] == ['--speichern']:
        speichern, args = args[1], args[2:]
    if args:
        pts = json.load(open(args[0]))
    else:
        pts = strecken(adressen())
        if speichern:
            json.dump(pts, open(speichern, 'w'), ensure_ascii=False)
    grenze = ZONEN[-1]['bis_km'] * 1000
    je_strasse = defaultdict(dict)
    for p in pts:
        if p.get('m') is None: continue
        nr = p['nr'].lower().replace(' ', '')
        alt = je_strasse[schluessel(p)].get(nr)
        # Mehrere Punkte fuer dieselbe Adresse (Gebaeude + Eingang): der naechste zaehlt
        je_strasse[schluessel(p)][nr] = p['m'] if alt is None else min(alt, p['m'])
    strassen, zu_weit = {}, {}
    for s, h in sorted(je_strasse.items()):
        if min(h.values()) > grenze:
            zu_weit[s] = min(h.values()) // 10       # abgerundet: "mindestens"
            continue
        zehner = {nr: math.ceil(m / 10) for nr, m in h.items()}
        zahlen = [int(re.match(r'\d+', nr).group()) for nr in zehner if re.match(r'\d+', nr)]
        if len({zone(m * 10) for m in zehner.values()}) == 1 and zahlen:
            # ganze Strasse in einer Zone
            strassen[s] = [max(zehner.values()), min(zahlen), max(zahlen)]
        else:
            strassen[s] = dict(sorted(zehner.items(), key=lambda kv: (len(kv[0]), kv[0])))
    aus = {
        '_quelle': 'Adressen (c) OpenStreetMap-Mitwirkende, ODbL; Fahrstrecke per OSRM (Auto), '
                   f'erzeugt am {time.strftime("%d.%m.%Y")} mit liefergebiet/erzeugen.py',
        '_einheit': 'Fahrstrecke vom Laden in 10 m (aufgerundet), je Strasse und Hausnummer; '
                    '[Strecke, kleinste Nr., groesste Nr.] gilt fuer die ganze Strasse '
                    '(alle Nummern in derselben Zone)',
        'einheit_m': 10,
        'zonen': ZONEN,
        'strassen': strassen,
        'zu_weit': zu_weit,
    }
    json.dump(aus, open(ZIEL, 'w'), ensure_ascii=False, separators=(',', ':'))
    n = sum(len(je_strasse[s]) for s in strassen)
    print(f'{len(strassen)} Strassen, {n} Adressen, {len(zu_weit)} Strassen ganz ueber '
          f'{ZONEN[-1]["bis_km"]} km -> {ZIEL}')


if __name__ == '__main__':
    main()
