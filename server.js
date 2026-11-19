const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const Stripe     = require('stripe');
const { Resend } = require('resend'); // v2.0.1
const cron       = require('node-cron');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const fs         = require('fs');
const { webBestellungAusRequest } = require('./bestellung');
const Zeiten     = require('./oeffnungszeiten');
const Vorbestellung = require('./vorbestellung');
const { kasseAnmerkung } = require('./kasse');
const Ust        = require('./umsatzsteuer');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// Stripe lazy – liest Key bei jedem Aufruf
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nicht gesetzt');
  return Stripe(key);
}

// Online-Zahlungen nur als Direct Charge auf dem eigenen Stripe-Konto des Ladens
// (STRIPE_DIREKT_KONTO), nie auf dem Plattformkonto. Erklaerung in stripe-direkt.js.
const stripeDirekt = require('./stripe-direkt');
const { gleichSicher } = stripeDirekt;

// ─── PayPal (REST v2, lazy) ──────────────────────────────────────
// Unabhängig von Stripe: eigene ENV-Keys, eigene Endpunkte.
// PAYPAL_ENV=live → Produktion, sonst Sandbox.
function paypalBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}
async function getPaypalAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET nicht gesetzt');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json();
  if (!r.ok) throw new Error('PayPal Auth: ' + (data.error_description || r.status));
  return data.access_token;
}
async function paypalApi(path, method, token, body) {
  const r = await fetch(`${paypalBase()}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`PayPal API ${path}: ` + (data.message || data.error_description || r.status));
  return data;
}

// Resend lazy – kein Crash beim Start wenn Key fehlt
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('⚠️  RESEND_API_KEY fehlt – E-Mails werden nicht gesendet'); return null; }
  const resend = new Resend(key);
  // Alle Standorte teilen ein Resend-Konto (10 Mails pro Sekunde). Um 22:00 senden
  // alle zugleich ihre Berichte, am 31.10.2026 gingen so drei Monatsberichte verloren.
  // Bei rate_limit_exceeded deshalb kurz warten und erneut senden.
  const senden = resend.emails.send.bind(resend.emails);
  resend.emails.send = async (...args) => {
    for (let versuch = 1; ; versuch++) {
      const antwort = await senden(...args);
      if (antwort?.error?.name !== 'rate_limit_exceeded' || versuch >= 6) return antwort;
      await new Promise(r => setTimeout(r, 1000 * versuch + Math.random() * 1000));
    }
  };
  return resend;
}

// ─── Eigene Adresse ──────────────────────────────────────────────
// Die einzige Stelle, an der die Domain steht. Sie wurde vorher sechsmal
// getippt, waehrend FRONTEND_URL zwar in .env und render.yaml stand, aber
// nie gelesen wurde - ein Umzug haette funf Stellen stumm veralten lassen.
const FRONTEND = process.env.FRONTEND_URL || 'https://odis-ahaus.com';

// ─── CORS ────────────────────────────────────────────────────────
const allowedOrigins = [
  FRONTEND,
  FRONTEND.replace('https://', 'https://www.'),
  // Rückfallweg, falls GitHub Pages einmal ohne die eigene Domain ausliefert
  'https://falahabed007.github.io',
];
// Lokale Entwicklung: localhost/127.0.0.1 auf beliebigem Port
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const corsOptions = {
  origin: function(origin, callback) {
    // Kein Origin = Postman / server-to-server / lokale Datei → erlauben
    if (!origin || origin === 'null') return callback(null, true);
    if (allowedOrigins.includes(origin) || localOrigin.test(origin)) {
      return callback(null, origin);
    }
    // Bewusst kein Error: den würde Express zu einem 500 ohne CORS-Header
    // machen, und im Browser käme nur das nichtssagende "Load failed" an.
    // callback(null, false) lässt die Antwort sauber ohne Allow-Origin durch.
    console.warn('CORS blockiert:', origin);
    return callback(null, false);
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
};
// Render terminiert TLS vor der App; ohne das ist req.ip immer die Proxy-IP.
app.set('trust proxy', 1);

app.use(cors(corsOptions));
// Preflight für alle Routen – mit denselben Optionen. Ein blankes cors()
// würde hier jeder Herkunft "Allow-Origin: *" geben und die Prüfung oben
// aushebeln.
app.options('*', cors(corsOptions));

// ─── Webhooks brauchen raw body (vor express.json) ───────────────
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── Statische HTML-Dateien (kein Cache) ─────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// ─── MongoDB ─────────────────────────────────────────────────────
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI nicht gesetzt – Datenbankfunktionen sind deaktiviert.');
}
// try/catch um den Aufruf, nicht nur .catch() dahinter: Bei einer fehlerhaften
// Zeichenkette wirft mongoose.connect SYNCHRON, und dann greift das .catch()
// daneben nicht - der Prozess stirbt beim Start und der Hoster meldet nur 502,
// ohne dass irgendwo steht, woran es lag. Haeufigste Ursache ist ein Passwort
// mit @ oder / darin, das nicht URL-kodiert wurde.
try {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB verbunden'))
    .catch(err => console.error('❌ MongoDB Erstverbindung fehlgeschlagen:', err.message));
} catch (err) {
  console.error('❌ MONGODB_URI ist unbrauchbar:', err.message);
  console.error('   Sonderzeichen im Passwort URL-kodieren: @ wird %40, / wird %2F, : wird %3A.');
}
// Dauerhafte Zustandswechsel sichtbar loggen (kein stiller Ausfall)
mongoose.connection.on('disconnected', () => console.error('❌ MongoDB getrennt – Reconnect läuft …'));
mongoose.connection.on('reconnected',  () => console.log('✅ MongoDB wieder verbunden'));
mongoose.connection.on('error',        err => console.error('❌ MongoDB Fehler:', err.message));

// ═══════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════

const orderSchema = new mongoose.Schema({
  orderNum:             { type: Number, unique: true },
  mode:                 { type: String, enum: ['lieferung','abholung'], required: true },
  status:               { type: String, default: 'pending',
                          enum: ['awaiting_payment','pending','confirmed','preparing','ready','delivered','cancelled'] },
  payment:              { type: String, enum: ['bar','stripe','karte','paypal'], required: true }, // paypal: Altbestellungen
  paymentStatus:        { type: String, default: 'unpaid', enum: ['unpaid','paid','pending','refunded'] },
  source:               { type: String, default: 'web', enum: ['web','pos'] },
  stripeSessionId:      String,
  // Vom Wachhund nachgeholt, statt vom Webhook. Verhindert doppelten Alarm
  // und macht im Nachhinein sichtbar, dass die Zahlkette geklemmt hat.
  nachgeholt:          { type: Boolean, default: false },
  stripePaymentIntentId:String,
  // Das Stripe-Konto des Ladens, auf dem Sitzung, Zahlung und Erstattung liegen
  // (Direct Charge). Jeder Stripe-Aufruf zu dieser Bestellung braucht es als
  // Option { stripeAccount }. Setzt nur create-stripe-checkout.
  stripeAccount:        String,
  // Echte Stripe-Gebuehr in Cent, nach der Zahlung nachgelesen. Fehlt sie, ist sie
  // noch nicht bekannt; die Berichte schaetzen sie nicht.
  stripeGebuehrCent:    Number,
  paypalOrderId:        String,
  paypalCaptureId:      String,
  prepTime:             Number,
  cancelReason:         { type: String, default: '' },
  customer: {
    first: String, last: String, email: String,
    phone: String, city: String, street: String, house: String
  },
  items:       [{ name: String, price: Number, qty: Number, note: String, extraDetails: [{ name: String, price: Number }] }],
  subtotal:    Number,
  deliveryFee: { type: Number, default: 0 },
  serviceFee:  { type: Number, default: 0.99 },
  discount:    { type: Number, default: 0 },
  total:       Number,
  note:        String,
  coupon:      String,
  // Vorbestellung (19.11.2026): gewünschter Abhol- bzw. Lieferzeitpunkt. Setzt nur
  // der Server nach der Prüfung (vorbestellung.js). Die Kassen-App kennt die Felder
  // nicht; sie sieht die Vorbestellung an der ersten Zeile von note.
  wunschzeit:    Date,
  vorbestellung: { type: Boolean, default: false },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Zugriffsschluessel fuer die Statusabfrage des Kunden. Bewusst nicht die _id:
  // deren Zufallsteil ist pro Serverprozess konstant und damit ratbar.
  statusToken: { type: String, index: true,
                 default: () => crypto.randomBytes(9).toString('base64url') },
  // Umsatzsteuer-Aufteilung (umsatzsteuer.js), beim Anlegen berechnet und gespeichert:
  // so bleibt sie, wie sie am Bestelltag mit der damaligen Karte war. Setzt nur der
  // Server (bestellung.js: GESPERRTE_FELDER). Alte Bestellungen haben das Feld nicht,
  // die Berichte rechnen sie zur Laufzeit nach.
  umsatzsteuer: { type: new mongoose.Schema({
    version:  Number,
    saetze:   { speisen: Number, getraenke: Number },
    brutto7:  Number, netto7:  Number, ust7:  Number,
    brutto19: Number, netto19: Number, ust19: Number,
    unklar:   [{ _id: false, name: String, grund: String }],
    abweichung: Number,
    berechnetAm: Date,
  }, { _id: false }), default: undefined },
}, { timestamps: true });

// Umsatzsteuer beim Anlegen einer Bestellung mitspeichern (alle drei Bestellwege:
// Bar, Stripe, PayPal). Scheitert die Rechnung, wird die Bestellung trotzdem
// gespeichert - der Bericht rechnet sie dann nach.
orderSchema.pre('save', function (next) {
  try {
    if (this.isNew && !this.umsatzsteuer) {
      const roh = this.toObject({ depopulate: true });
      if (!roh.createdAt) roh.createdAt = new Date();
      const u = Ust.aufteilen(roh, ustKarte());
      if (!u.totalFehlt) this.umsatzsteuer = { ...u, berechnetAm: new Date() };
    }
  } catch (e) { console.error(`Umsatzsteuer #${this.orderNum}: nicht gespeichert:`, e.message); }
  next();
});

const Order = mongoose.model('Order', orderSchema);

const counterSchema = new mongoose.Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', counterSchema);

const availabilitySchema = new mongoose.Schema({
  itemName:  { type: String, required: true, unique: true },
  available: { type: Boolean, default: false }
}, { timestamps: true });
const Availability = mongoose.model('Availability', availabilitySchema);

const settingsSchema = new mongoose.Schema({
  _id:            String,
  mode:           { type: String, default: 'online', enum: ['online','geschlossen','neutral'] },
  manualOverride: { type: Boolean, default: false },
  // Rückwärtskompatibilität
  isOpen:         { type: Boolean, default: true }
});
const Settings = mongoose.model('Settings', settingsSchema);

const userSchema = new mongoose.Schema({
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  first:    { type: String, required: true, trim: true },
  last:     { type: String, required: true, trim: true },
  phone:    { type: String, default: '' },
  addresses: [{
    label:  { type: String, default: 'Zuhause' },
    street: String,
    house:  String,
    city:   String,
    zip:    String,
  }],
  defaultAddress:  { type: Number, default: 0 },
  stampsRedeemed:  { type: Number, default: 0 },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

// ─── Counter ─────────────────────────────────────────────────────
async function getNextOrderNum() {
  const r = await Counter.findByIdAndUpdate('orderNum',
    { $inc: { seq: 1 } }, { new: true, upsert: true });
  return r.seq + 1000;
}

// ─── Admin Auth ───────────────────────────────────────────────────
// gleichSicher (zeitkonstanter Vergleich) kommt aus stripe-direkt.js, siehe oben.

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ message: 'Nicht autorisiert' });
  const token = h.slice(7);

  // Regulaerer Weg: befristetes Admin-JWT aus /api/admin/login.
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role === 'admin') { req.admin = payload; return next(); }
  } catch { /* kein gueltiges JWT – unten weiterpruefen */ }

  // Notweg fuer Clients, die noch das feste Token eingetragen haben
  // (z. B. die Sunmi-Kasse zwischen zwei Anmeldungen). Kann entfallen,
  // sobald alle Geraete einmal ueber /api/admin/login gelaufen sind.
  if (process.env.ADMIN_TOKEN_SECRET && gleichSicher(token, process.env.ADMIN_TOKEN_SECRET)) {
    req.admin = { role: 'admin', legacy: true };
    return next();
  }

  return res.status(401).json({ message: 'Token ungültig' });
}

// ─── Customer Auth (JWT) ──────────────────────────────────────────
function customerAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Nicht eingeloggt' });
  }
  try {
    req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Token abgelaufen oder ungültig' });
  }
}

// ═══════════════════════════════════════════════════════════════
// KUNDEN-AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, first, last, phone } = req.body;
    if (!email || !password || !first || !last || !phone) {
      return res.status(400).json({ message: 'Alle Pflichtfelder ausfüllen' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Passwort mindestens 6 Zeichen' });
    }
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: 'E-Mail bereits registriert' });

    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ email, password: hash, first, last, phone: phone || '' });
    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      token,
      user: { id: user._id, email: user.email, first: user.first, last: user.last }
    });
  } catch (err) {
    console.error('Register Fehler:', err);
    res.status(500).json({ message: 'Registrierung fehlgeschlagen' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'Falsche E-Mail oder Passwort' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: 'Falsche E-Mail oder Passwort' });

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: { id: user._id, email: user.email, first: user.first, last: user.last }
    });
  } catch (err) {
    console.error('Login Fehler:', err);
    res.status(500).json({ message: 'Login fehlgeschlagen' });
  }
});

app.get('/api/auth/me', customerAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User nicht gefunden' });
    res.json(user);
  } catch {
    res.status(500).json({ message: 'Fehler' });
  }
});

app.patch('/api/auth/profile', customerAuth, async (req, res) => {
  try {
    const { first, last, phone, addresses, defaultAddress } = req.body;
    const update = {};
    if (first) update.first = first;
    if (last) update.last = last;
    if (phone !== undefined) update.phone = phone;
    if (addresses) update.addresses = addresses;
    if (defaultAddress !== undefined) update.defaultAddress = defaultAddress;

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select('-password');
    res.json(user);
  } catch {
    res.status(500).json({ message: 'Profil-Update fehlgeschlagen' });
  }
});

app.patch('/api/auth/password', customerAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Neues Passwort mindestens 6 Zeichen' });
    }
    const user = await User.findById(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ message: 'Aktuelles Passwort falsch' });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ message: 'Passwort geändert' });
  } catch {
    res.status(500).json({ message: 'Fehler beim Passwort ändern' });
  }
});

app.get('/api/account/orders', customerAuth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('orderNum status payment total items createdAt mode');
    res.json(orders);
  } catch {
    res.status(500).json({ message: 'Bestellhistorie konnte nicht geladen werden' });
  }
});

app.post('/api/account/reorder/:orderId', customerAuth, async (req, res) => {
  try {
    const original = await Order.findOne({ _id: req.params.orderId, userId: req.user.id });
    if (!original) return res.status(404).json({ message: 'Bestellung nicht gefunden' });

    res.json({
      items: original.items,
      mode: original.mode,
      // ohne die Zeile "VORBESTELLUNG: …" – die neue Bestellung bekommt ihre eigene Zeit
      note: Vorbestellung.gastNotiz(original)
    });
  } catch {
    res.status(500).json({ message: 'Re-Order fehlgeschlagen' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════

// Lebenszeichen fuer den Lastverteiler: antwortet immer mit 200, solange der
// Prozess laeuft. Getrennt von /api/health, und zwar aus einem konkreten
// Grund: /api/health meldet bei fehlender Datenbank korrekt 503. Zeigt Renders
// healthCheckPath darauf, gilt der Dienst dauerhaft als krank, Render leitet
// keinen Verkehr hin und antwortet mit 502 - man kommt also nicht einmal mehr
// an die Meldung heran, die sagt, was fehlt. Henne und Ei.
app.get('/api/live', (req, res) => res.json({ alive: true, time: new Date() }));

// Was die Zustandsmeldung ueber die Datenbank verraten darf: ob eine URI
// gesetzt ist, ob ein Datenbankname darin steht, und in welchem Zustand die
// Verbindung ist. NICHT Benutzer, Passwort oder Clusteradresse - der Endpunkt
// ist oeffentlich.
function datenbankBefund() {
  const zustand = ['getrennt', 'verbunden', 'verbindet', 'trennt'][mongoose.connection.readyState] || 'unbekannt';
  const uri = process.env.MONGODB_URI;
  if (!uri) return { db: 'disconnected', grund: 'MONGODB_URI ist nicht gesetzt', zustand };
  const nachSchema = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const vorPfad = nachSchema.split('/')[0];
  if ((vorPfad.match(/@/g) || []).length > 1) {
    return { db: 'disconnected', zustand,
      grund: 'Mehrere @ vor der Clusteradresse - Sonderzeichen im Passwort URL-kodieren: @ wird %40' };
  }
  let name = null;
  try { name = new URL(uri.replace(/^mongodb\+srv:/, 'https:')).pathname.replace(/^\//, '') || null; }
  catch { return { db: 'disconnected', grund: 'MONGODB_URI laesst sich nicht lesen', zustand }; }
  if (mongoose.connection.readyState === 1) return { db: 'connected', datenbank: name, zustand };
  return { db: 'disconnected', datenbank: name, zustand,
    grund: !name
      ? 'Kein Datenbankname in der URI - er gehoert hinter den letzten Schraegstrich'
      : 'URI steht, Verbindung kommt nicht zustande - meist sind die Outbound-Adressen des Hosters nicht in Atlas freigegeben' };
}

app.get('/api/health', (req, res) => {
  const befund = datenbankBefund();
  const dbUp = befund.db === 'connected';
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'degraded',
    ...befund,
    restaurant: 'Odi’s Bowl Ahaus', time: new Date(),
    // Render setzt RENDER_GIT_COMMIT selbst. Ohne diese Angabe laesst sich
    // von aussen nicht feststellen, welcher Stand gerade laeuft.
    commit: (process.env.RENDER_GIT_COMMIT || 'unbekannt').slice(0, 7)
  });
});

// Odi’s Bowl Ahaus liefert nach Fahrstrecke statt nach Orten (Abed, 17.11.2026
// abends) - deliveryCities bleibt deshalb leer, die Zonen (Gebühr und
// Mindestbestellwert je Zone) stehen unter lieferung, dieselben Zahlen, mit
// denen der Server prüft. nurImLaden: online nicht bestellbar (Açaí).
// onlineZahlung sagt der Bestellseite, ob Stripe fertig
// eingerichtet und das Konto des Ladens freigeschaltet ist; sonst bietet sie
// nur bar an. Die Pruefung wartet hoechstens 4 s und wirft nie (Zwischenspeicher
// 5 Minuten), die Route antwortet also immer, im Zweifel mit false.
app.get('/api/config', async (req, res) => {
  let onlineZahlung = false;
  try { onlineZahlung = (await stripeBereit()) === true; } catch { onlineZahlung = false; }
  res.json({
    serviceFee: 0.99,
    nurAbholung: false,
    deliveryCities: {},
    lieferung: {
      zonen: LIEFERGEBIET.zonen.map(z => ({ bis_km: z.bis_km, gebuehr: z.gebuehr, mindestwert: z.mindestwert })),
      grenzeKm: LIEFERGEBIET.grenzeKm,
      nurImLaden: NUR_IM_LADEN_NAMEN,
    },
    onlineZahlung,
    zahlarten: onlineZahlung ? zahlarten() : [],
  });
});

// ── Restaurant Status (öffentlich) ───────────────────────────────
// mode/isOpen wie bisher (gespeicherter Wert). Neu: bestellbar und vorbestellung -
// die Seite zeigt den Geschlossen-Banner nur, wenn auch keine Vorbestellung geht.
app.get('/api/status', async (req, res) => {
  const z = await bestellZustandLesen(new Date());
  try {
    const s = await Settings.findById('restaurant');
    const mode = s ? (s.mode || (s.isOpen ? 'online' : 'geschlossen')) : 'online';
    res.json({ mode, isOpen: mode === 'online', bestellbar: z.bestellbar, vorbestellung: z.vorbestellung, manuell: z.manuell });
  } catch(e) { res.json({ mode: 'online', isOpen: true, bestellbar: z.bestellbar, vorbestellung: z.vorbestellung, manuell: z.manuell }); }
});

// ── Wählbare Zeiten für Vorbestellungen (öffentlich) ─────────────
// Liefert Zustand und Zeiten fertig gerechnet (Europe/Berlin), damit die Seite
// keine eigene Zeitzonen-Rechnung braucht. ?mode=abholung|lieferung
app.get('/api/zeiten', async (req, res) => {
  const art = req.query.mode === undefined ? 'abholung' : req.query.mode;
  if (!Vorbestellung.ARTEN.includes(art)) return res.status(400).json({ message: Vorbestellung.TEXT.keineArt });
  try {
    const jetzt = new Date();
    const zustand = await bestellZustandLesen(jetzt);
    res.set('Cache-Control', 'no-store');
    res.json(Vorbestellung.zeitenAntwort({ zustand, jetzt, art }));
  } catch (e) {
    console.error('Zeiten:', e.message);
    res.status(500).json({ message: 'Die Uhrzeiten konnten nicht geladen werden.' });
  }
});

// ── Restaurant Status (Admin) ─────────────────────────────────────
app.patch('/api/admin/status', auth, async (req, res) => {
  try {
    const { mode, manualOverride } = req.body;
    const update = {};
    if (mode !== undefined)           update.mode           = mode;
    if (manualOverride !== undefined) update.manualOverride = manualOverride;
    // Auto-Modus: sofort berechnen wenn manualOverride auf false gesetzt wird
    if (manualOverride === false && mode === undefined) {
      update.mode = calcAutoMode();
    }
    update.isOpen = (update.mode || mode) === 'online';
    const s = await Settings.findByIdAndUpdate('restaurant', update, { upsert: true, new: true });
    const icons = { online:'✅ ONLINE', geschlossen:'❌ GESCHLOSSEN', neutral:'⚪ NEUTRAL' };
    console.log(`🏪 Restaurant: ${icons[s.mode]} | Manuell: ${s.manualOverride}`);
    res.json({ mode: s.mode, manualOverride: s.manualOverride, isOpen: s.isOpen });
  } catch(e) { res.status(500).json({ message: 'Fehler' }); }
});

// ── Admin: aktuellen Status lesen ────────────────────────────────
app.get('/api/admin/status', auth, async (req, res) => {
  try {
    const s = await Settings.findById('restaurant');
    const mode = s ? (s.mode || (s.isOpen ? 'online' : 'geschlossen')) : 'online';
    res.json({ mode, manualOverride: s ? s.manualOverride : false, isOpen: mode === 'online' });
  } catch(e) { res.status(500).json({ mode: 'online', manualOverride: false }); }
});

app.get('/api/availability', async (req, res) => {
  try {
    const d = await Availability.find({ available: false }).select('itemName -_id');
    res.json({ disabled: d.map(x => x.itemName) });
  } catch(e) { res.status(500).json({ message: 'Fehler' }); }
});

// ── Rabatt: gibt es bei Odi’s Bowl Ahaus nicht ─────────────────────────
// Alle Bestellwege rufen berechneRabatt() auf und speichern das Ergebnis.
// Ein mitgeschickter Gutscheincode oder Rabattbetrag wird ignoriert.
const RABATT_CODE = null;

function berechneRabatt() {
  return 0;
}

// ── Lieferung nach Fahrstrecke, Açaí nur im Laden ───────────────
// Ab Wallstraße 7: bis 2 km 1,50 €, bis 5 km 2,50 € (Mindestbestellwert je
// 20 €), bis 9 km 5,50 € (Mindestbestellwert 40 €), darüber keine Lieferung
// (Abed, 17.11.2026 abends). Die Strecke je Adresse steht in liefergebiet.json;
// dieselbe Nachschlagefunktion nutzt die Bestellseite. Der Server rechnet Zone,
// Gebühr und Mindestbestellwert trotzdem selbst - was der Client als
// deliveryFee schickt, zählt nicht. Bei Abholung gibt es keine Liefergebühr.
// Açaí-Bowls (menu.json: nur_im_laden) sind online gar nicht bestellbar.
// Die Prüfung selbst steht in lieferung.js (Tests: test/lieferung.test.js).
const Liefergebiet = require('./liefergebiet.js');
const { erstellePruefer } = require('./lieferung');
const LIEFERGEBIET = Liefergebiet.erstelle(
  JSON.parse(fs.readFileSync(path.join(__dirname, 'liefergebiet.json'), 'utf8')));
// (MENU_FILE steht erst weiter unten - hier der Pfad direkt.)
const NUR_IM_LADEN_NAMEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'Menue', 'menu.json'), 'utf8')).kategorien
  .flatMap(k => k.items || []).filter(it => it.nur_im_laden).map(it => it.name);
const lieferPruefer = erstellePruefer({ gebiet: LIEFERGEBIET, nurImLadenNamen: NUR_IM_LADEN_NAMEN });

function lieferungAbgelehnt(req, res) {
  const r = lieferPruefer.pruefe(req.body);
  if (r.fehler) { res.status(400).json({ message: r.fehler }); return true; }
  return false;
}

// ── Vorbestellung: darf jetzt bzw. zur Wunschzeit bestellt werden? ──
// Zustand aus Settings('restaurant'). Fehlt der Eintrag oder ist die Datenbank
// gestört, gilt der aus der Uhrzeit berechnete Modus (vorbestellung.js). Wirft nie.
async function bestellZustandLesen(jetzt) {
  let settings = null;
  if (mongoose.connection.readyState === 1) {
    try { settings = await Settings.findById('restaurant').lean(); }
    catch (e) { console.warn('Settings nicht lesbar, Modus nach Uhrzeit:', e.message); }
  }
  return Vorbestellung.bestellZustand({ settings, jetzt });
}

// Die eine Prüfung für Barzahlung und Online-Zahlung. Lehnt mit 400 ab
// (zeiten: true = die Seite lädt die Uhrzeiten neu) und gibt sonst
// { wunschzeit, vorbestellung, note } zurück - die setzt nur der Server.
async function bestellzeitPruefen(req, res) {
  const jetzt = new Date();
  const r = Vorbestellung.pruefeBestellzeit({ body: req.body, zustand: await bestellZustandLesen(jetzt), jetzt });
  if (r.fehler) { res.status(400).json({ message: r.fehler, zeiten: r.zeit }); return null; }
  return r;
}

// ── Stripe: nur Direct Charges auf dem Konto des Ladens ──────────
// Online-Zahlung ist erst bereit, wenn STRIPE_SECRET_KEY, STRIPE_DIREKT_KONTO und
// STRIPE_CONNECT_WEBHOOK_SECRET in Coolify stehen UND Stripe fuer das Konto
// charges_enabled meldet. Ohne Webhook-Geheimnis kaeme eine bezahlte Bestellung
// nur ueber verify-payment und Wachhund an, ohne freigeschaltetes Konto scheitert
// jeder Checkout. Ein Rueckweg auf das Plattformkonto existiert bewusst nicht.
// Das Ergebnis haelt 5 Minuten (Fehler: 1 Minute), damit nicht jede Anfrage
// einen Zusatzaufruf bei Stripe macht.
// Klarna gibt es nur, wenn Stripe es fuer das Konto des Ladens freigeschaltet hat
// (Faehigkeit klarna_payments). Wird mit der Kontopruefung alle 5 Minuten aufgefrischt.
let klarnaAktiv = false;
const zahlarten = () => (klarnaAktiv ? ['card', 'klarna'] : ['card']);
const direktKontoBereit = stripeDirekt.erstelleKontoPruefer({
  abrufen: async konto => {
    const a = await getStripe().accounts.retrieve(konto);
    klarnaAktiv = (a.capabilities || {}).klarna_payments === 'active';
    return a.charges_enabled === true;
  },
  melden:  e => console.warn('Stripe-Konto des Ladens nicht abfragbar, Online-Zahlung aus:', e.message),
});

// acct_... wenn ein Checkout jetzt moeglich ist, sonst null. Wirft nie.
function direktKontoFuerCheckout() {
  return stripeDirekt.direktKontoWaehlen({ env: process.env, istBereit: direktKontoBereit });
}
async function stripeBereit() {
  return (await direktKontoFuerCheckout()) !== null;
}

// Einmal beim Start sagen, was eingestellt ist (nie Geheimwerte, nur Ja/Nein und
// die letzten vier Zeichen des Kontos), und das Konto gleich einmal abfragen.
{
  const sk = stripeDirekt.stripeKonfiguration(process.env);
  if (sk.vollstaendig) {
    console.log(`💳 Stripe Direct Charges: Konto …${sk.konto.slice(-4)}, Online-Zahlung sobald Stripe es freigibt`);
    stripeBereit().then(ok => console.log(ok
      ? '💳 Stripe-Konto des Ladens ist freigeschaltet: Online-Zahlung aktiv'
      : '⚠️  Stripe-Konto des Ladens ist (noch) nicht freigeschaltet: nur Barzahlung'));
  } else if (sk.teilweise) {
    console.warn(`⚠️  Stripe nur teilweise eingerichtet, es fehlt: ${sk.fehlend.join(', ')}. Online-Zahlung bleibt aus, nur Barzahlung.`);
  } else {
    console.log('💳 Stripe nicht eingerichtet: nur Barzahlung');
  }
}

// Checkout-Sitzung einer Bestellung abrufen. Sie liegt auf dem Konto des Ladens;
// ohne gespeichertes Konto wird bewusst NICHT auf dem Plattformkonto gesucht.
function sitzungAbrufen(stripe, sessionId, konto) {
  if (!konto) return Promise.reject(new Error('Bestellung ohne Stripe-Konto'));
  return stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: konto });
}

// Echte Stripe-Gebuehr einer bezahlten Bestellung nachlesen und speichern.
// Bewusst ohne await aufrufen: Die Zahlungsbestaetigung wartet nie darauf und kann
// daran nicht scheitern. Wirft nie; Fehler nur mit Bestellnummer ins Log.
async function stripeGebuehrNachlesen(order) {
  try {
    if (!stripeDirekt.istDirektBestellung(order) || !order.stripePaymentIntentId) return;
    if (Number.isInteger(order.stripeGebuehrCent)) return;
    const pi = await getStripe().paymentIntents.retrieve(order.stripePaymentIntentId,
      { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: order.stripeAccount });
    const cent = stripeDirekt.gebuehrCentAusPaymentIntent(pi);
    if (cent === null) return;   // Stripe kennt sie noch nicht, der Nachhol-Lauf versucht es spaeter
    await Order.updateOne({ _id: order._id, stripeGebuehrCent: { $exists: false } }, { $set: { stripeGebuehrCent: cent } });
  } catch (e) {
    console.warn(`Stripe-Gebuehr #${order?.orderNum} nicht gelesen: ${e.message}`);
  }
}

// ── Neue Web-Bestellung (pending) ────────────────────────────────
// Nur Barzahlung von der Bestellseite. Den früheren POS-Weg (source 'pos':
// sofort bestätigt, Betrag aus dem Request, Mails und Druck) gibt es nicht
// mehr – siehe bestellung.js.
app.post('/api/orders', async (req, res) => {
  try {
    if (lieferungAbgelehnt(req, res)) return;   // Liefergebiet, Mindestbestellwert je Zone, Açaí nur im Laden
    // Erst danach: lieferungAbgelehnt setzt deliveryFee (und die Lieferadresse) in req.body selbst.
    const auswahl = webBestellungAusRequest(req.body);
    if (auswahl.fehler) return res.status(400).json({ message: auswahl.fehler });
    const zeit = await bestellzeitPruefen(req, res);   // Laden zu → nur mit gültiger Wunschzeit
    if (!zeit) return;

    // userId aus Kunden-JWT extrahieren falls vorhanden (Gastbestellung bleibt möglich)
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        userId = decoded.id;
      } catch {} // Gastbestellung – kein Fehler
    }

    const orderNum = await getNextOrderNum();

    // Rabatt nicht aus dem Request übernehmen, sondern selbst rechnen
    const rabatt = berechneRabatt(req.body);
    const gesamt = Math.round((
      (Number(req.body.subtotal) || 0) - rabatt +
      (Number(req.body.deliveryFee) || 0) + (Number(req.body.serviceFee) || 0)
    ) * 100) / 100;

    const order    = new Order({
      ...auswahl.felder, orderNum, userId,
      wunschzeit: zeit.wunschzeit, vorbestellung: zeit.vorbestellung, note: zeit.note,
      discount: rabatt,
      total:    gesamt,
      coupon:   rabatt > 0 ? RABATT_CODE : null,
    });
    await order.save();
    res.status(201).json({ orderNum: order.orderNum, statusToken: order.statusToken, order });
  } catch(e) { console.error(e); res.status(500).json({ message: 'Fehler beim Speichern' }); }
});

// ── Bestellstatus fuer den wartenden Kunden (oeffentlich, Token-geschuetzt) ──
// Der Kunde wartet nach dem Absenden auf die Annahme durch das Restaurant.
// Antwortet absichtlich minimal: kein Name, keine Adresse, keine Betraege.
app.get('/api/orders/status/:token', async (req, res) => {
  try {
    const o = await Order.findOne({ statusToken: req.params.token })
      .select('status paymentStatus prepTime orderNum mode cancelReason wunschzeit vorbestellung');
    // Der Marker unterscheidet diese 404 von der eines Backends, das die Route
    // noch gar nicht kennt -- etwa im Fenster zwischen Seiten- und Backend-Deploy.
    if (!o) return res.status(404).json({ message: 'Nicht gefunden', unbekannterSchluessel: true });
    res.json({
      status:           o.status,
      paymentStatus:    o.paymentStatus,
      estimatedMinutes: o.prepTime || null,
      orderNum:         o.orderNum,
      mode:             o.mode,
      cancelReason:     o.cancelReason || '',
      vorbestellung:    Boolean(o.vorbestellung && o.wunschzeit),
      wunschzeit:       o.wunschzeit || null,
      // fertig formatiert (Europe/Berlin), z. B. "Fr. 20.11., 12:30 Uhr"
      wunschzeitText:   o.vorbestellung && o.wunschzeit ? Zeiten.zeitText(o.wunschzeit) : ''
    });
  } catch (e) {
    console.error('Statusabfrage:', e.message);
    res.status(500).json({ message: 'Fehler' });
  }
});

// ── Stripe Checkout ───────────────────────────────────────────────
// Nur Direct Charge auf dem eigenen Konto des Ladens. Ist das Konto nicht bereit
// oder scheitert die Sitzung, gibt es 503 mit Hinweis auf Barzahlung: keine
// Bestellung, kein zweiter Versuch auf einem anderen Weg. Das Plattformkonto
// nimmt fuer diesen Laden nie Geld an.
const ONLINE_ZAHLUNG_AUS = 'Online-Zahlung ist derzeit nicht möglich. Bitte wähle Barzahlung (bar bei Abholung oder Lieferung).';

app.post('/api/create-stripe-checkout', async (req, res) => {
  try {
    const konto = await direktKontoFuerCheckout();
    if (!konto) return res.status(503).json({ message: ONLINE_ZAHLUNG_AUS, onlineZahlung: false });
    if (lieferungAbgelehnt(req, res)) return;   // Liefergebiet, Mindestbestellwert je Zone, Açaí nur im Laden
    const zeit = await bestellzeitPruefen(req, res);   // Laden zu → nur mit gültiger Wunschzeit
    if (!zeit) return;
    const { items, subtotal, deliveryFee, serviceFee, customer, mode } = req.body;
    const { note, wunschzeit, vorbestellung } = zeit;
    const orderNum = await getNextOrderNum();

    // Kein Rabatt in Ahaus: berechneRabatt() liefert immer 0, ein mitgeschickter
    // Code oder Betrag wird ignoriert. Deshalb gibt es hier auch keinen Stripe-
    // Gutschein (coupons.create) mehr - einer auf dem Plattformkonto liesse sich
    // in einer Sitzung auf dem Konto des Ladens ohnehin nicht verwenden.
    const rabatt = berechneRabatt(req.body);
    if (rabatt !== 0) throw new Error('Rabatt ist in Ahaus nicht vorgesehen');
    const total  = Math.round((
      (Number(subtotal) || 0) + (Number(deliveryFee) || 0) + (Number(serviceFee) || 0)
    ) * 100) / 100;

    const lineItems = items.filter(i => i.price > 0).map(i => ({
      price_data: { currency:'eur',
        product_data: { name: `${i.qty}× ${i.name}${i.note?' ('+i.note+')':''}` },
        unit_amount: Math.round(i.price * 100) },
      quantity: i.qty,
    }));
    if (deliveryFee > 0) lineItems.push({
      price_data: { currency:'eur', product_data:{ name:'Liefergebühr' }, unit_amount: Math.round(deliveryFee*100) }, quantity:1
    });
    if (serviceFee > 0) lineItems.push({
      price_data: { currency:'eur', product_data:{ name:'Servicegebühr' }, unit_amount: Math.round(serviceFee*100) }, quantity:1
    });

    // Zugriffsschluessel schon hier erzeugen: die success_url wird gebaut,
    // bevor die Bestellung existiert, und muss ihn mitfuehren.
    const statusToken = crypto.randomBytes(9).toString('base64url');

    const sessionOpts = {
      line_items: lineItems,
      mode: 'payment',
      ...(customer.email ? { customer_email: customer.email } : {}),
      locale: 'de',
      metadata: { orderNum: String(orderNum) },
      success_url: `${FRONTEND}?order=${orderNum}&t=${statusToken}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${FRONTEND}?payment=cancelled`,
      // Karte (Apple Pay und Google Pay laufen darueber) und Klarna, wenn freigeschaltet -
      // alles Zahlarten, die sofort bestaetigt werden. Keine Plattformgebuehr und keine
      // Weiterleitung: Die Zahlung gehoert dem Laden.
      payment_method_types: zahlarten(),
      // Zahlseite nach 30 Minuten schliessen (Stripes Mindestwert): Eine abgebrochene
      // Bestellung bleibt so nicht bis zu 24 Stunden offen.
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    };

    let session;
    try {
      try {
        session = await getStripe().checkout.sessions.create(sessionOpts, { stripeAccount: konto });
      } catch (e) {
        // Lehnt Stripe Klarna ab (z. B. Betrag ausserhalb der Klarna-Grenzen), einmal nur
        // mit Karte auf demselben Konto versuchen. Das ist kein Rueckweg auf ein anderes Konto.
        if (sessionOpts.payment_method_types.length === 1) throw e;
        console.warn('Checkout mit Klarna abgelehnt, zweiter Versuch nur mit Karte:', e.message);
        sessionOpts.payment_method_types = ['card'];
        session = await getStripe().checkout.sessions.create(sessionOpts, { stripeAccount: konto });
      }
    } catch (e) {
      // Kein Rueckweg. Statt das Konto pauschal eine Minute zu sperren (dann koennte ein
      // einzelner kaputter Warenkorb die Kartenzahlung fuer alle Gaeste abschalten), wird
      // sofort neu bei Stripe nachgefragt: Nur wenn das Konto wirklich nicht (mehr)
      // freigeschaltet oder Stripe nicht erreichbar ist, schaltet die Seite auf "nur bar".
      console.error('Stripe-Checkout auf dem Konto des Ladens fehlgeschlagen:', e.message);
      direktKontoBereit.vergessen();
      const nochBereit = (await direktKontoFuerCheckout()) !== null;
      return res.status(503).json({
        message: nochBereit
          ? 'Die Online-Zahlung konnte nicht gestartet werden. Bitte versuche es erneut oder wähle Barzahlung.'
          : ONLINE_ZAHLUNG_AUS,
        onlineZahlung: nochBereit,
      });
    }

    const order = new Order({
      items, subtotal, deliveryFee, serviceFee, total,
      customer, mode, note, orderNum, wunschzeit, vorbestellung,
      discount: 0,
      coupon: null,
      payment: 'stripe', paymentStatus: 'pending',
      stripeSessionId: session.id, stripeAccount: konto, status: 'awaiting_payment',
      statusToken
    });
    await order.save();
    // statusToken: Die Seite merkt ihn sich, um einen gespeicherten Warenkorb nach
    // bezahlter Bestellung zu leeren, auch wenn der Gast nicht zurückkommt.
    res.json({ url: session.url, orderNum, statusToken });
  } catch(e) { console.error(e); res.status(500).json({ message: 'Stripe Fehler: '+e.message }); }
});

// ── Stripe Webhook ────────────────────────────────────────────────
app.post('/api/stripe-webhook', async (req, res) => {
  // Nur der Connect-Endpunkt (Ereignisse verbundener Konten) ist eingerichtet,
  // also gibt es nur dieses eine Signaturgeheimnis.
  const geheimnis = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!geheimnis) return res.status(400).send('Webhook Error: STRIPE_CONNECT_WEBHOOK_SECRET fehlt');
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], geheimnis);
  } catch(e) { return res.status(400).send('Webhook Error: '+e.message); }

  // Der Connect-Endpunkt bekommt die Ereignisse ALLER Laeden der Plattform.
  // Verarbeitet wird nur das eigene Konto; fremde Konten und Ereignisse ohne
  // Konto quittieren und liegen lassen, sonst wiederholt Stripe sie tagelang.
  if (!stripeDirekt.ereignisFuerUns(event, process.env.STRIPE_DIREKT_KONTO)) {
    return res.json({ received: true, ignoriert: true });
  }

  // Nur aus `awaiting_payment` heraus, und atomar. Stripe wiederholt eine
  // Zustellung bis zu drei Tage lang. Bis dahin ist die Bestellung laengst per
  // verify-payment oder Wachhund eingebucht, vielleicht schon ausgeliefert.
  // Ohne die Statusbedingung setzt eine spaete Wiederholung sie auf `pending`
  // zurueck, und sie steht als neue Bestellung an der Kasse (Fix aus Amoura,
  // 18.09.2026 - Nordkirchen als Vorlage nimmt keine Karte und hatte ihn nicht).
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      // "completed" heisst nur: Der Gast ist durch die Zahlseite durch. Bezahlt ist erst
      // payment_status 'paid' (bei Karte, Apple Pay, Google Pay und Klarna sofort der Fall).
      if (s.payment_status !== 'paid') return res.json({ received: true });
      const order = await Order.findOneAndUpdate(
        { stripeSessionId: s.id, status: 'awaiting_payment' },
        { $set: { paymentStatus: 'paid', status: 'pending', stripePaymentIntentId: s.payment_intent } }, // wartet auf Admin-Bestätigung
        { new: true });
      if (order) {
        console.log(`💳 Bezahlt: #${order.orderNum} → wartet auf Bestätigung`);
        stripeGebuehrNachlesen(order);   // ohne await, wirft nie
      }
    }
    if (event.type === 'checkout.session.expired') {
      await Order.findOneAndUpdate({ stripeSessionId: event.data.object.id, status: 'awaiting_payment' }, { status:'cancelled' });
    }
  } catch(e) {
    // Antworten statt haengen lassen: Stripe versucht es spaeter erneut, und
    // dank der Statusbedingung richtet die Wiederholung keinen Schaden an.
    console.error('Stripe-Webhook Verarbeitung fehlgeschlagen:', e.message);
    return res.status(500).send('Verarbeitung fehlgeschlagen');
  }
  res.json({ received: true });
});

// ── Zahlungsverifikation (Fallback falls Webhook fehlschlägt) ──
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ ok: false, message: 'sessionId fehlt' });

    // Die Sitzung liegt auf dem Konto des Ladens; das Konto steht an der Bestellung.
    // Deshalb erst die Bestellung lesen, dann Stripe fragen.
    const order = await Order.findOne({ stripeSessionId: sessionId });
    if (!order) return res.status(404).json({ ok: false, message: 'Bestellung nicht gefunden' });

    const session = await sitzungAbrufen(getStripe(), sessionId, order.stripeAccount);
    if (session.payment_status !== 'paid') {
      return res.json({ ok: false, message: 'Noch nicht bezahlt' });
    }

    // Atomar und nur aus awaiting_payment, wie Webhook und Wachhund
    const bezahlt = await Order.findOneAndUpdate(
      { _id: order._id, status: 'awaiting_payment' },
      { $set: { paymentStatus: 'paid', status: 'pending', stripePaymentIntentId: session.payment_intent } },
      { new: true });
    if (bezahlt) {
      console.log(`✅ Zahlung verifiziert (Fallback): #${bezahlt.orderNum}`);
      stripeGebuehrNachlesen(bezahlt);   // ohne await, wirft nie
    }

    res.json({ ok: true, orderNum: order.orderNum });
  } catch(e) {
    console.error('verify-payment Fehler:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── PayPal Checkout ───────────────────────────────────────────────
app.post('/api/create-paypal-order', async (req, res) => {
  try {
    if (lieferungAbgelehnt(req, res)) return;   // Liefergebiet, Mindestbestellwert je Zone, Açaí nur im Laden
    const zeit = await bestellzeitPruefen(req, res);   // die Seite bietet PayPal nicht an, die Route ist aber offen
    if (!zeit) return;
    const { items, subtotal, deliveryFee, serviceFee, customer, mode } = req.body;
    const { note, wunschzeit, vorbestellung } = zeit;
    const orderNum = await getNextOrderNum();

    // Rabatt serverseitig ermitteln – der Client-Betrag wird nicht übernommen.
    const rabatt = berechneRabatt(req.body);
    const total  = Math.round((
      (Number(subtotal) || 0) - rabatt + (Number(deliveryFee) || 0) + (Number(serviceFee) || 0)
    ) * 100) / 100;

    // Zugriffsschluessel schon hier erzeugen: die return_url wird gebaut,
    // bevor die Bestellung existiert, und muss ihn mitfuehren.
    const statusToken = crypto.randomBytes(9).toString('base64url');

    const token = await getPaypalAccessToken();
    const ppOrder = await paypalApi('/v2/checkout/orders', 'POST', token, {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: String(orderNum),
        custom_id:    String(orderNum),
        description:  `Odi’s Bowl Ahaus Bestellung #${orderNum}`,
        amount: { currency_code: 'EUR', value: Number(total).toFixed(2) }
      }],
      application_context: {
        brand_name:          'Odi’s Bowl Ahaus',
        locale:              'de-DE',
        user_action:         'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: `${FRONTEND}?order=${orderNum}&t=${statusToken}&paypal=1`,
        cancel_url: `${FRONTEND}?payment=cancelled`,
      }
    });

    const approve = (ppOrder.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action');

    const order = new Order({
      items, subtotal, deliveryFee, serviceFee, total,
      customer, mode, note, orderNum, wunschzeit, vorbestellung,
      discount: rabatt,
      coupon: rabatt > 0 ? RABATT_CODE : null,
      payment: 'paypal', paymentStatus: 'pending',
      paypalOrderId: ppOrder.id, status: 'awaiting_payment',
      statusToken
    });
    await order.save();
    res.json({ url: approve?.href, orderNum });
  } catch(e) { console.error(e); res.status(500).json({ message: 'PayPal Fehler: '+e.message }); }
});

// ── PayPal Capture (nach Rückkehr / Fallback) ─────────────────────
app.post('/api/paypal-capture', async (req, res) => {
  try {
    const paypalOrderId = req.body.paypalOrderId || req.body.token;
    if (!paypalOrderId) return res.status(400).json({ ok: false, message: 'paypalOrderId fehlt' });

    const order = await Order.findOne({ paypalOrderId });
    if (!order) return res.status(404).json({ ok: false, message: 'Bestellung nicht gefunden' });

    const token   = await getPaypalAccessToken();
    const current = await paypalApi(`/v2/checkout/orders/${paypalOrderId}`, 'GET', token);

    let captured;
    if (current.status === 'COMPLETED') {
      captured = current; // schon (z.B. per Webhook) eingezogen
    } else if (current.status === 'APPROVED') {
      captured = await paypalApi(`/v2/checkout/orders/${paypalOrderId}/capture`, 'POST', token, {});
    } else {
      return res.json({ ok: false, message: 'Noch nicht bezahlt' });
    }

    const captureId = captured?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (order.status === 'awaiting_payment') {
      order.paymentStatus = 'paid';
      order.status = 'pending';
      if (captureId) order.paypalCaptureId = captureId;
      await order.save();
      console.log(`✅ PayPal-Zahlung verifiziert: #${order.orderNum}`);
    }
    res.json({ ok: true, orderNum: order.orderNum });
  } catch(e) {
    console.error('paypal-capture Fehler:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── PayPal Webhook (Signatur per Verify-API → nutzt geparstes JSON) ─
app.post('/api/paypal-webhook', async (req, res) => {
  try {
    const token  = await getPaypalAccessToken();
    const verify = await paypalApi('/v1/notifications/verify-webhook-signature', 'POST', token, {
      auth_algo:         req.headers['paypal-auth-algo'],
      cert_url:          req.headers['paypal-cert-url'],
      transmission_id:   req.headers['paypal-transmission-id'],
      transmission_sig:  req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id:        process.env.PAYPAL_WEBHOOK_ID,
      webhook_event:     req.body
    });
    if (verify.verification_status !== 'SUCCESS') {
      console.warn('PayPal Webhook: ungültige Signatur');
      return res.status(400).send('invalid signature');
    }

    const event = req.body;
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const captureId = event.resource?.id;
      const ppOrderId = event.resource?.supplementary_data?.related_ids?.order_id;
      const order = ppOrderId
        ? await Order.findOne({ paypalOrderId: ppOrderId })
        : await Order.findOne({ paypalCaptureId: captureId });
      if (order && order.status === 'awaiting_payment') {
        order.paymentStatus = 'paid';
        order.status = 'pending';
        if (captureId) order.paypalCaptureId = captureId;
        await order.save();
        console.log(`💳 Bezahlt (PayPal): #${order.orderNum} → wartet auf Bestätigung`);
      }
    }
    res.json({ received: true });
  } catch(e) {
    console.error('paypal-webhook Fehler:', e.message);
    res.status(500).send('error');
  }
});

// ── Stripe-Bestellungen nachträglich einbuchen (Admin) ──────────
app.post('/api/admin/recover-stripe-orders', auth, async (_req, res) => {
  try {
    const stuck = await Order.find({ status: 'awaiting_payment', payment: 'stripe' });
    const recovered = [];
    for (const order of stuck) {
      try {
        const session = await sitzungAbrufen(getStripe(), order.stripeSessionId, order.stripeAccount);
        if (session.payment_status === 'paid') {
          // Atomar und nur aus awaiting_payment, wie Webhook und Wachhund
          const bezahlt = await Order.findOneAndUpdate(
            { _id: order._id, status: 'awaiting_payment' },
            { $set: { paymentStatus: 'paid', status: 'pending', stripePaymentIntentId: session.payment_intent } },
            { new: true });
          if (!bezahlt) continue;
          recovered.push(bezahlt.orderNum);
          console.log(`🔁 Nachträglich eingebucht: #${bezahlt.orderNum}`);
          stripeGebuehrNachlesen(bezahlt);   // ohne await, wirft nie
        }
      } catch(e) {
        console.warn(`Stripe-Abfrage für #${order.orderNum} fehlgeschlagen:`, e.message);
      }
    }
    res.json({ recovered, total: stuck.length });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/admin/customers/:userId/orders', auth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(orders);
  } catch(e) {
    res.status(500).json({ message: 'Fehler beim Laden der Bestellungen' });
  }
});

app.get('/api/admin/customers', auth, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    const userIds = users.map(u => u._id);
    const [stats, stampStats] = await Promise.all([
      Order.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 }, total: { $sum: '$total' }, lastOrder: { $max: '$createdAt' } } }
      ]),
      Order.aggregate([
        { $match: { userId: { $in: userIds }, status: { $nin: ['cancelled', 'awaiting_payment'] } } },
        { $group: { _id: '$userId', validOrders: { $sum: 1 } } }
      ])
    ]);
    const statsMap = {};
    stats.forEach(s => { statsMap[s._id.toString()] = s; });
    const stampMap = {};
    stampStats.forEach(s => { stampMap[s._id.toString()] = s.validOrders; });
    const result = users.map(u => {
      const validOrders   = stampMap[u._id.toString()] || 0;
      const redeemed      = u.stampsRedeemed || 0;
      const totalRewards  = Math.floor(validOrders / 3);
      const rewardsAvail  = Math.max(0, totalRewards - redeemed);
      const currentStamps = validOrders % 3;
      return {
        ...u.toObject(),
        orderCount:      statsMap[u._id.toString()]?.count || 0,
        orderTotal:      statsMap[u._id.toString()]?.total || 0,
        lastOrder:       statsMap[u._id.toString()]?.lastOrder || null,
        stamps:          currentStamps,
        rewardsAvailable: rewardsAvail,
      };
    });
    res.json(result);
  } catch(e) {
    res.status(500).json({ message: 'Fehler beim Laden der Kunden' });
  }
});

// Bremse gegen Passwort-Raten. Bewusst KEINE harte Sperre: die wuerde ein
// Angreifer nutzen, um den Wirt vor dem Feierabendgeschaeft auszusperren.
// Stattdessen wird jeder Fehlversuch pro IP langsamer beantwortet.
const loginVersuche = new Map();          // ip -> { n, zuletzt }
const VERSUCH_FENSTER_MS = 15 * 60 * 1000;
const MAX_WARTE_MS       = 5000;

function loginBremse(ip) {
  const jetzt = Date.now();
  const e = loginVersuche.get(ip);
  if (!e || jetzt - e.zuletzt > VERSUCH_FENSTER_MS) return 0;
  return Math.min(e.n * 500, MAX_WARTE_MS);
}
function fehlversuchNotieren(ip) {
  const jetzt = Date.now();
  const e = loginVersuche.get(ip);
  if (!e || jetzt - e.zuletzt > VERSUCH_FENSTER_MS) loginVersuche.set(ip, { n: 1, zuletzt: jetzt });
  else loginVersuche.set(ip, { n: e.n + 1, zuletzt: jetzt });
}
// Aufraeumen, damit die Map nicht unbegrenzt waechst
setInterval(() => {
  const jetzt = Date.now();
  for (const [ip, e] of loginVersuche) if (jetzt - e.zuletzt > VERSUCH_FENSTER_MS) loginVersuche.delete(ip);
}, VERSUCH_FENSTER_MS).unref?.();

app.post('/api/admin/login', async (req, res) => {
  const ip = req.ip || 'unbekannt';

  if (!process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
    console.error('ADMIN_PASSWORD oder JWT_SECRET fehlt – Admin-Login nicht moeglich');
    return res.status(500).json({ message: 'Server nicht konfiguriert' });
  }

  const warte = loginBremse(ip);
  if (warte) await new Promise(r => setTimeout(r, warte));

  if (!gleichSicher(String(req.body?.password ?? ''), process.env.ADMIN_PASSWORD)) {
    fehlversuchNotieren(ip);
    console.warn('Admin-Login fehlgeschlagen von', ip);
    return res.status(401).json({ message: 'Falsches Passwort' });
  }

  loginVersuche.delete(ip);
  // Befristetes Token statt des Server-Geheimnisses. 30 Tage, damit das
  // Kuechen-Tablet nicht mitten im Betrieb rausfliegt.
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// ── Pending Bestellungen (für 5s Polling) ───────────────────────
// Was die Kasse nie sehen darf: Online-Bestellungen, die (noch) nicht bezahlt sind.
// Der Gast hat nur "Online bezahlen" gewaehlt und die Zahlseite geoeffnet, vielleicht
// bricht er ab. Solche Bestellungen stehen als awaiting_payment in der Datenbank und
// werden nach Abbruch oder Ablauf zu cancelled - beides ging frueher in der Liste mit
// an das Geraet und erschien dort unter "Laeuft" (Abed, 17.11.2026). An die Kasse
// kommt eine Online-Bestellung erst, wenn Stripe die Zahlung bestaetigt hat.
const FUER_KASSE = { $nor: [{ payment: { $in: ['stripe', 'paypal'] }, paymentStatus: { $nin: ['paid', 'refunded'] } }] };

// Kassen-App druckt bei Artikeln mit Extras nur die Extras -- die Anmerkung
// am Artikel geht deshalb als Extra mit (kasse.js).
app.use('/api/admin/orders', kasseAnmerkung());

app.get('/api/admin/orders/pending', auth, async (req, res) => {
  try { res.json({ pending: await Order.find({ ...FUER_KASSE, status:'pending' }).sort({ createdAt:1 }) }); }
  catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Alle Bestellungen ────────────────────────────────────────────
app.get('/api/admin/orders', auth, async (req, res) => {
  try {
    const dateParam = req.query.date; // z.B. "2026-04-25"

    if (dateParam) {
      // ── Vergangenheits-Abfrage: nur Bestellungen dieses Tages ──
      // Deutschland = UTC+2 (CEST) / UTC+1 (CET)
      // Server läuft in UTC → 2h abziehen damit der volle deutsche Tag abgedeckt ist
      const from = new Date(dateParam + 'T00:00:00+02:00');
      const to   = new Date(dateParam + 'T23:59:59+02:00');
      const orders = await Order.find({
        ...FUER_KASSE,
        status:    { $nin: ['pending', 'awaiting_payment'] },
        createdAt: { $gte: from, $lte: to }
      }).sort({ createdAt: -1 });
      const valid = orders.filter(o => o.status !== 'cancelled');
      return res.json({
        orders,
        stats: {
          todayCount:   orders.length,
          todayRevenue: valid.reduce((s,o) => s+(o.total||0), 0),
          active:       orders.filter(o=>['confirmed','preparing'].includes(o.status)).length,
          done:         orders.filter(o=>['ready','delivered'].includes(o.status)).length,
          cancelled:    orders.filter(o=>o.status==='cancelled').length,
          unpaid:       orders.filter(o=>o.paymentStatus!=='paid'&&o.status!=='cancelled').length,
        }
      });
    }

    // ── Normalfall: heutige + laufende Bestellungen ──
    const orders  = await Order.find({ ...FUER_KASSE, status:{ $nin:['pending','awaiting_payment'] } }).sort({ createdAt:-1 }).limit(300);
    const pending = await Order.find({ ...FUER_KASSE, status:'pending' }).sort({ createdAt:1 });
    const today   = new Date(); today.setHours(0,0,0,0);
    const tod     = orders.filter(o => new Date(o.createdAt) >= today && o.status !== 'awaiting_payment');
    res.json({
      orders, pending,
      stats: {
        todayCount:   tod.length,
        todayRevenue: tod.filter(o=>o.status!=='cancelled').reduce((s,o)=>s+(o.total||0),0),
        totalRevenue: orders.reduce((s,o)=>s+(o.total||0),0),
        active:       orders.filter(o=>['confirmed','preparing'].includes(o.status)).length,
        done:         tod.filter(o=>['ready','delivered'].includes(o.status)).length,
        cancelled:    tod.filter(o=>o.status==='cancelled').length,
        unpaid:       orders.filter(o=>o.paymentStatus!=='paid'&&o.status!=='cancelled'&&o.status!=='awaiting_payment').length,
      }
    });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bestellung BESTÄTIGEN (Annehmen + Zeit) ──────────────────────
app.patch('/api/admin/orders/:id/confirm', auth, async (req, res) => {
  try {
    const { estimatedMinutes } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id,
      { status:'confirmed', prepTime: estimatedMinutes||45 }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    // E-Mail + Druck auslösen
    await sendConfirmationEmail(order, estimatedMinutes);
    await sendRestaurantEmail(order);
    await triggerPrint(order);
    console.log(`✅ #${order.orderNum} bestätigt – ${estimatedMinutes} Min.`);
    res.json(order);
  } catch(e) { console.error(e); res.status(500).json({ message:'Fehler' }); }
});

// ── Status ändern ────────────────────────────────────────────────
app.patch('/api/admin/orders/:id/status', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { status:req.body.status }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bezahlstatus togglen ─────────────────────────────────────────
app.patch('/api/admin/orders/:id/payment', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id,
      { paymentStatus:req.body.paymentStatus }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── STORNIEREN (mit Auto-Refund bei Stripe & PayPal) ─────────────
app.delete('/api/admin/orders/:id', auth, async (req, res) => {
  try {
    const reason = req.body?.cancelReason || '';
    const order  = await Order.findByIdAndUpdate(req.params.id,
      { status:'cancelled', cancelReason:reason }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });

    let refundStatus = null;
    if (order.payment === 'stripe' && order.paymentStatus === 'paid' && order.stripePaymentIntentId) {
      try {
        // Die Zahlung liegt auf dem Konto des Ladens, also auch die Erstattung.
        // Ohne gespeichertes Konto nie auf dem Plattformkonto versuchen.
        if (!order.stripeAccount) throw new Error('Bestellung ohne Stripe-Konto, bitte im Stripe-Dashboard des Ladens erstatten');
        const refund = await getStripe().refunds.create({ payment_intent: order.stripePaymentIntentId },
          { stripeAccount: order.stripeAccount });
        refundStatus = refund.status;
        await Order.findByIdAndUpdate(order._id, { paymentStatus:'refunded' });
        console.log(`💸 Stripe-Refund #${order.orderNum}: ${refund.status}`);
      } catch(e) { console.error('Stripe Refund Fehler:', e.message); refundStatus='failed'; }
    } else if (order.payment === 'paypal' && order.paymentStatus === 'paid' && order.paypalCaptureId) {
      try {
        const token  = await getPaypalAccessToken();
        const refund = await paypalApi(`/v2/payments/captures/${order.paypalCaptureId}/refund`, 'POST', token, {});
        refundStatus = refund.status;
        await Order.findByIdAndUpdate(order._id, { paymentStatus:'refunded' });
        console.log(`💸 PayPal-Refund #${order.orderNum}: ${refund.status}`);
      } catch(e) { console.error('PayPal Refund Fehler:', e.message); refundStatus='failed'; }
    }
    await sendCancellationEmail(order, reason, refundStatus);
    res.json({ success:true, order, refundStatus });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bon nachdrucken ──────────────────────────────────────────────
app.post('/api/admin/orders/:id/print', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    await triggerPrint(order);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ message:'Druckfehler' }); }
});

// ── Verfügbarkeit (Sold-Out Toggle) ─────────────────────────────
// Die Sammlung kennt nur Artikel, die schon einmal umgeschaltet wurden. Die Kasse
// zeigt aber genau das, was dieser Endpunkt liefert - ohne die Karte bliebe ihre
// Liste fast leer. Deshalb kommen die Namen aus Menue/menu.json, derselben Quelle,
// aus der karte-einsetzen.js frueher das POS_MENU des (entfernten) Web-Dashboards erzeugte.
const MENU_FILE = path.join(__dirname, 'Menue', 'menu.json');
let menuNamesCache = { mtimeMs: 0, names: [] };

// ── Umsatzsteuer (Regeln in umsatzsteuer.js) ─────────────────────
// Karte aus derselben menu.json; UST_MODUS=kleinunternehmer schaltet den Ausweis ab.
function ustKarte() { return Ust.karteLaden(MENU_FILE); }
function ustModus() { return Ust.ustModus(process.env); }
if (process.env.UST_MODUS && !Ust.UST_MODI.includes(process.env.UST_MODUS.trim().toLowerCase())) {
  console.warn(`⚠️  UST_MODUS="${process.env.UST_MODUS}" unbekannt, es gilt "regel" (moeglich: ${Ust.UST_MODI.join(', ')})`);
}
// Aufteilung einer Bestellung: gespeichert oder nachgerechnet, wirft nie
function ustBestellung(order) { return Ust.ausBestellung(order, ustKarte()); }
// Alle Bestellungen eines Berichts: { modus, eintraege, summe }
function ustAuswerten(orders) { return Ust.auswerten(orders, ustKarte(), ustModus()); }
// Zeile fuer die Bestellmails; ein Fehler kostet nie die Mail
function ustMailZeile(order) {
  try { return Ust.mailZeile(ustBestellung(order), ustModus()); }
  catch (e) { console.error('Umsatzsteuer-Zeile:', e.message); return ''; }
}

function menuItemNames() {
  try {
    const stat = fs.statSync(MENU_FILE);
    if (stat.mtimeMs === menuNamesCache.mtimeMs) return menuNamesCache.names;

    const karte = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
    const names = [];
    const seen  = new Set();
    (karte.kategorien || []).forEach(kat => (kat.items || []).forEach(it => {
      // Doppelte Namen nur einmal: die Bestellseite vergleicht per Namensanfang,
      // ein Schalter trifft ohnehin alle gleichnamigen Artikel.
      if (it && it.name && !seen.has(it.name)) { seen.add(it.name); names.push(it.name); }
    }));
    // Baukasten (Bowl, Wrap, Acai): auch einzelne Zutaten lassen sich ausverkauft
    // schalten. Ohne diesen Teil kaeme ein abgeschalteter Mais nach dem naechsten
    // Laden in der App wieder als verfuegbar an, obwohl die Seite ihn sperrt.
    const listen = karte._listen || {};
    (karte.kategorien || []).filter(k => k.typ === 'baukasten').forEach(kat => (kat.items || []).forEach(it =>
      (it.schritte || []).forEach(s => {
        const opt = s.gruppen ? s.gruppen.flatMap(g => g.optionen || [])
                  : s.liste ? (listen[s.liste] || []) : (s.optionen || []);
        opt.forEach(n => { if (!seen.has(n)) { seen.add(n); names.push(n); } });
      })));
    (listen.getraenke || []).forEach(n => { if (!seen.has(n)) { seen.add(n); names.push(n); } });
    if (!names.length) throw new Error('keine Artikelnamen in menu.json');

    menuNamesCache = { mtimeMs: stat.mtimeMs, names };
    return names;
  } catch (e) {
    // Lieber der letzte bekannte Stand als eine leere Liste.
    console.error('Speisekarte fuer Verfuegbarkeit nicht lesbar:', e.message);
    return menuNamesCache.names;
  }
}

app.get('/api/admin/availability', auth, async (req, res) => {
  try {
    const stored = await Availability.find();
    const state  = new Map(stored.map(d => [d.itemName, d.available !== false]));

    const items = menuItemNames().map(name => ({
      itemName:  name,
      available: state.has(name) ? state.get(name) : true
    }));

    // Eintraege, die nicht mehr auf der Karte stehen, gehen nicht verloren -
    // sonst liesse sich ein umbenannter Artikel nie wieder freischalten.
    const onMenu = new Set(items.map(i => i.itemName));
    stored.forEach(d => {
      if (!onMenu.has(d.itemName)) items.push({ itemName: d.itemName, available: d.available !== false });
    });

    res.json({ items });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.patch('/api/admin/availability', auth, async (req, res) => {
  try {
    const { itemName, available } = req.body;
    if (!itemName) return res.status(400).json({ message:'itemName fehlt' });
    const doc = await Availability.findOneAndUpdate(
      { itemName }, { available }, { upsert:true, new:true });
    console.log(`${available?'✅':'❌'} "${itemName}" → ${available?'verfügbar':'ausverkauft'}`);
    res.json(doc);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Finanzübersicht ──────────────────────────────────────────────
app.get('/api/admin/finance', auth, async (req, res) => {
  try {
    const orders = await Order.find({ status:{ $in:['confirmed','preparing','ready','delivered'] } });
    const today  = new Date(); today.setHours(0,0,0,0);
    const wStart = new Date(); wStart.setDate(wStart.getDate() - wStart.getDay() + 1); wStart.setHours(0,0,0,0);
    const calc = list => {
      const brutto    = list.reduce((s,o)=>s+(o.total||0),0);
      const svcFees   = list.reduce((s,o)=>s+(o.serviceFee||0.99),0);
      return { count:list.length, brutto, svcFees, auszahlung: brutto-svcFees };
    };
    res.json({
      today: calc(orders.filter(o=>new Date(o.createdAt)>=today)),
      week:  calc(orders.filter(o=>new Date(o.createdAt)>=wStart)),
    });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ═══════════════════════════════════════════════════════════════
// E-MAIL FUNKTIONEN
// ═══════════════════════════════════════════════════════════════

const cleanName = n => n.replace(/[A-Z0-9](,[A-Z0-9])+$/, '').trimEnd();

// Vorbestellung: Tag und Uhrzeit statt "in ca. X Minuten" (vorbestellung.js)
const istVorbestellung = order => Boolean(order && order.vorbestellung && order.wunschzeit);

async function sendConfirmationEmail(order, mins) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const m    = mins || order.prepTime || (order.mode==='lieferung'?45:20);
  const vor  = istVorbestellung(order);
  const wann = vor ? Zeiten.zeitText(order.wunschzeit) : '';
  const notiz = Vorbestellung.gastNotiz(order);
  const addr = order.mode==='lieferung'
    ? `${order.customer.street} ${order.customer.house}, ${order.customer.city}`
    : 'Wallstraße 7, 48683 Ahaus';
  const rows = (order.items||[]).map(i => {
    const extras = (i.extraDetails||[]).map(e => `<div style="font-size:11px;color:#888;padding-left:8px">↳ ${e.name}${e.price>0?' (+'+e.price.toFixed(2).replace('.',',')+'€)':''}</div>`).join('');
    return `<tr><td style="padding:4px 8px;vertical-align:top">${i.qty}×</td><td style="padding:4px 8px">${cleanName(i.name)}${i.note?' <em>('+i.note+')</em>':''}${extras}</td><td style="padding:4px 8px;text-align:right;vertical-align:top">${(i.price*i.qty).toFixed(2).replace('.',',')} €</td></tr>`;
  }).join('');
  // Firmen bestellen oft vor und brauchen die Steuer als Beleg (umsatzsteuer.js)
  const ustZeile = ustMailZeile(order);
  try {
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM || 'Odi’s Bowl Ahaus <bestellungen@odis-ahaus.com>',
      to:   order.customer.email,
      subject: vor
        ? `✅ Vorbestellung #${order.orderNum} bestätigt – ${order.mode==='lieferung'?'Lieferung':'Abholung'} ${wann}`
        : `✅ Bestellung #${order.orderNum} bestätigt – Odi’s Bowl Ahaus`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#0a1e47;color:#fff;padding:22px;text-align:center">
          <h1 style="margin:0;font-size:22px">🍕 Odi’s Bowl Ahaus</h1>
          <p style="margin:4px 0 0;opacity:.8;font-size:13px">Wallstraße 7 · 48683 Ahaus</p>
        </div>
        <div style="padding:26px 22px">
          <h2 style="color:#0a1e47;margin:0 0 14px">${vor?'Vorbestellung':'Bestellung'} #${order.orderNum} bestätigt ✅</h2>
          <p>Hallo <strong>${order.customer.first}</strong>, ${vor
            ? `wir haben deine Vorbestellung angenommen und machen sie zur gewünschten Zeit fertig.`
            : 'deine Bestellung ist in der Küche!'}</p>
          <div style="background:#fff8f0;border-left:4px solid #d4a76a;padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0">
            <p style="margin:0 0 4px;font-weight:bold">${order.mode==='lieferung'?'🛵 Lieferung':'🏃 Abholung'}</p>
            <p style="margin:0;font-size:13px;color:#666">${addr}</p>
            <p style="margin:4px 0 0;font-size:15px;font-weight:bold;color:#0a1e47">${vor
              ? `📅 ${order.mode==='lieferung'?'Lieferung':'Abholung'} am ${wann.replace(', ', ' um ')}`
              : `⏱ Voraussichtlich ~${m} Minuten`}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0">
            <thead><tr style="border-bottom:2px solid #eee"><th align="left" style="padding:4px 8px">Menge</th><th align="left" style="padding:4px 8px">Artikel</th><th align="right" style="padding:4px 8px">Preis</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="border-top:1px solid #eee;padding-top:10px;font-size:13px">
            <div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Zwischensumme</span><span>${(order.subtotal||0).toFixed(2).replace('.',',')} €</span></div>
            ${order.discount>0?`<div style="display:flex;justify-content:space-between;color:#2e7d32;margin:3px 0"><span>Rabatt</span><span>\u2212${order.discount.toFixed(2)} \u20ac</span></div>`:''}
            ${order.deliveryFee>0?`<div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Liefergebühr</span><span>${order.deliveryFee.toFixed(2).replace('.',',')} €</span></div>`:''}
            <div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Servicegebühr</span><span>${(order.serviceFee||0.99).toFixed(2).replace('.',',')} €</span></div>
            <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:15px;border-top:2px solid #0a1e47;padding-top:8px;margin-top:6px"><span>Gesamt</span><span style="color:#0a1e47">${(order.total||0).toFixed(2).replace('.',',')} €</span></div>
            ${ustZeile?`<div style="color:#666;font-size:12px;margin:6px 0 0">${ustZeile}</div>`:''}
          </div>
          <p style="font-size:13px;color:#666;margin-top:14px">
            Zahlung: ${order.payment==='stripe'?'💳 Online (Stripe)':order.payment==='paypal'?'💙 PayPal':order.payment==='karte'?'💳 EC-Karte':'💵 Barzahlung'} ·
            ${order.paymentStatus==='paid'?'✅ Bereits bezahlt':'💵 Bitte bereithalten'}
          </p>
          ${notiz?`<p style="background:#fff3ea;padding:10px;border-radius:6px;font-size:13px">📝 Anmerkung: ${notiz}</p>`:''}
        </div>
        <div style="background:#f7f3ee;padding:14px;text-align:center;font-size:11px;color:#999">Odi’s Bowl Ahaus · Wallstraße 7 · 48683 Ahaus · Tel: 02561 8916861</div>
      </div>`
    });
    console.log(`📧 Bestätigung → ${order.customer.email}`);
  } catch(e) { console.error('Mail Fehler:', e); }
}

async function sendRestaurantEmail(order) {
  if (!process.env.RESTAURANT_EMAIL) return;
  const vor   = istVorbestellung(order);
  const art   = order.mode==='lieferung'?'Lieferung':'Abholung';
  const wann  = vor ? Zeiten.zeitText(order.wunschzeit) : '';
  const notiz = Vorbestellung.gastNotiz(order);
  const items = (order.items||[]).map(i=>{
    const base = `${i.qty}× ${cleanName(i.name)}${i.note?' ('+i.note+')':''}`;
    const extras = (i.extraDetails||[]).map(e=>`   ↳ ${e.name}${e.price>0?' (+'+e.price.toFixed(2)+'€)':''}`).join('\n');
    return extras ? base+'\n'+extras : base;
  }).join('\n');
  try {
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM||'Odi’s Bowl Ahaus <bestellungen@odis-ahaus.com>',
      to:   process.env.RESTAURANT_EMAIL,
      subject: vor
        ? `🔔 VORBESTELLUNG #${order.orderNum} – ${art} ${wann}`
        : `🔔 Bestellung #${order.orderNum} – ${art}`,
      html: `<pre style="font-family:monospace;font-size:13px">BESTELLUNG #${order.orderNum} · ${order.source==='pos'?'POS':'ONLINE'}
═══════════════════════════════
${vor?`📅 VORBESTELLUNG: ${art} am ${wann.replace(', ', ' um ')}
═══════════════════════════════
`:''}Art:    ${order.mode==='lieferung'?'🛵 LIEFERUNG':'🏃 ABHOLUNG'}
Kunde:  ${order.customer?.first} ${order.customer?.last}
Tel:    ${order.customer?.phone||'–'}
${order.mode==='lieferung'?`Adresse: ${order.customer?.street} ${order.customer?.house}, ${order.customer?.city}`:''}

ARTIKEL:
${items}

Zwischensumme: ${(order.subtotal||0).toFixed(2)} €
${order.discount>0?`Rabatt: -${order.discount.toFixed(2)} €\n`:''}${order.deliveryFee?`Liefergebühr:  ${order.deliveryFee.toFixed(2)} €`:''}
Servicegebühr: ${(order.serviceFee||0.99).toFixed(2)} €
GESAMT:        ${(order.total||0).toFixed(2)} €
${ustMailZeile(order)}

Zahlung: ${order.payment==='stripe'?'KREDITKARTE':order.payment==='paypal'?'PAYPAL':order.payment==='karte'?'EC-KARTE':'BAR'} – ${order.paymentStatus==='paid'?'✅ BEZAHLT':'❌ NOCH OFFEN'}
${notiz?`Anmerkung: ${notiz}`:''}</pre>`
    });
  } catch(e) { console.error('Restaurant Mail:', e); }
}

async function sendCancellationEmail(order, reason, refundStatus) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const isOnlineRefund = ['stripe','paypal'].includes(order.payment) && order.paymentStatus === 'refunded';
  const refundHtml = isOnlineRefund
    ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px;margin:14px 0">
        <strong style="color:#2e7d32">💸 Rückerstattung eingeleitet</strong><br>
        <span style="font-size:13px;color:#555">Der Betrag von ${(order.total||0).toFixed(2).replace('.',',')} € wird in 5–10 Werktagen zurückgebucht.</span>
       </div>` : '';
  try {
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM||'Odi’s Bowl Ahaus <bestellungen@odis-ahaus.com>',
      to:   order.customer.email,
      subject: `❌ Bestellung #${order.orderNum} storniert – Odi’s Bowl Ahaus`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#0a1e47;color:#fff;padding:22px;text-align:center"><h1 style="margin:0">🍕 Odi’s Bowl Ahaus</h1></div>
        <div style="padding:26px 22px">
          <h2>Bestellung #${order.orderNum} storniert</h2>
          <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung wurde leider storniert.</p>
          ${reason?`<div style="background:#fff3ea;border-radius:8px;padding:12px;margin:14px 0"><strong>Grund:</strong> ${reason}</div>`:''}
          ${refundHtml}
          <p>Bei Fragen: <strong>02561 8916861</strong></p>
        </div>
      </div>`
    });
  } catch(e) { console.error('Storno Mail:', e); }
}

// ═══════════════════════════════════════════════════════════════
// PRINTNODE
// ═══════════════════════════════════════════════════════════════

async function triggerPrint(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) return;
  try { const p = require('./printnode-helper'); await p.printOrder(order); }
  catch(e) { console.error('PrintNode:', e); }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-STATUS (Cron – jede Minute, Öffnungszeiten Deutschland)
// ═══════════════════════════════════════════════════════════════

// Öffnungszeiten Odi’s Bowl Ahaus stehen an einer Stelle: oeffnungszeiten.js
// (Mo–Fr 11–21, Sa 12–21, So 14–21 Uhr, Europe/Berlin, kein Ruhetag).
function calcAutoMode() {
  return Zeiten.modusAusUhrzeit(new Date());
}

cron.schedule('* * * * *', async () => {
  try {
    const s = await Settings.findById('restaurant');
    if (s && s.manualOverride) return; // Manuell gesetzt – nicht überschreiben
    const autoMode = calcAutoMode();
    await Settings.findByIdAndUpdate('restaurant',
      { mode: autoMode, isOpen: autoMode === 'online' },
      { upsert: true, new: true }
    );
  } catch(e) { console.error('Auto-Status Fehler:', e); }
});

// ── Wachhund: bezahlt, aber unsichtbar ──────────────────────────
// Eine Kartenzahlung wird erst zur Bestellung, wenn Stripes Webhook sie
// meldet. Bricht diese Kette, bleibt die Bestellung auf `awaiting_payment`
// stehen: Der Gast hat gezahlt, die Kueche sieht nichts, und nichts meldet
// sich. Genau das ist an drei FlueVate-Standorten von April bis September 2026
// passiert - allein in den letzten 30 Tagen 18 Zahlungen ueber 757,91 €.
//
// Der Wachhund schaut alle fuenf Minuten nach Bestellungen, die laenger als
// zehn Minuten warten, fragt bei Stripe nach und holt sie nach. Er ist
// Rettung und Alarm zugleich: Das Geschaeft laeuft mit Verspaetung weiter,
// und es faellt trotzdem auf, statt monatelang unbemerkt zu bleiben.
const WACHHUND_MINUTEN = 10;
// Obere Altersgrenze, und die ist nicht optional. Ohne sie greift der
// Wachhund beim ersten Lauf nach JEDER haengenden Bestellung - an diesen
// drei Standorten also nach allem seit April. Die Liste der eingehenden
// Bestellungen (damals im Web-Dashboard) hat keine Datumsgrenze und sortiert die aeltesten
// nach oben: Mitten im Betrieb stuende dort eine Wand aus Monate alten
// "neuen" Bestellungen, jede mit Alarmton. Und weil "pending" im Umsatz
// zaehlt, aenderten sich rueckwirkend Berichte und Gebuehren.
//
// Nach zwei Stunden wartet kein Gast mehr. Aeltere Faelle sind Aufraeumarbeit
// und brauchen eine Entscheidung, keinen Automaten.
const WACHHUND_HOECHSTENS_STUNDEN = 2;

cron.schedule('*/5 * * * *', async () => {
  if (mongoose.connection.readyState !== 1) return;
  let stripe;
  try { stripe = getStripe(); } catch { return; }   // ohne Stripe kein Wachhund

  try {
    const grenze = new Date(Date.now() - WACHHUND_MINUTEN * 60 * 1000);
    const haengend = await Order.find({
      status: 'awaiting_payment', payment: 'stripe',
      createdAt: { $lt: grenze, $gt: new Date(Date.now() - WACHHUND_HOECHSTENS_STUNDEN * 3600 * 1000) },
      nachgeholt: { $ne: true },
    }).limit(50);
    if (!haengend.length) return;

    const geholt = [];
    for (const order of haengend) {
      try {
        const sitzung = await sitzungAbrufen(stripe, order.stripeSessionId, order.stripeAccount);
        if (sitzung.payment_status !== 'paid') continue;   // Gast hat abgebrochen
        // Atomar und nur aus awaiting_payment: kam der Webhook in der
        // Zwischenzeit doch noch an, bleibt die Bestellung, wie sie ist.
        const nachgeholt = await Order.findOneAndUpdate(
          { _id: order._id, status: 'awaiting_payment' },
          { $set: { paymentStatus: 'paid', status: 'pending', nachgeholt: true,
                    ...(sitzung.payment_intent ? { stripePaymentIntentId: sitzung.payment_intent } : {}) } },
          { new: true });
        if (!nachgeholt) continue;
        geholt.push(nachgeholt);
        console.error(`🚨 Wachhund: #${order.orderNum} war bezahlt und unsichtbar - jetzt auf pending`);
        stripeGebuehrNachlesen(nachgeholt);   // ohne await, wirft nie
      } catch (e) {
        console.warn(`Wachhund uebersprungen #${order.orderNum}: ${e.message}`);
      }
    }
    if (geholt.length) await wachhundMelden(geholt);
  } catch (e) { console.error('Wachhund Fehler:', e.message); }
});

// ── Echte Stripe-Gebuehr nachholen ──────────────────────────────
// Direkt nach der Zahlung kennt Stripe die Gebuehr manchmal noch nicht, oder die
// Abfrage scheitert. Alle 30 Minuten werden bis zu 20 bezahlte Bestellungen der
// letzten 14 Tage ohne Gebuehr nachgelesen (auf dem Konto der Bestellung). Ohne
// Treffer bleibt sie in den Berichten "noch nicht bekannt".
cron.schedule('*/30 * * * *', async () => {
  if (!process.env.STRIPE_SECRET_KEY || mongoose.connection.readyState !== 1) return;
  try {
    const offen = await Order.find({
      payment: 'stripe', stripeAccount: { $exists: true, $nin: [null, ''] },
      stripePaymentIntentId: { $exists: true, $nin: [null, ''] },
      stripeGebuehrCent: { $exists: false }, paymentStatus: { $in: ['paid', 'refunded'] },
      createdAt: { $gt: new Date(Date.now() - 14 * 24 * 3600 * 1000) },
    }).limit(20);
    for (const o of offen) await stripeGebuehrNachlesen(o);
  } catch (e) { console.error('Stripe-Gebuehr nachholen Fehler:', e.message); }
});

// Die Meldung geht an beide: der Betreiber muss wissen, dass die Zahlkette
// klemmt, und das Restaurant, dass ein Gast seit zehn Minuten wartet.
async function wachhundMelden(bestellungen) {
  const resend = getResend();
  if (!resend) { console.error('🚨 Wachhund: kein RESEND_API_KEY - Alarm bleibt ungesendet'); return; }
  const empfaenger = [process.env.OWNER_EMAIL, process.env.RESTAURANT_EMAIL].filter(Boolean);
  if (!empfaenger.length) { console.error('🚨 Wachhund: kein Empfaenger gesetzt'); return; }

  const zeilen = bestellungen.map(o =>
    `<tr><td style="padding:4px 12px 4px 0">#${o.orderNum}</td>` +
    `<td style="padding:4px 12px 4px 0">${Number(o.total || 0).toFixed(2).replace('.', ',')} €</td>` +
    `<td style="padding:4px 0;color:#666">${new Date(o.createdAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}</td></tr>`).join('');

  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to: empfaenger,
    subject: `🚨 ${bestellungen.length} bezahlte Bestellung${bestellungen.length > 1 ? 'en' : ''} war${bestellungen.length > 1 ? 'en' : ''} unsichtbar`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#222">
      <h2 style="font-size:18px;margin:0 0 8px">Bezahlt, aber nicht in der App angekommen</h2>
      <p style="margin:0 0 12px">Diese Bestellung${bestellungen.length > 1 ? 'en' : ''} stand${bestellungen.length > 1 ? 'en' : ''}
      laenger als ${WACHHUND_MINUTEN} Minuten auf "wartet auf Zahlung", obwohl bei Stripe bezahlt wurde.
      Sie wurde${bestellungen.length > 1 ? 'n' : ''} soeben nachgeholt und ist jetzt in der App sichtbar.</p>
      <table style="font-size:14px;border-collapse:collapse">${zeilen}</table>
      <p style="margin:16px 0 0;font-size:13px;color:#666">
        Der Gast wartet entsprechend laenger. Ursache ist fast immer der Stripe-Webhook:
        falsche Adresse, abgeschalteter Endpunkt oder ein Signaturgeheimnis, das mit
        <code>we_</code> statt <code>whsec_</code> beginnt. Pruefen mit
        <code>zahlkette-pruefen.js</code> aus dem Betriebs-Skill.</p></div>`,
  });
  if (error) console.error('🚨 Wachhund: Alarm-Mail fehlgeschlagen:', error.message || error);
  else console.error(`🚨 Wachhund: Alarm an ${empfaenger.join(', ')} gesendet`);
}

// ═══════════════════════════════════════════════════════════════
// WOCHENBERICHT + RECHNUNG (Cron – jeden Sonntag 23:59)
// ═══════════════════════════════════════════════════════════════

// PDF-Bau der Berichte (Layout, Abrechnung, Umsatzsteuer) steht in berichte-pdf.js -
// ohne Datenbank aufrufbar. Hier bleiben Abfragen, Zeitraeume und Versand.
const Berichte = require('./berichte-pdf');
const { generatePdf, PDF_SV, berichtAbrechnung, abrechnungMailZeilen, abrechnungOwnerText,
        buildWochenberichtPdf, getWeekNum } = Berichte;


// TAGESBERICHT (täglich um 22:00 Uhr)
cron.schedule('0 22 * * *', async () => {
  try {
    const now   = new Date();
    const start = new Date(now); start.setHours(0,0,0,0);
    const end   = new Date(now); end.setHours(23,59,59,999);
    const label = now.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'2-digit', year:'numeric' });

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $nin: ['cancelled','awaiting_payment'] }
    }).sort({ orderNum: 1 });

    if (orders.length === 0) {
      console.log('[Tagesbericht] Keine Bestellungen heute – kein PDF versendet.');
      return;
    }

    const total       = orders.reduce((s,o) => s + (o.total||0), 0);
    const totalBar    = orders.filter(o=>o.payment==='bar').reduce((s,o)=>s+(o.total||0),0);
    const totalStripe = orders.filter(o=>o.payment==='stripe').reduce((s,o)=>s+(o.total||0),0);
    const totalPayPal = orders.filter(o=>o.payment==='paypal').reduce((s,o)=>s+(o.total||0),0);
    const nLief       = orders.filter(o=>o.mode==='lieferung').length;
    const nAbh        = orders.filter(o=>o.mode==='abholung').length;

    const tagespdf = await generatePdf(doc => {
      const W = 495;
      const fmt = n => n.toFixed(2).replace('.',',')+' €';

      // Header
      doc.rect(0,0,595,70).fill('#0a1e47');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Tagesbericht', 50, 16);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.8)')
        .text(`Odi’s Bowl Ahaus  ·  ${label}`, 50, 44);

      doc.moveDown(3.5);

      // Zusammenfassung
      const sumRows = [
        ['Bestellungen gesamt', `${orders.length}`, false],
        ['davon Lieferung', `${nLief}`, true],
        ['davon Abholung', `${nAbh}`, false],
        ['Umsatz Barzahlung', fmt(totalBar), true],
        ['Umsatz Online-Zahlung (Ihr Stripe-Konto)', fmt(totalStripe), false],
        // PayPal gibt es in Ahaus nicht; die Zeile nur, falls doch eine Altbestellung auftaucht
        ...(totalPayPal ? [['Umsatz PayPal', fmt(totalPayPal), true]] : []),
      ];
      sumRows.forEach(([label, val, shade]) => {
        const y = doc.y;
        if (shade) doc.rect(50,y,W,26).fill('#f5f5f5');
        doc.font('Helvetica').fontSize(11).fillColor('#222').text(label, 58, y+7);
        doc.text(val, 50, y+7, { width: W-8, align:'right' });
        doc.y = y+26;
      });

      // Gesamtumsatz
      const ty = doc.y;
      doc.rect(50,ty,W,36).fill('#0a1e47');
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff')
        .text('GESAMTUMSATZ', 58, ty+11);
      doc.text(fmt(total), 50, ty+11, { width:W-8, align:'right' });
      doc.y = ty+50;

      // Umsatzsteuer: nur die Summentabelle (Einzelaufstellung im Monatsbericht)
      Berichte.pdfUstSumme(doc, ustAuswerten(orders));

      doc.moveDown(1);

      // Bestelldetails
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#0a1e47').text('Alle Bestellungen');
      doc.moveDown(0.4);

      orders.forEach((o, i) => {
        if (doc.y > 730) doc.addPage();
        const rowY = doc.y;
        const shade = i % 2 === 0;
        if (shade) doc.rect(50,rowY,W,0).fill('#f9f9f9');

        const kunde    = `${o.customer?.first||''} ${o.customer?.last||''}`.trim() || '–';
        const telefon  = o.customer?.phone || '–';
        const email    = o.customer?.email || '–';
        const adresse  = o.mode==='lieferung'
          ? `${o.customer?.street||''} ${o.customer?.house||''}, ${o.customer?.city||''}`.trim()
          : 'Abholung';
        const zahlung  = o.payment==='stripe'?'Online (Ihr Stripe-Konto)':o.payment==='paypal'?'PayPal':o.payment==='karte'?'EC-Karte':'Bar';
        const bezahlt  = o.paymentStatus==='paid'?'✓ Bezahlt':'✗ Offen';
        const items    = (o.items||[]).map(it=>{
          const extras = (it.extraDetails||[]).map(e=>e.name).filter(Boolean).join(', ');
          return `${it.qty}× ${cleanName(it.name)}${extras?' ['+extras+']':''}${it.note?' ('+it.note+')':''}`;
        }).join(', ');

        // Trennlinie
        doc.rect(50, rowY, W, 0.5).fill('#e0e0e0');

        doc.font('Helvetica-Bold').fontSize(10).fillColor('#0a1e47')
          .text(`#${o.orderNum}  ${new Date(o.createdAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}  ${o.mode==='lieferung'?'LIEFERUNG':'ABHOLUNG'}`, 50, rowY+6, { width: W/2 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#222')
          .text(fmt(o.total||0), 50, rowY+6, { width:W, align:'right' });

        doc.font('Helvetica').fontSize(9).fillColor('#333')
          .text(`Kunde: ${kunde}  |  Tel: ${telefon}  |  ${email}`, 50, rowY+20, { width: W });
        doc.text(`Adresse: ${adresse}  |  Zahlung: ${zahlung}  |  ${bezahlt}`, 50, rowY+32, { width: W });
        doc.text(`Artikel: ${items}`, 50, rowY+44, { width: W });

        doc.y = rowY + 60;
      });

      // Footer
      doc.fontSize(8).fillColor('#aaa')
        .text(`Odi’s Bowl Ahaus  ·  Tagesbericht ${label}  ·  Erstellt: ${now.toLocaleTimeString('de-DE')}`, 50, 790, { width: W, align:'center' });
    });

    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'Odi’s Bowl Ahaus <bestellungen@odis-ahaus.com>',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📋 Tagesbericht ${label} · Odi’s Bowl Ahaus`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
          <div style="background:#0a1e47;padding:22px 28px;color:#fff">
            <h2 style="margin:0;font-size:20px">Tagesbericht</h2>
            <p style="margin:4px 0 0;opacity:.8;font-size:13px">${label}</p>
          </div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
              <tr><td style="padding:8px">davon Lieferung</td><td style="padding:8px;text-align:right">${nLief}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">davon Abholung</td><td style="padding:8px;text-align:right">${nAbh}</td></tr>
              <tr><td style="padding:8px">Umsatz Barzahlung</td><td style="padding:8px;text-align:right">${totalBar.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">Umsatz Online-Zahlung (Ihr Stripe-Konto)</td><td style="padding:8px;text-align:right">${totalStripe.toFixed(2).replace('.',',')} €</td></tr>
              ${totalPayPal ? `<tr><td style="padding:8px">Umsatz PayPal</td><td style="padding:8px;text-align:right">${totalPayPal.toFixed(2).replace('.',',')} €</td></tr>` : ''}
              <tr style="background:#0a1e47"><td style="padding:10px;font-weight:bold;color:#fff;font-size:15px">Gesamtumsatz</td><td style="padding:10px;text-align:right;font-weight:bold;color:#fff;font-size:15px">${total.toFixed(2).replace('.',',')} €</td></tr>
            </table>
            <p style="font-size:12px;color:#888;margin-top:12px">Die vollständige Bestellliste mit Kundendaten finden Sie im beigefügten PDF.</p>
          </div>
        </div>`,
        attachments: [{ filename: `Tagesbericht_${now.toISOString().slice(0,10)}.pdf`, content: tagespdf.toString('base64') }]
      });
    }
    console.log(`📋 Tagesbericht versendet: ${orders.length} Bestellungen, ${total.toFixed(2)} €`);
  } catch(e) { console.error('Tagesbericht Fehler:', e); }
});

// Baut und versendet den Wochenbericht fuer die Woche, die auf `now` endet.
// Einzige Quelle - der Sonntags-Cron und POST /api/admin/send-weekly rufen
// beide hier rein. Fehler werden bewusst nicht gefangen: der Cron loggt sie,
// der Endpunkt macht daraus einen 500er.
//
// nurOwner=true laesst die Mail an das Restaurant aus - fuer Probelaeufe.
// Bewusst ein Parameter und nicht das Leeren von RESTAURANT_EMAIL: an der
// Variablen haengt auch die Benachrichtigung bei jeder eingehenden
// Bestellung, die dabei mit ausfallen wuerde.
async function wochenberichtVersenden(now, { nurOwner = false } = {}) {
  const wStart   = new Date(now); wStart.setDate(now.getDate()-6); wStart.setHours(0,0,0,0);
  const wEnd     = new Date(now); wEnd.setHours(23,59,59,999);
  const kw       = getWeekNum(now);
  const datum    = now.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
  const vonBis   = `${wStart.toLocaleDateString('de-DE')} – ${datum}`;

  const orders = await Order.find({
    status: { $in: ['confirmed','preparing','ready','delivered'] },
    createdAt: { $gte: wStart, $lte: wEnd }
  });

  const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
  const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const auszahlung = brutto - svcFees;
  const barOrders  = orders.filter(o => o.payment === 'bar');
  const barSvc     = barOrders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const barNetto   = barOrders.reduce((s,o) => s+(o.total||0), 0) - barSvc;
  const barBetrag  = barSvc;
  const a = berichtAbrechnung(orders, false);

  const berichtPdf = await generatePdf(doc => buildWochenberichtPdf(doc, {
    kw, jahr: now.getFullYear(), vonBis, orders, brutto, svcFees, auszahlung,
    barOrders, barSvc, barNetto, barBetrag, ust: ustAuswerten(orders),
  }));

  // Wer wirklich eine Mail bekommen hat. Fehlt der Resend-Key oder eine
  // Adresse, wird still uebersprungen - ohne dieses Protokoll meldet der
  // Endpunkt einen Erfolg, dem gar kein Versand entspricht.
  const resend   = getResend();
  const versandt = [];

  // ── E-Mail 1: Restaurant bekommt Wochenbericht als PDF-Anhang ────────
  if (resend && process.env.RESTAURANT_EMAIL && !nurOwner) {
    const antwort = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Odi’s Bowl Ahaus <bestellungen@odis-ahaus.com>',
      to: process.env.RESTAURANT_EMAIL,
      subject: `📊 Wochenbericht KW ${kw} / ${now.getFullYear()} · Odi’s Bowl Ahaus`,
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
<div style="background:#0a1e47;padding:24px 28px;color:#fff">
  <h2 style="margin:0;font-size:20px">Wochenbericht KW ${kw} / ${now.getFullYear()}</h2>
  <p style="margin:4px 0 0;opacity:.8;font-size:13px">${vonBis}</p>
</div>
<div style="padding:24px 28px">
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
    ${abrechnungMailZeilen(a)}
  </table>
  <p style="font-size:11px;color:#aaa;margin-top:8px">Anbei der Wochenbericht mit Bestellliste${barOrders.length > 0 ? ' und Bar-Übersicht' : ''}.</p>
</div>
</div>`,
      attachments: [{ filename: `KW${kw}_${now.getFullYear()}_Odi’s Bowl Ahaus_Wochenbericht.pdf`, content: berichtPdf.toString('base64') }],
    });
    if (antwort?.error) console.error('Resend lehnte die Restaurant-Mail ab:', antwort.error);
    else versandt.push('restaurant');
  }

  // ── E-Mail 2: Owner bekommt den Wochenbericht als Anhang ──────
  if (resend && process.env.OWNER_EMAIL) {
    const antwort = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Odi’s Bowl Ahaus <bestellungen@odis-ahaus.com>',
      to: process.env.OWNER_EMAIL,
      subject: `📊 Wochenbericht KW ${kw} · Odi’s Bowl Ahaus`,
      html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei der Wochenbericht KW ${kw} / ${now.getFullYear()} für Odi’s Bowl Ahaus.</p>
             <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br>${abrechnungOwnerText(a)}</p>`,
      attachments: [
        { filename: `KW${kw}_${now.getFullYear()}_Odi’s Bowl Ahaus_Wochenbericht.pdf`, content: berichtPdf.toString('base64') },
      ],
    });
    if (antwort?.error) console.error('Resend lehnte die Owner-Mail ab:', antwort.error);
    else versandt.push('owner');
  }

  return { kw, jahr: now.getFullYear(), vonBis, anzahl: orders.length,
           brutto, svcFees, auszahlung, berichtPdf, nurOwner, versandt };
}

cron.schedule('0 22 * * 0', async () => {
  try {
    const r = await wochenberichtVersenden(new Date());
    console.log(`📊 Wochenbericht KW ${r.kw} (${r.anzahl} Bestellungen) an: `
              + (r.versandt.join(', ') || 'NIEMANDEN – Resend-Key oder Adressen fehlen'));
  } catch(e) { console.error('Wochenbericht Fehler:', e); }
});

// MONATSBERICHT (Cron – täglich 22:00, nur am letzten Tag des Monats)
// ═══════════════════════════════════════════════════════════════════
// Baut und versendet den Monatsbericht fuer den Monat von `refDate`. Einzige
// Quelle - der Cron am Monatsletzten und POST /api/admin/send-monthly rufen beide
// hier rein (bis 19.11.2026 stand der Ablauf an beiden Stellen getrennt). Beide
// liefern damit dasselbe PDF und dieselbe Umsatz-CSV fuer den Steuerberater.
// Fehler werden bewusst nicht gefangen: der Cron loggt sie, der Endpunkt macht
// daraus einen 500er.
//
// nur: 'restaurant' | 'inhaber' | 'owner' - Probelauf an nur eine Rolle.
// manuell: aendert nur den Text der Owner-Mail ("Manuell ausgeloest").
async function monatsberichtVersenden(refDate, { nur, manuell = false } = {}) {
  const now    = refDate;
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const mEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const monat  = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const datum  = mEnd.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
  const vonBis = `${mStart.toLocaleDateString('de-DE')} – ${datum}`;

  const orders = await Order.find({
    status: { $in: ['confirmed','preparing','ready','delivered'] },
    createdAt: { $gte: mStart, $lte: mEnd }
  });
  const stornos = await Order.find({ status: 'cancelled', createdAt: { $gte: mStart, $lte: mEnd } }).sort({ createdAt: 1 });

  // ── PDF (Kennzahlen, Abrechnung, Bestellliste, Stornos, Umsatzsteuer, Bar-Übersicht) + CSV
  const d = Berichte.monatsberichtDaten({ monat, vonBis, orders, stornos, ust: ustAuswerten(orders) });
  const { monatsPdf, pdfName, csv, csvName } = await Berichte.monatsberichtErstellen(d);
  const anhaenge = [
    { filename: pdfName, content: monatsPdf.toString('base64') },
    { filename: csvName, content: csv.toString('base64') },
  ];
  const a = d.a;

  // ── E-Mail: Restaurant + Inhaber ───────────────────────────────────────────
  // INHABER_EMAIL bekommt nur den Monatsbericht, INHABER_CC (z.B. Steuerberater,
  // mehrere mit Komma) steht dabei in CC. Je Empfaenger-Rolle eine eigene Mail.
  const versandt = [];
  const inhaberCc = (process.env.INHABER_CC || '').split(',').map(a => a.trim()).filter(Boolean);
  for (const [rolle, an, cc] of [['restaurant', process.env.RESTAURANT_EMAIL, []], ['inhaber', process.env.INHABER_EMAIL, inhaberCc]]) {
    if (!an || (nur && nur !== rolle)) continue;
    const antwort = await getResend()?.emails.send({
      from: process.env.EMAIL_FROM || 'Odi’s Bowl Ahaus <bestellungen@odis-ahaus.com>',
      to:   an,
      ...(cc.length ? { cc } : {}),
      subject: `📅 Monatsbericht ${monat} · Odi’s Bowl Ahaus`,
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
  <div style="background:#0a1e47;padding:24px 28px;color:#fff">
    <h2 style="margin:0;font-size:20px">Monatsbericht ${monat}</h2>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${vonBis}</p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
      ${abrechnungMailZeilen(a)}
    </table>
    <p style="font-size:11px;color:#aaa;margin-top:8px">Anbei der Monatsbericht mit Bestellliste, Umsatzsteuer je Bestellung${d.barOrdersM.length > 0 ? ', Bar-Übersicht' : ''} und die Umsatzliste für den Steuerberater (${csvName}).</p>
  </div>
</div>`,
      attachments: anhaenge,
    });
    if (!antwort || antwort.error) console.error(`Monatsbericht an ${rolle} nicht versendet:`, antwort?.error || 'kein RESEND_API_KEY');
    else versandt.push(rolle + (cc.length ? ` (cc ${cc.length})` : ''));
  }

  // ── E-Mail: Owner ─────────────────────────────────────────────────────
  if (process.env.OWNER_EMAIL && (!nur || nur === 'owner')) {
    const antwort = await getResend()?.emails.send({
      from: process.env.EMAIL_FROM || 'Odi’s Bowl Ahaus <bestellungen@odis-ahaus.com>',
      to: process.env.OWNER_EMAIL,
      subject: `📅 Monatsbericht ${monat} · Odi’s Bowl Ahaus`,
      html: `<p style="font-family:Arial,sans-serif;color:#555">${manuell
               ? `Manuell ausgelöst: Monatsbericht <b>${monat}</b>.`
               : `Anbei der Monatsbericht <b>${monat}</b> für Odi’s Bowl Ahaus.`}</p>
             <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br>${abrechnungOwnerText(a)}</p>`,
      attachments: anhaenge,
    });
    if (!antwort || antwort.error) console.error('Monatsbericht an owner nicht versendet:', antwort?.error || 'kein RESEND_API_KEY');
    else versandt.push('owner');
  }
  return { monat, vonBis, anzahl: orders.length, monatsPdf, csv, csvName, versandt };
}

cron.schedule('0 22 * * *', async () => {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return; // nur am letzten Tag des Monats

  try {
    const r = await monatsberichtVersenden(now);
    console.log(`📅 Monatsbericht ${r.monat} an: ` + (r.versandt.join(', ') || 'NIEMANDEN'));
  } catch(e) { console.error('Monatsbericht Fehler:', e); }
});

// ── Wochenbericht manuell triggern ───────────────────────────────
// POST /api/admin/send-weekly?date=2026-09-13  (oder leer = laufende Woche)
// date ist der Endtag der Woche; der Bericht deckt die 7 Tage davor ab.
// only=owner verschickt nur an OWNER_EMAIL, das Restaurant bleibt aussen vor.
app.post('/api/admin/send-weekly', auth, async (req, res) => {
  try {
    const p = req.query.date;
    const now = p ? new Date(`${p}T22:00:00`) : new Date();
    if (isNaN(now.getTime())) return res.status(400).json({ message: 'date muss YYYY-MM-TT sein' });
    const nurOwner = req.query.only === 'owner';
    const r = await wochenberichtVersenden(now, { nurOwner });
    console.log(`📊 Wochenbericht KW ${r.kw} manuell versendet (${r.anzahl} Bestellungen)`
              + (nurOwner ? ' – nur an Owner' : ''));
    res.json({
      success: true, kw: r.kw, jahr: r.jahr, zeitraum: r.vonBis, orders: r.anzahl,
      empfaenger: r.versandt,
      // Nur Ja/Nein, nie die Werte selbst - sagt genau, welche Variable fehlt.
      konfig: {
        RESEND_API_KEY:   !!process.env.RESEND_API_KEY,
        EMAIL_FROM:       !!process.env.EMAIL_FROM,
        OWNER_EMAIL:      !!process.env.OWNER_EMAIL,
        RESTAURANT_EMAIL: !!process.env.RESTAURANT_EMAIL,
      },
      warnung: r.versandt.length ? undefined
             : 'Es wurde nichts verschickt. Siehe konfig: was auf false steht, fehlt in Render.',
      berichtPdfBase64: r.berichtPdf.toString('base64'),
    });
  } catch(e) {
    console.error('Wochenbericht manuell Fehler:', e);
    res.status(500).json({ message: e.message });
  }
});

// ── Monatsbericht manuell triggern ───────────────────────────────
// POST /api/admin/send-monthly?month=2026-05  (oder leer = aktueller Monat)
// ?nur=restaurant|inhaber|owner: Probelauf an nur eine Rolle.
// Derselbe Ablauf wie der Cron (monatsberichtVersenden), samt Umsatz-CSV.
app.post('/api/admin/send-monthly', auth, async (req, res) => {
  try {
    const monthParam = req.query.month; // z.B. "2026-05"
    let refDate;
    if (monthParam) {
      const [y, m] = monthParam.split('-').map(Number);
      refDate = new Date(y, m - 1, 28, 22, 0, 0); // letzter Tag des Monats
    } else {
      refDate = new Date();
    }
    const r = await monatsberichtVersenden(refDate, { nur: req.query.nur, manuell: true });
    console.log(`📅 Monatsbericht ${r.monat} manuell an: ` + (r.versandt.join(', ') || 'NIEMANDEN') + ` (${r.anzahl} Bestellungen)`);
    res.json({
      success: true, monat: r.monat, orders: r.anzahl,
      empfaenger: r.versandt,
      // Nur Ja/Nein, nie die Werte selbst - sagt genau, welche Variable fehlt.
      konfig: {
        RESEND_API_KEY:   !!process.env.RESEND_API_KEY,
        RESTAURANT_EMAIL: !!process.env.RESTAURANT_EMAIL,
        INHABER_EMAIL:    !!process.env.INHABER_EMAIL,
        INHABER_CC:       !!process.env.INHABER_CC,
        OWNER_EMAIL:      !!process.env.OWNER_EMAIL,
      },
      warnung: r.versandt.length ? undefined : 'Es wurde nichts verschickt. Siehe konfig: was auf false steht, fehlt in Coolify.',
      monatsPdfBase64: r.monatsPdf.toString('base64'),
      umsatzCsvName:   r.csvName,
      umsatzCsvBase64: r.csv.toString('base64'),
    });
  } catch(e) {
    console.error('Monatsbericht manuell Fehler:', e);
    res.status(500).json({ message: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// HISTORIE & AUSWERTUNG  (für die Fluevate-Kasse-App)
// ═══════════════════════════════════════════════════════════════
// GET /api/admin/history?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Liefert Kennzahlen, Tageswerte UND die Bestellungen eines Zeitraums in einer Antwort.
// /api/admin/finance kennt nur "heute" und "diese Woche" – für Monatsumsatz und
// Bestellhistorie reicht das nicht.
//
// Zeitzone: die Tagesgrenzen richten sich nach Europe/Berlin, nicht nach UTC. Sonst
// landen Bestellungen zwischen 22:00 und 24:00 im falschen Tag.
app.get('/api/admin/history', auth, async (req, res) => {
  try {
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const berlinDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });

    const from = isDate(req.query.from) ? req.query.from : berlinDay(new Date());
    const to   = isDate(req.query.to)   ? req.query.to   : from;
    if (to < from) return res.status(400).json({ message: 'Zeitraum ist verdreht' });

    // Grosszuegiges UTC-Fenster laden und danach exakt nach Berliner Tagen filtern –
    // das ist auch bei der Sommerzeitumstellung korrekt.
    const padFrom = new Date(from + 'T00:00:00Z'); padFrom.setUTCDate(padFrom.getUTCDate() - 1);
    const padTo   = new Date(to   + 'T23:59:59Z'); padTo.setUTCDate(padTo.getUTCDate() + 1);

    const raw = await Order.find({
      ...FUER_KASSE,
      status:    { $nin: ['awaiting_payment'] },
      createdAt: { $gte: padFrom, $lte: padTo }
    }).sort({ createdAt: -1 }).limit(3000);

    const all = raw.filter(o => {
      const k = berlinDay(o.createdAt);
      return k >= from && k <= to;
    });

    // Stornierte Bestellungen zaehlen nicht zum Umsatz, aber sehr wohl zur Statistik.
    const valid = all.filter(o => o.status !== 'cancelled');
    const r2  = n => Math.round((n + Number.EPSILON) * 100) / 100;
    const sum = pick => valid.reduce((s, o) => s + (pick(o) || 0), 0);

    const brutto  = sum(o => o.total);
    const svcFees = sum(o => o.serviceFee);

    const byPayment = {};
    const byPaymentRevenue = {};
    valid.forEach(o => {
      const k = o.payment || 'unbekannt';
      byPayment[k] = (byPayment[k] || 0) + 1;
      byPaymentRevenue[k] = r2((byPaymentRevenue[k] || 0) + (o.total || 0));
    });

    const days = {};
    valid.forEach(o => {
      const k = berlinDay(o.createdAt);
      if (!days[k]) days[k] = { date: k, count: 0, brutto: 0 };
      days[k].count  += 1;
      days[k].brutto += (o.total || 0);
    });

    res.json({
      from, to,
      stats: {
        count:        valid.length,
        brutto:       r2(brutto),
        svcFees:      r2(svcFees),
        deliveryFees: r2(sum(o => o.deliveryFee)),
        auszahlung:   r2(brutto - svcFees),
        cancelled:    all.length - valid.length,
        unpaid:       valid.filter(o => o.paymentStatus !== 'paid').length,
        byPayment,
        byPaymentRevenue
      },
      byDay: Object.values(days)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(d => ({ date: d.date, count: d.count, brutto: r2(d.brutto) })),
      // Begrenzt, damit die Antwort auf einem Kassengeraet handhabbar bleibt.
      orders: all.slice(0, 500)
    });
  } catch (e) {
    console.error('history:', e);
    res.status(500).json({ message: 'Fehler' });
  }
});


app.listen(PORT, () => console.log(`🍕 Odi’s Bowl Ahaus Backend · Port ${PORT}`));
