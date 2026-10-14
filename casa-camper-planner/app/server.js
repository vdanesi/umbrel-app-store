// Camper Planner — server per Umbrel
// Salva gli itinerari come file JSON in DATA_DIR e fa da proxy verso
// i servizi OpenStreetMap (routing, aree sosta, ricerca luoghi).

import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { haversine, makeArea, searchOverture, parsePoiFile, mergePois, guessCategory } from './sources.js';
import { CATALOG, MANUAL_SOURCES } from './catalog.js';
import { createAuth } from './auth.js';
import { createOsmTiles } from './osmtiles.js';
import { createGeocoder, dominantCountry, centerOf } from './geocode.js';
import { planDays, nightWindow, rankNight } from './planner.js';
import { createFuel, FUELS } from './fuel.js';
import { createWeather } from './weather.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Ogni richiesta lavora nella cartella del proprio account (vedi il middleware dopo l'accesso).
const userStore = new AsyncLocalStorage();
const ctx = () => {
  const c = userStore.getStore();
  if (!c) throw new Error('Nessun account per questa richiesta');
  return c;
};
const userCtx = dir => ({ dir, tripsDir: path.join(dir, 'trips'), settingsFile: path.join(dir, 'settings.json'), collectionFile: path.join(dir, 'collection.json') });
const VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const ORS_URL = process.env.ORS_URL || 'https://api.openrouteservice.org';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const PHOTON_URL = process.env.PHOTON_URL ?? 'https://photon.komoot.io';
const OVERPASS_URLS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',').map(s => s.trim()).filter(Boolean);
const USER_AGENT = `CamperPlanner/${VERSION} (self-hosted Umbrel app)`;

// Check-list di partenza predefinita: ogni utente la può cambiare e salvare come proprio modello.
const C = (group, items) => items.map(text => ({ group, text }));
const DEFAULT_CHECKLIST = [
  ...C('Documenti', ['Patente e carta d\'identità', 'Libretto di circolazione e assicurazione (carta verde per l\'estero)', 'Tessera sanitaria europea', 'CampingCard ACSI e tessere dei club', 'Vignette o pedaggi dei paesi esteri (Svizzera, Austria, Slovenia…)', 'Prenotazioni di campeggi e traghetti']),
  ...C('Mezzo', ['Pressione delle gomme (anche la ruota di scorta)', 'Olio motore e liquido di raffreddamento', 'AdBlue e liquido lavavetri', 'Luci, frecce e stop', 'Batteria dei servizi carica', 'Portabici fissato con il pannello di segnalazione', 'Triangolo, giubbotti ed estintore']),
  ...C('Acqua e gas', ['Serbatoio dell\'acqua pieno (o metà, se si è vicini al limite di peso)', 'Bombole del gas piene e regolatore controllato', 'Acque grigie e cassetta WC vuote', 'Prodotto per il WC chimico']),
  ...C('A bordo', ['Frigorifero acceso il giorno prima', 'Farmaci e cassetta di pronto soccorso', 'Cavo corrente, adattatore CEE e prolunga', 'Cunei livellanti', 'Tubo e raccordi per l\'acqua', 'Torcia e attrezzi di base']),
  ...C('Ogni partenza dalla sosta', ['Gradino rientrato', 'Antenna o parabola abbassata', 'Oblò, finestre e tendalino chiusi', 'Sportelli esterni chiusi a chiave', 'Gas chiuso (o frigo a 12 V)', 'Frigo, cassetti e pensili bloccati', 'Cavo della corrente staccato', 'Cunei recuperati', 'Giro completo intorno al mezzo'])
];
const sanitizeChecklist = (list, withDone) => (Array.isArray(list) ? list : []).slice(0, 300)
  .map(x => ({ ...(withDone ? { id: str(x.id, 64) || crypto.randomUUID(), done: x.done === true } : {}), group: str(x.group, 60).trim() || 'Altro', text: str(x.text, 200).trim() }))
  .filter(x => x.text);

const DEFAULT_SETTINGS = {
  vehicle: {
    name: 'Il mio camper',
    length: 7.0,      // m
    width: 2.35,      // m
    height: 3.1,      // m
    weight: 3.5,      // t
    consumption: 11,  // l/100 km
    fuelType: 'diesel'
  },
  fuelPrice: 1.75,     // €/l
  durationFactor: 1.15, // i tempi OSRM sono per auto: un camper è più lento
  orsApiKey: '',
  openPlacesKey: '',
  currency: 'EUR'
};

// ---------- archivio ----------

const auth = createAuth({ dataDir: DATA_DIR, writeJsonAtomic: (f, d) => writeJsonAtomic(f, d), readJson: (f, d) => readJson(f, d) });

async function countData(dir) {
  const U = userCtx(dir);
  let trips = 0, points = 0;
  try { trips = (await fs.readdir(U.tripsDir)).filter(f => f.endsWith('.json')).length; } catch { /* nessun viaggio */ }
  try { points = (JSON.parse(await fs.readFile(U.collectionFile, 'utf8')).items || []).length; } catch { /* raccolta vuota */ }
  return { viaggi: trips, punti: points };
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

const validId = id => /^[a-f0-9-]{8,64}$/i.test(id);
const tripFile = id => path.join(ctx().tripsDir, `${id}.json`);

async function loadSettings() {
  const s = await readJson(ctx().settingsFile, {});
  return { ...DEFAULT_SETTINGS, ...s, vehicle: { ...DEFAULT_SETTINGS.vehicle, ...(s.vehicle || {}) } };
}

function publicSettings(s) {
  const { orsApiKey, openPlacesKey, ...rest } = s;
  return { ...rest, checklist: rest.checklist?.length ? rest.checklist : DEFAULT_CHECKLIST, checklistCustom: Boolean(rest.checklist?.length), orsApiKeySet: Boolean(orsApiKey), openPlacesKeySet: Boolean(openPlacesKey) };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(v, max = 2000) { return typeof v === 'string' ? v.slice(0, max) : ''; }

function sanitizeTrip(input, existing = {}) {
  const t = input || {};
  const stops = Array.isArray(t.stops) ? t.stops.slice(0, 200).map(s => ({
    id: str(s.id, 64) || crypto.randomUUID(),
    name: str(s.name, 200) || 'Tappa',
    lat: num(s.lat), lon: num(s.lon),
    nights: Math.max(0, Math.min(365, Math.round(num(s.nights)))),
    kind: ['tappa', 'sosta', 'campeggio', 'visita'].includes(s.kind) ? s.kind : 'tappa',
    notes: str(s.notes, 10000),
    acsi: s.acsi ? { price: Number.isFinite(Number(s.acsi.price)) && s.acsi.price !== null && s.acsi.price !== '' ? Math.round(Number(s.acsi.price) * 100) / 100 : null } : null,
    poi: s.poi && typeof s.poi === 'object' ? {
      osmType: str(s.poi.osmType, 16), osmId: num(s.poi.osmId), category: str(s.poi.category, 40),
      sources: Array.isArray(s.poi.sources) ? s.poi.sources.slice(0, 5).map(x => str(x, 20)) : undefined
    } : null
  })) : [];
  const expenses = Array.isArray(t.expenses) ? t.expenses.slice(0, 2000).map(e => ({
    id: str(e.id, 64) || crypto.randomUUID(),
    date: str(e.date, 10),
    category: str(e.category, 40) || 'altro',
    amount: Math.round(num(e.amount) * 100) / 100,
    description: str(e.description, 300),
    stopId: str(e.stopId, 64)
  })) : [];
  let route = null;
  if (t.route && typeof t.route === 'object' && Array.isArray(t.route.geometry)) {
    route = {
      distance: num(t.route.distance), duration: num(t.route.duration),
      legs: Array.isArray(t.route.legs) ? t.route.legs.map(l => ({ distance: num(l.distance), duration: num(l.duration) })) : [],
      geometry: t.route.geometry.slice(0, 200000).map(p => [num(p[0]), num(p[1])]),
      provider: str(t.route.provider, 40),
      signature: str(t.route.signature, 20000),
      computedAt: str(t.route.computedAt, 40)
    };
  }
  return {
    id: existing.id || crypto.randomUUID(),
    name: str(t.name, 200) || 'Nuovo viaggio',
    startDate: str(t.startDate, 10),
    budget: Math.max(0, num(t.budget)),
    plan: { maxKm: Math.max(0, Math.min(2000, num(t.plan?.maxKm, 250))), maxHours: Math.max(0, Math.min(24, num(t.plan?.maxHours, 0))) },
    notes: str(t.notes, 50000),
    stops, expenses, route,
    checklist: sanitizeChecklist(t.checklist, true),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function summary(t) {
  const nights = t.stops.reduce((a, s) => a + s.nights, 0);
  return {
    id: t.id, name: t.name, startDate: t.startDate,
    stops: t.stops.length, nights,
    distance: t.route?.distance || 0,
    spent: t.expenses.reduce((a, e) => a + e.amount, 0),
    from: t.stops[0]?.name || '', to: t.stops.at(-1)?.name || '',
    updatedAt: t.updatedAt
  };
}

// ---------- servizi esterni ----------

async function fetchJson(url, opts = {}, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts, signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', ...(opts.headers || {}) }
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const msg = body?.error?.message || body?.error || body?.message || body?.raw || res.statusText;
      const err = new Error(`${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      err.status = res.status; throw err;
    }
    return body;
  } finally { clearTimeout(timer); }
}

async function routeOSRM(coords, settings) {
  const pts = coords.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const url = `${OSRM_URL}/route/v1/driving/${pts}?overview=full&geometries=geojson&steps=false`;
  const data = await fetchJson(url);
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.message || 'Percorso non trovato');
  const r = data.routes[0];
  const f = num(settings.durationFactor, 1.15) || 1;
  return {
    provider: 'OSRM (auto, tempi corretti x' + f + ')',
    distance: r.distance, duration: r.duration * f,
    legs: r.legs.map(l => ({ distance: l.distance, duration: l.duration * f })),
    geometry: r.geometry.coordinates.map(([lon, lat]) => [lat, lon])
  };
}

async function routeORS(coords, settings) {
  const v = settings.vehicle;
  const body = {
    coordinates: coords.map(([lat, lon]) => [lon, lat]),
    options: {
      vehicle_type: 'hgv',
      profile_params: { restrictions: {
        length: num(v.length), width: num(v.width), height: num(v.height), weight: num(v.weight)
      } }
    }
  };
  const data = await fetchJson(`${ORS_URL}/v2/directions/driving-hgv/geojson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': settings.orsApiKey },
    body: JSON.stringify(body)
  }, 40000);
  const feat = data.features?.[0];
  if (!feat) throw new Error('Percorso non trovato');
  const p = feat.properties;
  return {
    provider: 'OpenRouteService (mezzo pesante, con dimensioni)',
    distance: p.summary.distance, duration: p.summary.duration,
    legs: (p.segments || []).map(s => ({ distance: s.distance, duration: s.duration })),
    geometry: feat.geometry.coordinates.map(([lon, lat]) => [lat, lon])
  };
}

// categorie dei punti: le prime cinque vengono anche da OpenStreetMap, 'luogo' solo dalle raccolte
const CATEGORIES = ['area_camper', 'campeggio', 'scarico', 'acqua', 'gpl', 'luogo'];
const POI_FILTERS = {
  area_camper: ['nwr["tourism"="caravan_site"]'],
  campeggio: ['nwr["tourism"="camp_site"]["caravans"!="no"]'],
  scarico: ['nwr["amenity"="sanitary_dump_station"]', 'nwr["sanitary_dump_station"="yes"]'],
  acqua: ['nwr["amenity"="water_point"]'],
  gpl: ['nwr["amenity"="fuel"]["fuel:lpg"="yes"]']
};

function classifyPoi(tags) {
  if (tags.tourism === 'caravan_site') return 'area_camper';
  if (tags.tourism === 'camp_site') return 'campeggio';
  if (tags.amenity === 'sanitary_dump_station' || tags.sanitary_dump_station === 'yes') return 'scarico';
  if (tags.amenity === 'water_point') return 'acqua';
  if (tags.amenity === 'fuel') return 'gpl';
  return 'altro';
}

// ---------- GPX ----------

const xml = s => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function tripToGpx(t) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="Camper Planner" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<metadata><name>${xml(t.name)}</name><time>${new Date().toISOString()}</time></metadata>`
  ];
  t.stops.forEach((s, i) => {
    lines.push(`<wpt lat="${s.lat.toFixed(6)}" lon="${s.lon.toFixed(6)}"><name>${xml(`${i + 1}. ${s.name}`)}</name>` +
      (s.notes ? `<desc>${xml(s.notes)}</desc>` : '') + `<type>${xml(s.kind)}</type></wpt>`);
  });
  lines.push(`<rte><name>${xml(t.name)}</name>`);
  t.stops.forEach((s, i) => lines.push(`<rtept lat="${s.lat.toFixed(6)}" lon="${s.lon.toFixed(6)}"><name>${xml(`${i + 1}. ${s.name}`)}</name></rtept>`));
  lines.push('</rte>');
  if (t.route?.geometry?.length) {
    lines.push(`<trk><name>${xml(t.name)}</name><trkseg>`);
    for (const [lat, lon] of t.route.geometry) lines.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`);
    lines.push('</trkseg></trk>');
  }
  lines.push('</gpx>');
  return lines.join('\n');
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

// Le modifiche devono partire dall'app stessa: un altro sito non può aggiungere questa intestazione.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-camper'] !== '1') return res.status(403).json({ error: 'Richiesta non consentita' });
  next();
});

// pagine: l'app solo con un account, altrimenti la pagina di accesso
const sendPage = file => (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', file)); };
app.get(['/', '/index.html'], (req, res, next) => auth.pageGuard(req).needsLogin ? res.redirect(302, 'accesso') : sendPage('index.html')(req, res, next));
app.get(['/accesso', '/accesso.html'], (req, res, next) => {
  const g = auth.pageGuard(req);
  return g.user && !g.needsLogin ? res.redirect(302, './') : sendPage('accesso.html')(req, res, next);
});
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, index: false }));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(req.method, req.path, e.message);
  res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message });
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION }));

auth.routes(app, { wrap, countData });

// da qui in poi ogni API lavora sui dati dell'account che ha fatto l'accesso
app.use('/api', (req, res, next) => {
  const U = userCtx(auth.userDir(req.user.id));
  fs.mkdir(U.tripsDir, { recursive: true }).then(() => userStore.run(U, next), next);
});
app.get('/api/me', (req, res) => res.json({ id: req.user.id, nome: req.user.nome, admin: !!req.user.admin, version: VERSION }));

app.get('/api/settings', wrap(async (req, res) => res.json(publicSettings(await loadSettings()))));

app.put('/api/settings', wrap(async (req, res) => {
  const cur = await loadSettings();
  const b = req.body || {};
  const v = b.vehicle || {};
  const next = {
    ...cur,
    vehicle: {
      name: str(v.name ?? cur.vehicle.name, 100),
      length: num(v.length, cur.vehicle.length), width: num(v.width, cur.vehicle.width),
      height: num(v.height, cur.vehicle.height), weight: num(v.weight, cur.vehicle.weight),
      consumption: num(v.consumption, cur.vehicle.consumption),
      fuelType: ['diesel', 'benzina', 'gpl'].includes(v.fuelType) ? v.fuelType : cur.vehicle.fuelType
    },
    fuelPrice: num(b.fuelPrice, cur.fuelPrice),
    durationFactor: Math.min(2, Math.max(1, num(b.durationFactor, cur.durationFactor)))
  };
  if (Array.isArray(b.checklist)) next.checklist = sanitizeChecklist(b.checklist, false);
  if (b.checklist === null) delete next.checklist;
  if (typeof b.orsApiKey === 'string') next.orsApiKey = b.orsApiKey.trim().slice(0, 300);
  if (typeof b.openPlacesKey === 'string') next.openPlacesKey = b.openPlacesKey.trim().slice(0, 300);
  await writeJsonAtomic(ctx().settingsFile, next);
  res.json(publicSettings(next));
}));

app.get('/api/trips', wrap(async (req, res) => {
  const files = (await fs.readdir(ctx().tripsDir)).filter(f => f.endsWith('.json'));
  const trips = [];
  for (const f of files) {
    try { trips.push(summary(JSON.parse(await fs.readFile(path.join(ctx().tripsDir, f), 'utf8')))); }
    catch (e) { console.error('Viaggio illeggibile', f, e.message); }
  }
  trips.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json(trips);
}));

app.post('/api/trips', wrap(async (req, res) => {
  const trip = sanitizeTrip(req.body);
  // un viaggio importato riceve sempre ID nuovi, così non sovrascrive nulla
  await writeJsonAtomic(tripFile(trip.id), trip);
  res.status(201).json(trip);
}));

app.get('/api/trips/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID non valido' });
  const t = await readJson(tripFile(req.params.id), null);
  if (!t) return res.status(404).json({ error: 'Viaggio non trovato' });
  res.json(t);
}));

app.put('/api/trips/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID non valido' });
  const existing = await readJson(tripFile(req.params.id), null);
  if (!existing) return res.status(404).json({ error: 'Viaggio non trovato' });
  const trip = sanitizeTrip(req.body, existing);
  await writeJsonAtomic(tripFile(trip.id), trip);
  res.json(trip);
}));

app.delete('/api/trips/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID non valido' });
  await fs.rm(tripFile(req.params.id), { force: true });
  res.status(204).end();
}));

app.get('/api/trips/:id/gpx', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID non valido' });
  const t = await readJson(tripFile(req.params.id), null);
  if (!t) return res.status(404).json({ error: 'Viaggio non trovato' });
  const fname = (t.name || 'viaggio').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'viaggio';
  res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}.gpx"`);
  res.send(tripToGpx(t));
}));

app.post('/api/route', wrap(async (req, res) => {
  const coords = (req.body?.coords || []).map(c => [num(c[0]), num(c[1])]);
  if (coords.length < 2) return res.status(400).json({ error: 'Servono almeno due tappe' });
  if (coords.length > 70) return res.status(400).json({ error: 'Massimo 70 tappe per percorso' });
  const settings = await loadSettings();
  let warning = '';
  if (settings.orsApiKey) {
    try { return res.json(await routeORS(coords, settings)); }
    catch (e) { warning = `OpenRouteService non disponibile (${e.message}), uso OSRM.`; }
  }
  const r = await routeOSRM(coords, settings);
  res.json({ ...r, warning });
}));

app.get('/api/geocode', wrap(async (req, res) => {
  const q = str(req.query.q, 200).trim();
  if (!q) return res.json([]);
  const url = `${NOMINATIM_URL}/search?format=jsonv2&limit=8&accept-language=it&q=${encodeURIComponent(q)}`;
  const data = await fetchJson(url);
  res.json(data.map(d => ({ name: d.name || d.display_name.split(',')[0], label: d.display_name, lat: +d.lat, lon: +d.lon })));
}));

app.get('/api/reverse', wrap(async (req, res) => {
  const lat = num(req.query.lat), lon = num(req.query.lon);
  const url = `${NOMINATIM_URL}/reverse?format=jsonv2&zoom=14&accept-language=it&lat=${lat}&lon=${lon}`;
  const d = await fetchJson(url);
  const a = d.address || {};
  const name = a.village || a.town || a.city || a.hamlet || a.municipality || d.name || (d.display_name || '').split(',')[0];
  res.json({ name: name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, label: d.display_name || '' });
}));

const osmTiles = createOsmTiles({ cacheDir: path.join(DATA_DIR, 'cache'), overpassUrls: OVERPASS_URLS, userAgent: USER_AGENT });

async function searchOsm(area, types, onProgress) {
  if (!types.some(t => POI_FILTERS[t])) return Object.assign([], { stats: { tiles: 0, fromCache: 0 } });
  const { elements, tiles, fromCache } = await osmTiles.elementsFor(area, onProgress);
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const key = el.type + el.id;
    if (seen.has(key)) continue; seen.add(key);
    const tags = el.tags || {};
    const category = classifyPoi(tags);
    if (!types.includes(category) || !area.contains([el.lat, el.lon])) continue;
    out.push({
      id: `osm:${el.type}/${el.id}`, sources: ['osm'],
      osmType: el.type, osmId: el.id, lat: el.lat, lon: el.lon, category,
      name: tags.name || tags.operator || null,
      tags: {
        fee: tags.fee, charge: tags.charge, capacity: tags.capacity, power: tags.power_supply,
        water: tags.drinking_water || tags.water_point, dump: tags.sanitary_dump_station,
        toilets: tags.toilets, shower: tags.shower, opening: tags.opening_hours,
        website: tags.website || tags['contact:website'], phone: tags.phone || tags['contact:phone'],
        maxstay: tags.maxstay, internet: tags.internet_access
      }
    });
  }
  out.stats = { tiles, fromCache };
  return out;
}

// Risposte di Open Places API in cache per 7 giorni (stessa domanda = stessa risposta).
const OVT_DIR = path.join(DATA_DIR, 'cache', 'overture');
async function cachedFetchJson(url, opts = {}, timeoutMs) {
  if (opts.method && opts.method !== 'GET') return fetchJson(url, opts, timeoutMs);
  const file = path.join(OVT_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  try {
    const c = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Date.now() - c.at < 7 * 864e5) return c.data;
  } catch { /* non in cache */ }
  const data = await fetchJson(url, opts, timeoutMs);
  await fs.mkdir(OVT_DIR, { recursive: true });
  await writeJsonAtomic(file, { at: Date.now(), data });
  return data;
}

// ---------- la mia raccolta ----------

// La raccolta può avere decine di migliaia di punti: si rilegge solo se il file è cambiato.
const collMemo = new Map();   // file -> {mtime, data}
async function loadCollection() {
  const file = ctx().collectionFile;
  let mtime = 0;
  try { mtime = (await fs.stat(file)).mtimeMs; } catch { return { items: [], imports: [] }; }
  const m = collMemo.get(file);
  if (m && m.mtime === mtime) return structuredClone(m.data);
  const c = await readJson(file, null);
  const data = c && Array.isArray(c.items) ? c : { items: [], imports: [] };
  collMemo.set(file, { mtime, data });
  if (collMemo.size > 50) collMemo.delete(collMemo.keys().next().value);
  return structuredClone(data);
}
function collectionSummary(c) {
  const fav = c.items.filter(i => i.source === 'preferiti').length;
  const acsi = c.items.filter(i => i.acsi).length;
  // gli indirizzi da riprovare restano sul server: al browser basta sapere quanti sono
  return { total: c.items.length, favorites: fav, acsi, imports: c.imports.map(({ pending, ...i }) => ({ ...i, canRetry: !!pending?.length })) };
}
function searchMine(c, area, types) {
  return c.items.filter(i => types.includes(i.category) && area.contains([i.lat, i.lon])).map(i => ({
    id: 'mine:' + i.id, mineId: i.id, sources: ['mine'], lat: i.lat, lon: i.lon, category: i.category, name: i.name || null,
    acsi: i.acsi || null,
    tags: { ...(i.tags || {}), notes: i.notes || undefined, list: i.source === 'preferiti' ? undefined : (i.list ? `${i.source} / ${i.list}` : i.source), website: i.website || undefined, phone: i.phone || undefined }
  }));
}

app.get('/api/collection', wrap(async (req, res) => res.json(collectionSummary(await loadCollection()))));

async function storeImport(name, pts, meta = {}) {
  const c = await loadCollection();
  // reimportare la stessa fonte la sostituisce
  c.items = c.items.filter(i => i.source !== name);
  if (c.items.length + pts.length > 200000) { const e = new Error('Raccolta troppo grande (massimo 200.000 punti)'); e.status = 400; throw e; }
  const now = new Date().toISOString();
  for (const p of pts) c.items.push({ id: crypto.randomUUID(), source: name, addedAt: now, ...p });
  c.imports = c.imports.filter(i => i.name !== name).concat({ name, count: pts.length, importedAt: now, ...meta });
  await writeJsonAtomic(ctx().collectionFile, c);
  return { added: pts.length, ...collectionSummary(c) };
}

// Scarica una fonte esterna (dati aperti) direttamente dall'Umbrel.
async function downloadText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/geo+json, application/json, text/csv, application/gpx+xml, */*' } });
    if (!r.ok) { const e = new Error(`il server ha risposto ${r.status}`); e.status = 502; throw e; }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 60 * 1024 * 1024) { const e = new Error('file troppo grande (oltre 60 MB)'); e.status = 400; throw e; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 60 * 1024 * 1024) { const e = new Error('file troppo grande (oltre 60 MB)'); e.status = 400; throw e; }
    if (buf[0] === 0x50 && buf[1] === 0x4b) { const e = new Error('è un archivio ZIP: scaricalo, estrai il file GeoJSON, CSV, KML o GPX e importalo'); e.status = 400; throw e; }
    let text = buf.toString('utf8');
    if (text.includes('�')) text = buf.toString('latin1'); // vecchi CSV in Windows-1252
    return { text, type: r.headers.get('content-type') || '' };
  } catch (e) {
    if (e.name === 'AbortError') { const x = new Error('download troppo lento (oltre 2 minuti)'); x.status = 504; throw x; }
    throw e;
  } finally { clearTimeout(timer); }
}

// CATALOG_BASE (solo per i test) riscrive gli indirizzi verso un server locale
const catalogEntries = () => process.env.CATALOG_BASE
  ? CATALOG.map(s => ({ ...s, url: `${process.env.CATALOG_BASE}/${s.id}` })) : CATALOG;

// Link di Google My Maps (visualizza/modifica/incorpora) → esportazione KML completa
function normalizeMapUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && /\/maps\/d\//.test(u.pathname)) {
      const mid = u.searchParams.get('mid');
      if (mid) return `https://www.google.com/maps/d/kml?forcekml=1&mid=${encodeURIComponent(mid)}`;
    }
    return u.href;
  } catch { return url; }
}

function checkPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { const e = new Error('Indirizzo non valido'); e.status = 400; throw e; }
  if (!/^https?:$/.test(u.protocol)) { const e = new Error('Servono indirizzi http o https'); e.status = 400; throw e; }
  // solo siti pubblici: niente indirizzi della rete di casa
  if (!process.env.ALLOW_PRIVATE_URLS && /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i.test(u.hostname)) {
    const e = new Error('Sono ammessi solo indirizzi pubblici'); e.status = 400; throw e;
  }
  return u;
}

async function downloadAndParse(url, category) {
  const u = checkPublicUrl(normalizeMapUrl(url));
  const { text, type } = await downloadText(u.href);
  let hint = u.pathname;
  if (/kml|google\.[a-z.]+$/.test(type + ' ' + u.hostname) && /\/maps\/d\//.test(u.pathname)) hint += '.kml';
  else if (/json/.test(type) && !/\.(geo)?json$/i.test(hint)) hint += '.json';
  else if (/csv/.test(type) && !/\.csv$/i.test(hint)) hint += '.csv';
  try { return { url: u.href, pts: parsePoiFile(hint, text, { category }) }; }
  catch (e) { const x = new Error('Formato non riconosciuto: ' + e.message); x.status = 400; throw x; }
}

// Raccoglie i punti di un file e delle mappe collegate (NetworkLink), fino a 3 livelli e 20 mappe.
async function collectPoints(first, { category, onPhase } = {}) {
  const points = [...first.pts], needGeocode = [...(first.pts.needGeocode || [])];
  const urls = first.url ? [first.url] : [];
  let skipped = first.pts.skipped || 0, shapes = first.pts.shapes || 0;
  const source = first.pts.source || '';
  let docName = first.pts.docName || '';
  const queue = (first.pts.links || []).map(l => ({ url: l, depth: 1 }));
  const seen = new Set(urls);
  const errors = [];
  while (queue.length && seen.size < 20) {
    const { url, depth } = queue.shift();
    const norm = normalizeMapUrl(url);
    if (seen.has(norm)) continue;
    seen.add(norm);
    onPhase?.(`scarico la mappa collegata ${urls.length + 1}`);
    try {
      const r = await downloadAndParse(norm, category);
      urls.push(r.url);
      points.push(...r.pts); needGeocode.push(...(r.pts.needGeocode || []));
      skipped += r.pts.skipped || 0; shapes += r.pts.shapes || 0;
      if (!docName) docName = r.pts.docName || '';
      if (depth < 3) for (const l of r.pts.links || []) queue.push({ url: l, depth: depth + 1 });
    } catch (e) { errors.push(`${norm}: ${e.message}`); }
  }
  return { points, needGeocode, urls, skipped, shapes, source, docName, errors };
}

// ---------- geocodifica degli indirizzi (vedi geocode.js) ----------
const geocoder = createGeocoder({ cacheFile: path.join(DATA_DIR, 'cache', 'geocode.json'), nominatimUrl: NOMINATIM_URL, photonUrl: PHOTON_URL, userAgent: USER_AGENT, fetchJson });

// Posiziona i punti che hanno solo l'indirizzo. Se il servizio smette di rispondere,
// quelli rimasti restano "da riprovare" invece di essere dati per non trovati.
async function geocodePending(job, pending, known) {
  const found = [], notFound = [], retry = [];
  const country = dominantCountry(known, pending);
  let bias = centerOf(known);
  let failures = 0;
  job.total = pending.length; job.done = 0; job.phase = 'indirizzi';
  for (const p of pending) {
    if (failures >= 3) { retry.push(p); job.done++; continue; }
    try {
      const c = await geocoder.geocode(p, { country, bias });
      failures = 0;
      if (c) { const { address, ...rest } = p; found.push({ ...rest, tags: { ...(rest.tags || {}), address }, lat: c[0], lon: c[1] }); if (!bias) bias = c; }
      else notFound.push(p);
    } catch (e) {
      console.error('Geocodifica:', e.message);
      if (e.unavailable) { failures++; retry.push(p); } else notFound.push(p);
    }
    job.done++;
  }
  return { found, notFound, retry };
}

// ---------- importazioni in background ----------
const jobs = new Map();   // id -> {uid, name, status, phase, done, total, result, error, at}
function jobView(j) { return { id: j.id, name: j.name, status: j.status, phase: j.phase, done: j.done, total: j.total, result: j.result, error: j.error }; }
setInterval(() => { for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 30 * 60e3) jobs.delete(id); }, 60e3).unref();

// Avvia l'importazione; se finisce entro 3 secondi risponde subito, altrimenti con l'id del lavoro.
async function runImport(req, res, name, work) {
  const U = ctx();
  const job = { id: crypto.randomUUID(), uid: req.user.id, name, status: 'running', phase: 'lettura', done: 0, total: 0, at: Date.now() };
  jobs.set(job.id, job);
  const p = userStore.run(U, () => work(job)).then(r => { job.status = 'done'; job.result = r; job.at = Date.now(); return r; },
    e => { job.status = 'error'; job.error = e.message; job.at = Date.now(); throw e; });
  const quick = await Promise.race([p.then(r => ({ r }), e => ({ e })), new Promise(r => setTimeout(() => r(null), 3000))]);
  if (!quick) return res.status(202).json({ job: jobView(job) });
  jobs.delete(job.id);
  if (quick.e) return res.status(quick.e.status && quick.e.status < 500 ? quick.e.status : 502).json({ error: quick.e.message });
  res.json(quick.r);
}

async function finishImport(job, name, collected, meta = {}) {
  const { points, needGeocode, urls, skipped, shapes, source, docName, errors } = collected;
  let notFound = [], retry = [];
  if (needGeocode.length) {
    const g = await geocodePending(job, needGeocode, points);
    points.push(...g.found); notFound = g.notFound; retry = g.retry;
  }
  const missingItems = [...retry, ...notFound];
  const missing = missingItems.map(p => p.name || p.address);
  if (!points.length) {
    const e = new Error(errors.length ? `Mappa non scaricata: ${errors[0]}` : missing.length ? 'Nessun indirizzo della mappa è stato trovato' : 'Nessun punto trovato (servono GPX, KML, GeoJSON o CSV con coordinate o indirizzi)');
    e.status = 400; throw e;
  }
  job.phase = 'salvataggio';
  const licenceMeta = source === 'camperonline'
    ? { licence: 'solo uso personale, non ridistribuire', attribution: 'CamperOnLine.it', page: 'https://www.camperonline.it/iCOL' } : {};
  const extra = { ...licenceMeta, ...meta, ...(urls.length ? { url: urls[0], urls } : {}), ...(docName ? { title: docName } : {}),
    ...(missing.length ? { missing: missing.slice(0, 50), missingCount: missing.length, pending: missingItems.slice(0, 2000), retryCount: retry.length }
      : { missing: undefined, missingCount: undefined, pending: undefined, retryCount: undefined }) };
  const r = await storeImport(name, points, extra);
  return { ...r, skipped, shapes, missing: missing.length, unavailable: retry.length, linked: urls.length, errors, source };
}

app.post('/api/collection/import', wrap(async (req, res) => {
  const filename = str(req.body?.filename, 120).replace(/[\\/]/g, '_') || 'importazione';
  const text = typeof req.body?.content === 'string' ? req.body.content : '';
  let pts;
  try { pts = parsePoiFile(filename, text); } catch (e) { return res.status(400).json({ error: 'File non leggibile: ' + e.message }); }
  if (!pts.length && !pts.needGeocode?.length && !pts.links?.length) return res.status(400).json({ error: 'Nessun punto trovato nel file (servono GPX, KML, GeoJSON o CSV con coordinate)' });
  await runImport(req, res, filename, async job => finishImport(job, filename, await collectPoints({ pts }, { onPhase: t => (job.phase = t) })));
}));

// Riprova solo gli indirizzi rimasti senza posizione, senza riscaricare la mappa.
app.post('/api/collection/retry-missing', wrap(async (req, res) => {
  const c0 = await loadCollection();
  const imp = c0.imports.find(i => i.name === req.body?.name);
  if (!imp?.pending?.length) return res.status(404).json({ error: 'Non ci sono indirizzi da riprovare per questa importazione' });
  await runImport(req, res, imp.name, async job => {
    const known = c0.items.filter(i => i.source === imp.name);
    const g = await geocodePending(job, imp.pending, known);
    job.phase = 'salvataggio';
    const c = await loadCollection();
    const rec = c.imports.find(i => i.name === imp.name);
    if (!rec) throw new Error('L\'importazione è stata rimossa nel frattempo');
    const now = new Date().toISOString();
    for (const p of g.found) c.items.push({ id: crypto.randomUUID(), source: imp.name, addedAt: now, ...p });
    const left = [...g.retry, ...g.notFound];
    rec.count = (rec.count || 0) + g.found.length;
    if (left.length) Object.assign(rec, { pending: left, missing: left.map(p => p.name || p.address).slice(0, 50), missingCount: left.length, retryCount: g.retry.length });
    else { delete rec.pending; delete rec.missing; delete rec.missingCount; delete rec.retryCount; }
    await writeJsonAtomic(ctx().collectionFile, c);
    return { added: g.found.length, missing: left.length, unavailable: g.retry.length, retried: true, ...collectionSummary(c) };
  });
}));

app.get('/api/collection/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.uid !== req.user.id) return res.status(404).json({ error: 'Importazione non trovata (forse è terminata da tempo)' });
  res.json(jobView(j));
});

async function importFromUrl(req, res, { url, urls, name, category, meta }) {
  const list = (urls && urls.length ? urls : [url]).map(normalizeMapUrl);
  list.forEach(checkPublicUrl);
  const fallback = (() => { try { const u = new URL(list[0]); return `${u.hostname}${u.pathname.split('/').filter(Boolean).slice(-1).map(x => ' · ' + x)}`.slice(0, 120); } catch { return 'dal web'; } })();
  await runImport(req, res, name || fallback, async job => {
    job.phase = 'download';
    const first = await downloadAndParse(list[0], category);
    // le altre mappe già note dall'importazione precedente si riscaricano come collegamenti
    first.pts.links = [...(first.pts.links || []), ...list.slice(1)];
    const collected = await collectPoints(first, { category, onPhase: t => (job.phase = t) });
    const finalName = (name || collected.docName || fallback).replace(/[\\/]/g, '_').slice(0, 120);
    job.name = finalName;
    return finishImport(job, finalName, collected, meta);
  });
}

app.get('/api/catalog', wrap(async (req, res) => {
  const c = await loadCollection();
  const byUrl = new Map(c.imports.filter(i => i.url).map(i => [i.catalogId || i.url, i]));
  res.json({
    sources: catalogEntries().map(s => ({ ...s, imported: byUrl.get(s.id) || byUrl.get(s.url) || null })),
    manual: MANUAL_SOURCES
  });
}));

app.post('/api/collection/import-catalog', wrap(async (req, res) => {
  const s = catalogEntries().find(x => x.id === req.body?.id);
  if (!s) return res.status(404).json({ error: 'Fonte non trovata' });
  await importFromUrl(req, res, { url: s.url, name: s.name, category: s.category,
    meta: { catalogId: s.id, licence: s.licence, attribution: s.attribution, page: s.page } });
}));

app.post('/api/collection/import-url', wrap(async (req, res) => {
  const url = str(req.body?.url, 2000).trim();
  // senza nome si usa il titolo della mappa (es. Google My Maps) o il sito
  const name = str(req.body?.name, 120).trim().replace(/[\\/]/g, '_');
  const category = CATEGORIES.includes(req.body?.category) ? req.body.category : undefined;
  await importFromUrl(req, res, { url, name, category, meta: { category: category || '' } });
}));

app.post('/api/collection/refresh', wrap(async (req, res) => {
  const c = await loadCollection();
  const imp = c.imports.find(i => i.name === req.body?.name && i.url);
  if (!imp) return res.status(404).json({ error: 'Questa fonte non ha un indirizzo da cui aggiornarla' });
  const s = imp.catalogId && catalogEntries().find(x => x.id === imp.catalogId);
  const { name, count, importedAt, url, urls, missing, missingCount, pending, retryCount, ...meta } = imp;
  await importFromUrl(req, res, { url: s ? s.url : url, urls: s ? null : urls, name, category: s ? s.category : (imp.category || undefined), meta });
}));

app.delete('/api/collection/imports/:name', wrap(async (req, res) => {
  const c = await loadCollection();
  c.items = c.items.filter(i => i.source !== req.params.name);
  c.imports = c.imports.filter(i => i.name !== req.params.name);
  await writeJsonAtomic(ctx().collectionFile, c);
  res.json(collectionSummary(c));
}));

app.post('/api/collection/favorites', wrap(async (req, res) => {
  const b = req.body || {};
  const lat = num(b.lat, NaN), lon = num(b.lon, NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Coordinate non valide' });
  const c = await loadCollection();
  const near = c.items.find(i => i.source === 'preferiti' && haversine([i.lat, i.lon], [lat, lon]) < 30);
  if (near) return res.json({ item: near, ...collectionSummary(c) });
  const category = CATEGORIES.includes(b.category) ? b.category : guessCategory(str(b.name));
  const item = { id: crypto.randomUUID(), source: 'preferiti', addedAt: new Date().toISOString(), lat, lon, category,
    name: str(b.name, 200), notes: str(b.notes, 2000), website: str(b.website, 300), phone: str(b.phone, 60) };
  c.items.push(item);
  await writeJsonAtomic(ctx().collectionFile, c);
  res.status(201).json({ item, ...collectionSummary(c) });
}));

const parseAcsi = a => a ? { price: a.price === null || a.price === '' || a.price === undefined || !Number.isFinite(Number(a.price)) ? null : Math.round(Number(a.price) * 100) / 100 } : null;

// Segna (o toglie) un campeggio come CampingCard ACSI nella raccolta.
app.post('/api/collection/acsi', wrap(async (req, res) => {
  const b = req.body || {};
  const acsi = parseAcsi(b.acsi);
  const c = await loadCollection();
  // il segno va sempre su un preferito: i punti importati vengono sostituiti a ogni aggiornamento
  let item = b.mineId ? c.items.find(i => i.id === b.mineId && i.source === 'preferiti') : null;
  const src = b.mineId ? c.items.find(i => i.id === b.mineId) : null;
  const lat = num(b.lat, src ? src.lat : NaN), lon = num(b.lon, src ? src.lon : NaN);
  if (!item && Number.isFinite(lat) && Number.isFinite(lon)) {
    item = c.items.find(i => i.source === 'preferiti' && haversine([i.lat, i.lon], [lat, lon]) < 60) || null;
  }
  if (!item) {
    if (!acsi) return res.json({ item: null, ...collectionSummary(c) });
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Coordinate non valide' });
    item = { id: crypto.randomUUID(), source: 'preferiti', addedAt: new Date().toISOString(), lat, lon,
      category: CATEGORIES.includes(b.category) ? b.category : 'campeggio',
      name: str(b.name, 200), notes: str(b.notes, 2000), website: str(b.website, 300), phone: str(b.phone, 60) };
    c.items.push(item);
  }
  if (acsi) item.acsi = acsi; else delete item.acsi;
  await writeJsonAtomic(ctx().collectionFile, c);
  res.json({ item, ...collectionSummary(c) });
}));

app.delete('/api/collection/items/:id', wrap(async (req, res) => {
  const c = await loadCollection();
  c.items = c.items.filter(i => i.id !== req.params.id);
  await writeJsonAtomic(ctx().collectionFile, c);
  res.json(collectionSummary(c));
}));

app.get('/api/collection/export', wrap(async (req, res) => {
  const c = await loadCollection();
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="Camper Planner" xmlns="http://www.topografix.com/GPX/1/1">'];
  for (const i of c.items) lines.push(`<wpt lat="${i.lat.toFixed(6)}" lon="${i.lon.toFixed(6)}"><name>${xml(i.name || 'Area sosta')}</name>` +
    ((i.notes || i.acsi) ? `<desc>${xml([i.acsi ? `ACSI${i.acsi.price != null ? ' ' + i.acsi.price + ' €' : ''}` : '', i.notes].filter(Boolean).join(' · '))}</desc>` : '') + `<type>${xml(i.category)}</type></wpt>`);
  lines.push('</gpx>');
  res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="la-mia-raccolta.gpx"');
  res.send(lines.join('\n'));
}));

// ---------- ricerca aree sosta su tutte le fonti ----------

app.post('/api/pois', wrap(async (req, res) => {
  const b = req.body || {};
  const types = (Array.isArray(b.types) ? b.types : Object.keys(POI_FILTERS)).filter(t => CATEGORIES.includes(t));
  const sources = (Array.isArray(b.sources) ? b.sources : ['osm']).filter(s => ['osm', 'overture', 'mine'].includes(s));
  // i segni ACSI stanno nella raccolta: serve sempre leggerla
  if (b.acsiOnly && !sources.includes('mine')) sources.push('mine');
  if (!types.length || !sources.length) return res.json({ pois: [], warnings: [], counts: {} });
  const radius = Math.max(500, Math.min(50000, Math.round(num(b.radius, 10000))));
  let area;
  if (Array.isArray(b.line) && b.line.length >= 2) area = makeArea({ line: b.line.map(p => [num(p[0]), num(p[1])]), radius });
  else if (b.center) area = makeArea({ center: [num(b.center[0]), num(b.center[1])], radius });
  else return res.status(400).json({ error: 'Indica una tappa o un percorso' });

  const settings = await loadSettings();
  const warnings = [];
  const labels = { osm: 'OpenStreetMap', overture: 'Overture', mine: 'La mia raccolta' };
  const stream = !!b.stream;
  if (stream) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }
  const send = obj => { if (stream && !res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
  const jobs = {
    osm: () => searchOsm(area, types, p => send({ progress: { osm: p } })),
    overture: () => settings.openPlacesKey
      ? searchOverture({ area, types, apiKey: settings.openPlacesKey, fetchJson: cachedFetchJson })
      : Promise.reject(new Error('manca la chiave Open Places API (scheda Mezzo)')),
    mine: async () => searchMine(await loadCollection(), area, types)
  };
  const results = {};
  const order = ['osm', 'mine', 'overture'];   // OSM ha i dati più ricchi, poi la raccolta, poi Overture
  const build = () => {
    const lists = order.filter(s => results[s]).map(s => results[s]);
    let pois = mergePois(lists);
    if (b.acsiOnly) pois = pois.filter(p => p.acsi);
    return pois.slice(0, 600);
  };
  const counts = () => Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length]));
  await Promise.all(sources.map(s => jobs[s]()
    .then(r => { results[s] = r; })
    .catch(e => { results[s] = []; warnings.push(`${labels[s]}: ${e.message}`); })
    .finally(() => send({ partial: true, done: s, pois: build(), counts: counts(), warnings, osm: results.osm?.stats }))));
  const final = { pois: build(), warnings, counts: counts(), osm: results.osm?.stats };
  if (stream) { send({ ...final, final: true }); return res.end(); }
  if (sources.every(s => !results[s].length) && warnings.length === sources.length) return res.status(502).json({ error: warnings.join(' · ') });
  res.json(final);
}));

// ---------- giornate di viaggio ----------
app.post('/api/plan', wrap(async (req, res) => {
  const b = req.body || {};
  const geometry = (Array.isArray(b.geometry) ? b.geometry : []).map(p => [num(p[0]), num(p[1])]);
  const stops = (Array.isArray(b.stops) ? b.stops : []).map(s => ({ lat: num(s.lat), lon: num(s.lon), nights: Math.max(0, Math.round(num(s.nights))), name: str(s.name, 200) }));
  if (geometry.length < 2 || stops.length < 2) return res.status(400).json({ error: 'Serve un percorso calcolato con almeno due tappe' });
  const maxKm = Math.max(0, Math.min(2000, num(b.maxKm))), maxHours = Math.max(0, Math.min(24, num(b.maxHours)));
  if (!maxKm && !maxHours) return res.status(400).json({ error: 'Indica i km o le ore di guida al giorno' });
  const plan = planDays({ geometry, legs: Array.isArray(b.legs) ? b.legs : [], stops, startDate: str(b.startDate, 10), maxKm, maxHours });
  const sources = (Array.isArray(b.sources) ? b.sources : ['osm', 'mine']).filter(x => ['osm', 'mine'].includes(x));
  const warnings = [];
  const coll = sources.includes('mine') ? await loadCollection() : null;
  for (const n of plan.nights) {
    const line = nightWindow(plan.geometry, plan.cumKm, n, maxKm);
    const area = makeArea({ line, radius: Math.max(3000, Math.min(20000, num(b.radius, 8000))) });
    const lists = [];
    if (sources.includes('osm')) {
      try { lists.push(await searchOsm(area, ['area_camper', 'campeggio'])); }
      catch (e) { if (!warnings.length) warnings.push(`OpenStreetMap: ${e.message}`); }
    }
    if (coll) lists.push(searchMine(coll, area, ['area_camper', 'campeggio']));
    n.candidates = rankNight(mergePois(lists), n.point, plan.cumKm, plan.geometry, n.index).slice(0, 5);
  }
  const { cumKm, sIdx, geometry: _g, ...out } = plan;
  res.json({ ...out, warnings });
}));

// ---------- meteo delle giornate (Open-Meteo) ----------
const weather = createWeather({ fetchJson });
app.post('/api/weather', wrap(async (req, res) => {
  const pts = (Array.isArray(req.body?.points) ? req.body.points : []).slice(0, 60)
    .map(p => ({ lat: num(p.lat), lon: num(p.lon), date: /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : '' }))
    .filter(p => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  res.json(await weather.forDays(pts));
}));

// ---------- prezzi dei carburanti (MIMIT) ----------
const fuel = createFuel({ cacheDir: path.join(DATA_DIR, 'cache'), userAgent: USER_AGENT });
app.post('/api/fuel', wrap(async (req, res) => {
  const b = req.body || {};
  const kind = FUELS[b.fuel] ? b.fuel : 'gasolio';
  const radius = Math.max(500, Math.min(20000, Math.round(num(b.radius, 3000))));
  const line = Array.isArray(b.line) && b.line.length >= 2 ? b.line.map(p => [num(p[0]), num(p[1])]) : null;
  const center = !line && Array.isArray(b.center) ? [num(b.center[0]), num(b.center[1])] : null;
  if (!line && !center) return res.status(400).json({ error: 'Serve un percorso o un punto' });
  const r = await fuel.search({ line, center, radius, fuel: kind });
  // i più economici ogni 50 km, così si vede dove conviene fermarsi
  const byBand = new Map();
  for (const s of r.stations) { const k = Math.floor(s.routeKm / 50); if (!byBand.has(k) || s.price < byBand.get(k).price) byBand.set(k, s); }
  const bestIds = new Set([...byBand.values()].map(s => s.id));
  const cheapest = [...r.stations].sort((a, b) => a.price - b.price).slice(0, 200);
  const keep = new Map([...cheapest, ...byBand.values()].map(s => [s.id, { ...s, bestOfBand: bestIds.has(s.id) }]));
  res.json({ ...r, stations: [...keep.values()].sort((a, b) => a.routeKm - b.routeKm || a.price - b.price), total: r.stations.length });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Non trovato' }));
app.get('*', (req, res) => res.redirect(302, auth.pageGuard(req).needsLogin ? '/accesso' : '/'));

await fs.mkdir(DATA_DIR, { recursive: true });
await auth.load();
app.listen(PORT, () => console.log(`Camper Planner ${VERSION} in ascolto su :${PORT}, dati in ${DATA_DIR}`));
