// Da indirizzo a coordinate, per i punti delle mappe che non hanno la posizione.
// Nominatim (OpenStreetMap) per primo; se non trova nulla si riprova con versioni
// semplificate dell'indirizzo e poi con Photon, che tollera meglio i nomi scritti male.
// Una richiesta al secondo per tutto il server, come chiedono i due servizi.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const STREET = /^(via|viale|v\.le|piazza|p\.zza|piazzale|corso|largo|strada|str\.|località|loc\.?|contrada|c\.da|frazione|fraz\.?|sp|ss|sr|lungomare|lungolago|vicolo|borgo|rue|avenue|calle|carrer|stra(ss|ß)e)\b/i;
const COUNTRIES = /\b(italia|italy|francia|france|spagna|españa|spain|germania|deutschland|austria|svizzera|schweiz|suisse|slovenia|croazia|portogallo|portugal|grecia)\b/i;
const IT_BOX = { s: 35.4, n: 47.2, w: 6.5, e: 18.7 };
const inItaly = ([la, lo]) => la >= IT_BOX.s && la <= IT_BOX.n && lo >= IT_BOX.w && lo <= IT_BOX.e;
const GENERIC = /^(parcheggio|parking|area( di)? sosta|area camper|sosta|camper ?service|aa|ps|cs)$/i;

const BACKOFF_MS = Number(process.env.GEO_BACKOFF_MS || 15000);   // attesa dopo un "troppe richieste"
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = t => String(t || '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '').trim();

// Versioni via via più semplici dello stesso indirizzo.
export function addressVariants(address, name, country) {
  const out = [];
  const add = v => { v = norm(v); if (v.length >= 2 && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v); };
  const raw = norm(address);
  // solo la via, senza paese ("Via Lepri"): da sola indicherebbe un posto a caso, si prova solo col nome
  const streetOnly = !raw.includes(',') && STREET.test(raw);
  if (!streetOnly) add(raw);
  const clean = norm(raw
    .replace(/\([^)]*\)/g, ' ')                       // note tra parentesi
    .replace(/\b\d{5}\b/g, ' ')                       // CAP
    .replace(/\s+[A-Z]{2}(?=\s*(,|$))/g, ' ')         // sigla della provincia: "Borso del Grappa TV"
    .replace(/\b(loc\.?|località)\s+/gi, ' '));
  if (!streetOnly) add(clean);
  // "Cavriana -Piazza S. Sebastiano", "Peschiera del Garda - alla fine di Via …"
  const beforeDash = clean.split(/\s[-–—]\s?|\s?[-–—]\s/)[0];
  if (!streetOnly || !STREET.test(beforeDash)) add(beforeDash);
  // senza la via: "Via Molinetto, Borso del Grappa, Italia" → "Borso del Grappa, Italia"
  const parts = clean.split(',').map(norm).filter(Boolean);
  if (parts.length > 1 && STREET.test(parts[0])) add(parts.slice(1).join(', '));
  if (parts.length > 2) add(parts.slice(-2).join(', '));
  // il nome del punto, se dice dove si trova
  const nm = norm(String(name || '').replace(/\([^)]*\)/g, ' ').split(/\s[-–—]\s?|\s?[-–—]\s/)[0]);
  if (nm && !GENERIC.test(nm) && nm.toLowerCase() !== raw.toLowerCase()) add(nm);
  // il paese, se la mappa è di un solo paese e l'indirizzo non lo dice
  if (country) for (const v of [...out]) if (!COUNTRIES.test(v)) add(`${v}, ${country}`);
  return out.slice(0, 7);
}

export function createGeocoder({ cacheFile, nominatimUrl, photonUrl, userAgent, fetchJson }) {
  let cache = null, saveTimer = null, chain = Promise.resolve(), last = 0;

  async function load() {
    if (!cache) {
      cache = new Map();
      try {
        const old = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        // si tengono solo i risultati positivi: i "non trovato" della 2.3.0 erano spesso errori del servizio
        for (const [k, v] of Object.entries(old)) if (Array.isArray(v) || (k.startsWith('nf|') && typeof v === 'number')) cache.set(k, v);
      } catch { /* cache vuota */ }
    }
    return cache;
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(cache)));
        await fs.rename(tmp, cacheFile);
      } catch (e) { console.error('Cache indirizzi non salvata:', e.message); }
    }, 2000);
  }
  const key = t => t.toLowerCase().replace(/\s+/g, ' ').trim();

  // Una richiesta alla volta, almeno 1,1 s tra l'una e l'altra; se il servizio è occupato si aspetta e si riprova.
  function throttled(url) {
    const run = chain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = 1100 - (Date.now() - last);
        if (wait > 0) await sleep(wait);
        last = Date.now();
        try { return await fetchJson(url, { headers: { 'User-Agent': userAgent } }, 20000); }
        catch (e) {
          const busy = !e.status || e.status === 429 || e.status >= 500 || e.status === 403;
          if (!busy || attempt >= 2) { e.unavailable = busy; throw e; }
          await sleep((attempt === 0 ? 1 : 3) * BACKOFF_MS);
        }
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  async function nominatim(q, countryCode) {
    const k = 'n|' + (countryCode || '') + '|' + key(q);
    if (cache.has(k)) return cache.get(k);
    const d = await throttled(`${nominatimUrl}/search?format=jsonv2&limit=1&accept-language=it${countryCode ? `&countrycodes=${countryCode}` : ''}&q=${encodeURIComponent(q)}`);
    const r = Array.isArray(d) && d[0] ? [Number(d[0].lat), Number(d[0].lon)] : null;
    if (r) { cache.set(k, r); save(); }
    return r;
  }
  async function photon(q, bias) {
    if (!photonUrl) return null;
    const k = 'p|' + key(q);
    if (cache.has(k)) return cache.get(k);
    const b = bias ? `&lat=${bias[0].toFixed(3)}&lon=${bias[1].toFixed(3)}` : '';
    const d = await throttled(`${photonUrl}/api/?limit=1&q=${encodeURIComponent(q)}${b}`);
    const c = d?.features?.[0]?.geometry?.coordinates;
    const r = c ? [Number(c[1]), Number(c[0])] : null;
    if (r) { cache.set(k, r); save(); }
    return r;
  }

  // Restituisce [lat, lon], oppure null se nessuna versione dell'indirizzo è stata trovata.
  // Lancia un errore con .unavailable = true se il servizio non risponde.
  async function geocode({ address, name }, { country, bias } = {}) {
    await load();
    const nfKey = 'nf|' + key(address);
    if (Date.now() - (cache.get(nfKey) || 0) < 30 * 864e5) return null;
    // risultati della versione 2.3.0 (stesso indirizzo esatto)
    const legacy = cache.get(key(address));
    if (Array.isArray(legacy)) return legacy;
    const italy = country === 'Italia';
    const ok = r => r && (!italy || inItaly(r));
    // con l'Italia basta il filtro countrycodes=it: niente varianti con ", Italia" in coda
    const vars = addressVariants(address, name, italy ? '' : country);
    let requests = 0;
    for (const v of vars) {
      if (requests >= 5) break;
      requests++;
      const r = await nominatim(v, italy ? 'it' : '');
      if (ok(r)) return r;
    }
    for (const v of [vars[1] || vars[0], vars[2]].filter(Boolean).slice(0, 2)) {
      const r = await photon(v, bias);
      if (ok(r)) return r;
    }
    cache.set(nfKey, Date.now()); save();
    return null;
  }

  return { geocode };
}

// Paese prevalente dei punti già posizionati di una mappa (oggi riconosce solo l'Italia).
export function dominantCountry(points, pending = []) {
  const pts = points.filter(p => Number.isFinite(p.lat));
  if (pts.length >= 3 && pts.filter(p => inItaly([p.lat, p.lon])).length / pts.length >= 0.8) return 'Italia';
  // mappe senza coordinate: lo dicono gli indirizzi ("…, 31030 Borso del Grappa TV, Italia")
  if (pending.length >= 3 && pending.filter(p => /\bitalia\b|\b\d{5}\s+[^,]+\s[A-Z]{2}\b/i.test(p.address)).length / pending.length >= 0.6) return 'Italia';
  return '';
}

export function centerOf(points) {
  const pts = points.filter(p => Number.isFinite(p.lat));
  if (!pts.length) return null;
  const lats = pts.map(p => p.lat).sort((a, b) => a - b), lons = pts.map(p => p.lon).sort((a, b) => a - b);
  return [lats[lats.length >> 1], lons[lons.length >> 1]];
}
