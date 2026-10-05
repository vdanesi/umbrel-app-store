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
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

const MAX_LAVORI = 9;
const MAX_ANOMALIE = 9;
const MAX_MODULI_PER_COLONNA = 8;

const DEFAULT_SETTINGS = {
  agente: '', qualifica: '', cid: '',
  residenza: '', servizio: '', unita: '',
  orarioOrdinario: '08:00',          // oltre questo totale scatta lo straordinario
  codiceModulo3: '',                 // terza colonna dei moduli emessi (la prima è 0229, la seconda 0452)
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
    codiceModulo3: str(s.codiceModulo3, 12),
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
    const data = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
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

  // rapporto precedente più vicino (per "copia dal giorno prima")
  const prev = /^\/api\/precedente\/(\d{4}-\d\d-\d\d)$/.exec(p);
  if (prev && m === 'GET') {
    const all = (await listReports()).filter(r => r.data < prev[1]);
    return all.length ? send(res, 200, all.at(-1)) : fail(res, 404, 'Nessun rapporto precedente');
  }

  if (p === '/api/backup' && m === 'GET') {
    const body = JSON.stringify({ app: 'rapportini', versione: VERSION, esportato: new Date().toISOString(),
      impostazioni: await loadSettings(), rapporti: await listReports() }, null, 2);
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
