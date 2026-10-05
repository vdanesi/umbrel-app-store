// Rapportini — server per Umbrel (Node.js senza dipendenze)
// Salva un rapporto giornaliero (Mod. 0444) per ogni data in DATA_DIR/rapporti/AAAA-MM-GG.json
// e le impostazioni dell'agente in DATA_DIR/impostazioni.json.

import http from 'node:http';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3444);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const REP_DIR = path.join(DATA_DIR, 'rapporti');
const SETTINGS_FILE = path.join(DATA_DIR, 'impostazioni.json');
const PRAT_DIR = path.join(DATA_DIR, 'pratiche');     // domande di congedo e trasferte
const MOD_DIR = path.join(DATA_DIR, 'modelli');       // PDF vuoti dei moduli aziendali (caricati dall'utente)
const MODELLI = ['0319', '0692', '0693'];
const DIST_FILE = path.join(DATA_DIR, 'distanze.json');   // cache di località e percorsi già calcolati
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
const repFile = d => path.join(REP_DIR, `${d}.json`);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function loadSettings() {
  const s = await readJson(SETTINGS_FILE, {});
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

async function listReports() {
  let files = [];
  try { files = await fs.readdir(REP_DIR); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const out = [];
  for (const f of files.filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort()) {
    try { out.push(await readJson(path.join(REP_DIR, f), null)); } catch { /* file rovinato: lo salto */ }
  }
  return out.filter(Boolean);
}

// ---------- pratiche (congedi e trasferte) ----------

const validPid = id => typeof id === 'string' && /^[a-z0-9-]{8,64}$/i.test(id);
const pratFile = id => path.join(PRAT_DIR, `${id}.json`);

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
async function listPratiche() {
  let files = [];
  try { files = await fs.readdir(PRAT_DIR); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const out = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    try { const p = await readJson(path.join(PRAT_DIR, f), null); if (p) out.push(p); } catch { /* salto */ }
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

  if (p === '/api/impostazioni') {
    if (m === 'GET') return send(res, 200, { ...(await loadSettings()), versione: VERSION });
    if (m === 'PUT') {
      const s = sanitizeSettings(await readBody(req));
      await writeJsonAtomic(SETTINGS_FILE, s);
      return send(res, 200, { ...s, versione: VERSION });
    }
  }

  if (p === '/api/rapporti' && m === 'GET') {
    const mese = url.searchParams.get('mese');
    let all = await listReports();
    if (mese && /^\d{4}-\d\d$/.test(mese)) all = all.filter(r => r.data.startsWith(mese));
    return send(res, 200, all.map(summary));
  }

  // suggerimenti per i campi: luoghi, descrizioni, località, servizi già usati
  if (p === '/api/suggerimenti' && m === 'GET') {
    const all = await listReports();
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
      const r = await readJson(repFile(d), null);
      return r ? send(res, 200, r) : fail(res, 404, 'Nessun rapporto per questa data');
    }
    if (m === 'PUT') {
      const r = sanitizeReport(await readBody(req), d);
      await fs.mkdir(REP_DIR, { recursive: true });
      await writeJsonAtomic(repFile(d), r);
      return send(res, 200, r);
    }
    if (m === 'DELETE') {
      try { await fs.unlink(repFile(d)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return send(res, 200, { ok: true });
    }
  }

  // ---- pratiche ----
  if (p === '/api/pratiche' && m === 'GET') return send(res, 200, await listPratiche());
  const pm = /^\/api\/pratiche\/([^/]+)$/.exec(p);
  if (pm) {
    const id = pm[1];
    if (!validPid(id)) return fail(res, 400, 'Identificativo non valido');
    if (m === 'GET') { const x = await readJson(pratFile(id), null); return x ? send(res, 200, x) : fail(res, 404, 'Pratica non trovata'); }
    if (m === 'PUT') {
      const existing = await readJson(pratFile(id), null);
      const x = sanitizePratica(await readBody(req), id, existing);
      await fs.mkdir(PRAT_DIR, { recursive: true });
      await writeJsonAtomic(pratFile(id), x);
      return send(res, 200, x);
    }
    if (m === 'DELETE') {
      try { await fs.unlink(pratFile(id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/distanza' && m === 'GET') {
    const it = str(url.searchParams.get('itinerario') || '', 300);
    try { return send(res, 200, await distanza(it)); }
    catch (e) { return fail(res, e.status || 502, e.message); }
  }

  // ---- modelli PDF ----
  if (p === '/api/modelli' && m === 'GET') return send(res, 200, await modelliPresenti());
  const mm2 = /^\/api\/modelli\/(\d{4})$/.exec(p);
  if (mm2 && MODELLI.includes(mm2[1])) {
    const file = path.join(MOD_DIR, mm2[1] + '.pdf');
    if (m === 'GET') {
      try { const b = await fs.readFile(file); return send(res, 200, b, 'application/pdf'); }
      catch { return fail(res, 404, `Il modulo ${mm2[1]} non è ancora stato caricato`); }
    }
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
    const all = (await listReports()).filter(r => r.data < prev[1]);
    return all.length ? send(res, 200, all.at(-1)) : fail(res, 404, 'Nessun rapporto precedente');
  }

  if (p === '/api/backup' && m === 'GET') {
    const body = JSON.stringify({ app: 'rapportini', versione: VERSION, esportato: new Date().toISOString(),
      impostazioni: await loadSettings(), rapporti: await listReports(), pratiche: await listPratiche(),
      modelli: Object.fromEntries(await Promise.all(MODELLI.map(async c => {
        try { return [c, (await fs.readFile(path.join(MOD_DIR, c + '.pdf'))).toString('base64')]; } catch { return [c, null]; }
      }))) }, null, 2);
    const nome = `rapportini-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return send(res, 200, body, 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="${nome}"` });
  }

  if (p === '/api/ripristino' && m === 'POST') {
    const b = await readBody(req);
    if (b?.app !== 'rapportini' || !Array.isArray(b.rapporti)) return fail(res, 400, 'Questo file non è un backup di Rapportini');
    const sovrascrivi = url.searchParams.get('sovrascrivi') === '1';
    await fs.mkdir(REP_DIR, { recursive: true });
    let importati = 0, saltati = 0;
    for (const r of b.rapporti) {
      if (!validDate(r?.data)) { saltati++; continue; }
      const exists = await readJson(repFile(r.data), null);
      if (exists && !sovrascrivi) { saltati++; continue; }
      const clean = sanitizeReport(r, r.data);
      if (r.aggiornato) clean.aggiornato = str(r.aggiornato, 40);
      await writeJsonAtomic(repFile(r.data), clean);
      importati++;
    }
    if (Array.isArray(b.pratiche)) {
      await fs.mkdir(PRAT_DIR, { recursive: true });
      for (const x of b.pratiche) {
        if (!validPid(x?.id)) continue;
        const exists = await readJson(pratFile(x.id), null);
        if (exists && !sovrascrivi) continue;
        await writeJsonAtomic(pratFile(x.id), { ...sanitizePratica(x, x.id, exists || { creato: x.creato }), aggiornato: str(x.aggiornato, 40) || new Date().toISOString() });
      }
    }
    if (b.modelli && typeof b.modelli === 'object') {
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
    if (b.impostazioni && (sovrascrivi || !(await readJson(SETTINGS_FILE, null)))) {
      await writeJsonAtomic(SETTINGS_FILE, sanitizeSettings(b.impostazioni));
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
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Errore del server');
  }
});

await fs.mkdir(REP_DIR, { recursive: true });
server.listen(PORT, () => console.log(`Rapportini ${VERSION} in ascolto sulla porta ${PORT}, dati in ${DATA_DIR}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
