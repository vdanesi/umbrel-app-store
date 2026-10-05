/* Camper Planner — client */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x'.repeat(32).replace(/x/g, () => (Math.random() * 16 | 0).toString(16)));

const KINDS = { tappa: 'Tappa', sosta: 'Area sosta', campeggio: 'Campeggio', visita: 'Visita' };
const POI_TYPES = {
  area_camper: { label: 'Aree camper', letter: 'A', kind: 'sosta' },
  campeggio: { label: 'Campeggi', letter: 'C', kind: 'campeggio' },
  scarico: { label: 'Carico/scarico', letter: 'S', kind: 'sosta' },
  acqua: { label: 'Acqua', letter: 'W', kind: 'sosta' },
  gpl: { label: 'GPL', letter: 'G', kind: 'tappa' }
};
const EXPENSE_CATS = {
  carburante: 'Carburante', pedaggi: 'Pedaggi', sosta: 'Aree sosta', campeggio: 'Campeggi',
  traghetto: 'Traghetti', spesa: 'Spesa', ristoranti: 'Ristoranti', visite: 'Visite e biglietti',
  manutenzione: 'Manutenzione', altro: 'Altro'
};

const fmtEur = n => (n || 0).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const fmtKm = m => `${Math.round((m || 0) / 1000).toLocaleString('it-IT')} km`;
const fmtDur = s => { s = Math.round((s || 0) / 60); const h = Math.floor(s / 60), m = s % 60; return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };
const parseDate = d => { if (!d) return null; const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = d => d ? d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- stato ----------
const state = {
  trip: null,
  settings: null,
  dirty: false,
  saving: false,
  pois: [],
  routeSeq: 0
};

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch('api' + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.innerHTML = (isErr ? '<span class="err">✘</span> ' : '<span class="ok">✔</span> ') + esc(msg);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 2500);
}

function setSaveStatus(kind) {
  const el = $('#saveStatus');
  el.innerHTML = {
    dirty: '<span class="c-yellow">●</span> modifiche',
    saving: '<span class="c-cyan">…</span> salvataggio',
    saved: '<span class="ok">✔</span> salvato',
    error: '<span class="err">✘</span> non salvato'
  }[kind] || '';
}

// ---------- calcoli ----------
function stopDates(trip) {
  const start = parseDate(trip.startDate);
  let acc = 0;
  return trip.stops.map(s => {
    const arr = start ? addDays(start, acc) : null;
    acc += s.nights;
    return { arrive: arr, leave: start ? addDays(start, acc) : null, dayIndex: acc - s.nights };
  });
}
function totals(trip) {
  const nights = trip.stops.reduce((a, s) => a + (s.nights || 0), 0);
  const distance = trip.route?.distance || 0;
  const v = state.settings?.vehicle || {};
  const fuelL = distance / 1000 * (v.consumption || 0) / 100;
  const fuelCost = fuelL * (state.settings?.fuelPrice || 0);
  const spent = trip.expenses.reduce((a, e) => a + (e.amount || 0), 0);
  const spentFuel = trip.expenses.filter(e => e.category === 'carburante').reduce((a, e) => a + e.amount, 0);
  return { nights, days: trip.stops.length ? nights + 1 : 0, distance, duration: trip.route?.duration || 0, fuelL, fuelCost, spent, spentFuel };
}
const routeSignature = trip => trip.stops.map(s => `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`).join(';');

// ---------- salvataggio ----------
let saveTimer;
function markDirty({ reroute = false } = {}) {
  state.dirty = true;
  setSaveStatus('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
  if (reroute) scheduleRoute();
  renderSummary();
}
async function save() {
  if (!state.trip || state.saving) { if (state.saving) saveTimer = setTimeout(save, 400); return; }
  state.saving = true; state.dirty = false;
  setSaveStatus('saving');
  try {
    const saved = await api(`/trips/${state.trip.id}`, { method: 'PUT', body: state.trip });
    state.trip.updatedAt = saved.updatedAt;
    setSaveStatus(state.dirty ? 'dirty' : 'saved');
  } catch (e) {
    setSaveStatus('error'); toast('Salvataggio non riuscito: ' + e.message, true);
    state.dirty = true;
  } finally { state.saving = false; }
}
window.addEventListener('beforeunload', e => { if (state.dirty) { save(); e.preventDefault(); } });

// ---------- navigazione ----------
function showHome() {
  if (state.dirty) save();
  state.trip = null;
  $('#homeView').hidden = false; $('#tripView').hidden = true; $('#tabTrip').hidden = true;
  $('#tabHome').classList.add('tab-active-home');
  setSaveStatus('');
  history.replaceState(null, '', '#');
  loadTrips();
}
async function openTrip(id) {
  try {
    state.trip = await api(`/trips/${id}`);
  } catch (e) { toast(e.message, true); return showHome(); }
  state.pois = [];
  delete $('#poiScope').dataset.touched;
  $('#homeView').hidden = true; $('#tripView').hidden = false; $('#tabTrip').hidden = false;
  history.replaceState(null, '', '#' + id);
  initMap();
  setTimeout(() => map.invalidateSize(), 0);
  fillTripForm();
  renderAll();
  fitAll();
  setSaveStatus('saved');
  if (state.trip.stops.length >= 2 && state.trip.route?.signature !== routeSignature(state.trip)) scheduleRoute(0);
}

// ---------- home ----------
async function loadTrips() {
  const list = $('#tripList');
  try {
    const trips = await api('/trips');
    if (!trips.length) {
      list.innerHTML = '<p class="empty">Nessun viaggio ancora. Crea il primo con <span class="c-magenta">+ Nuovo viaggio</span>.</p>';
      return;
    }
    list.innerHTML = trips.map(t => {
      const start = parseDate(t.startDate);
      const when = start ? `${fmtDate(start)} → ${fmtDate(addDays(start, t.nights))}` : 'date da definire';
      const route = t.from ? `${esc(t.from)}${t.to && t.to !== t.from ? ' → ' + esc(t.to) : ''}` : '<span class="muted">nessuna tappa</span>';
      return `<div class="trip-row" data-id="${esc(t.id)}" tabindex="0" role="button">
        <span class="trip-title">${esc(t.name)}</span>
        <span class="trip-meta">${t.stops} tappe · ${t.nights} notti · ${fmtKm(t.distance)}</span>
        <span class="trip-sub">${route} <span class="muted">· ${when}${t.spent ? ' · speso ' + fmtEur(t.spent) : ''}</span></span>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<p class="empty err">✘ Impossibile leggere i viaggi: ${esc(e.message)}</p>`;
  }
}
$('#tripList').addEventListener('click', e => { const r = e.target.closest('.trip-row'); if (r) openTrip(r.dataset.id); });
$('#tripList').addEventListener('keydown', e => { const r = e.target.closest('.trip-row'); if (r && e.key === 'Enter') openTrip(r.dataset.id); });
$('#btnNewTrip').addEventListener('click', async () => {
  const t = await api('/trips', { method: 'POST', body: { name: 'Nuovo viaggio', startDate: isoDate(addDays(new Date(), 7)) } });
  openTrip(t.id);
});
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const t = await api('/trips', { method: 'POST', body: data });
    toast('Viaggio importato'); openTrip(t.id);
  } catch (err) { toast('File non valido: ' + err.message, true); }
});
$('#tabHome').addEventListener('click', showHome);
$('#tabTripClose').addEventListener('click', showHome);

// ---------- modulo viaggio ----------
function fillTripForm() {
  const t = state.trip;
  $('#tripName').value = t.name;
  $('#tripStart').value = t.startDate || '';
  $('#tripBudget').value = t.budget || '';
  $('#tripNotes').value = t.notes || '';
  $('#tabTripName').textContent = t.name;
  $('#expDate').value = t.startDate || isoDate(new Date());
}
$('#tripName').addEventListener('input', e => { state.trip.name = e.target.value; $('#tabTripName').textContent = e.target.value || 'Viaggio'; markDirty(); });
$('#tripStart').addEventListener('change', e => { state.trip.startDate = e.target.value; renderStops(); markDirty(); });
$('#tripBudget').addEventListener('input', e => { state.trip.budget = Number(e.target.value) || 0; renderDiary(); markDirty(); });
$('#tripNotes').addEventListener('input', e => { state.trip.notes = e.target.value; markDirty(); });

$$('.subtab').forEach(b => b.addEventListener('click', () => {
  $$('.subtab').forEach(x => x.classList.toggle('active', x === b));
  $$('.pane').forEach(p => (p.hidden = p.id !== 'pane-' + b.dataset.pane));
  if (b.dataset.pane === 'pois') { renderPoiScope(); loadCollection(); if (!state.catalog) loadCatalog(); }
  if (b.dataset.pane === 'diary') renderDiary();
}));

function renderAll() { renderSummary(); renderStops(); renderMapStops(); renderRoute(); renderDiary(); renderPoiScope(); renderPois(); }

function renderSummary() {
  const t = state.trip; if (!t) return;
  const tt = totals(t);
  const start = parseDate(t.startDate);
  const short = d => d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  $('#plDates').textContent = start ? `▣ ${short(start)} → ${short(addDays(start, tt.nights))}` : '▣ senza date';
  $('#plDays').textContent = `◷ ${tt.days} gg · ${tt.nights} nt`;
  $('#plKm').textContent = tt.distance ? `${fmtKm(tt.distance)} · ${fmtDur(tt.duration)}` : `${t.stops.length} tappe`;
  $('#powerline').title = `${$('#plDates').textContent}  ${$('#plDays').textContent}  ${$('#plKm').textContent}`;
}

// ---------- tappe ----------
function renderStops() {
  const t = state.trip;
  const dates = stopDates(t);
  const legs = t.route?.signature === routeSignature(t) ? t.route.legs : [];
  const ol = $('#stopList');
  if (!t.stops.length) {
    ol.innerHTML = '<li class="empty">Nessuna tappa. Cerca un luogo o fai clic sulla mappa.</li>';
    $('#routeInfo').innerHTML = '';
    return;
  }
  ol.innerHTML = t.stops.map((s, i) => {
    const d = dates[i];
    const dateTxt = d.arrive
      ? (s.nights ? `${fmtDate(d.arrive)} → ${fmtDate(d.leave)} · giorno ${d.dayIndex + 1}` : `${fmtDate(d.arrive)} · di passaggio`)
      : (s.nights ? `${s.nights} notti` : 'di passaggio');
    const leg = i < t.stops.length - 1
      ? `<div class="leg">${legs[i] ? `↓ ${fmtKm(legs[i].distance)} · ${fmtDur(legs[i].duration)} di guida` : '↓ …'}</div>` : '';
    return `<li class="stop" data-i="${i}" draggable="true">
      <div class="stop-head">
        <span class="drag" title="Trascina per riordinare">⋮⋮</span>
        <span class="badge k-${s.kind}">${i + 1}</span>
        <input class="stop-name" data-f="name" value="${esc(s.name)}" aria-label="Nome tappa">
        <button class="btn-icon" data-a="center" title="Mostra sulla mappa">◎</button>
        <button class="btn-icon" data-a="up" title="Su" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn-icon" data-a="down" title="Giù" ${i === t.stops.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn-icon" data-a="del" title="Elimina">✕</button>
      </div>
      <div class="stop-body">
        <span class="stop-dates">${dateTxt}${acsiBadge(s.acsi)}</span>
        <label>Tipo
          <select data-f="kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${k === s.kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label>Notti
          <span class="nights"><button type="button" data-a="n-">−</button><input type="number" min="0" max="365" data-f="nights" value="${s.nights}"><button type="button" data-a="n+">+</button></span>
        </label>
        ${s.kind === 'campeggio' || s.acsi ? `<label class="full acsi-field"><span><input type="checkbox" data-f="acsi" ${s.acsi ? 'checked' : ''}> CampingCard ACSI</span>
          <span class="acsi-price">tariffa a notte € <input type="number" min="0" step="0.5" data-f="acsiPrice" value="${s.acsi?.price ?? ''}" ${s.acsi ? '' : 'disabled'}></span></label>` : ''}
        <details class="notes full" ${s.notes ? 'open' : ''}>
          <summary>Note e diario della tappa</summary>
          <textarea data-f="notes" rows="3" placeholder="Prenotazione, cosa vedere, impressioni…">${esc(s.notes)}</textarea>
        </details>
      </div>
    </li>${leg}`;
  }).join('');
  renderRouteInfo();
}

function renderRouteInfo() {
  const r = state.trip.route;
  const el = $('#routeInfo');
  if (state.trip.stops.length < 2) { el.innerHTML = '<span class="muted">Aggiungi almeno due tappe per calcolare il percorso.</span>'; return; }
  if (!r || r.signature !== routeSignature(state.trip)) { el.innerHTML = '<span class="muted">Percorso da ricalcolare…</span>'; return; }
  el.innerHTML = `Totale <span class="c-magenta">${fmtKm(r.distance)}</span> · <span class="c-magenta">${fmtDur(r.duration)}</span> di guida
    <br><span class="muted">via ${esc(r.provider)}</span>${r.warning ? `<br><span class="warn">${esc(r.warning)}</span>` : ''}`;
}

const stopList = $('#stopList');
stopList.addEventListener('input', e => {
  const li = e.target.closest('.stop'); if (!li) return;
  const s = state.trip.stops[+li.dataset.i];
  const f = e.target.dataset.f;
  if (f === 'name') { s.name = e.target.value; renderMapStops(); markDirty(); }
  if (f === 'notes') { s.notes = e.target.value; markDirty(); }
});
stopList.addEventListener('change', e => {
  const li = e.target.closest('.stop'); if (!li) return;
  const s = state.trip.stops[+li.dataset.i];
  const f = e.target.dataset.f;
  if (f === 'kind') { s.kind = e.target.value; renderStops(); renderMapStops(); markDirty(); }
  if (f === 'nights') { s.nights = Math.max(0, Math.min(365, parseInt(e.target.value, 10) || 0)); renderStops(); markDirty(); }
  if (f === 'acsi') { s.acsi = e.target.checked ? { price: s.acsi?.price ?? null } : null; renderStops(); renderDiary(); markDirty(); }
  if (f === 'acsiPrice') { const n = parseFloat(e.target.value); s.acsi = { price: Number.isFinite(n) ? n : null }; renderStops(); renderDiary(); markDirty(); }
});
stopList.addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const li = b.closest('.stop'); const i = +li.dataset.i;
  const stops = state.trip.stops;
  switch (b.dataset.a) {
    case 'center': map.setView([stops[i].lat, stops[i].lon], Math.max(map.getZoom(), 12)); stopMarkers[i]?.openPopup(); return;
    case 'up': [stops[i - 1], stops[i]] = [stops[i], stops[i - 1]]; break;
    case 'down': [stops[i + 1], stops[i]] = [stops[i], stops[i + 1]]; break;
    case 'del': if (!confirm(`Eliminare la tappa "${stops[i].name}"?`)) return; stops.splice(i, 1); break;
    case 'n-': stops[i].nights = Math.max(0, stops[i].nights - 1); renderStops(); return markDirty();
    case 'n+': stops[i].nights = Math.min(365, stops[i].nights + 1); renderStops(); return markDirty();
  }
  afterStopsChanged();
});

// trascina per riordinare
let dragFrom = null;
stopList.addEventListener('dragstart', e => {
  const li = e.target.closest('.stop'); if (!li || e.target.matches('input,textarea,select')) return;
  dragFrom = +li.dataset.i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
});
stopList.addEventListener('dragover', e => {
  if (dragFrom === null) return;
  e.preventDefault();
  $$('.stop.drop-before').forEach(x => x.classList.remove('drop-before'));
  e.target.closest('.stop')?.classList.add('drop-before');
});
stopList.addEventListener('dragend', () => { dragFrom = null; $$('.stop').forEach(x => x.classList.remove('dragging', 'drop-before')); });
stopList.addEventListener('drop', e => {
  e.preventDefault();
  const li = e.target.closest('.stop'); if (dragFrom === null || !li) return;
  let to = +li.dataset.i;
  const stops = state.trip.stops;
  const [moved] = stops.splice(dragFrom, 1);
  if (dragFrom < to) to -= 1;
  stops.splice(to, 0, moved);
  dragFrom = null;
  afterStopsChanged();
});

function afterStopsChanged() {
  renderStops(); renderMapStops(); renderRoute(); renderPoiScope(); renderExpenseStops();
  markDirty({ reroute: true });
}

function addStop(stop, index) {
  const s = { id: uid(), name: stop.name || 'Tappa', lat: +stop.lat, lon: +stop.lon, nights: stop.nights ?? 1, kind: stop.kind || 'tappa', notes: stop.notes || '', poi: stop.poi || null, acsi: stop.acsi || null };
  const stops = state.trip.stops;
  if (index == null || index > stops.length) stops.push(s); else stops.splice(index, 0, s);
  afterStopsChanged();
  toast(`Aggiunta: ${s.name}`);
}

// posizione migliore per inserire un punto (minima deviazione in linea d'aria)
function bestInsertIndex(lat, lon) {
  const st = state.trip.stops;
  if (st.length < 2) return st.length;
  const d = (a, b) => L.latLng(a).distanceTo(L.latLng(b));
  const p = [lat, lon];
  let best = st.length, cost = d([st.at(-1).lat, st.at(-1).lon], p);
  for (let i = 0; i < st.length - 1; i++) {
    const a = [st[i].lat, st[i].lon], b = [st[i + 1].lat, st[i + 1].lon];
    const c = d(a, p) + d(p, b) - d(a, b);
    if (c < cost) { cost = c; best = i + 1; }
  }
  return best;
}

$('#btnReverse').addEventListener('click', () => { state.trip.stops.reverse(); afterStopsChanged(); });
$('#btnRecalc').addEventListener('click', () => scheduleRoute(0, true));
$('#btnFit').addEventListener('click', fitAll);

// ricerca luoghi
$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim(); if (!q) return;
  const box = $('#searchResults');
  box.innerHTML = '<div class="search-hit muted">ricerca…</div>';
  try {
    const hits = await api('/geocode?q=' + encodeURIComponent(q));
    if (!hits.length) { box.innerHTML = '<div class="search-hit muted">Nessun risultato.</div>'; return; }
    box.innerHTML = hits.map((h, i) => `<div class="search-hit">
      <div><div>${esc(h.name)}</div><div class="lbl" title="${esc(h.label)}">${esc(h.label)}</div></div>
      <span><button class="btn-icon" data-show="${i}" title="Mostra">◎</button><button class="btn" data-add="${i}">+ Tappa</button></span>
    </div>`).join('');
    box._hits = hits;
  } catch (err) { box.innerHTML = `<div class="search-hit err">✘ ${esc(err.message)}</div>`; }
});
$('#searchResults').addEventListener('click', e => {
  const box = $('#searchResults');
  const add = e.target.closest('[data-add]'), show = e.target.closest('[data-show]');
  if (add) {
    const h = box._hits[+add.dataset.add];
    addStop({ name: h.name, lat: h.lat, lon: h.lon });
    box.innerHTML = ''; $('#searchInput').value = '';
    map.setView([h.lat, h.lon], Math.max(map.getZoom(), 9));
  } else if (show) {
    const h = box._hits[+show.dataset.show];
    map.setView([h.lat, h.lon], 12);
  }
});

// ---------- mappa ----------
let map, stopLayer, routeLayer, poiLayer, stopMarkers = [];
function initMap() {
  if (map) return;
  const osmDark = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tiles-dark', attribution: '&copy; OpenStreetMap' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; OpenStreetMap, SRTM | OpenTopoMap' });
  map = L.map('map', { zoomControl: true, layers: [osmDark] }).setView([45.6, 10.2], 6);
  L.control.layers({ 'Scura': osmDark, 'Chiara': osm, 'Topografica': topo }, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  poiLayer = L.layerGroup().addTo(map);
  stopLayer = L.layerGroup().addTo(map);

  map.on('click', async e => {
    const { lat, lng } = e.latlng;
    const pop = L.popup().setLatLng(e.latlng).setContent('<span class="muted">cerco il nome…</span>').openOn(map);
    let name = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    try { name = (await api(`/reverse?lat=${lat}&lon=${lng}`)).name || name; } catch { /* offline: tengo le coordinate */ }
    const div = document.createElement('div');
    div.innerHTML = `<b>${esc(name)}</b><br><span class="muted">${lat.toFixed(5)}, ${lng.toFixed(5)}</span><br>
      <button class="btn" data-x="end">+ In fondo</button> <button class="btn" data-x="best">+ Nel punto migliore</button>`;
    div.addEventListener('click', ev => {
      const x = ev.target.closest('[data-x]')?.dataset.x; if (!x) return;
      addStop({ name, lat, lon: lng }, x === 'best' ? bestInsertIndex(lat, lng) : undefined);
      map.closePopup();
    });
    pop.setContent(div);
  });
}

function stopIcon(s, i) {
  return L.divIcon({ className: '', html: `<div class="stop-marker k-${s.kind}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -14] });
}
function renderMapStops() {
  if (!map) return;
  stopLayer.clearLayers(); stopMarkers = [];
  state.trip.stops.forEach((s, i) => {
    const m = L.marker([s.lat, s.lon], { icon: stopIcon(s, i), draggable: true, title: s.name })
      .bindPopup(`<b>${i + 1}. ${esc(s.name)}</b><br>${KINDS[s.kind]} · ${s.nights} notti`);
    m.on('dragend', () => {
      const p = m.getLatLng(); s.lat = p.lat; s.lon = p.lng;
      renderRoute(); markDirty({ reroute: true });
    });
    m.addTo(stopLayer); stopMarkers.push(m);
  });
}
function renderRoute() {
  if (!map) return;
  routeLayer.clearLayers();
  const t = state.trip;
  const fresh = t.route && t.route.signature === routeSignature(t);
  if (fresh && t.route.geometry?.length) {
    L.polyline(t.route.geometry, { color: '#000', weight: 8, opacity: .55 }).addTo(routeLayer);
    L.polyline(t.route.geometry, { color: '#ff4dff', weight: 4.5, opacity: .95 }).addTo(routeLayer);
  } else if (t.stops.length >= 2) {
    L.polyline(t.stops.map(s => [s.lat, s.lon]), { color: '#ececec', weight: 2, dashArray: '6 6', opacity: .7 }).addTo(routeLayer);
  }
  renderRouteInfo();
}
function fitAll() {
  if (!map) return;
  const pts = state.trip.stops.map(s => [s.lat, s.lon]);
  if (pts.length === 1) map.setView(pts[0], 11);
  else if (pts.length) map.fitBounds(pts, { padding: [40, 40] });
}

// ---------- calcolo percorso ----------
let routeTimer;
function scheduleRoute(delay = 900, force = false) {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(() => computeRoute(force), delay);
}
async function computeRoute(force) {
  const t = state.trip; if (!t) return;
  const sig = routeSignature(t);
  if (t.stops.length < 2) { t.route = null; renderRoute(); renderSummary(); return; }
  if (!force && t.route?.signature === sig) return;
  const seq = ++state.routeSeq;
  $('#mapBusy').hidden = false;
  try {
    const r = await api('/route', { method: 'POST', body: { coords: t.stops.map(s => [s.lat, s.lon]) } });
    if (seq !== state.routeSeq || state.trip !== t) return;
    t.route = { ...r, signature: sig, computedAt: new Date().toISOString() };
    if (r.warning) toast(r.warning, true);
    renderStops(); renderRoute(); renderSummary(); renderDiary(); markDirty();
  } catch (e) {
    if (seq === state.routeSeq) { toast('Percorso non calcolato: ' + e.message, true); renderRoute(); }
  } finally {
    if (seq === state.routeSeq) $('#mapBusy').hidden = true;
  }
}

// ---------- aree sosta ----------
const SOURCES = {
  osm: { label: 'OpenStreetMap', short: 'OSM' },
  overture: { label: 'Overture', short: 'OVT' },
  mine: { label: 'La mia raccolta', short: 'MIA' }
};
state.collection = { total: 0, favorites: 0, imports: [] };
const punti = n => `${n.toLocaleString('it-IT')} ${n === 1 ? 'punto' : 'punti'}`;

(function initPoiTypes() {
  $('#poiTypes').innerHTML = Object.entries(POI_TYPES).map(([k, p]) =>
    `<label><input type="checkbox" value="${k}" ${['area_camper', 'campeggio', 'scarico'].includes(k) ? 'checked' : ''}>
      <span class="poi-dot c-${k}">${p.letter}</span>${p.label}</label>`).join('');
})();

function renderPoiSources() {
  const s = state.settings || {};
  const prev = Object.fromEntries($$('#poiSources input').map(i => [i.value, i.checked]));
  const items = [
    { k: 'osm', on: prev.osm ?? true, note: 'aree, campeggi, servizi' },
    { k: 'overture', on: prev.overture ?? Boolean(s.openPlacesKeySet), disabled: !s.openPlacesKeySet,
      note: s.openPlacesKeySet ? 'dati aperti Meta, Microsoft, Foursquare' : 'serve la chiave gratuita (scheda Mezzo)' },
    { k: 'mine', on: prev.mine ?? state.collection.total > 0, disabled: !state.collection.total,
      note: state.collection.total ? punti(state.collection.total) : 'vuota: importa un file o salva con ★' }
  ];
  $('#poiSources').innerHTML = items.map(i => `<label class="${i.disabled ? 'off' : ''}">
    <input type="checkbox" value="${i.k}" ${i.on && !i.disabled ? 'checked' : ''} ${i.disabled ? 'disabled' : ''}>
    <span class="src src-${i.k}">${SOURCES[i.k].short}</span>${SOURCES[i.k].label} <span class="muted">· ${i.note}</span></label>`).join('');
}

async function loadCollection() {
  try { state.collection = await api('/collection'); } catch { /* resta il valore precedente */ }
  renderCollection(); renderPoiSources();
}
function renderCollection() {
  const c = state.collection;
  $('#collSummary').innerHTML = c.total
    ? `<span class="c-magenta">${punti(c.total)}</span> · <span class="c-yellow">★ ${c.favorites}</span> ${c.favorites === 1 ? 'preferito' : 'preferiti'}${c.acsi ? ` · <span class="acsi">ACSI</span> ${c.acsi}` : ''}`
    : '<span class="muted">Vuota. Importa un file o una fonte esterna qui sotto, oppure salva le aree che trovi con ☆.</span>';
  $('#collImports').innerHTML = c.imports.map(i => `<div class="coll-row">
      <span>${esc(i.name)} <span class="muted">· ${punti(i.count)} · ${new Date(i.importedAt).toLocaleDateString('it-IT')}${i.licence ? ' · ' + esc(i.licence) : ''}</span></span>
      <span class="poi-actions">${i.url ? `<button class="btn-icon" data-refresh="${esc(i.name)}" title="Riscarica la versione più recente">↻</button>` : ''}
      <button class="btn-icon" data-delimport="${esc(i.name)}" title="Rimuovi dalla raccolta">✕</button></span></div>`).join('');
  renderCatalog();
}

const FLAGS = { FR: 'Francia', ES: 'Spagna', IT: 'Italia', DE: 'Germania' };
async function loadCatalog() {
  try { state.catalog = await api('/catalog'); } catch { state.catalog = state.catalog || { sources: [], manual: [] }; }
  renderCatalog();
  $('#manualList').innerHTML = state.catalog.manual.map(m => `<div class="manual">
      <b>${esc(m.name)}</b> <span class="muted">· ${esc(m.country)}</span><br>${esc(m.what)}<br>
      <span class="muted">${esc(m.how)}</span><br><a href="${esc(m.page)}" target="_blank" rel="noopener">Apri il sito</a></div>`).join('');
}
function renderCatalog() {
  const cat = state.catalog; if (!cat) return;
  const imported = new Map(state.collection.imports.filter(i => i.catalogId).map(i => [i.catalogId, i]));
  $('#catalogList').innerHTML = cat.sources.map(s => {
    const imp = imported.get(s.id);
    return `<div class="catalog-row">
      <span class="poi-dot c-${s.category}">${POI_TYPES[s.category]?.letter || '?'}</span>
      <span class="cat-main"><b>${esc(s.name)}</b> <span class="muted">· ${FLAGS[s.country] || s.country}</span><br>
        <span class="muted">${esc(s.attribution)} · ${esc(s.licence)} · aggiornamento ${esc(s.updated)} · <a href="${esc(s.page)}" target="_blank" rel="noopener">pagina</a></span>
        ${imp ? `<br><span class="ok">✔</span> <span class="c-magenta">${punti(imp.count)}</span> <span class="muted">· ${new Date(imp.importedAt).toLocaleDateString('it-IT')}</span>` : ''}</span>
      <button class="btn ${imp ? '' : 'btn-primary'}" data-catimport="${esc(s.id)}">${imp ? 'Aggiorna' : 'Importa'}</button>
    </div>`;
  }).join('');
}
async function runImport(label, btn, fn) {
  const old = btn?.textContent;
  let ok = false;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  toast(`${label}: download in corso…`);
  try {
    const r = await fn();
    state.collection = r;
    toast(`${label}: ${punti(r.added)} ${r.added === 1 ? 'importato' : 'importati'}`);
    ok = true;
  } catch (err) { toast(`${label}: ${err.message}`, true); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
  renderCollection(); renderPoiSources();
  return ok;
}
$('#catalogList').addEventListener('click', e => {
  const b = e.target.closest('[data-catimport]'); if (!b) return;
  const s = state.catalog.sources.find(x => x.id === b.dataset.catimport);
  runImport(s.name, b, () => api('/collection/import-catalog', { method: 'POST', body: { id: s.id } }));
});
$('#urlForm').addEventListener('submit', e => {
  e.preventDefault();
  const url = $('#urlInput').value.trim(); if (!url) return;
  const btn = e.target.querySelector('button');
  runImport('Importazione dal web', btn, () => api('/collection/import-url', { method: 'POST', body: { url, category: $('#urlCat').value } }))
    .then(ok => { if (ok) $('#urlInput').value = ''; });
});
$('#collFile').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { toast(`${f.name}: file troppo grande (max 20 MB)`, true); continue; }
    try {
      const r = await api('/collection/import', { method: 'POST', body: { filename: f.name, content: await f.text() } });
      state.collection = r; toast(`${f.name}: ${punti(r.added)} ${r.added === 1 ? 'importato' : 'importati'}`);
    } catch (err) { toast(`${f.name}: ${err.message}`, true); }
  }
  renderCollection(); renderPoiSources();
});
$('#collImports').addEventListener('click', async e => {
  const rf = e.target.closest('[data-refresh]');
  if (rf) return runImport(rf.dataset.refresh, rf, () => api('/collection/refresh', { method: 'POST', body: { name: rf.dataset.refresh } }));
  const b = e.target.closest('[data-delimport]'); if (!b) return;
  if (!confirm(`Rimuovere dalla raccolta i punti di "${b.dataset.delimport}"?`)) return;
  state.collection = await api('/collection/imports/' + encodeURIComponent(b.dataset.delimport), { method: 'DELETE' });
  renderCollection(); renderPoiSources();
});
$('#btnCollExport').addEventListener('click', () => { location.href = 'api/collection/export'; });

function renderPoiScope() {
  const t = state.trip; if (!t) return;
  const sel = $('#poiScope'); const prev = sel.value;
  const hasRoute = t.route?.signature === routeSignature(t);
  sel.innerHTML = (hasRoute ? '<option value="route">Lungo tutto il percorso</option>' : '') +
    t.stops.map((s, i) => `<option value="${i}">Vicino a ${i + 1}. ${esc(s.name)}</option>`).join('') +
    '<option value="view">Centro della mappa</option>';
  if (sel.dataset.touched && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  else sel.value = sel.options[0].value;
}
$('#poiScope').addEventListener('change', e => (e.target.dataset.touched = '1'));
$('#btnPoiSearch').addEventListener('click', async () => {
  const types = $$('#poiTypes input:checked').map(i => i.value);
  const sources = $$('#poiSources input:checked').map(i => i.value);
  if (!types.length) return toast('Scegli almeno un tipo', true);
  if (!sources.length) return toast('Scegli almeno una fonte', true);
  const scope = $('#poiScope').value, radius = +$('#poiRadius').value;
  const body = { types, radius, sources, acsiOnly: $('#poiAcsiOnly').checked };
  const t = state.trip;
  if (scope === 'route') { body.line = t.route.geometry; body.radius = Math.min(radius, 10000); }
  else if (scope === 'view') { const c = map.getCenter(); body.center = [c.lat, c.lng]; }
  else { const s = t.stops[+scope]; body.center = [s.lat, s.lon]; }
  $('#poiStatus').innerHTML = `<span class="c-cyan">…</span> ricerca su ${sources.map(x => SOURCES[x].label).join(', ')} (può richiedere qualche secondo)`;
  $('#btnPoiSearch').disabled = true;
  try {
    const r = await api('/pois', { method: 'POST', body });
    state.pois = r.pois;
    const per = Object.entries(r.counts || {}).map(([k, n]) => `<span class="src src-${k}">${SOURCES[k].short}</span> ${n}`).join(' ');
    const merged = state.pois.filter(p => p.sources.length > 1).length;
    $('#poiStatus').innerHTML = (state.pois.length
      ? `<span class="ok">✔</span> ${state.pois.length} risultati · ${per}${merged ? ` · <span class="muted">${merged} presenti in più fonti</span>` : ''}${scope === 'route' && radius > 10000 ? '<br><span class="muted">raggio limitato a 10 km lungo il percorso</span>' : ''}`
      : 'Nessun risultato: prova un raggio più ampio o un\'altra fonte.') +
      (r.warnings || []).map(w => `<br><span class="c-yellow">⚠ ${esc(w)}</span>`).join('');
    renderPois();
    if (state.pois.length) map.fitBounds(state.pois.map(p => [p.lat, p.lon]).concat(t.stops.map(s => [s.lat, s.lon])), { padding: [30, 30] });
  } catch (e) {
    $('#poiStatus').innerHTML = `<span class="err">✘</span> ${esc(e.message)}`;
  } finally { $('#btnPoiSearch').disabled = false; }
});
$('#btnPoiClear').addEventListener('click', () => { state.pois = []; renderPois(); $('#poiStatus').textContent = ''; });

function poiName(p) { return p.name || POI_TYPES[p.category]?.label.replace(/i$/, 'o') || 'Punto'; }
const acsiLabel = a => a ? `ACSI${a.price != null ? ' ' + fmtEur(a.price) : ''}` : '';
const acsiBadge = a => a ? `<span class="acsi" title="CampingCard ACSI${a.price != null ? ', tariffa a notte' : ''}">${acsiLabel(a)}</span>` : '';
function campingCardUrl(p) {
  const city = (p.tags?.address || '').split(',').pop().trim();
  return 'https://www.google.com/search?q=' + encodeURIComponent(`site:campingcard.it ${p.name || ''} ${city}`.trim());
}
function askAcsiPrice(current) {
  const v = prompt('Tariffa CampingCard ACSI a notte in € (lascia vuoto se non la sai):', current?.price ?? '');
  if (v === null) return undefined; // annullato
  const n = parseFloat(String(v).replace(',', '.'));
  return { price: Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null };
}
const srcBadges = p => p.sources.map(s => `<span class="src src-${s}" title="${SOURCES[s].label}">${SOURCES[s].short}</span>`).join('');
function poiDetails(p) {
  const t = p.tags || {}, bits = [];
  const yes = v => v === 'yes';
  if (t.fee) bits.push(yes(t.fee) ? (t.charge ? `<b>${esc(t.charge)}</b>` : 'a pagamento') : t.fee === 'no' ? '<b>gratuita</b>' : esc(t.fee));
  if (t.capacity) bits.push(`${esc(t.capacity)} posti`);
  if (yes(t.power)) bits.push('corrente');
  if (yes(t.water)) bits.push('acqua');
  if (yes(t.dump)) bits.push('scarico');
  if (yes(t.toilets)) bits.push('WC');
  if (yes(t.shower)) bits.push('docce');
  if (t.maxstay) bits.push(`max ${esc(t.maxstay)}`);
  if (t.opening) bits.push(esc(t.opening));
  if (t.address) bits.push(esc(t.address));
  if (t.closed) bits.push(`<span class="err">${esc(t.closed)}</span>`);
  if (t.list) bits.push(`da ${esc(t.list)}`);
  if (t.notes && p.sources?.every(x => x === 'mine')) bits.push(esc(t.notes.length > 140 ? t.notes.slice(0, 140) + '…' : t.notes));
  return bits.join(' · ');
}
function poiPopup(p, idx) {
  const t = p.tags || {};
  const links = [];
  if (t.website) links.push(`<a href="${esc(/^https?:/i.test(t.website) ? t.website : 'https://' + t.website)}" target="_blank" rel="noopener">sito web</a>`);
  if (p.osmType) links.push(`<a href="https://www.openstreetmap.org/${p.osmType}/${p.osmId}" target="_blank" rel="noopener">OpenStreetMap</a>`);
  links.push(`<a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}" target="_blank" rel="noopener">Google Maps</a>`);
  return `<b>${esc(poiName(p))}</b> ${srcBadges(p)} ${acsiBadge(p.acsi)}<br><span class="muted">${POI_TYPES[p.category]?.label || ''}</span>
    ${poiDetails(p) ? '<br>' + poiDetails(p) : ''}
    ${t.phone ? `<br>☎ ${esc(t.phone)}` : ''}
    <br>${links.join(' · ')}
    ${p.category === 'campeggio' || p.acsi ? `<br><a href="${campingCardUrl(p)}" target="_blank" rel="noopener">Cerca su CampingCard ACSI</a>` : ''}
    <br><button class="btn" data-addpoi="${idx}">+ Aggiungi al viaggio</button>
    <button class="btn" data-favpoi="${idx}">${p.mineId ? '★ Nella raccolta' : '☆ Salva'}</button>
    <button class="btn" data-acsipoi="${idx}">${p.acsi ? '✎ ' + acsiLabel(p.acsi) : 'Segna ACSI'}</button>`;
}
function renderPois() {
  if (!map) return;
  poiLayer.clearLayers();
  const list = $('#poiList');
  const ref = state.trip.stops.length ? state.trip.stops : null;
  state.pois.forEach((p, i) => {
    const pt = POI_TYPES[p.category] || { letter: '?' };
    const cls = p.sources.length === 1 && p.sources[0] !== 'osm' ? ` poi-${p.sources[0]}` : '';
    const icon = L.divIcon({ className: '', html: `<span class="poi-dot poi-marker c-${p.category}${cls}">${pt.letter}</span>`, iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -10] });
    p._marker = L.marker([p.lat, p.lon], { icon, title: poiName(p) }).bindPopup(() => poiPopup(p, i)).addTo(poiLayer);
  });
  list.innerHTML = state.pois.map((p, i) => {
    let near = '';
    if (ref) {
      let best = Infinity, bi = 0;
      ref.forEach((s, j) => { const d = L.latLng(s.lat, s.lon).distanceTo([p.lat, p.lon]); if (d < best) { best = d; bi = j; } });
      near = `${(best / 1000).toFixed(1)} km da ${bi + 1}`;
    }
    return `<div class="poi" data-i="${i}">
      <span class="poi-dot c-${p.category}">${POI_TYPES[p.category]?.letter || '?'}</span>
      <span class="poi-name">${esc(poiName(p))} ${srcBadges(p)} ${acsiBadge(p.acsi)}</span>
      <span class="poi-actions">
        ${p.category === 'campeggio' || p.acsi ? `<button class="btn-icon ${p.acsi ? 'acsi-on' : ''}" data-acsipoi="${i}" title="${p.acsi ? 'Modifica o togli il segno ACSI' : 'Segna come campeggio CampingCard ACSI'}">A</button>` : ''}
        <button class="btn-icon ${p.mineId ? 'fav-on' : ''}" data-favpoi="${i}" title="${p.mineId ? 'Già nella tua raccolta' : 'Salva nella raccolta'}">${p.mineId ? '★' : '☆'}</button>
        <button class="btn-icon" data-addpoi="${i}" title="Aggiungi al viaggio">＋</button>
      </span>
      <span class="poi-tags">${near ? `<span class="c-cyan">${near}</span>` : ''}${poiDetails(p) ? ' · ' + poiDetails(p) : ''}</span>
    </div>`;
  }).join('');
}
function addPoi(i) {
  const p = state.pois[i];
  addStop({ name: poiName(p), lat: p.lat, lon: p.lon, kind: POI_TYPES[p.category]?.kind || 'sosta',
    nights: ['area_camper', 'campeggio'].includes(p.category) ? 1 : 0,
    notes: poiDetails(p).replace(/<[^>]+>/g, ''),
    acsi: p.acsi || null,
    poi: { osmType: p.osmType || '', osmId: p.osmId || 0, category: p.category, sources: p.sources } }, bestInsertIndex(p.lat, p.lon));
  map.closePopup();
}
async function toggleFav(i) {
  const p = state.pois[i];
  try {
    if (p.mineId) {
      if (!p.sources.includes('mine') || !confirm(`Togliere "${poiName(p)}" dalla raccolta?`)) {
        if (!p.sources.includes('mine')) toast('Già nella raccolta');
        return;
      }
      state.collection = await api('/collection/items/' + encodeURIComponent(p.mineId), { method: 'DELETE' });
      p.mineId = null; p.sources = p.sources.filter(s => s !== 'mine');
      if (!p.sources.length) { state.pois.splice(i, 1); map.closePopup(); }
      toast('Tolto dalla raccolta');
    } else {
      const t = p.tags || {};
      const r = await api('/collection/favorites', { method: 'POST', body: {
        lat: p.lat, lon: p.lon, name: poiName(p), category: p.category, website: t.website || '', phone: t.phone || '',
        notes: poiDetails(p).replace(/<[^>]+>/g, '') } });
      state.collection = r; p.mineId = r.item.id;
      toast('★ Salvato nella raccolta');
    }
    renderPois(); renderCollection(); renderPoiSources();
  } catch (e) { toast(e.message, true); }
}
async function toggleAcsi(i) {
  const p = state.pois[i];
  let acsi;
  if (p.acsi) {
    const v = prompt(`"${poiName(p)}" è segnato ACSI. Nuova tariffa a notte in €, oppure scrivi "no" per togliere il segno:`, p.acsi.price ?? '');
    if (v === null) return;
    if (/^\s*no\s*$/i.test(v)) acsi = null;
    else { const n = parseFloat(String(v).replace(',', '.')); acsi = { price: Number.isFinite(n) && n >= 0 ? n : null }; }
  } else {
    acsi = askAcsiPrice(null);
    if (acsi === undefined) return;
  }
  try {
    const t = p.tags || {};
    const r = await api('/collection/acsi', { method: 'POST', body: {
      lat: p.lat, lon: p.lon, name: poiName(p), category: p.category, website: t.website || '', phone: t.phone || '',
      notes: poiDetails(p).replace(/<[^>]+>/g, ''), acsi } });
    state.collection = r;
    p.acsi = acsi;
    if (r.item && !p.mineId) { p.mineId = r.item.id; if (!p.sources.includes('mine')) p.sources.push('mine'); }
    // aggiorna anche le tappe del viaggio nello stesso punto
    let changed = false;
    for (const s of state.trip.stops) if (L.latLng(s.lat, s.lon).distanceTo([p.lat, p.lon]) < 60) { s.acsi = acsi; changed = true; }
    if (changed) { renderStops(); renderDiary(); markDirty(); }
    toast(acsi ? `Segnato ${acsiLabel(acsi)}` : 'Segno ACSI tolto');
    renderPois(); renderCollection(); renderPoiSources();
    map.closePopup();
  } catch (e) { toast(e.message, true); }
}
$('#poiList').addEventListener('click', e => {
  const add = e.target.closest('[data-addpoi]');
  if (add) return addPoi(+add.dataset.addpoi);
  const ac = e.target.closest('[data-acsipoi]');
  if (ac) return toggleAcsi(+ac.dataset.acsipoi);
  const fav = e.target.closest('[data-favpoi]');
  if (fav) return toggleFav(+fav.dataset.favpoi);
  const row = e.target.closest('.poi'); if (!row) return;
  const p = state.pois[+row.dataset.i];
  map.setView([p.lat, p.lon], Math.max(map.getZoom(), 13)); p._marker.openPopup();
});
document.getElementById('map').addEventListener('click', e => {
  const add = e.target.closest('[data-addpoi]'); if (add) { e.stopPropagation(); addPoi(+add.dataset.addpoi); return; }
  const fav = e.target.closest('[data-favpoi]'); if (fav) { e.stopPropagation(); toggleFav(+fav.dataset.favpoi); return; }
  const ac = e.target.closest('[data-acsipoi]'); if (ac) { e.stopPropagation(); toggleAcsi(+ac.dataset.acsipoi); }
}, true); // fase di cattura: i popup di Leaflet bloccano la propagazione

// ---------- diario e costi ----------
$('#expCat').innerHTML = Object.entries(EXPENSE_CATS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
function renderExpenseStops() {
  const sel = $('#expStop'); const prev = sel.value;
  sel.innerHTML = '<option value="">— nessuna tappa —</option>' + state.trip.stops.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  sel.value = prev;
}
function renderDiary() {
  const t = state.trip; if (!t) return;
  renderExpenseStops();
  const tt = totals(t);
  const fuelGap = Math.max(0, tt.fuelCost - tt.spentFuel);
  const estimate = tt.spent + fuelGap;
  const acsiStops = t.stops.filter(s => s.acsi && s.nights > 0);
  const acsiNights = acsiStops.reduce((a, s) => a + s.nights, 0);
  const acsiKnown = acsiStops.filter(s => s.acsi.price != null);
  const acsiUnknown = acsiStops.length - acsiKnown.length;
  const acsiCost = acsiKnown.length ? acsiKnown.reduce((a, s) => a + s.acsi.price * s.nights, 0) : null;
  const rows = [
    ['Distanza', tt.distance ? fmtKm(tt.distance) : '—'],
    ['Guida', tt.duration ? fmtDur(tt.duration) : '—'],
    ['Giorni / notti', `${tt.days} / ${tt.nights}`],
    ['Carburante stimato', tt.distance ? `${Math.round(tt.fuelL)} l · ${fmtEur(tt.fuelCost)}` : '—'],
    ...(acsiStops.length ? [['Notti ACSI stimate', `${acsiNights} notti · ${acsiCost != null ? fmtEur(acsiCost) : '—'}${acsiUnknown ? ` <span class="muted">(${acsiUnknown} senza tariffa)</span>` : ''}`]] : []),
    ['Già speso', fmtEur(tt.spent)],
    ['Costo previsto', fmtEur(estimate)],
    ...(tt.days ? [['Per giorno', fmtEur(estimate / tt.days)]] : []),
    ...(t.budget ? [['Budget residuo', `<span class="${t.budget - estimate < 0 ? 'err' : 'ok'}">${fmtEur(t.budget - estimate)}</span>`]] : [])
  ];
  $('#stats').innerHTML = rows.map(([k, v]) => { const c = k === 'Costo previsto' ? ' class="total"' : ''; return `<dt${c}>${k}</dt><dd${c}>${v}</dd>`; }).join('') +
    `<dt class="muted" style="grid-column:1/-1;font-size:12px">Il costo previsto somma le spese inserite e il carburante stimato non ancora registrato.</dt>`;

  const byCat = {};
  t.expenses.forEach(e => (byCat[e.category] = (byCat[e.category] || 0) + e.amount));
  const max = Math.max(1, ...Object.values(byCat));
  $('#catTotals').innerHTML = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    `<div class="cat-row"><span>${EXPENSE_CATS[k] || k}</span><span class="cat-bar" style="width:${Math.max(2, v / max * 100)}%"></span><span class="amt">${fmtEur(v)}</span></div>`).join('');

  const stopName = id => t.stops.find(s => s.id === id)?.name || '';
  const sorted = [...t.expenses].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  $('#expenseTable').innerHTML = sorted.length ? `<tr><th>Data</th><th>Voce</th><th class="amt">€</th><th></th></tr>` + sorted.map(e => `
    <tr><td>${e.date ? fmtDate(parseDate(e.date)) : ''}</td>
      <td>${EXPENSE_CATS[e.category] || e.category}${e.description ? ` · ${esc(e.description)}` : ''}${e.stopId ? `<br><span class="muted">${esc(stopName(e.stopId))}</span>` : ''}</td>
      <td class="amt">${fmtEur(e.amount)}</td>
      <td><button class="btn-icon" data-delexp="${esc(e.id)}" title="Elimina">✕</button></td></tr>`).join('')
    : '<tr><td class="muted">Nessuna spesa registrata.</td></tr>';
}
$('#expenseForm').addEventListener('submit', e => {
  e.preventDefault();
  const amount = parseFloat($('#expAmount').value);
  if (!(amount > 0)) return toast('Importo non valido', true);
  state.trip.expenses.push({ id: uid(), date: $('#expDate').value, category: $('#expCat').value, amount: Math.round(amount * 100) / 100, description: $('#expDesc').value.trim(), stopId: $('#expStop').value });
  $('#expAmount').value = ''; $('#expDesc').value = '';
  renderDiary(); markDirty(); $('#expAmount').focus();
});
$('#expenseTable').addEventListener('click', e => {
  const b = e.target.closest('[data-delexp]'); if (!b) return;
  state.trip.expenses = state.trip.expenses.filter(x => x.id !== b.dataset.delexp);
  renderDiary(); markDirty();
});

// ---------- mezzo / impostazioni ----------
async function loadSettings() {
  state.settings = await api('/settings');
  const f = $('#vehicleForm'), s = state.settings;
  for (const k of ['name', 'length', 'width', 'height', 'weight', 'consumption', 'fuelType']) f.elements[k].value = s.vehicle[k];
  f.elements.fuelPrice.value = s.fuelPrice;
  f.elements.durationFactor.value = s.durationFactor;
  f.elements.orsApiKey.value = '';
  f.elements.openPlacesKey.value = '';
  $('#opHint').innerHTML = s.openPlacesKeySet
    ? '<span class="ok">✔</span> Chiave impostata: nelle Aree sosta puoi cercare anche su Overture.'
    : `<span class="c-cyan">info</span> Aggiunge le aree sosta di Overture Maps (dati aperti), oltre a OpenStreetMap. Chiave gratuita, 10.000 ricerche al mese, su <a href="https://openplacesapi.com" target="_blank" rel="noopener">openplacesapi.com</a>.`;
  renderPoiSources();
  $('#orsHint').innerHTML = s.orsApiKeySet
    ? '<span class="ok">✔</span> Chiave impostata: il percorso usa il profilo mezzo pesante con le dimensioni del camper.'
    : `<span class="c-cyan">info</span> Senza chiave il percorso usa OSRM (profilo auto) e ignora altezza e peso. Una chiave gratuita si ottiene su <a href="https://openrouteservice.org/dev/#/signup" target="_blank" rel="noopener">openrouteservice.org</a>.`;
}
$('#vehicleForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, v = {};
  for (const k of ['name', 'length', 'width', 'height', 'weight', 'consumption', 'fuelType']) v[k] = f.elements[k].value;
  const body = { vehicle: v, fuelPrice: f.elements.fuelPrice.value, durationFactor: f.elements.durationFactor.value };
  if (f.elements.orsApiKey.value.trim()) body.orsApiKey = f.elements.orsApiKey.value.trim();
  if (f.elements.openPlacesKey.value.trim()) body.openPlacesKey = f.elements.openPlacesKey.value.trim();
  try {
    await api('/settings', { method: 'PUT', body });
    await loadSettings(); toast('Mezzo salvato');
    if (state.trip) { renderDiary(); if (body.orsApiKey) scheduleRoute(0, true); }
  } catch (err) { toast(err.message, true); }
});
$('#btnClearOp').addEventListener('click', async () => {
  await api('/settings', { method: 'PUT', body: { openPlacesKey: '' } });
  await loadSettings(); toast('Chiave Open Places rimossa');
});
$('#btnClearOrs').addEventListener('click', async () => {
  await api('/settings', { method: 'PUT', body: { orsApiKey: '' } });
  await loadSettings(); toast('Chiave rimossa');
});

// ---------- esporta ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const safeName = s => (s || 'viaggio').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'viaggio';
$('#btnGpx').addEventListener('click', async () => { await save(); location.href = `api/trips/${state.trip.id}/gpx`; });
$('#btnJson').addEventListener('click', () => download(`${safeName(state.trip.name)}.json`, JSON.stringify(state.trip, null, 2), 'application/json'));
$('#btnDuplicate').addEventListener('click', async () => {
  await save();
  const copy = JSON.parse(JSON.stringify(state.trip)); copy.name += ' (copia)';
  const t = await api('/trips', { method: 'POST', body: copy });
  toast('Copia creata'); openTrip(t.id);
});
$('#btnDeleteTrip').addEventListener('click', async () => {
  if (!confirm(`Eliminare definitivamente "${state.trip.name}"? Non si può annullare.`)) return;
  clearTimeout(saveTimer); state.dirty = false;
  await api(`/trips/${state.trip.id}`, { method: 'DELETE' });
  toast('Viaggio eliminato'); showHome();
});
$('#btnPrint').addEventListener('click', () => { buildPrint(); window.print(); });

function buildPrint() {
  const t = state.trip, tt = totals(t), dates = stopDates(t);
  const legs = t.route?.signature === routeSignature(t) ? t.route.legs : [];
  const start = parseDate(t.startDate);
  const byCat = {};
  t.expenses.forEach(e => (byCat[e.category] = (byCat[e.category] || 0) + e.amount));
  $('#printView').innerHTML = `
    <div class="print-head"><img src="img/vc-solutions-logo.jpg" alt="VC Solutions"><div>
      <h1>${esc(t.name)}</h1>
      <div>${start ? `${fmtDate(start)} → ${fmtDate(addDays(start, tt.nights))} · ` : ''}${tt.days} giorni · ${tt.nights} notti · ${tt.distance ? fmtKm(tt.distance) + ' · ' + fmtDur(tt.duration) + ' di guida' : ''}</div>
      <div>${esc(state.settings.vehicle.name)} · ${state.settings.vehicle.length} × ${state.settings.vehicle.width} × ${state.settings.vehicle.height} m · ${state.settings.vehicle.weight} t</div>
    </div></div>
    <h2>Itinerario</h2>
    <table><tr><th>#</th><th>Tappa</th><th>Date</th><th class="r">Notti</th><th class="r">Tratto successivo</th></tr>
    ${t.stops.map((s, i) => `<tr><td>${i + 1}</td><td><b>${esc(s.name)}</b><br><small>${KINDS[s.kind]}${s.acsi ? ' · ' + acsiLabel(s.acsi) : ''} · ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</small>${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ''}</td>
      <td>${dates[i].arrive ? fmtDate(dates[i].arrive) + (s.nights ? ' → ' + fmtDate(dates[i].leave) : '') : ''}</td>
      <td class="r">${s.nights}</td><td class="r">${legs[i] ? fmtKm(legs[i].distance) + '<br>' + fmtDur(legs[i].duration) : ''}</td></tr>`).join('')}
    </table>
    <h2>Costi</h2>
    <table>
      <tr><td>Carburante stimato</td><td class="r">${Math.round(tt.fuelL)} l · ${fmtEur(tt.fuelCost)}</td></tr>
      ${Object.entries(byCat).map(([k, v]) => `<tr><td>${EXPENSE_CATS[k] || k}</td><td class="r">${fmtEur(v)}</td></tr>`).join('')}
      <tr><th>Totale speso</th><th class="r">${fmtEur(tt.spent)}</th></tr>
      ${t.budget ? `<tr><td>Budget</td><td class="r">${fmtEur(t.budget)}</td></tr>` : ''}
    </table>
    ${t.notes ? `<h2>Diario</h2><div class="note">${esc(t.notes)}</div>` : ''}`;
}

// ---------- avvio ----------
(async function boot() {
  try { await loadSettings(); } catch (e) { toast('Server non raggiungibile: ' + e.message, true); }
  loadCollection();
  const id = location.hash.slice(1);
  if (id) openTrip(id); else showHome();
})();
