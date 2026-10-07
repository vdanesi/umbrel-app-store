// Rapportini — server per Umbrel (Node.js senza dipendenze)
// Account personali: ogni utente ha i suoi dati in DATA_DIR/utenti/<id>/
//   impostazioni.json, rapporti/AAAA-MM-GG.json, pratiche/<id>.json
// In comune: modelli/ (PDF vuoti dei moduli, gestiti dall'amministratore) e distanze.json.

import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3444);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'utenti');
const USERS_FILE = path.join(DATA_DIR, 'utenti.json');
const SESS_FILE = path.join(DATA_DIR, 'sessioni.json');
const COOKIE = 'rapportini_sessione';
const SESSION_DAYS = 30, SESSION_HOURS_SHORT = 12;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MOD_DIR = path.join(DATA_DIR, 'modelli');       // PDF vuoti dei moduli aziendali (caricati dall'utente)
const MODELLI = ['0444', '0319', '0692', '0693'];
const DIST_FILE = path.join(DATA_DIR, 'distanze.json');
const MIGR_FILE = path.join(DATA_DIR, 'migrazione.json');  // modelli di configurazione PL e chiave OSPF (in comune)   // cache di località e percorsi già calcolati
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

const MAX_LAVORI = 9;
const MAX_ANOMALIE = 9;
const MAX_MODULI_PER_COLONNA = 8;

const DEFAULT_SETTINGS = {
  agente: '', qualifica: '', cid: '',
  residenza: '', servizio: '', unita: '',
  orarioOrdinario: '08:00',          // senza orario del turno: oltre questo totale scatta lo straordinario
  turnoDalle: '', turnoAlle: '',     // orario del turno: il lavoro fuori da questa fascia è straordinario
  codiceModulo3: '',
  struttura: '', assunto: '', luogo: '', recapito: '',   // per i moduli 0319 / 0692 / 0693
  tipoAuto: '', euroKm: '',                 // terza colonna dei moduli emessi (la prima è 0229, la seconda 0452)
  stampa: { offsetX: 0, offsetY: 0, scala: 100 }  // calibrazione per il modulo prestampato
};

// ---------- utilità ----------

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : '');
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const ora = v => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '');
const durata = v => (typeof v === 'string' && /^\d{1,3}:[0-5]\d$/.test(v) ? v : '');
const validDate = d => typeof d === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d);
/** Cartelle dell'utente (U). */
function userCtx(uid) {
  const dir = path.join(USERS_DIR, uid);
  return { uid, dir, repDir: path.join(dir, 'rapporti'), pratDir: path.join(dir, 'pratiche'), settingsFile: path.join(dir, 'impostazioni.json') };
}
const repFile = (U, d) => path.join(U.repDir, `${d}.json`);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function loadSettings(U) {
  const s = await readJson(U.settingsFile, {});
  return { ...DEFAULT_SETTINGS, ...s, stampa: { ...DEFAULT_SETTINGS.stampa, ...(s.stampa || {}) } };
}

function sanitizeSettings(s = {}) {
  const st = s.stampa || {};
  return {
    agente: str(s.agente, 120), qualifica: str(s.qualifica, 80), cid: str(s.cid, 40),
    residenza: str(s.residenza, 120), servizio: str(s.servizio, 120), unita: str(s.unita, 120),
    orarioOrdinario: durata(s.orarioOrdinario) || DEFAULT_SETTINGS.orarioOrdinario,
    turnoDalle: ora(s.turnoDalle), turnoAlle: ora(s.turnoAlle),
    codiceModulo3: str(s.codiceModulo3, 12),
    struttura: str(s.struttura, 120), assunto: validDate(s.assunto) ? s.assunto : '',
    luogo: str(s.luogo, 60), recapito: str(s.recapito, 120),
    tipoAuto: str(s.tipoAuto, 120), euroKm: str(s.euroKm, 12),
    stampa: {
      offsetX: Math.max(-30, Math.min(30, num(st.offsetX))),
      offsetY: Math.max(-30, Math.min(30, num(st.offsetY))),
      scala: Math.max(80, Math.min(120, num(st.scala, 100)))
    }
  };
}

function sanitizeReport(r = {}, data) {
  const lavori = (Array.isArray(r.lavori) ? r.lavori : []).slice(0, MAX_LAVORI).map(l => ({
    luogo: str(l?.luogo, 120), treni: str(l?.treni, 40), descrizione: str(l?.descrizione, 400),
    sigilli: str(l?.sigilli, 40), dalle: ora(l?.dalle), alle: ora(l?.alle), ore: durata(l?.ore)
  }));
  const anomalie = (Array.isArray(r.anomalie) ? r.anomalie : []).slice(0, MAX_ANOMALIE).map(a => ({
    localita: str(a?.localita, 120), testo: str(a?.testo, 400)
  }));
  const m = r.moduli || {};
  const col = v => (Array.isArray(v) ? v : []).slice(0, MAX_MODULI_PER_COLONNA).map(x => str(x, 20));
  const h = r.testata || {};
  const rr = r.riepilogo || {};
  return {
    data,
    testata: {
      agente: str(h.agente, 120), qualifica: str(h.qualifica, 80), cid: str(h.cid, 40),
      residenza: str(h.residenza, 120), servizio: str(h.servizio, 120), unita: str(h.unita, 120)
    },
    lavori, anomalie,
    moduli: { m0229: col(m.m0229), m0452: col(m.m0452), codice3: str(m.codice3, 12), m3: col(m.m3) },
    riepilogo: {
      totaleOre: durata(rr.totaleOre), oreStraord: durata(rr.oreStraord),
      straordManuale: Boolean(rr.straordManuale),
      turnoDalle: ora(rr.turnoDalle), turnoAlle: ora(rr.turnoAlle),
      trasferte: str(rr.trasferte, 40), surrogazioni: str(rr.surrogazioni, 40)
    },
    note: str(r.note, 4000),
    aggiornato: new Date().toISOString()
  };
}

const minuti = hhmm => { const m = /^(\d+):(\d\d)$/.exec(hhmm || ''); return m ? (+m[1]) * 60 + (+m[2]) : 0; };

function summary(r) {
  return {
    data: r.data,
    servizio: r.testata?.servizio || '',
    luoghi: [...new Set((r.lavori || []).map(l => l.luogo).filter(Boolean))].join(', '),
    lavori: (r.lavori || []).filter(l => l.descrizione || l.luogo).length,
    anomalie: (r.anomalie || []).filter(a => a.testo).length,
    moduli: ['m0229', 'm0452', 'm3'].reduce((a, k) => a + (r.moduli?.[k] || []).filter(Boolean).length, 0),
    totaleMin: minuti(r.riepilogo?.totaleOre),
    straordMin: minuti(r.riepilogo?.oreStraord),
    trasferte: r.riepilogo?.trasferte || '',
    surrogazioni: r.riepilogo?.surrogazioni || ''
  };
}

async function listReports(U) {
  let files = [];
  try { files = await fs.readdir(U.repDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const out = [];
  for (const f of files.filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort()) {
    try { out.push(await readJson(path.join(U.repDir, f), null)); } catch { /* file rovinato: lo salto */ }
  }
  return out.filter(Boolean);
}

// ---------- pratiche (congedi e trasferte) ----------

const validPid = id => typeof id === 'string' && /^[a-z0-9-]{8,64}$/i.test(id);
const pratFile = (U, id) => path.join(U.pratDir, `${id}.json`);

/** Copia "pulita" di dati qualsiasi: solo testo, numeri, sì/no, liste e oggetti piccoli. */
function cleanAny(v, depth = 0) {
  if (typeof v === 'string') return str(v, 2000);
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v;
  if (depth > 4 || v == null) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => cleanAny(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 80)) if (/^[a-zA-Z0-9_]{1,40}$/.test(k)) out[k] = cleanAny(v[k], depth + 1);
    return out;
  }
  return null;
}
function sanitizePratica(p, id, existing) {
  const c = cleanAny(p || {});
  return {
    ...c, id,
    tipo: ['congedo', 'trasferta'].includes(c.tipo) ? c.tipo : (existing?.tipo || 'congedo'),
    creato: existing?.creato || str(c.creato, 40) || new Date().toISOString(),
    aggiornato: new Date().toISOString()
  };
}
async function listPratiche(U) {
  let files = [];
  try { files = await fs.readdir(U.pratDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const out = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    try { const p = await readJson(path.join(U.pratDir, f), null); if (p) out.push(p); } catch { /* salto */ }
  }
  return out.sort((a, b) => String(b.creato).localeCompare(String(a.creato)));
}
async function modelliPresenti() {
  const out = {};
  for (const c of MODELLI) { try { const st = await fs.stat(path.join(MOD_DIR, c + '.pdf')); out[c] = st.size; } catch { out[c] = 0; } }
  return out;
}
function readRaw(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('File troppo grande (max 8 MB)'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- distanze stradali (rimborso km) ----------

let distCache = null;
async function loadDist() {
  if (!distCache) distCache = await readJson(DIST_FILE, { luoghi: {}, percorsi: {} });
  distCache.luoghi ||= {}; distCache.percorsi ||= {};
  return distCache;
}
async function fetchJsonExt(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': `Rapportini/${VERSION} (self-hosted Umbrel app)`, 'Accept': 'application/json', 'Accept-Language': 'it' } });
    if (!res.ok) throw new Error(`servizio mappe: errore ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('servizio mappe non raggiungibile (tempo scaduto)');
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(String(e.message) + String(e.cause?.code))) throw new Error("servizio mappe non raggiungibile: l'Umbrel è collegato a internet?");
    throw e;
  } finally { clearTimeout(t); }
}
let lastNominatim = 0;
async function geocode(nome) {
  const key = nome.trim().toLowerCase();
  const c = await loadDist();
  if (c.luoghi[key]) return c.luoghi[key];
  const wait = 1100 - (Date.now() - lastNominatim);   // regola di Nominatim: al massimo 1 richiesta al secondo
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatim = Date.now();
  const url = `${NOMINATIM_URL}/search?format=jsonv2&limit=1&countrycodes=it&q=${encodeURIComponent(nome)}`;
  const r = await fetchJsonExt(url);
  if (!Array.isArray(r) || !r.length) throw Object.assign(new Error(`Località non trovata: "${nome}"`), { status: 404 });
  const g = { lat: Number(r[0].lat), lon: Number(r[0].lon), nome: str(r[0].display_name, 200) };
  c.luoghi[key] = g;
  await writeJsonAtomic(DIST_FILE, c);
  return g;
}
/** Km stradali lungo le tappe "A - B - C" (andata e ritorno se l'itinerario lo indica). */
async function distanza(itinerario) {
  const tappe = itinerario.split(/\s+[-–—>]+\s+|\s*→\s*/).map(t => t.trim()).filter(Boolean).slice(0, 10);
  if (tappe.length < 2) throw Object.assign(new Error('Scrivi l\'itinerario con almeno due località separate da " - ", es. "Brescia - Iseo - Brescia"'), { status: 400 });
  const key = tappe.map(t => t.toLowerCase()).join(' | ');
  const c = await loadDist();
  if (c.percorsi[key]) return { km: c.percorsi[key], tappe, cache: true };
  const pts = [];
  for (const t of tappe) pts.push(await geocode(t));
  const coords = pts.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const r = await fetchJsonExt(`${OSRM_URL}/route/v1/driving/${coords}?overview=false`);
  if (r.code !== 'Ok' || !r.routes?.length) throw new Error('Percorso stradale non trovato');
  const km = Math.round(r.routes[0].distance / 1000);
  c.percorsi[key] = km;
  await writeJsonAtomic(DIST_FILE, c);
  return { km, tappe, cache: false };
}

// ---------- generatore migrazione PL ----------
// Segnaposto: {{X}} porta Cisco, {{LOOPBACK}} loopback/router-id, {{PTP}} IP PTP Extreme,
// {{TAG}} tag tratta, {{CHIAVE_OSPF}} chiave digest OSPF (salvata solo sull'Umbrel, mai nel codice).
const MIGR_DEFAULT = {
  cisco: 'Enable\nConf t\ninterface GigabitEthernet1/{{X}}\nip ospf lls disable\ndo write mem\n\n(RICORDARSI DI SALVARE)',
  extreme: [
    'Creazione Loopback', '', 'interface loopback 2', 'ip address 2 {{LOOPBACK}} 255.255.255.255 vrf circolazione', 'Exit', '',
    'Abilitazione OSPF Globale su VRF circolazione', '', 'router vrf circolazione', 'ip ospf', 'ip ospf router-id {{LOOPBACK}}',
    'ip ospf area 0.0.0.10', 'ip ospf as-boundary-router enable', 'ip ospf admin-state', 'exit', '',
    'Creazione PTP con cisco e abilitazione OSPF', '', 'vlan create 4010 name PTP_OSPF type port-mstprstp 0', 'vlan members add 4010 1/28',
    'interface vlan 4010', 'vrf circolazione', 'ip address {{PTP}} 255.255.255.252', 'ip ospf area 0.0.0.10', 'ip ospf network p2p',
    'ip ospf hello-interval 1', 'ip ospf dead-interval 3', 'ip ospf enable', 'ip ospf authentication-type message-digest',
    'ip ospf digest-key 1 key {{CHIAVE_OSPF}}', 'ip ospf authentication-type message-digest primary-digest-key 1', 'Exit', '',
    'Redistribuzione delle rotte OSPF nel ISIS', '', 'router ospf enable', 'router vrf circolazione', 'ip ospf redistribute direct',
    'ip ospf redistribute direct enable', 'exit', 'ip ospf apply redistribute direct vrf circolazione', '',
    'Comandi per evitare Loop di rotte + redistribuzione', '', 'enable', 'configure terminal', 'router vrf circolazione',
    'route-map "tag-ospf-PL" 1', 'permit', 'enable', 'set metric {{TAG}}', 'set metric-type-isis external', 'exit',
    'route-map "isis-non-tag-ospf_PL" 1', 'no permit', 'enable', 'match metric-type-isis external', 'match metric {{TAG}}', 'exit',
    'route-map "isis-non-tag-ospf_PL" 2', 'permit', 'enable', 'exit', 'route-map "peer-tag" 1', 'permit', 'enable',
    'match metric-type-isis external', 'match metric {{TAG}}', 'set ip-preference 130', 'exit', 'ip ospf redistribute isis',
    'ip ospf redistribute isis route-map "isis-non-tag-ospf_PL"', 'ip ospf redistribute isis enable', 'isis redistribute ospf',
    'isis redistribute ospf route-map "tag-ospf-PL"', 'isis redistribute ospf enable', 'no ip alternative-route',
    'ip route preference protocol isis-external {{TAG}}', 'isis accept route-map "peer-tag"', 'exit',
    'ip ospf apply redistribute isis vrf circolazione', 'isis apply redistribute ospf vrf circolazione', 'isis apply accept vrf circolazione',
    'end', 'save config'
  ].join('\n'),
  // righe che iniziano con "!" diventano avvisi in evidenza
  checklist: [
    '! UTILIZZARE SAFE MODE e USARE LA X ROSSA NON IL MENO!!!!!',
    'Disattivare port ethX quella verso il primo PL (7 o 8 di solito)',
    'Disattivare nel menu IP addresses ip relativo alla porta',
    'Disabilitare in routing OSPF → TAB Network la net di riferimento; la si capisce dal tab IP addresses',
    '! DISABILITARE IL SAFE MODE'
  ].join('\n')
};
async function loadMigr() {
  const m = await readJson(MIGR_FILE, {});
  return { cisco: m.cisco ?? MIGR_DEFAULT.cisco, extreme: m.extreme ?? MIGR_DEFAULT.extreme, checklist: m.checklist ?? MIGR_DEFAULT.checklist, chiave: m.chiave || '' };
}
const storicoFile = U => path.join(U.dir, 'migrazioni.json');

async function migrApi(req, res, url, me, U) {
  const p = url.pathname, m = req.method;
  if (p === '/api/migrazione' && m === 'GET') {
    const x = await loadMigr();
    return send(res, 200, { ...x, chiaveImpostata: !!x.chiave, predefiniti: { cisco: MIGR_DEFAULT.cisco, extreme: MIGR_DEFAULT.extreme, checklist: MIGR_DEFAULT.checklist } });
  }
  if (p === '/api/migrazione' && m === 'PUT') {
    if (!me.admin) return fail(res, 403, "I modelli li modifica l'amministratore.");
    const b = await readBody(req, 256 * 1024);
    const cur = await loadMigr();
    const nuovo = {
      cisco: typeof b.cisco === 'string' ? b.cisco.slice(0, 20000) : cur.cisco,
      extreme: typeof b.extreme === 'string' ? b.extreme.slice(0, 50000) : cur.extreme,
      checklist: typeof b.checklist === 'string' ? b.checklist.slice(0, 10000) : cur.checklist,
      chiave: typeof b.chiave === 'string' ? b.chiave.slice(0, 200) : cur.chiave
    };
    await writeJsonAtomic(MIGR_FILE, nuovo);
    return send(res, 200, { ...nuovo, chiaveImpostata: !!nuovo.chiave });
  }
  if (p === '/api/migrazione/storico' && m === 'GET') return send(res, 200, await readJson(storicoFile(U), []));
  if (p === '/api/migrazione/storico' && m === 'POST') {
    const b = await readBody(req, 64 * 1024);
    const voce = { id: crypto.randomUUID(), quando: new Date().toISOString(), x: str(b.x, 10), loop: str(b.loop, 40), ptp: str(b.ptp, 40), tag: str(b.tag, 10), nota: str(b.nota, 200) };
    const list = (await readJson(storicoFile(U), [])).filter(v => !(v.x === voce.x && v.loop === voce.loop && v.ptp === voce.ptp && v.tag === voce.tag && v.nota === voce.nota));
    list.unshift(voce);
    await fs.mkdir(U.dir, { recursive: true });
    await writeJsonAtomic(storicoFile(U), list.slice(0, 100));
    return send(res, 200, list.slice(0, 100));
  }
  const sm = /^\/api\/migrazione\/storico\/([a-z0-9-]{8,64})$/i.exec(p);
  if (sm && m === 'DELETE') {
    const list = (await readJson(storicoFile(U), [])).filter(v => v.id !== sm[1]);
    await writeJsonAtomic(storicoFile(U), list);
    return send(res, 200, list);
  }
  return null;
}

// ---------- account ----------

let users = [];                        // {id, nome, hash, salt, admin, creato, cambioPassword, ultimoAccesso}
let accSettings = { registrazioniAperte: true };
const sessions = new Map();            // sha256(token) -> {uid, scade, creata}

const saveUsers = () => writeJsonAtomic(USERS_FILE, { versione: 1, utenti: users, impostazioni: accSettings });
let sessTimer = null;
const saveSessions = () => { clearTimeout(sessTimer); sessTimer = setTimeout(() => writeJsonAtomic(SESS_FILE, { sessioni: [...sessions.entries()].map(([h, x]) => ({ h, ...x })) }).catch(console.error), 200); };

function scrypt(password, salt) {
  return new Promise((ok, ko) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? ko(e) : ok(k))));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('base64'), hash: (await scrypt(pw, salt)).toString('base64') };
}
const DUMMY = { salt: crypto.randomBytes(16).toString('base64'), hash: crypto.randomBytes(64).toString('base64') };
async function checkPassword(user, pw) {
  const u = user || DUMMY;   // stesso lavoro anche per nomi inesistenti: nessun indizio dai tempi di risposta
  const k = await scrypt(String(pw), Buffer.from(u.salt, 'base64'));
  return crypto.timingSafeEqual(k, Buffer.from(u.hash, 'base64')) && !!user;
}
const validPassword = pw => typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
/** Password temporanea leggibile (senza caratteri che si confondono). */
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(12);
  return [...b].map(x => abc[x % abc.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}

// dietro Cloudflare Tunnel o un altro proxy https il browser usa https anche se a noi arriva http
function isHttps(req) {
  if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  try { return JSON.parse(req.headers['cf-visitor'] || '{}').scheme === 'https'; } catch { return false; }
}
const cookieAttrs = req => 'HttpOnly; SameSite=Lax; Path=/' + (isHttps(req) ? '; Secure' : '');
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}
function newSession(req, res, uid, ricorda) {
  const token = crypto.randomBytes(32).toString('base64url');
  const scade = Date.now() + (ricorda ? SESSION_DAYS * 864e5 : SESSION_HOURS_SHORT * 36e5);
  sessions.set(sha(token), { uid, scade, creata: Date.now() });
  saveSessions();
  // senza "Resta connesso" il cookie non ha durata: il browser lo dimentica quando viene chiuso
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(req)}` + (ricorda ? `; Max-Age=${SESSION_DAYS * 86400}` : ''));
}
const clearCookie = (req, res) => res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
function tokenOf(req) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}
function currentUser(req) {
  const t = tokenOf(req); if (!t) return null;
  const x = sessions.get(sha(t));
  if (!x) return null;
  if (x.scade < Date.now()) { sessions.delete(sha(t)); saveSessions(); return null; }
  return users.find(u => u.id === x.uid) || null;
}
function closeSessionsOf(uid, exceptHash) { for (const [h, x] of sessions) if (x.uid === uid && h !== exceptHash) sessions.delete(h); saveSessions(); }
const publicUser = u => u && { id: u.id, nome: u.nome, admin: !!u.admin, cambioPassword: !!u.cambioPassword };

// tentativi di accesso: 5 errori per nome+indirizzo, 30 per indirizzo, 20 per nome → 15 minuti di attesa
const fails = new Map();
const isLocked = key => { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; };
function noteFail(key, limit) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++; if (f.n >= limit) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  fails.set(key, f);
}

/** I dati della versione senza account (1.x) passano al primo utente creato. */
async function adoptLegacyData(U) {
  await fs.mkdir(U.dir, { recursive: true });
  for (const [from, to] of [['rapporti', U.repDir], ['pratiche', U.pratDir], ['impostazioni.json', U.settingsFile]]) {
    const src = path.join(DATA_DIR, from);
    try { await fs.rename(src, to); console.log(`Dati esistenti (${from}) assegnati al primo account`); }
    catch (e) { if (e.code !== 'ENOENT') console.error('Spostamento dati non riuscito:', from, e.message); }
  }
}
async function contaFile(dir) { try { return (await fs.readdir(dir)).filter(f => f.endsWith('.json')).length; } catch { return 0; } }

async function accountApi(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/stato' && m === 'GET') {
    return send(res, 200, { versione: VERSION, utente: publicUser(currentUser(req)), primoAvvio: users.length === 0, registrazioniAperte: users.length === 0 || accSettings.registrazioniAperte });
  }
  if (p === '/api/registrati' && m === 'POST') {
    const b = await readBody(req, 64 * 1024);
    const nome = String(b.nome || '').trim().toLowerCase();
    const first = users.length === 0;
    if (!first && !accSettings.registrazioniAperte) return fail(res, 403, "Le registrazioni sono chiuse. Chiedi all'amministratore di aprirle.");
    if (!NAME_RE.test(nome)) return fail(res, 400, 'Il nome utente deve avere da 3 a 32 caratteri: lettere minuscole, numeri, punto, trattino, trattino basso.');
    if (!validPassword(b.password)) return fail(res, 400, 'La password deve avere almeno 8 caratteri.');
    if (users.some(u => u.nome === nome)) return fail(res, 409, 'Questo nome utente esiste già.');
    const u = { id: crypto.randomUUID(), nome, ...(await hashPassword(b.password)), admin: first, creato: new Date().toISOString(), cambioPassword: false };
    if ((first && users.length) || users.some(x => x.nome === nome)) return fail(res, 409, "Questo nome utente esiste già, oppure l'amministratore è appena stato creato. Riprova.");
    users.push(u); await saveUsers();
    const U = userCtx(u.id);
    if (first) await adoptLegacyData(U);
    await fs.mkdir(U.repDir, { recursive: true });
    newSession(req, res, u.id, !!b.ricorda);
    console.log(`Nuovo account: ${nome}${first ? ' (amministratore)' : ''}`);
    return send(res, 200, { utente: publicUser(u) });
  }
  if (p === '/api/accedi' && m === 'POST') {
    const b = await readBody(req, 64 * 1024);
    const nome = String(b.nome || '').trim().toLowerCase();
    const ip = clientIp(req), key = ip + '|' + nome, ipKey = ip + '|*', nameKey = '*|' + nome;
    const wait = isLocked(key) || isLocked(ipKey) || isLocked(nameKey);
    if (wait) return fail(res, 429, `Troppi tentativi. Riprova tra ${wait} minut${wait === 1 ? 'o' : 'i'}.`);
    const u = users.find(x => x.nome === nome);
    if (!(await checkPassword(u, b.password || ''))) {
      noteFail(key, 5); noteFail(ipKey, 30); noteFail(nameKey, 20);
      return fail(res, 401, 'Nome utente o password non corretti.');
    }
    fails.delete(key);
    u.ultimoAccesso = new Date().toISOString(); saveUsers().catch(console.error);
    newSession(req, res, u.id, !!b.ricorda);
    return send(res, 200, { utente: publicUser(u) });
  }
  if (p === '/api/esci' && m === 'POST') {
    const t = tokenOf(req); if (t) { sessions.delete(sha(t)); saveSessions(); }
    clearCookie(req, res);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/password' && m === 'POST') {
    const me = currentUser(req);
    if (!me) return fail(res, 401, 'Accedi per continuare.');
    const b = await readBody(req, 64 * 1024);
    if (!(await checkPassword(me, b.attuale || ''))) return fail(res, 400, 'La password attuale non è corretta.');
    if (!validPassword(b.nuova)) return fail(res, 400, 'La nuova password deve avere almeno 8 caratteri.');
    if (b.nuova === b.attuale) return fail(res, 400, 'La nuova password deve essere diversa da quella attuale.');
    Object.assign(me, await hashPassword(b.nuova), { cambioPassword: false }); await saveUsers();
    closeSessionsOf(me.id);          // esce dagli altri dispositivi
    newSession(req, res, me.id, false);
    return send(res, 200, { utente: publicUser(me) });
  }
  return null;
}

async function adminApi(req, res, url, me) {
  const p = url.pathname, m = req.method;
  if (!me.admin) return fail(res, 403, "Solo l'amministratore può farlo.");
  if (p === '/api/admin/utenti' && m === 'GET') {
    const out = [];
    for (const u of users) {
      const U = userCtx(u.id);
      out.push({ ...publicUser(u), creato: u.creato, ultimoAccesso: u.ultimoAccesso || '', rapporti: await contaFile(U.repDir), pratiche: await contaFile(U.pratDir) });
    }
    return send(res, 200, { utenti: out, impostazioni: accSettings });
  }
  if (p === '/api/admin/impostazioni' && m === 'POST') {
    const b = await readBody(req, 64 * 1024);
    accSettings.registrazioniAperte = !!b.registrazioniAperte; await saveUsers();
    return send(res, 200, { impostazioni: accSettings });
  }
  const mm = /^\/api\/admin\/utenti\/([A-Za-z0-9-]{1,80})(?:\/(reset|admin))?$/.exec(p);
  if (mm) {
    const u = users.find(x => x.id === mm[1]);
    if (!u) return fail(res, 404, 'Utente non trovato.');
    if (mm[2] === 'reset' && m === 'POST') {
      const temp = tempPassword();
      Object.assign(u, await hashPassword(temp), { cambioPassword: true });
      await saveUsers();
      closeSessionsOf(u.id);
      fails.forEach((_, k) => { if (k.endsWith('|' + u.nome)) fails.delete(k); });   // sblocca i tentativi
      console.log(`Password azzerata dall'amministratore per: ${u.nome}`);
      return send(res, 200, { nome: u.nome, passwordTemporanea: temp });
    }
    if (mm[2] === 'admin' && m === 'POST') {
      const b = await readBody(req, 64 * 1024);
      const val = !!b.admin;
      if (!val && u.admin && users.filter(x => x.admin).length === 1) return fail(res, 400, 'Deve restare almeno un amministratore.');
      u.admin = val; await saveUsers();
      return send(res, 200, { utente: publicUser(u) });
    }
    if (!mm[2] && m === 'DELETE') {
      if (u.id === me.id) return fail(res, 400, 'Non puoi eliminare il tuo account mentre lo usi.');
      if (u.admin && users.filter(x => x.admin).length === 1) return fail(res, 400, 'Deve restare almeno un amministratore.');
      users = users.filter(x => x.id !== u.id); await saveUsers();
      closeSessionsOf(u.id);
      await fs.rm(userCtx(u.id).dir, { recursive: true, force: true });
      console.log(`Account eliminato: ${u.nome}`);
      return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, 'Non trovato');
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = type.startsWith('application/json') && typeof body !== 'string' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}
const fail = (res, status, msg) => send(res, status, { errore: msg });

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Dati troppo grandi'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON non valido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'Vietato');
  try {
    let data = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    // Dopo un aggiornamento il browser deve prendere subito i file nuovi:
    // la pagina chiede gli script con "?v=<versione>" e niente resta in cache senza ricontrollo.
    if (ext === '.html') data = Buffer.from(data.toString('utf8').replace(/(src|href)="([\w./-]+\.(?:js|css))"/g, `$1="$2?v=${VERSION}"`));
    const etag = `"${VERSION}-${data.length}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff'
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    fail(res, 404, 'Non trovato');
  }
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // Le modifiche arrivano solo dall'app: richiedono un'intestazione che un altro sito
  // non può aggiungere senza un permesso CORS (che questo server non concede mai).
  if (m !== 'GET' && m !== 'HEAD' && req.headers['x-rapportini'] !== '1') return fail(res, 403, 'Richiesta non consentita');

  if (p === '/api/health') return send(res, 200, { ok: true, versione: VERSION });

  const acc = await accountApi(req, res, url);
  if (acc !== null) return acc;

  // ---- da qui in poi serve un account ----
  const me = currentUser(req);
  if (!me) return send(res, 401, { errore: 'Accedi per continuare.', accesso: true });
  if (me.cambioPassword) return send(res, 403, { errore: 'Devi impostare una nuova password.', cambioPassword: true });
  if (p.startsWith('/api/admin/')) return adminApi(req, res, url, me);
  const U = userCtx(me.id);

  if (p === '/api/impostazioni') {
    const extra = { versione: VERSION, utente: publicUser(me) };
    if (m === 'GET') return send(res, 200, { ...(await loadSettings(U)), ...extra });
    if (m === 'PUT') {
      const s = sanitizeSettings(await readBody(req));
      await fs.mkdir(U.dir, { recursive: true });
      await writeJsonAtomic(U.settingsFile, s);
      return send(res, 200, { ...s, ...extra });
    }
  }

  if (p === '/api/rapporti' && m === 'GET') {
    const mese = url.searchParams.get('mese');
    let all = await listReports(U);
    if (mese && /^\d{4}-\d\d$/.test(mese)) all = all.filter(r => r.data.startsWith(mese));
    return send(res, 200, all.map(summary));
  }

  // suggerimenti per i campi: luoghi, descrizioni, località, servizi già usati
  if (p === '/api/suggerimenti' && m === 'GET') {
    const all = await listReports(U);
    const count = new Map();
    const add = (k, v) => { if (!v) return; const key = k + '\u0000' + v; count.set(key, (count.get(key) || 0) + 1); };
    for (const r of all) {
      add('servizio', r.testata?.servizio);
      for (const l of r.lavori || []) { add('luogo', l.luogo); add('descrizione', l.descrizione); }
      for (const a of r.anomalie || []) { add('localita', a.localita); add('anomalia', a.testo); }
    }
    const out = { servizio: [], luogo: [], descrizione: [], localita: [], anomalia: [] };
    [...count.entries()].sort((a, b) => b[1] - a[1]).forEach(([key]) => {
      const [k, v] = key.split('\u0000'); if (out[k].length < 200) out[k].push(v);
    });
    return send(res, 200, out);
  }

  const mm = /^\/api\/rapporti\/(\d{4}-\d\d-\d\d)$/.exec(p);
  if (mm) {
    const d = mm[1];
    if (!validDate(d)) return fail(res, 400, 'Data non valida');
    if (m === 'GET') {
      const r = await readJson(repFile(U, d), null);
      return r ? send(res, 200, r) : fail(res, 404, 'Nessun rapporto per questa data');
    }
    if (m === 'PUT') {
      const r = sanitizeReport(await readBody(req), d);
      await fs.mkdir(U.repDir, { recursive: true });
      await writeJsonAtomic(repFile(U, d), r);
      return send(res, 200, r);
    }
    if (m === 'DELETE') {
      try { await fs.unlink(repFile(U, d)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return send(res, 200, { ok: true });
    }
  }

  // ---- pratiche ----
  if (p === '/api/pratiche' && m === 'GET') return send(res, 200, await listPratiche(U));
  const pm = /^\/api\/pratiche\/([^/]+)$/.exec(p);
  if (pm) {
    const id = pm[1];
    if (!validPid(id)) return fail(res, 400, 'Identificativo non valido');
    if (m === 'GET') { const x = await readJson(pratFile(U, id), null); return x ? send(res, 200, x) : fail(res, 404, 'Pratica non trovata'); }
    if (m === 'PUT') {
      const existing = await readJson(pratFile(U, id), null);
      const x = sanitizePratica(await readBody(req), id, existing);
      await fs.mkdir(U.pratDir, { recursive: true });
      await writeJsonAtomic(pratFile(U, id), x);
      return send(res, 200, x);
    }
    if (m === 'DELETE') {
      try { await fs.unlink(pratFile(U, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/distanza' && m === 'GET') {
    const it = str(url.searchParams.get('itinerario') || '', 300);
    try { return send(res, 200, await distanza(it)); }
    catch (e) { return fail(res, e.status || 502, e.message); }
  }

  if (p.startsWith('/api/migrazione')) { const r = await migrApi(req, res, url, me, U); if (r !== null) return r; }

  // ---- modelli PDF ----
  if (p === '/api/modelli' && m === 'GET') return send(res, 200, await modelliPresenti());
  const mm2 = /^\/api\/modelli\/(\d{4})$/.exec(p);
  if (mm2 && MODELLI.includes(mm2[1])) {
    const file = path.join(MOD_DIR, mm2[1] + '.pdf');
    if (m === 'GET') {
      try { const b = await fs.readFile(file); return send(res, 200, b, 'application/pdf'); }
      catch { return fail(res, 404, `Il modulo ${mm2[1]} non è ancora stato caricato`); }
    }
    if ((m === 'PUT' || m === 'DELETE') && !me.admin) return fail(res, 403, "I moduli vuoti li carica l'amministratore.");
    if (m === 'PUT') {
      const b = await readRaw(req);
      if (b.subarray(0, 5).toString('latin1') !== '%PDF-') return fail(res, 400, 'Il file non è un PDF');
      await fs.mkdir(MOD_DIR, { recursive: true });
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, b); await fs.rename(tmp, file);
      return send(res, 200, await modelliPresenti());
    }
    if (m === 'DELETE') {
      try { await fs.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return send(res, 200, await modelliPresenti());
    }
  }

  // rapporto precedente più vicino (per "copia dal giorno prima")
  const prev = /^\/api\/precedente\/(\d{4}-\d\d-\d\d)$/.exec(p);
  if (prev && m === 'GET') {
    const all = (await listReports(U)).filter(r => r.data < prev[1]);
    return all.length ? send(res, 200, all.at(-1)) : fail(res, 404, 'Nessun rapporto precedente');
  }

  if (p === '/api/backup' && m === 'GET') {
    const body = JSON.stringify({ app: 'rapportini', versione: VERSION, esportato: new Date().toISOString(),
      impostazioni: await loadSettings(), rapporti: await listReports(U), pratiche: await listPratiche(U),
      modelli: Object.fromEntries(await Promise.all(MODELLI.map(async c => {
        try { return [c, (await fs.readFile(path.join(MOD_DIR, c + '.pdf'))).toString('base64')]; } catch { return [c, null]; }
      }))) }, null, 2);
    const nome = `rapportini-${me.nome}-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return send(res, 200, body, 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="${nome}"` });
  }

  if (p === '/api/ripristino' && m === 'POST') {
    const b = await readBody(req);
    if (b?.app !== 'rapportini' || !Array.isArray(b.rapporti)) return fail(res, 400, 'Questo file non è un backup di Rapportini');
    const sovrascrivi = url.searchParams.get('sovrascrivi') === '1';
    await fs.mkdir(U.repDir, { recursive: true });
    let importati = 0, saltati = 0;
    for (const r of b.rapporti) {
      if (!validDate(r?.data)) { saltati++; continue; }
      const exists = await readJson(repFile(U, r.data), null);
      if (exists && !sovrascrivi) { saltati++; continue; }
      const clean = sanitizeReport(r, r.data);
      if (r.aggiornato) clean.aggiornato = str(r.aggiornato, 40);
      await writeJsonAtomic(repFile(U, r.data), clean);
      importati++;
    }
    if (Array.isArray(b.pratiche)) {
      await fs.mkdir(U.pratDir, { recursive: true });
      for (const x of b.pratiche) {
        if (!validPid(x?.id)) continue;
        const exists = await readJson(pratFile(U, x.id), null);
        if (exists && !sovrascrivi) continue;
        await writeJsonAtomic(pratFile(U, x.id), { ...sanitizePratica(x, x.id, exists || { creato: x.creato }), aggiornato: str(x.aggiornato, 40) || new Date().toISOString() });
      }
    }
    if (me.admin && b.modelli && typeof b.modelli === 'object') {
      await fs.mkdir(MOD_DIR, { recursive: true });
      for (const c of MODELLI) {
        if (typeof b.modelli[c] !== 'string') continue;
        const file = path.join(MOD_DIR, c + '.pdf');
        const buf = Buffer.from(b.modelli[c], 'base64');
        if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') continue;
        let has = true; try { await fs.stat(file); } catch { has = false; }
        if (!has || sovrascrivi) await fs.writeFile(file, buf);
      }
    }
    if (b.impostazioni && (sovrascrivi || !(await readJson(U.settingsFile, null)))) {
      await writeJsonAtomic(U.settingsFile, sanitizeSettings(b.impostazioni));
    }
    return send(res, 200, { importati, saltati });
  }

  return fail(res, 404, 'Non trovato');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Metodo non consentito');
    // l'app si apre solo con un account; tutti gli altri vedono la pagina di accesso
    const u = currentUser(req);
    const p = url.pathname;
    if (p === '/' || p === '/index.html') {
      if (!u || u.cambioPassword) return send(res, 302, '', 'text/plain', { Location: '/accesso' });
      return await serveStatic(req, res, '/index.html');
    }
    if (p === '/accesso' || p === '/accesso.html') {
      if (u && !u.cambioPassword) return send(res, 302, '', 'text/plain', { Location: '/' });
      return await serveStatic(req, res, '/accesso.html');
    }
    return await serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Errore del server');
  }
});

async function loadAccounts() {
  const f = await readJson(USERS_FILE, null);
  users = Array.isArray(f?.utenti) ? f.utenti : [];
  accSettings = { registrazioniAperte: true, ...(f?.impostazioni || {}) };
  const sf = await readJson(SESS_FILE, { sessioni: [] });
  const now = Date.now();
  for (const x of sf.sessioni || []) if (x.h && x.scade > now && users.some(u => u.id === x.uid)) sessions.set(x.h, { uid: x.uid, scade: x.scade, creata: x.creata });
}
await fs.mkdir(USERS_DIR, { recursive: true });
await loadAccounts();
setInterval(() => {   // pulizia sessioni scadute e tentativi vecchi
  const now = Date.now(); let ch = false;
  for (const [h, x] of sessions) if (x.scade < now) { sessions.delete(h); ch = true; }
  if (ch) saveSessions();
  for (const [k, f] of fails) if (f.until < now && !f.n) fails.delete(k);
}, 3600e3).unref();
server.listen(PORT, () => console.log(`Rapportini ${VERSION} in ascolto sulla porta ${PORT}, dati in ${DATA_DIR}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
