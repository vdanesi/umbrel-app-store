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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRIPS_DIR = path.join(DATA_DIR, 'trips');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const COLLECTION_FILE = path.join(DATA_DIR, 'collection.json');
const VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const ORS_URL = process.env.ORS_URL || 'https://api.openrouteservice.org';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OVERPASS_URLS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',').map(s => s.trim()).filter(Boolean);
const USER_AGENT = `CamperPlanner/${VERSION} (self-hosted Umbrel app)`;

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

async function ensureDirs() {
  await fs.mkdir(TRIPS_DIR, { recursive: true });
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
const tripFile = id => path.join(TRIPS_DIR, `${id}.json`);

async function loadSettings() {
  const s = await readJson(SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...s, vehicle: { ...DEFAULT_SETTINGS.vehicle, ...(s.vehicle || {}) } };
}

function publicSettings(s) {
  const { orsApiKey, openPlacesKey, ...rest } = s;
  return { ...rest, orsApiKeySet: Boolean(orsApiKey), openPlacesKeySet: Boolean(openPlacesKey) };
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
    notes: str(t.notes, 50000),
    stops, expenses, route,
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

// Punti campione lungo la linea, distanziati in modo uniforme (per Overpass "around").
function samplePolyline(pts, maxPoints = 120) {
  if (pts.length <= maxPoints) return pts;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversine(pts[i - 1], pts[i]);
  const step = total / (maxPoints - 1);
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += haversine(pts[i - 1], pts[i]);
    if (acc >= step) { out.push(pts[i]); acc = 0; }
  }
  if (out.at(-1) !== pts.at(-1)) out.push(pts.at(-1));
  return out;
}

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

async function overpass(query) {
  let lastErr;
  for (const base of OVERPASS_URLS) {
    try {
      return await fetchJson(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      }, 60000);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass non raggiungibile');
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
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(req.method, req.path, e.message);
  res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message });
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION }));

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
  if (typeof b.orsApiKey === 'string') next.orsApiKey = b.orsApiKey.trim().slice(0, 300);
  if (typeof b.openPlacesKey === 'string') next.openPlacesKey = b.openPlacesKey.trim().slice(0, 300);
  await writeJsonAtomic(SETTINGS_FILE, next);
  res.json(publicSettings(next));
}));

app.get('/api/trips', wrap(async (req, res) => {
  const files = (await fs.readdir(TRIPS_DIR)).filter(f => f.endsWith('.json'));
  const trips = [];
  for (const f of files) {
    try { trips.push(summary(JSON.parse(await fs.readFile(path.join(TRIPS_DIR, f), 'utf8')))); }
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

async function searchOsm(area, types, b) {
  let around;
  if (area.kind === 'line') {
    const pts = samplePolyline(area.line, 120);
    around = `around:${area.radius},${pts.map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(',')}`;
  } else around = `around:${area.radius},${area.center[0].toFixed(5)},${area.center[1].toFixed(5)}`;
  const parts = types.flatMap(t => POI_FILTERS[t].map(f => `${f}(${around});`)).join('');
  const data = await overpass(`[out:json][timeout:50];(${parts});out center tags 400;`);
  const seen = new Set();
  const out = [];
  for (const el of data.elements || []) {
    const key = el.type + el.id;
    if (seen.has(key)) continue; seen.add(key);
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const tags = el.tags || {};
    out.push({
      id: `osm:${el.type}/${el.id}`, sources: ['osm'],
      osmType: el.type, osmId: el.id, lat, lon, category: classifyPoi(tags),
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
  return out;
}

// ---------- la mia raccolta ----------

async function loadCollection() {
  const c = await readJson(COLLECTION_FILE, null);
  return c && Array.isArray(c.items) ? c : { items: [], imports: [] };
}
function collectionSummary(c) {
  const fav = c.items.filter(i => i.source === 'preferiti').length;
  return { total: c.items.length, favorites: fav, imports: c.imports };
}
function searchMine(c, area, types) {
  return c.items.filter(i => types.includes(i.category) && area.contains([i.lat, i.lon])).map(i => ({
    id: 'mine:' + i.id, mineId: i.id, sources: ['mine'], lat: i.lat, lon: i.lon, category: i.category, name: i.name || null,
    tags: { notes: i.notes || undefined, list: i.source === 'preferiti' ? undefined : i.source, website: i.website || undefined, phone: i.phone || undefined }
  }));
}

app.get('/api/collection', wrap(async (req, res) => res.json(collectionSummary(await loadCollection()))));

app.post('/api/collection/import', wrap(async (req, res) => {
  const filename = str(req.body?.filename, 120).replace(/[\\/]/g, '_') || 'importazione';
  const text = typeof req.body?.content === 'string' ? req.body.content : '';
  const pts = parsePoiFile(filename, text);
  if (!pts.length) return res.status(400).json({ error: 'Nessun punto trovato nel file (servono GPX, KML o CSV con coordinate)' });
  const c = await loadCollection();
  // reimportare lo stesso file lo sostituisce
  c.items = c.items.filter(i => i.source !== filename);
  if (c.items.length + pts.length > 200000) return res.status(400).json({ error: 'Raccolta troppo grande (massimo 200.000 punti)' });
  const now = new Date().toISOString();
  for (const p of pts) c.items.push({ id: crypto.randomUUID(), source: filename, addedAt: now, ...p });
  c.imports = c.imports.filter(i => i.name !== filename).concat({ name: filename, count: pts.length, importedAt: now });
  await writeJsonAtomic(COLLECTION_FILE, c);
  res.json({ added: pts.length, ...collectionSummary(c) });
}));

app.delete('/api/collection/imports/:name', wrap(async (req, res) => {
  const c = await loadCollection();
  c.items = c.items.filter(i => i.source !== req.params.name);
  c.imports = c.imports.filter(i => i.name !== req.params.name);
  await writeJsonAtomic(COLLECTION_FILE, c);
  res.json(collectionSummary(c));
}));

app.post('/api/collection/favorites', wrap(async (req, res) => {
  const b = req.body || {};
  const lat = num(b.lat, NaN), lon = num(b.lon, NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Coordinate non valide' });
  const c = await loadCollection();
  const near = c.items.find(i => i.source === 'preferiti' && haversine([i.lat, i.lon], [lat, lon]) < 30);
  if (near) return res.json({ item: near, ...collectionSummary(c) });
  const category = ['area_camper', 'campeggio', 'scarico', 'acqua', 'gpl'].includes(b.category) ? b.category : guessCategory(str(b.name));
  const item = { id: crypto.randomUUID(), source: 'preferiti', addedAt: new Date().toISOString(), lat, lon, category,
    name: str(b.name, 200), notes: str(b.notes, 2000), website: str(b.website, 300), phone: str(b.phone, 60) };
  c.items.push(item);
  await writeJsonAtomic(COLLECTION_FILE, c);
  res.status(201).json({ item, ...collectionSummary(c) });
}));

app.delete('/api/collection/items/:id', wrap(async (req, res) => {
  const c = await loadCollection();
  c.items = c.items.filter(i => i.id !== req.params.id);
  await writeJsonAtomic(COLLECTION_FILE, c);
  res.json(collectionSummary(c));
}));

app.get('/api/collection/export', wrap(async (req, res) => {
  const c = await loadCollection();
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="Camper Planner" xmlns="http://www.topografix.com/GPX/1/1">'];
  for (const i of c.items) lines.push(`<wpt lat="${i.lat.toFixed(6)}" lon="${i.lon.toFixed(6)}"><name>${xml(i.name || 'Area sosta')}</name>` +
    (i.notes ? `<desc>${xml(i.notes)}</desc>` : '') + `<type>${xml(i.category)}</type></wpt>`);
  lines.push('</gpx>');
  res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="la-mia-raccolta.gpx"');
  res.send(lines.join('\n'));
}));

// ---------- ricerca aree sosta su tutte le fonti ----------

app.post('/api/pois', wrap(async (req, res) => {
  const b = req.body || {};
  const types = (Array.isArray(b.types) ? b.types : Object.keys(POI_FILTERS)).filter(t => POI_FILTERS[t]);
  const sources = (Array.isArray(b.sources) ? b.sources : ['osm']).filter(s => ['osm', 'overture', 'mine'].includes(s));
  if (!types.length || !sources.length) return res.json({ pois: [], warnings: [], counts: {} });
  const radius = Math.max(500, Math.min(50000, Math.round(num(b.radius, 10000))));
  let area;
  if (Array.isArray(b.line) && b.line.length >= 2) area = makeArea({ line: b.line.map(p => [num(p[0]), num(p[1])]), radius });
  else if (b.center) area = makeArea({ center: [num(b.center[0]), num(b.center[1])], radius });
  else return res.status(400).json({ error: 'Indica una tappa o un percorso' });

  const settings = await loadSettings();
  const warnings = [];
  const labels = { osm: 'OpenStreetMap', overture: 'Overture', mine: 'La mia raccolta' };
  const jobs = {
    osm: () => searchOsm(area, types, b),
    overture: () => settings.openPlacesKey
      ? searchOverture({ area, types, apiKey: settings.openPlacesKey, fetchJson })
      : Promise.reject(new Error('manca la chiave Open Places API (scheda Mezzo)')),
    mine: async () => searchMine(await loadCollection(), area, types)
  };
  const results = await Promise.all(sources.map(s => jobs[s]().catch(e => { warnings.push(`${labels[s]}: ${e.message}`); return []; })));
  const counts = Object.fromEntries(sources.map((s, i) => [s, results[i].length]));
  if (results.every(r => !r.length) && warnings.length === sources.length) {
    return res.status(502).json({ error: warnings.join(' · ') });
  }
  // ordine: OSM (dati più ricchi), poi la raccolta, poi Overture
  const order = ['osm', 'mine', 'overture'];
  const lists = order.filter(s => sources.includes(s)).map(s => results[sources.indexOf(s)]);
  const pois = mergePois(lists).slice(0, 600);
  res.json({ pois, warnings, counts });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Non trovato' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

await ensureDirs();
app.listen(PORT, () => console.log(`Camper Planner ${VERSION} in ascolto su :${PORT}, dati in ${DATA_DIR}`));
