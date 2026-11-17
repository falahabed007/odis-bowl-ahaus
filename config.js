// ═══════════════════════════════════════════════════════════════
// Zentrale Konfiguration – FlueVate-Bestellsystem
// ═══════════════════════════════════════════════════════════════
//
// EINZIGE Stelle, an der die Backend-Adresse steht. Sie wird von
// index.html (Bestellung) und account.html (Kundenkonto) gemeinsam
// benutzt. (Das frühere Web-Dashboard gibt es nicht mehr; die Läden
// arbeiten mit der App.)
//
// Zieht das Backend um, ist hier eine Zeile zu ändern – vorher stand
// die Adresse dreimal im Code, und beim Umzug wurde nur index.html
// angepasst. Kundenkonto und (damals) Dashboard zeigten dadurch monatelang auf
// einen Host, den es nicht gibt.
//
// Diese Datei muss in <head> vor allen anderen Skripten geladen werden.

window.FLUEVATE_BACKEND = 'https://api.odis-ahaus.com';

// Vorschau vor dem Livegang: Liefert das Backend die Seite selbst aus (Testadresse
// auf dem Server), fragt die Seite dieses Backend - gleiche Herkunft, kein CORS.
// Unter der echten Domain greift diese Zeile nie.
if (/\.sslip\.io$|\.vorschau\.fluevate\.de$/.test(location.hostname)) {
  window.FLUEVATE_BACKEND = location.origin;
}
