// Prezzi dei carburanti in Italia: dati aperti del Ministero delle Imprese e del Made in Italy
// (Osservatorio prezzi carburanti, licenza IODL 2.0). Ogni giorno escono due file:
// l'anagrafica dei distributori (con le coordinate) e i prezzi comunicati alle 8 del giorno prima.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { haversine, pointsEvery } from './sources.js';

export const MIMIT_STATIONS = process.env.MIMIT_STATIONS_URL || 'https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv';
export const MIMIT_PRICES = process.env.MIMIT_PRICES_URL || 'https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv';
export const FUELS = { gasolio: 'Gasolio', benzina: 'Benzina', gpl: 'GPL', metano: 'Metano' };

// Una riga CSV con separatore | (dal 10/02/2026) oppure ; (file precedenti).
function splitRow(line, sep) {
  if (sep === '|') return line.split('|').map(s => s.trim());
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === sep) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// Righe con intestazione: si salta la prima riga "Estrazione del …" se c'è.
function* rows(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let head = null, sep = '|', extracted = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!head) {
      if (/^estrazione/i.test(line)) { extracted = (line.match(/\d{4}-\d{2}-\d{2}/) || [''])[0]; continue; }
      sep = line.includes('|') ? '|' : ';';
      head = splitRow(line, sep).map(h => h.toLowerCase().replace(/\s+/g, ''));
      yield { header: head, extracted };
      continue;
    }
    const c = splitRow(line, sep);
    yield Object.fromEntries(head.map((h, i) => [h, c[i]]));
  }
}

export function fuelKey(desc) {
  const d = String(desc || '').toLowerCase().trim();
  if (d === 'gasolio' || d === 'diesel') return 'gasolio';
  if (d === 'benzina') return 'benzina';
  if (d === 'gpl') return 'gpl';
  if (d === 'metano' || d === 'gnc') return 'metano';
  if (/gpl/.test(d)) return 'gpl';
  if (/metano|gnl|l-gnc/.test(d)) return 'metano';
  return null;       // carburanti speciali (premium, blue…): si tengono solo quelli standard
}

export function parseMimit(stationsText, pricesText) {
  const stations = new Map();
  let extracted = '';
  for (const r of rows(stationsText)) {
    if (r.header) { extracted = r.extracted || extracted; continue; }
    const lat = parseFloat(String(r.latitudine || '').replace(',', '.')), lon = parseFloat(String(r.longitudine || '').replace(',', '.'));
    // coordinate facoltative e non sempre verificate: si tengono solo quelle plausibili per l'Italia
    if (!(lat > 35 && lat < 47.3 && lon > 6 && lon < 19)) continue;
    stations.set(r.idimpianto, {
      id: r.idimpianto, name: r.nomeimpianto || '', brand: r.bandiera || '', manager: r.gestore || '',
      type: r.tipoimpianto || '', address: [r.indirizzo, r.comune, r.provincia].filter(Boolean).join(', '),
      lat, lon, p: {}
    });
  }
  let pricesDate = '';
  for (const r of rows(pricesText)) {
    if (r.header) { pricesDate = r.extracted || ''; continue; }
    const s = stations.get(r.idimpianto); if (!s) continue;
    const k = fuelKey(r.desccarburante); if (!k) continue;
    const price = parseFloat(String(r.prezzo || '').replace(',', '.'));
    if (!(price > 0.3 && price < 5)) continue;
    const self = r.isself === '1';
    const slot = (s.p[k] ||= {});
    const field = self ? 'self' : 'servito';
    if (!slot[field] || price < slot[field]) slot[field] = price;
    slot.at = r.dtcomu || slot.at;
  }
  // senza prezzi non servono
  for (const [id, s] of stations) if (!Object.keys(s.p).length) stations.delete(id);
  return { stations: [...stations.values()], extracted, pricesDate };
}

export function createFuel({ cacheDir, userAgent }) {
  const file = path.join(cacheDir, 'carburanti.json');
  let data = null, loading = null, grid = null;

  function index(stations) {
    grid = new Map();
    for (const s of stations) {
      const k = `${Math.floor(s.lat * 10)}_${Math.floor(s.lon * 10)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }
  }
  async function download(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': userAgent } });
      if (!r.ok) throw new Error(`MIMIT ha risposto ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const text = buf.toString('utf8');
      return text.includes('�') ? buf.toString('latin1') : text;
    } finally { clearTimeout(t); }
  }
  // dati vecchi: i file escono ogni mattina con i prezzi del giorno prima
  const stale = d => !d || Date.now() - d.fetchedAt > 20 * 3600e3;

  async function refresh() {
    const [st, pr] = await Promise.all([download(MIMIT_STATIONS), download(MIMIT_PRICES)]);
    const parsed = parseMimit(st, pr);
    if (parsed.stations.length < 100 && !process.env.MIMIT_STATIONS_URL) throw new Error('file MIMIT incompleti');
    data = { ...parsed, fetchedAt: Date.now() };
    index(data.stations);
    await fs.mkdir(cacheDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
    return data;
  }

  async function get() {
    if (!data) {
      try { data = JSON.parse(await fs.readFile(file, 'utf8')); index(data.stations); } catch { data = null; }
    }
    if (!stale(data)) return { data, warning: '' };
    loading ||= refresh().finally(() => { loading = null; });
    try { return { data: await loading, warning: '' }; }
    catch (e) {
      if (data) return { data, warning: `prezzi non aggiornati (${e.message}): uso quelli del ${new Date(data.fetchedAt).toLocaleDateString('it-IT')}` };
      throw new Error(`prezzi carburante non disponibili: ${e.message}`);
    }
  }

  // Distributori con quel carburante lungo il percorso (o vicino a un punto), con la posizione in km.
  async function search({ line, center, radius, fuel }) {
    const { data: d, warning } = await get();
    const near = [];
    const cells = new Set();
    const addCells = (la, lo, r) => {
      const dl = r / 111000 + 0.1, dn = r / (111000 * Math.cos(la * Math.PI / 180)) + 0.1;
      for (let a = Math.floor((la - dl) * 10); a <= Math.floor((la + dl) * 10); a++)
        for (let b = Math.floor((lo - dn) * 10); b <= Math.floor((lo + dn) * 10); b++) cells.add(`${a}_${b}`);
    };
    let marks = null;
    if (line) {
      marks = pointsEvery(line, 1000);
      let acc = 0; marks = marks.map((p, i) => { if (i) acc += haversine(marks[i - 1], p); return { p, km: acc / 1000 }; });
      for (const m of marks.filter((_, i) => i % 5 === 0)) addCells(m.p[0], m.p[1], radius + 5000);
    } else addCells(center[0], center[1], radius);
    for (const c of cells) for (const s of grid?.get(c) || []) {
      const pr = s.p[fuel]; if (!pr) continue;
      let off = Infinity, km = 0;
      if (marks) { for (const m of marks) { const dd = haversine(m.p, [s.lat, s.lon]); if (dd < off) { off = dd; km = m.km; } } }
      else off = haversine(center, [s.lat, s.lon]);
      if (off > radius) continue;
      near.push({ ...s, price: pr.self ?? pr.servito, self: pr.self ?? null, servito: pr.servito ?? null, priceAt: pr.at || '', offKm: +(off / 1000).toFixed(1), routeKm: Math.round(km), p: undefined });
    }
    const prices = near.map(s => s.price).sort((a, b) => a - b);
    const stats = prices.length ? {
      min: prices[0], max: prices.at(-1),
      median: prices[prices.length >> 1],
      avg: +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3)
    } : null;
    return { stations: near, stats, fuel, warning, updated: d.fetchedAt, pricesDate: d.pricesDate || d.extracted || '' };
  }

  return { search, get };
}
