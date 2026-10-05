// Ricerca aree sosta su OpenStreetMap a riquadri, con cache condivisa sull'Umbrel.
// Una query "around" lungo tutto il percorso è la più lenta per Overpass: chiedere i
// riquadri (bbox) è molto più veloce, e i riquadri già scaricati non si richiedono più.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pointsEvery } from './sources.js';

export const TILE = 0.25;                 // gradi (~28 km di latitudine)
const TTL = 14 * 864e5;                   // i riquadri valgono 14 giorni
const MAX_TILES_PER_QUERY = 36;
const HEDGE_MS = 5000;                    // dopo 5 s senza risposta si prova anche il secondo server

// Tutti i tipi di punto in un colpo solo: ogni riquadro in cache serve per qualunque ricerca.
const FILTERS = [
  'nwr["tourism"="caravan_site"]',
  'nwr["tourism"="camp_site"]["caravans"!="no"]',
  'nwr["amenity"="sanitary_dump_station"]',
  'nwr["sanitary_dump_station"="yes"]',
  'nwr["amenity"="water_point"]',
  'nwr["amenity"="fuel"]["fuel:lpg"="yes"]'
];

const keyOf = (ix, iy) => `${ix}_${iy}`;
const cellOf = (lat, lon) => [Math.floor(lon / TILE), Math.floor(lat / TILE)];
const bboxOf = key => { const [ix, iy] = key.split('_').map(Number); return [iy * TILE, ix * TILE, (iy + 1) * TILE, (ix + 1) * TILE]; }; // s,w,n,e

function addCellsAround(set, lat, lon, radius) {
  const dLat = radius / 111000, dLon = radius / (111000 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const [x0, y0] = cellOf(lat - dLat, lon - dLon), [x1, y1] = cellOf(lat + dLat, lon + dLon);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) set.add(keyOf(x, y));
}

export function tilesForArea(area) {
  const set = new Set();
  if (area.kind === 'line') {
    const step = Math.max(1000, Math.min(area.radius, TILE * 111000 / 3));
    for (const [la, lo] of pointsEvery(area.line, step)) addCellsAround(set, la, lo, area.radius);
  } else addCellsAround(set, area.center[0], area.center[1], area.radius);
  return [...set];
}

export function createOsmTiles({ cacheDir, overpassUrls, userAgent }) {
  const dir = path.join(cacheDir, 'osm');
  const mem = new Map();                  // key -> {at, els}
  const inflight = new Map();             // key -> Promise
  let dirReady = null;
  const ensureDir = () => (dirReady ||= fs.mkdir(dir, { recursive: true }));

  async function readTile(key) {
    const m = mem.get(key);
    if (m && Date.now() - m.at < TTL) return m;
    try {
      const t = JSON.parse(await fs.readFile(path.join(dir, key + '.json'), 'utf8'));
      if (Date.now() - t.at < TTL) { mem.set(key, t); return t; }
    } catch { /* non in cache */ }
    return null;
  }
  async function writeTile(key, els) {
    const t = { at: Date.now(), els };
    mem.set(key, t);
    if (mem.size > 4000) mem.delete(mem.keys().next().value);
    // la cache è solo un aiuto: se non si riesce a salvarla, la ricerca prosegue lo stesso
    const tmp = path.join(dir, `${key}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ensureDir();
        await fs.writeFile(tmp, JSON.stringify(t));
        await fs.rename(tmp, path.join(dir, key + '.json'));
        return;
      } catch (e) {
        if (e.code === 'ENOENT' && attempt === 0) { dirReady = null; continue; }
        console.error('Cache OSM non salvata:', key, e.message);
        return;
      }
    }
  }

  // Una richiesta a un server Overpass, annullabile.
  async function post(base, query, signal) {
    const r = await fetch(base, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent, Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(query)
    });
    const text = await r.text();
    if (!r.ok) throw new Error(r.status === 429 ? 'server OpenStreetMap occupato (troppe richieste), riprova tra poco' : `Overpass ${r.status}`);
    try { return JSON.parse(text); } catch { throw new Error('risposta non valida da Overpass'); }
  }

  // Il primo server risponde di solito; se tarda, parte anche il secondo e vince il più rapido.
  function hedged(query) {
    const ctrls = [];
    return new Promise((resolve, reject) => {
      let pending = 0, started = 0, done = false, lastErr;
      let hedgeTimer = null;
      const giveUp = setTimeout(() => finish(null, new Error('OpenStreetMap non ha risposto in tempo'), true), 90000);
      function finish(val, err, force) {
        if (done) return;
        if (err && pending > 0 && !force) return; // c'è ancora un server in corsa
        done = true; clearTimeout(giveUp); clearTimeout(hedgeTimer);
        ctrls.forEach(c => c.abort());
        err ? reject(err) : resolve(val);
      }
      function start() {
        if (started >= overpassUrls.length || done) return;
        const c = new AbortController(); ctrls.push(c);
        const base = overpassUrls[started++];
        pending++;
        post(base, query, c.signal).then(v => { pending--; finish(v); }, e => {
          pending--; lastErr = e;
          if (started < overpassUrls.length) start(); else finish(null, lastErr);
        });
      }
      start();
      hedgeTimer = setTimeout(start, HEDGE_MS);
    });
  }

  async function fetchTiles(keys) {
    const parts = keys.map(k => {
      const [s, w, n, e] = bboxOf(k);
      const bb = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
      return FILTERS.map(f => `${f}(${bb});`).join('');
    }).join('');
    const data = await hedged(`[out:json][timeout:80];(${parts});out center tags qt;`);
    const by = new Map(keys.map(k => [k, []]));
    for (const el of data.elements || []) {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const k = keyOf(...cellOf(lat, lon));
      if (by.has(k)) by.get(k).push({ type: el.type, id: el.id, lat, lon, tags: el.tags || {} });
    }
    await Promise.all([...by].map(([k, els]) => writeTile(k, els)));
    return by;
  }

  // Restituisce gli elementi OSM dei riquadri; scarica solo quelli mancanti.
  async function elementsFor(area, onProgress) {
    const keys = tilesForArea(area);
    const out = new Map();
    const missing = [];
    for (const k of keys) {
      const t = await readTile(k);
      if (t) out.set(k, t.els); else missing.push(k);
    }
    const waits = [];
    const toFetch = [];
    for (const k of missing) inflight.has(k) ? waits.push(inflight.get(k).then(m => out.set(k, m.get(k) || []))) : toFetch.push(k);
    const batches = [];
    for (let i = 0; i < toFetch.length; i += MAX_TILES_PER_QUERY) batches.push(toFetch.slice(i, i + MAX_TILES_PER_QUERY));
    let done = keys.length - missing.length;
    onProgress?.({ tiles: keys.length, cached: done });
    // al massimo 2 richieste insieme: rispetto per i server pubblici
    let next = 0;
    async function worker() {
      while (next < batches.length) {
        const b = batches[next++];
        const p = fetchTiles(b);
        for (const k of b) inflight.set(k, p);
        try { const m = await p; for (const k of b) out.set(k, m.get(k)); }
        finally { for (const k of b) inflight.delete(k); }
        done += b.length; onProgress?.({ tiles: keys.length, cached: keys.length - missing.length, done });
      }
    }
    await Promise.all([worker(), worker(), ...waits]);
    return { elements: [...out.values()].flat(), tiles: keys.length, fromCache: keys.length - missing.length };
  }

  async function stats() {
    try { return { tiles: (await fs.readdir(dir)).filter(f => f.endsWith('.json')).length }; } catch { return { tiles: 0 }; }
  }
  async function clear() { mem.clear(); await fs.rm(dir, { recursive: true, force: true }); dirReady = null; }

  return { elementsFor, stats, clear };
}

