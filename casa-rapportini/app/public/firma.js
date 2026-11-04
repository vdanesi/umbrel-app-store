/* Rapportini — firma personale: caricamento, pulizia dello sfondo e uso nei PDF */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const A = () => window.App;
  let cache;            // undefined = da leggere · null = nessuna firma · ArrayBuffer = PNG

  async function get() {
    if (cache !== undefined) return cache;
    try {
      const r = await fetch('api/firma', { cache: 'no-store' });
      cache = r.ok ? await r.arrayBuffer() : null;
    } catch { cache = null; }
    return cache;
  }
  const presente = async () => !!(await get());

  function caricaImmagine(file) {
    return new Promise((ok, ko) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("Formato non leggibile: usa una foto JPG o un'immagine PNG.")); };
      img.src = url;
    });
  }

  /** Rende trasparente lo sfondo chiaro, ritaglia i margini e riduce l'immagine. */
  async function prepara(file, trasparente) {
    const img = await caricaImmagine(file);
    const k = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * k)), H = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H), px = d.data;
    if (trasparente) {
      // soglia adattiva: lo sfondo è la parte più chiara del foglio
      let somma = 0, n = 0;
      for (let i = 0; i < px.length; i += 16) { somma += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; n++; }
      const carta = Math.min(245, somma / n), alto = carta - 18, basso = carta - 85;
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const a = l >= alto ? 0 : l <= basso ? 255 : Math.round(255 * (alto - l) / (alto - basso));
        px[i + 3] = Math.min(px[i + 3], a);
        if (a) { const s = 0.55; px[i] *= s; px[i + 1] *= s; px[i + 2] *= s; }   // inchiostro più deciso
      }
      g.putImageData(d, 0, 0);
    }
    // ritaglio sui tratti visibili
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (px[(y * W + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) throw new Error("Nell'immagine non si vede nessuna firma: prova una foto più contrastata su foglio bianco.");
    const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, z = Math.min(1, 320 / ch, 1000 / cw);
    const out = document.createElement('canvas'); out.width = Math.round(cw * z); out.height = Math.round(ch * z);
    out.getContext('2d').drawImage(c, x0, y0, cw, ch, 0, 0, out.width, out.height);
    return new Promise(ok => out.toBlob(ok, 'image/png'));
  }

  async function mostra() {
    const f = await get();
    const box = $('firmaPreview');
    box.innerHTML = '';
    if (f) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(new Blob([f], { type: 'image/png' }));
      img.alt = 'La tua firma';
      box.appendChild(img);
    } else {
      box.textContent = 'Nessuna firma caricata';
    }
    box.classList.toggle('vuota', !f);
    $('firmaDel').hidden = !f;
    $('firmaLoadTxt').textContent = f ? 'Sostituisci la firma' : 'Carica la firma';
    $('firmaRap').checked = A().getSettings()?.firmaRapporto !== false;
  }

  function init() {
    $('firmaFile').onchange = async e => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      try {
        const png = await prepara(file, $('firmaTrasp').checked);
        const res = await fetch('api/firma', { method: 'PUT', headers: { 'X-Rapportini': '1', 'Content-Type': 'image/png' }, body: png });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.errore || 'Caricamento non riuscito');
        cache = undefined; await mostra();
        A().toast('Firma salvata: comparirà nei moduli.');
      } catch (x) { A().toast(x.message, true); }
    };
    $('firmaDel').onclick = async () => {
      if (!confirm('Eliminare la tua firma? I moduli usciranno senza.')) return;
      try { await A().api('firma', { method: 'DELETE' }); cache = null; await mostra(); A().toast('Firma eliminata.'); }
      catch (x) { A().toast(x.message, true); }
    };
    $('firmaRap').onchange = async e => {
      const s = A().getSettings(); s.firmaRapporto = e.target.checked;
      try { await A().api('impostazioni', { method: 'PUT', body: JSON.stringify(s) }); A().toast(e.target.checked ? 'La firma andrà nel Mod. 0444.' : 'Mod. 0444 senza firma.'); }
      catch (x) { A().toast(x.message, true); }
    };
  }

  window.Firma = { init, get, presente, mostra };
})();
