// Suddivide il percorso in giornate di guida (massimo km e/o ore al giorno) e indica
// dove serve una notte che il viaggio non prevede ancora.

import { haversine, pointsEvery, lineLength } from './sources.js';
import { tollKmBetween } from './tolls.js';

// Posizione di ogni tappa lungo la linea del percorso (indici crescenti).
function stopIndexes(geometry, stops) {
  const idx = [0];
  let from = 0;
  for (let s = 1; s < stops.length - 1; s++) {
    let best = from, bd = Infinity;
    // la tappa successiva sta più avanti: si cerca solo in avanti
    for (let i = from; i < geometry.length; i++) {
      const d = haversine(geometry[i], [stops[s].lat, stops[s].lon]);
      if (d < bd) { bd = d; best = i; }
      if (bd < 3000 && d > bd + 40000) break;   // trovata e superata
    }
    idx.push(best); from = best;
  }
  idx.push(geometry.length - 1);
  return idx;
}

export function planDays({ geometry, legs, stops, startDate, maxKm, maxHours, tolls, routeDistance }) {
  geometry = geometry.slice();
  if (!Array.isArray(geometry) || geometry.length < 2 || !Array.isArray(stops) || stops.length < 2) return { days: [], nights: [] };
  const limKm = maxKm > 0 ? maxKm * 1000 : Infinity;
  const limS = maxHours > 0 ? maxHours * 3600 : Infinity;
  // linea con pochi punti: la si infittisce (un punto ogni km circa), altrimenti le notti cadono sulle tappe
  if (lineLength(geometry) / geometry.length > 1500) geometry = pointsEvery(geometry, 1000);
  const sIdx = stopIndexes(geometry, stops);

  // distanza e tempo progressivi su ogni punto della linea; il tempo di ogni tratto
  // viene distribuito in proporzione alla lunghezza
  const D = [0], T = [0];
  for (let i = 1; i < geometry.length; i++) D.push(D[i - 1] + haversine(geometry[i - 1], geometry[i]));
  const rate = new Array(geometry.length).fill(0);
  for (let j = 0; j < sIdx.length - 1; j++) {
    const a = sIdx[j], b = sIdx[j + 1];
    const len = Math.max(1, D[b] - D[a]);
    const r = (legs?.[j]?.duration || len / 18) / len;    // senza tempi: 65 km/h
    for (let i = a + 1; i <= b; i++) rate[i] = r;
  }
  for (let i = 1; i < geometry.length; i++) T.push(T[i - 1] + (D[i] - D[i - 1]) * rate[i]);

  const days = [];
  const nights = [];                 // notti da scegliere
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startDate || '') ? new Date(startDate + 'T12:00:00Z') : null;   // mezzogiorno UTC: niente salti di fuso
  const dateOf = n => start ? new Date(start.getTime() + n * 864e5).toISOString().slice(0, 10) : '';
  let dayN = 0;
  let cur = 0;                       // indice della linea da cui parte la giornata
  let curName = stops[0].name;
  const stopAt = i => { const k = sIdx.indexOf(i); return k >= 0 ? k : -1; };

  // tappe con notti: lì la giornata finisce comunque
  const overnight = [];
  for (let s = 1; s < stops.length; s++) if (s === stops.length - 1 || (stops[s].nights || 0) > 0) overnight.push(s);

  for (const s of overnight) {
    const end = sIdx[s];
    // finché il resto fino alla prossima notte prevista è troppo lungo, serve una notte in mezzo
    let guard = 0;
    while ((D[end] - D[cur] > limKm * 1.08 || T[end] - T[cur] > limS * 1.08) && guard++ < 60) {
      let k = cur + 1;
      while (k < end && D[k] - D[cur] < limKm && T[k] - T[cur] < limS) k++;
      // tappa precedente al punto: la nuova notte si inserisce dopo di lei
      let after = 0;
      for (let q = 0; q < sIdx.length; q++) if (sIdx[q] <= k) after = q;
      const night = {
        day: dayN + 1, date: dateOf(dayN), index: k, point: geometry[k],
        km: Math.round((D[k] - D[cur]) / 1000), hours: +((T[k] - T[cur]) / 3600).toFixed(1),
        fromName: curName, insertAt: Math.min(after + 1, stops.length - 1),
        routeKm: Math.round(D[k] / 1000)
      };
      nights.push(night);
      days.push({ day: dayN + 1, date: dateOf(dayN), from: curName, to: null, night: nights.length - 1,
        km: night.km, hours: night.hours, fromIndex: cur, toIndex: k });
      dayN++;
      cur = k; curName = 'notte da scegliere';
    }
    days.push({ day: dayN + 1, date: dateOf(dayN), from: curName, to: stops[s].name, stop: s,
      km: Math.round((D[end] - D[cur]) / 1000), hours: +((T[end] - T[cur]) / 3600).toFixed(1), fromIndex: cur, toIndex: end });
    dayN++;
    // giorni fermi nella stessa tappa
    const extra = s === stops.length - 1 ? 0 : Math.max(0, (stops[s].nights || 0) - 1);
    for (let e = 0; e < extra; e++) { days.push({ day: dayN + 1, date: dateOf(dayN), from: stops[s].name, to: stops[s].name, stop: s, km: 0, hours: 0, rest: true }); dayN++; }
    cur = end; curName = stops[s].name;
  }
  // punti per navigare ogni giornata: partenza, tappe di passaggio, arrivo
  const ptAt = i => { const k = sIdx.indexOf(i); return k >= 0 ? [stops[k].lat, stops[k].lon] : geometry[i]; };
  // i tratti a pedaggio sono in metri del percorso calcolato: si riportano sulla linea qui
  const k = routeDistance > 0 && D.at(-1) > 0 ? routeDistance / D.at(-1) : 1;
  for (const d of days) {
    if (d.rest) continue;
    if (tolls) { const tk = tollKmBetween(tolls, D[d.fromIndex] * k, D[d.toIndex] * k); d.tollKm = Math.round(tk.it); d.tollKmAbroad = Math.round(tk.abroad); }
    d.nav = [ptAt(d.fromIndex)];
    for (let k = 1; k < stops.length - 1; k++) if (sIdx[k] > d.fromIndex && sIdx[k] < d.toIndex) d.nav.push([stops[k].lat, stops[k].lon]);
    d.nav.push(ptAt(d.toIndex));
    delete d.fromIndex; delete d.toIndex;
  }
  return { days, nights, totalKm: Math.round(D.at(-1) / 1000), totalHours: +(T.at(-1) / 3600).toFixed(1), cumKm: D, sIdx, geometry };
}

// Tratto di linea in cui cercare la notte: l'ultimo quarto della giornata e un poco oltre.
export function nightWindow(geometry, D, night, maxKm) {
  const back = Math.max(15000, (maxKm > 0 ? maxKm * 1000 : 200000) * 0.25);
  const ahead = 12000;
  const a = D[night.index] - back, b = D[night.index] + ahead;
  const line = [];
  for (let i = 0; i < geometry.length; i++) if (D[i] >= a && D[i] <= b) line.push(geometry[i]);
  if (line.length < 2) line.push(geometry[Math.max(0, night.index - 1)], geometry[Math.min(geometry.length - 1, night.index + 1)]);
  return line;
}

// Punteggio di un'area per la notte: vicina al punto ideale, con servizi, già scelta da te.
export function rankNight(pois, point, D, geometry, nightIndex) {
  const target = D[nightIndex];
  // posizione lungo il percorso del punto più vicino della linea (campionata)
  const step = Math.max(1, Math.floor(geometry.length / 4000));
  const along = p => {
    let best = Infinity, bi = 0;
    for (let i = 0; i < geometry.length; i += step) { const d = haversine(geometry[i], [p.lat, p.lon]); if (d < best) { best = d; bi = i; } }
    return { off: best, at: D[bi] };
  };
  return pois
    .filter(p => p.category === 'area_camper' || p.category === 'campeggio')
    .map(p => {
      const { off, at } = along(p);
      const t = p.tags || {};
      let score = 0;
      if (p.acsi) score += 30;
      if (p.mineId) score += 15;
      if (p.sources?.length > 1) score += 4;
      if (p.category === 'area_camper') score += 6;
      if (t.power === 'yes') score += 5;
      if (t.dump === 'yes') score += 5;
      if (t.water === 'yes') score += 3;
      if (t.fee === 'no') score += 4;
      if (p.name) score += 3;
      score -= Math.abs(at - target) / 1000 * 0.35;   // lontano dal punto della giornata
      score -= off / 1000 * 1.5;                       // deviazione dal percorso
      if (at > target) score -= (at - target) / 1000 * 0.2;   // oltre il limite pesa di più
      return { ...p, score: Math.round(score * 10) / 10, offKm: +(off / 1000).toFixed(1), deltaKm: Math.round((at - target) / 1000) };
    })
    .sort((a, b) => b.score - a.score);
}
