// Pagina in sola lettura di un viaggio condiviso con un link (nessun account richiesto).
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KINDS = { tappa: 'Tappa', sosta: 'Area sosta', campeggio: 'Campeggio', visita: 'Visita' };
  const fmtKm = m => `${Math.round((m || 0) / 1000).toLocaleString('it-IT')} km`;
  const fmtDur = s => { s = Math.round((s || 0) / 60); const h = Math.floor(s / 60), m = s % 60; return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };
  const parseDate = d => { if (!d) return null; const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmtDate = d => d ? d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const nav = (lat, lon) => {
    const ll = `${(+lat).toFixed(6)},${(+lon).toFixed(6)}`;
    return `<span class="navlinks">➤ Naviga: <a href="https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving" target="_blank" rel="noopener">Google Maps</a>` +
      `<a href="https://waze.com/ul?ll=${ll}&navigate=yes" target="_blank" rel="noopener">Waze</a>` +
      `<a href="https://maps.apple.com/?daddr=${ll}&dirflg=d" target="_blank" rel="noopener">Apple</a>` +
      `<a href="https://osmand.net/map?pin=${ll}#15/${(+lat).toFixed(5)}/${(+lon).toFixed(5)}" target="_blank" rel="noopener">OsmAnd</a></span>`;
  };
  const token = location.pathname.split('/').filter(Boolean).pop();
  let map, layer;

  async function load() {
    let t;
    try {
      const r = await fetch(`../api/condiviso/${encodeURIComponent(token)}`, { cache: 'no-store' });
      t = await r.json();
      if (!r.ok) throw new Error(t.error || 'Viaggio non disponibile');
    } catch (e) {
      $('#shMain').outerHTML = `<div class="sh-error"><h2 class="c-yellow">Viaggio non disponibile</h2><p>${esc(e.message)}</p></div>`;
      return;
    }
    render(t);
  }

  function render(t) {
    document.title = `${t.name} · Camper Planner`;
    $('#shTab').textContent = t.name; $('#shName').textContent = t.name;
    const start = parseDate(t.startDate);
    const nights = t.stops.reduce((a, s) => a + (s.nights || 0), 0);
    const legs = t.route?.current ? t.route.legs : [];
    $('#shSummary').innerHTML = [
      start ? `${fmtDate(start)} → ${fmtDate(addDays(start, nights))}` : '',
      `${t.stops.length} tappe · ${nights} notti`,
      t.route?.current ? `${fmtKm(t.route.distance)} · ${fmtDur(t.route.duration)} di guida` : ''
    ].filter(Boolean).join(' · ');
    let acc = 0;
    $('#shStops').innerHTML = t.stops.map((s, i) => {
      const arrive = start ? addDays(start, acc) : null; acc += s.nights || 0;
      const leave = start ? addDays(start, acc) : null;
      const leg = legs[i] && i < t.stops.length - 1 ? `<div class="sh-leg">↓ ${fmtKm(legs[i].distance)} · ${fmtDur(legs[i].duration)}</div>` : '';
      return `<div class="sh-stop">
        <b>${i + 1}. ${esc(s.name)}</b>
        <div class="sh-meta">${KINDS[s.kind] || 'Tappa'}${s.acsi ? ' · CampingCard ACSI' : ''} · ${s.nights || 0} ${s.nights === 1 ? 'notte' : 'notti'}${arrive ? ` · ${fmtDate(arrive)}${s.nights ? ' → ' + fmtDate(leave) : ''}` : ''}</div>
        ${s.notes ? `<div class="sh-notes">${esc(s.notes)}</div>` : ''}
        <div class="sh-meta">${nav(s.lat, s.lon)}</div>
      </div>${leg}`;
    }).join('');
    $('#shFoot').innerHTML = `Viaggio condiviso in sola lettura con Camper Planner. Aggiornato il ${esc(new Date(t.updatedAt).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }))}. <a href="#" id="shReload">Ricarica</a>`;
    $('#shReload').onclick = e => { e.preventDefault(); load(); };

    if (!map) {
      map = L.map('shMap', { zoomControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tiles-dark', attribution: '&copy; OpenStreetMap' }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    if (t.route?.current && t.route.geometry?.length) {
      L.polyline(t.route.geometry, { color: '#000', weight: 8, opacity: .55 }).addTo(layer);
      L.polyline(t.route.geometry, { color: '#ff4dff', weight: 4.5, opacity: .95 }).addTo(layer);
    } else if (t.stops.length > 1) {
      L.polyline(t.stops.map(s => [s.lat, s.lon]), { color: '#ececec', weight: 2, dashArray: '6 6', opacity: .7 }).addTo(layer);
    }
    t.stops.forEach((s, i) => L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: '', html: `<div class="stop-marker k-${s.kind}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -14] }), title: s.name
    }).bindPopup(`<b>${i + 1}. ${esc(s.name)}</b><br>${nav(s.lat, s.lon)}`).addTo(layer));
    const pts = t.stops.map(s => [s.lat, s.lon]);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
    else map.setView([42.5, 12.5], 5);
  }

  load();
})();
