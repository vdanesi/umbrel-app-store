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
    // cerchi ogni ~50 km lungo il percorso, abbastanza grandi da coprire tutta la fascia
    const n = Math.max(1, Math.min(10, Math.ceil(area.len / 50000)));
    const step = area.len / n;
    const r = Math.sqrt((step / 2) ** 2 + area.radius ** 2) * 1.2;
    const marks = pointsEvery(area.line, step / 2);           // 0, s/2, s, 3s/2, …
    const pts = marks.filter((_, i) => i % 2 === 1).slice(0, n);
    if (!pts.length) pts.push(area.line[Math.floor(area.line.length / 2)]);
    // controllo: se una parte della fascia resta fuori (curve strette, estremi) aggiungo un cerchio lì
    const dLat = area.radius / 111000;
    for (const q of pointsEvery(area.line, Math.max(1000, area.radius / 3))) {
      const dLon = area.radius / (111000 * Math.cos(q[0] * Math.PI / 180));
      const probes = [q, [q[0] + dLat, q[1]], [q[0] - dLat, q[1]], [q[0], q[1] + dLon], [q[0], q[1] - dLon]];
      if (probes.some(x => !pts.some(c => haversine(c, x) <= r)) && pts.length < 14) pts.push(q);
    }
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
  const pages = await mapLimit(reqs, 8, async params => {
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
    // indirizzo nelle estensioni Garmin (gpxx:Address), se c'è
    const address = ['gpxx:StreetAddress', 'gpxx:City', 'gpxx:State'].map(t => tag(body, t)).filter(Boolean).join(', ');
    out.push({ lat: parseFloat(attr(head, 'lat')), lon: parseFloat(attr(head, 'lon')),
      name: tag(body, 'name'), notes: [tag(body, 'desc'), tag(body, 'cmt')].filter(Boolean).join(' · '),
      cmt: tag(body, 'cmt'), city: tag(body, 'gpxx:City'), address,
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

// Sceglie i campi utili da un record con nomi di colonna sconosciuti
// (dataset aperti di regioni e comuni: ognuno li chiama a modo suo).
const FIELD_RULES = {
  name: [/^(name|nome|nom|title|titolo|titre|denominazione|denomination|nomoffre|nom_offre|nom_de_l_offre|nom_du_poi|raison_sociale|raisonsociale|documentname|syndicobjectname|nombre|nombre_establecimiento|libelle|label)$/,
    /(^|_)(nom|name|nome|denominaz|titre|title|nombre)(_|$)/],
  notes: [/^(description|desc|descrizione|descriptif|presentation|descripcion|documentdescription|note|notes|comment|commentaire)$/,
    /(descri|presentation|comment)/],
  website: [/^(website|web|site|site_web|siteweb|sito|sito_web|url|www)$/, /(site.?web|sito|website|url)/],
  phone: [/^(phone|telephone|tel|telefono|téléphone|telefon)$/, /(t(e|é)l(e|é)phone|telefono|phone)/],
  city: [/^(commune|comune|city|ville|municipio|municipality|locality|localita|località|town)$/, /(commune|comune|municip|ville|locali)/],
  price: [/^(tarif|tarifs|prix|price|prezzo|prezzi|precio)$/, /(tarif|prix|prezz|price|precio)/],
  capacity: [/^(capacity|capacite|capacité|posti|places|plazas|nb_places|emplacements)$/, /(capacit|nb_?places|emplacement|posti|plazas)/],
  type: [/^(type|tipo|tipologia|typologie|categorie|category|categoria|modalidad|lodgingtype|type_offre|typeoffre)$/, /(tipolog|typolog|type|modalid|categor)/],
  lat: [/^(lat|latitude|latitudine|latitud|y|coord_y|gps_lat|geo_lat)$/, /(^|_)lat(itud[ei]?)?(_|$)/],
  lon: [/^(lon|lng|long|longitude|longitudine|longitud|x|coord_x|gps_lon|gps_lng|geo_lon)$/, /(^|_)(lon|lng)(gitud[ei]?)?(_|$)/],
  point: [/^(geo_point_2d|geopoint|geo_point|coordonnees|coordonnees_gps|coordinate|coordinates|coordenadas|geolocalisation|geolocalizzazione|position|location|gps)$/, /(geo_?point|coordonn|coordin|coorden|geoloc)/]
};
const keyNorm = k => String(k).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function pickFields(keys) {
  const nk = keys.map(keyNorm);
  const out = {};
  for (const [field, [exact, loose]] of Object.entries(FIELD_RULES)) {
    let i = nk.findIndex(k => exact.test(k));
    if (i < 0) i = nk.findIndex(k => loose.test(k) && !Object.values(out).includes(keys[nk.indexOf(k)]));
    if (i >= 0) out[field] = keys[i];
  }
  return out;
}

const toNum = v => typeof v === 'number' ? v : parseFloat(String(v ?? '').trim().replace(',', '.'));
const clean = v => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(clean).filter(Boolean).join(', ');
  if (typeof v === 'object') return '';
  return String(v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

function parsePointValue(v) {
  if (v == null) return null;
  if (Array.isArray(v) && v.length >= 2) return [toNum(v[0]), toNum(v[1])]; // Opendatasoft: [lat, lon]
  if (typeof v === 'object') {
    const la = v.lat ?? v.latitude, lo = v.lon ?? v.lng ?? v.longitude;
    return la != null && lo != null ? [toNum(la), toNum(lo)] : null;
  }
  const m = String(v).match(/(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)/);
  return m ? [toNum(m[1]), toNum(m[2])] : null;
}

function recordToPoint(rec, f, coords) {
  let lat, lon;
  if (coords) [lon, lat] = coords;
  if (!(Number.isFinite(lat) && Number.isFinite(lon)) && f.lat && f.lon) { lat = toNum(rec[f.lat]); lon = toNum(rec[f.lon]); }
  if (!(Number.isFinite(lat) && Number.isFinite(lon)) && f.point) { const p = parsePointValue(rec[f.point]); if (p) [lat, lon] = p; }
  const extras = [];
  if (f.city && rec[f.city]) extras.push(clean(rec[f.city]));
  if (f.price && clean(rec[f.price])) extras.push(clean(rec[f.price]).slice(0, 200));
  if (f.capacity && clean(rec[f.capacity])) extras.push(`${clean(rec[f.capacity])} posti`);
  const desc = f.notes ? clean(rec[f.notes]) : '';
  return {
    lat, lon,
    name: f.name ? clean(rec[f.name]) : '',
    notes: [extras.join(' · '), desc.length > 600 ? desc.slice(0, 600) + '…' : desc].filter(Boolean).join(' — '),
    website: f.website ? clean(rec[f.website]).split(/[\s,;]+/)[0] : '',
    phone: f.phone ? clean(rec[f.phone]).slice(0, 60) : '',
    kindHint: f.type ? clean(rec[f.type]) : ''
  };
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (!lines.length) return [];
  const sep = [';', '\t', ','].map(s => [s, splitCsvLine(lines[0], s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const head = splitCsvLine(lines[0], sep);
  const f = pickFields(head);
  if ((f.lat && f.lon) || f.point) {
    return lines.slice(1).map(l => {
      const c = splitCsvLine(l, sep);
      const rec = Object.fromEntries(head.map((h, i) => [h, c[i]]));
      return recordToPoint(rec, f);
    });
  }
  // senza intestazione riconoscibile: formato POI Garmin/MIO "lon,lat,nome,descrizione"
  return lines.map(l => {
    const c = splitCsvLine(l, sep);
    return { lat: toNum(c[1]), lon: toNum(c[0]), name: c[2] || '', notes: c[3] || '' };
  });
}

function centroid(geom) {
  if (!geom) return null;
  const t = geom.type, c = geom.coordinates;
  if (t === 'Point') return c;
  if (t === 'MultiPoint' || t === 'LineString') return c[0];
  if (t === 'Polygon' || t === 'MultiLineString') {
    const ring = c[0]; let x = 0, y = 0;
    for (const p of ring) { x += p[0]; y += p[1]; }
    return [x / ring.length, y / ring.length];
  }
  if (t === 'MultiPolygon') return centroid({ type: 'Polygon', coordinates: c[0] });
  if (t === 'GeometryCollection') return centroid(geom.geometries?.[0]);
  return null;
}

function parseJson(text) {
  const data = JSON.parse(text);
  // GeoJSON
  const feats = data.type === 'FeatureCollection' ? data.features : data.type === 'Feature' ? [data] : null;
  if (feats) {
    const keys = new Set();
    for (const ft of feats.slice(0, 50)) Object.keys(ft.properties || {}).forEach(k => keys.add(k));
    const f = pickFields([...keys]);
    return feats.map(ft => recordToPoint(ft.properties || {}, f, centroid(ft.geometry)));
  }
  // array di record (export JSON di Opendatasoft, CKAN, Socrata…)
  const rows = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : Array.isArray(data.records) ? data.records.map(r => r.fields || r.record?.fields || r) : null;
  if (!rows) return [];
  const keys = new Set();
  for (const r of rows.slice(0, 50)) Object.keys(r || {}).forEach(k => keys.add(k));
  const f = pickFields([...keys]);
  return rows.map(r => recordToPoint(r || {}, f, r?.geometry?.coordinates || r?.geo_shape?.geometry?.coordinates));
}

export function guessCategory(text) {
  if (RE_CAMP.test(text) && !RE_SOSTA.test(text)) return 'campeggio';
  if (/(scarico|dump|vidange|entsorgung|ver\s*sorgung)/i.test(text) && !/(sosta|stellplatz)/i.test(text)) return 'scarico';
  return 'area_camper';
}

// ---------- file di CamperOnLine.it ----------
// I nomi iniziano con i codici del sito: [AA] area attrezzata, [PS] punto sosta,
// [CS] camper service, [AU] area di servizio autostradale (anche combinati: [PS+CS]).
// I servizi sono un elenco fisso nel campo <cmt>.
const COL_CODES = { AA: 'area attrezzata', PS: 'punto sosta', CS: 'camper service', AU: 'area di servizio' };
const isCamperOnLine = text => /creator="CamperOnLine/i.test(text.slice(0, 1500));

// Testo codificato due volte alla fonte ("MÃ¼nchberg" invece di "Münchberg"): si ripara.
function fixMojibake(t) {
  t = String(t || '');
  if (!/[ÃÂÅ][\u0080-\u00BF]/.test(t)) return t;
  try {
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from([...t].map(c => c.charCodeAt(0) & 0xff)));
    return [...t].every(c => c.charCodeAt(0) < 256) ? fixed : t;
  } catch { return t; }
}

function camperOnLinePoint(p) {
  p = { ...p, name: fixMojibake(p.name), cmt: fixMojibake(p.cmt), city: fixMojibake(p.city), address: fixMojibake(p.address) };
  const m = String(p.name || '').match(/^\s*\[([A-Z+]*)\]\s*/);
  const codes = m ? m[1].split('+').filter(c => COL_CODES[c]) : [];
  const name = m ? p.name.slice(m[0].length).trim() : p.name;
  const srv = new Set(String(p.cmt || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const has = (...k) => k.some(x => srv.has(x));
  const category = codes.length && codes.every(c => c === 'CS') ? 'scarico' : 'area_camper';
  const tags = {};
  if (has('a pagamento')) tags.fee = 'yes';
  if (has('allacciamento elettrico')) tags.power = 'yes';
  if (has('carico acqua')) tags.water = 'yes';
  if (has('scarico pozzetto', 'scarico cassetta wc')) tags.dump = 'yes';
  if (has('servizi igienici con wc')) tags.toilets = 'yes';
  if (has('docce calde', 'docce fredde')) tags.shower = 'yes';
  if (has('wi-fi')) tags.internet = 'yes';
  if (p.address) tags.address = p.address;
  const other = [...srv].filter(x => !['a pagamento', 'allacciamento elettrico', 'carico acqua', 'scarico pozzetto', 'scarico cassetta wc',
    'servizi igienici con wc', 'docce calde', 'docce fredde', 'wi-fi'].includes(x));
  const kind = codes.map(c => COL_CODES[c]).join(' + ');
  return {
    ...p,
    name: name || (kind ? kind[0].toUpperCase() + kind.slice(1) : 'Area sosta') + (p.city ? ` ${p.city}` : ''),
    notes: [kind, other.join(', ')].filter(Boolean).join(' · '),
    category, tags
  };
}

// Alcuni punti dei file CamperOnLine hanno la latitudine troncata (es. 2.57 invece di 42.57)
// o uguale alla longitudine: si scartano quelli fuori dall'Europa e dintorni.
const inEuropeArea = p => p.lat !== p.lon && p.lat >= 27 && p.lat <= 72 && p.lon >= -32 && p.lon <= 45;

export function parsePoiFile(filename, text, { category } = {}) {
  const ext = (filename.split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
  const head = text.slice(0, 2000).trimStart();
  let pts;
  const col = isCamperOnLine(text);
  let skipped = 0;
  if (ext === 'gpx' || /<gpx[\s>]/i.test(head)) pts = parseGpx(text);
  else if (ext === 'kml' || /<kml[\s>]/i.test(head)) pts = parseKml(text);
  else if (/^(geo)?json$/.test(ext) || head.startsWith('{') || head.startsWith('[')) pts = parseJson(text);
  else pts = parseCsv(text);
  if (col) {
    const before = pts.length;
    pts = pts.filter(p => Number.isFinite(p.lat) && inEuropeArea(p)).map(camperOnLinePoint);
    skipped = before - pts.length;
  }
  const out = pts
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0))
    .map(p => ({ lat: p.lat, lon: p.lon, name: String(p.name || '').slice(0, 200), notes: String(p.notes || '').slice(0, 2000),
      website: String(p.website || '').slice(0, 300), phone: String(p.phone || '').slice(0, 60),
      ...(p.tags && Object.keys(p.tags).length ? { tags: p.tags } : {}),
      category: category || p.category || guessCategory(`${p.name} ${p.kindHint || ''} ${filename}`) }));
  out.skipped = skipped;
  out.source = col ? 'camperonline' : '';
  return out;
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
    if (p.acsi && !hit.acsi) hit.acsi = p.acsi;
  }
  return out;
}
