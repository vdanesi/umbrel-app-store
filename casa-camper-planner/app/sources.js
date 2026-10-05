// Fonti aggiuntive per le aree sosta:
// - Overture Maps tramite Open Places API (dati aperti, chiave gratuita)
// - "La mia raccolta": punti importati da GPX/KML/CSV o salvati come preferiti
// e unione dei risultati che indicano lo stesso posto.

export const OPENPLACES_URL = process.env.OPENPLACES_URL || 'https://api.openplacesapi.com';

export function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function lineLength(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += haversine(pts[i - 1], pts[i]);
  return t;
}

// Punti distanziati di "step" metri lungo la linea (primo e ultimo inclusi).
export function pointsEvery(pts, step) {
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let seg = haversine(a, b);
    while (acc + seg >= step && seg > 0) {
      const f = (step - acc) / seg;
      a = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      out.push(a);
      seg = haversine(a, b);
      acc = 0;
    }
    acc += seg;
  }
  const last = pts.at(-1);
  if (haversine(out.at(-1), last) > step * 0.3) out.push(last);
  return out;
}

// Area di ricerca: un punto con raggio, oppure una linea con distanza massima.
export function makeArea({ center, line, radius }) {
  if (line) {
    const len = lineLength(line);
    const spacing = Math.max(250, radius / 2, len / 1500);
    const dense = pointsEvery(line, spacing);
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const [la, lo] of line) {
      minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
      minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo);
    }
    const dLat = radius / 111000, dLon = radius / (111000 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));
    const bbox = [minLat - dLat, maxLat + dLat, minLon - dLon, maxLon + dLon];
    return {
      kind: 'line', line, len, radius,
      contains(p) {
        if (p[0] < bbox[0] || p[0] > bbox[1] || p[1] < bbox[2] || p[1] > bbox[3]) return false;
        const slack = radius * 1.05 + spacing / 2;
        for (const q of dense) if (haversine(p, q) <= slack) return true;
        return false;
      }
    };
  }
  return { kind: 'point', center, radius, contains: p => haversine(p, center) <= radius };
}

// ---------- Overture / Open Places API ----------

const OVERTURE_CATEGORIES = { campground: 'campeggio', rv_park: 'area_camper' };
const RE_SOSTA = /(area\s*(di\s*)?sosta|sosta\s*camper|camper\s*(stop|park|service)|stellplatz|wohnmobil|aire\s+de|aire\s+camping|camperplaats|motorhome|autocaravan|rv\s*park|caravan)/i;
const RE_CAMP = /(camping|campeggio|campground|campsite|camp\b)/i;

function mapOverture(r) {
  const cats = [r.category, ...(r.categories || [])].filter(Boolean).map(String);
  let category = null;
  for (const c of cats) if (OVERTURE_CATEGORIES[c]) { category = OVERTURE_CATEGORIES[c]; break; }
  const name = r.name || '';
  if (!category) {
    if (RE_SOSTA.test(name) || cats.some(c => /rv|caravan|motorhome/i.test(c))) category = 'area_camper';
    else if (RE_CAMP.test(name) || cats.some(c => /camp/i.test(c))) category = 'campeggio';
  }
  if (!category) return null;
  const a = r.address || {};
  const addr = [a.freeform || a.street, a.locality].filter(Boolean).join(', ');
  return {
    id: 'overture:' + (r.place_id || `${r.lat},${r.lon}`),
    sources: ['overture'], lat: Number(r.lat), lon: Number(r.lon), category, name: name || null,
    tags: { website: r.website || undefined, phone: r.phone || undefined, address: addr || undefined,
      closed: r.operating_status && !/open/i.test(r.operating_status) ? r.operating_status : undefined }
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function searchOverture({ area, types, apiKey, fetchJson }) {
  const wanted = types.filter(t => t === 'area_camper' || t === 'campeggio');
  if (!wanted.length) return [];
  // punti di interrogazione: il centro, o al massimo 12 punti lungo il percorso
  let queries;
  if (area.kind === 'line') {
    const n = Math.max(1, Math.min(12, Math.ceil(area.len / (2 * area.radius))));
    const r = Math.max(area.radius, area.len / (2 * n) * 1.1);
    const pts = n === 1 ? [area.line[Math.floor(area.line.length / 2)]] : pointsEvery(area.line, area.len / (n - 1) * 0.999).slice(0, n);
    queries = pts.map(p => ({ p, r }));
  } else queries = [{ p: area.center, r: area.radius }];

  const reqs = [];
  for (const { p, r } of queries) {
    const base = { lat: p[0].toFixed(5), lon: p[1].toFixed(5), radius_mi: Math.min(50, Math.max(0.5, r / 1609.34)).toFixed(1) };
    if (wanted.includes('campeggio')) reqs.push({ ...base, category: 'campground', limit: 50 });
    if (wanted.includes('area_camper')) {
      reqs.push({ ...base, category: 'rv_park', limit: 50 });
      reqs.push({ ...base, q: 'area sosta camper', limit: 20 });
    }
  }
  const errors = [];
  const pages = await mapLimit(reqs, 4, async params => {
    try {
      return await fetchJson(`${OPENPLACES_URL}/v1/places?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
    } catch (e) { errors.push(e.message); return null; }
  });
  if (pages.every(p => !p)) throw new Error(errors[0] || 'Open Places API non raggiungibile');
  const out = new Map();
  for (const page of pages) for (const r of page?.results || []) {
    const p = mapOverture(r);
    if (p && Number.isFinite(p.lat) && wanted.includes(p.category) && area.contains([p.lat, p.lon])) out.set(p.id, p);
  }
  return [...out.values()];
}

// ---------- import GPX / KML / CSV ----------

const decode = s => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };
const attr = (head, name) => { const m = head.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i')); return m ? m[1] : ''; };

function parseGpx(text) {
  const out = [];
  const re = /<(wpt|rtept)\b([^>]*)>([\s\S]*?)<\/\1>|<(wpt|rtept)\b([^>]*)\/>/gi;
  let m;
  while ((m = re.exec(text))) {
    const head = m[2] || m[5] || '', body = m[3] || '';
    out.push({ lat: parseFloat(attr(head, 'lat')), lon: parseFloat(attr(head, 'lon')),
      name: tag(body, 'name'), notes: [tag(body, 'desc'), tag(body, 'cmt')].filter(Boolean).join(' · '),
      kindHint: tag(body, 'type') + ' ' + tag(body, 'sym') });
  }
  return out;
}

function parseKml(text) {
  const out = [];
  const re = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const pt = body.match(/<Point\b[\s\S]*?<coordinates>\s*([-\d.]+)\s*,\s*([-\d.]+)/i);
    if (!pt) continue; // linee e poligoni non sono aree sosta
    out.push({ lat: parseFloat(pt[2]), lon: parseFloat(pt[1]), name: tag(body, 'name'), notes: tag(body, 'description') });
  }
  return out;
}

function splitCsvLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (!lines.length) return [];
  const sep = [';', '\t', ','].map(s => [s, (lines[0].match(new RegExp(s === '\t' ? '\t' : `\\${s}`, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const first = splitCsvLine(lines[0], sep).map(h => h.toLowerCase().replace(/^﻿/, ''));
  const find = (...names) => first.findIndex(h => names.includes(h));
  let iLat = find('lat', 'latitude', 'latitudine', 'y'), iLon = find('lon', 'lng', 'long', 'longitude', 'longitudine', 'x');
  let iName = find('name', 'nome', 'title', 'titolo'), iNote = find('description', 'desc', 'descrizione', 'note', 'notes', 'comment');
  let rows = lines.slice(1);
  if (iLat < 0 || iLon < 0) {
    // senza intestazione: formato POI Garmin "lon,lat,nome,descrizione"
    iLon = 0; iLat = 1; iName = 2; iNote = 3; rows = lines;
  }
  const num = v => parseFloat(String(v ?? '').replace(',', '.'));
  return rows.map(l => {
    const c = splitCsvLine(l, sep);
    return { lat: num(c[iLat]), lon: num(c[iLon]), name: c[iName] || '', notes: iNote >= 0 ? c[iNote] || '' : '' };
  });
}

export function guessCategory(text) {
  if (RE_CAMP.test(text) && !RE_SOSTA.test(text)) return 'campeggio';
  if (/(scarico|dump|vidange|entsorgung|ver\s*sorgung)/i.test(text) && !/(sosta|stellplatz)/i.test(text)) return 'scarico';
  return 'area_camper';
}

export function parsePoiFile(filename, text) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  let pts;
  if (ext === 'gpx' || /<gpx[\s>]/i.test(text.slice(0, 2000))) pts = parseGpx(text);
  else if (ext === 'kml' || /<kml[\s>]/i.test(text.slice(0, 2000))) pts = parseKml(text);
  else pts = parseCsv(text);
  return pts
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0))
    .map(p => ({ lat: p.lat, lon: p.lon, name: String(p.name || '').slice(0, 200), notes: String(p.notes || '').slice(0, 2000),
      category: guessCategory(`${p.name} ${p.kindHint || ''} ${filename}`) }));
}

// ---------- unione dei duplicati ----------

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(area|sosta|camper|camping|campeggio|parking|parcheggio|di|del|della|la|il|le)\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 4);

function sameName(a, b) {
  if (!a || !b) return false;
  const wa = new Set(norm(a));
  return norm(b).some(w => wa.has(w));
}

// Le fonti arrivano in ordine di ricchezza dei dati: il primo resta, gli altri lo completano.
export function mergePois(lists) {
  const out = [];
  for (const list of lists) for (const p of list) {
    let hit = null;
    for (const q of out) {
      const d = haversine([p.lat, p.lon], [q.lat, q.lon]);
      if (d < 60 || (d < 300 && sameName(p.name, q.name))) { hit = q; break; }
    }
    if (!hit) { out.push({ ...p, tags: { ...(p.tags || {}) } }); continue; }
    for (const s of p.sources) if (!hit.sources.includes(s)) hit.sources.push(s);
    if (!hit.name && p.name) hit.name = p.name;
    for (const [k, v] of Object.entries(p.tags || {})) if (v && !hit.tags[k]) hit.tags[k] = v;
    if (p.mineId && !hit.mineId) hit.mineId = p.mineId;
  }
  return out;
}
