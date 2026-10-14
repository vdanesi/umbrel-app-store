// Tratti a pedaggio del percorso e stima del costo sulle autostrade italiane.
// Il servizio di percorso segnala le strade a pedaggio (dati OpenStreetMap); il costo è
// una stima a km: le tariffe vere cambiano da tratta a tratta e da concessionaria a concessionaria.

import { haversine } from './sources.js';

// €/km IVA compresa (2026). Classe A dagli esempi delle tratte ASPI (circa 8–9 € ogni 100 km);
// rapporti tra le classi dalla tabella 2026 SATAP A4 (B ≈ A × 1,02; 3 ≈ A × 1,28; 4 ≈ A × 2,0; 5 ≈ A × 2,4).
export const TOLL_RATES = { A: 0.085, B: 0.087, 3: 0.109, 4: 0.17, 5: 0.203 };
export const TOLL_CLASSES = ['A', 'B', '3', '4', '5'];   // (Object.keys metterebbe prima le cifre)

const IT_BOX = { s: 36.6, n: 47.1, w: 6.6, e: 18.6 };
// Italia "a grandi linee": per le autostrade a pedaggio basta (Svizzera, Austria e Slovenia usano la vignetta)
export const inItaly = ([la, lo]) => la >= IT_BOX.s && la <= IT_BOX.n && lo >= IT_BOX.w && lo <= IT_BOX.e && !(la > 45.8 && lo < 7.1) && !(lo > 13.9 && la > 45.45) && !(la > 43.4 && la < 44.3 && lo < 7.53);

// Unisce i tratti vicini (meno di 300 m di distanza) e scarta quelli minuscoli.
function merge(ranges) {
  ranges.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of ranges) {
    const last = out.at(-1);
    if (last && r[0] - last[1] < 300 && last[2] === r[2]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out.filter(r => r[1] - r[0] > 200).map(([a, b, it]) => [Math.round(a), Math.round(b), it ? 1 : 0]);
}

// OSRM con steps=true: ogni incrocio dice le classi della strada che segue ("toll", "motorway"…).
export function tollRangesFromOsrm(route) {
  const ranges = [];
  let base = 0;
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      const coords = (step.geometry?.coordinates || []).map(([lo, la]) => [la, lo]);
      const ints = step.intersections || [];
      if (coords.length < 2 || !ints.length) { base += step.distance || 0; continue; }
      // posizione di ogni incrocio lungo il passo
      const cum = [0];
      for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
      const scale = cum.at(-1) > 0 ? (step.distance || cum.at(-1)) / cum.at(-1) : 1;
      const posOf = loc => {
        const p = [loc[1], loc[0]]; let bi = 0, bd = Infinity;
        for (let i = 0; i < coords.length; i++) { const d = haversine(coords[i], p); if (d < bd) { bd = d; bi = i; } }
        return cum[bi] * scale;
      };
      const pos = ints.map(x => posOf(x.location));
      ints.forEach((x, i) => {
        if (!(x.classes || []).includes('toll')) return;
        const a = pos[i], b = i + 1 < ints.length ? pos[i + 1] : (step.distance || cum.at(-1) * scale);
        if (b > a) ranges.push([base + a, base + b, inItaly([x.location[1], x.location[0]])]);
      });
      base += step.distance || 0;
    }
  }
  return merge(ranges);
}

// OpenRouteService con extra_info tollways: intervalli di indici dei punti della linea.
export function tollRangesFromOrs(coords, values, totalDistance) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const scale = cum.at(-1) > 0 && totalDistance ? totalDistance / cum.at(-1) : 1;
  const ranges = [];
  for (const [a, b, v] of values || []) {
    if (v !== 1 || !(b > a) || !coords[a] || !coords[b]) continue;
    ranges.push([cum[a] * scale, cum[b] * scale, inItaly(coords[Math.floor((a + b) / 2)])]);
  }
  return merge(ranges);
}

// km a pedaggio (in Italia e all'estero) fra due posizioni lungo il percorso, in metri
export function tollKmBetween(tolls, from, to) {
  let it = 0, abroad = 0;
  for (const [a, b, isIt] of tolls || []) {
    const o = Math.min(b, to) - Math.max(a, from);
    if (o > 0) isIt ? (it += o) : (abroad += o);
  }
  return { it: it / 1000, abroad: abroad / 1000 };
}
