/* Rapportini — disegno del Mod. 0444 "Rapporto giornaliero dell'agente".
 * Le coordinate sono rilevate dal modulo cartaceo (fotografia di 2237 x 1640 punti)
 * e convertite in millimetri su un foglio A4 orizzontale (297 x 210 mm).
 * In modalità "overlay" restano visibili solo i dati, da stampare sul modulo prestampato. */
(function () {
  'use strict';
  const KX = 297 / 2237, KY = 210 / 1640;
  const X = p => (p * KX).toFixed(2) + 'mm';
  const Y = p => (p * KY).toFixed(2) + 'mm';
  const W = p => (p * KX).toFixed(2) + 'mm';
  const H = p => (p * KY).toFixed(2) + 'mm';

  // ----- geometria del modulo (punti della foto) -----
  const T1 = { x: [167, 561, 653, 1747, 1858, 1952, 2045, 2133], top: 400, head: 455, bottom: 927, rows: 9 };
  const T2 = { x: [162, 557, 1430, 1561, 1653, 1745], top: 957, head: 1010, bottom: 1488, rows: 9 };
  const RIEP = { x: [1747, 2045, 2133], top: 957, rowH: 52.75, labels: ['totale ore', 'ore straord.', 'trasferte', 'surrogazioni'] };
  const rowY = (t, i) => t.head + (t.bottom - t.head) / t.rows * i;
  const rowH = t => (t.bottom - t.head) / t.rows;

  const HEAD = [
    // [etichetta, x etichetta, inizio linea, fine linea, linea y, grassetto, chiave]
    ['AGENTE', 170, 288, 930, 307, true, 'agente'],
    ['QUALIFICA', 941, 1097, 1372, 307, true, 'qualifica'],
    ['CID', 1382, 1434, 1590, 307, true, 'cid'],
    ['RAPPORTO DEL GIORNO', 1600, 1922, 2133, 307, true, 'data'],
    ['RESIDENZA DI SERVIZIO', 168, 480, 930, 372, false, 'residenza'],
    ['SERVIZIO', 937, 1062, 1590, 372, false, 'servizio'],
    ['UNITÀ', 1595, 1677, 2133, 372, false, 'unita']
  ];
  const FIRME = [["L'agente", 158, 256, 652], ['Il Capo Operatori', 662, 868, 1158], ['Il Capo Unità Tecnica', 1166, 1405, 1655], ['Ufficio Tecnico', 1668, 1840, 2133]];

  function el(parent, cls, css, text) {
    const d = document.createElement('div');
    d.className = cls;
    Object.assign(d.style, css);
    if (text != null) d.textContent = text;
    parent.appendChild(d);
    return d;
  }
  const pre = (f, cls, css, text) => el(f, 'pre ' + cls, css, text);
  const lbl = (f, text, x, y, opt = {}) => pre(f, 'lbl' + (opt.b ? ' b' : '') + (opt.c ? ' c' : ''),
    { left: X(x), top: Y(y), ...(opt.w ? { width: W(opt.w) } : {}), ...(opt.size ? { fontSize: opt.size } : {}) }, text);
  const hline = (f, x1, x2, y, cls = 'ln') => pre(f, cls, { left: X(x1), top: Y(y), width: W(x2 - x1) });
  const vline = (f, x, y1, y2) => pre(f, 'vl', { left: X(x), top: Y(y1), height: H(y2 - y1) });
  const box = (f, x1, y1, x2, y2) => pre(f, 'bx', { left: X(x1), top: Y(y1), width: W(x2 - x1), height: H(y2 - y1) });

  /** Valore in un rettangolo (punti della foto). */
  function val(f, text, x1, y1, x2, y2, cls = '') {
    if (text == null || text === '') return null;
    const d = el(f, 'val ' + cls, { left: X(x1), top: Y(y1), width: W(x2 - x1), height: H(y2 - y1) });
    if (cls.includes('wrap')) { const s = document.createElement('span'); s.textContent = text; d.appendChild(s); }
    else d.textContent = text;
    return d;
  }

  function dataIt(iso) {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }

  function drawForm(f, codice3) {
    // intestazione (il logo è già sul modulo cartaceo)
    lbl(f, 'Mod. 0444', 1925, 62, { b: true, size: '7pt' });
    lbl(f, 'Rev.01', 2062, 62, { size: '7pt' });
    vline(f, 1393, 110, 232);
    lbl(f, "RAPPORTO GIORNALIERO DELL'AGENTE", 1458, 152, { b: true, size: '11pt' });

    for (const [t, lx, x1, x2, y, b] of HEAD) {
      lbl(f, t, lx, y - 26, { b });
      hline(f, x1, x2, y);
    }

    // tabella lavori
    box(f, T1.x[0], T1.top, T1.x.at(-1), T1.bottom);
    hline(f, T1.x[0], T1.x.at(-1), T1.head);
    [1, 2, 3, 4, 6].forEach(i => vline(f, T1.x[i], T1.top, T1.bottom));
    vline(f, T1.x[5], 428, T1.bottom);
    hline(f, T1.x[4], T1.x[6], 428);
    for (let i = 1; i < T1.rows; i++) hline(f, T1.x[0], T1.x.at(-1), rowY(T1, i), 'dot');
    const hc = (t, a, b, y, extra = {}) => lbl(f, t, T1.x[a], y, { c: true, w: T1.x[b] - T1.x[a], ...extra });
    hc('luogo di lavoro', 0, 1, 418);
    lbl(f, 'treni', T1.x[1], 407, { c: true, w: T1.x[2] - T1.x[1], size: '6.6pt' });
    lbl(f, 'usufr. N.', T1.x[1], 428, { c: true, w: T1.x[2] - T1.x[1], size: '6.6pt' });
    hc('DESCRIZIONE DEL LAVORO', 2, 3, 418);
    lbl(f, 'sigilli', T1.x[3], 407, { c: true, w: T1.x[4] - T1.x[3], size: '6.6pt' });
    lbl(f, 'tolti', T1.x[3], 428, { c: true, w: T1.x[4] - T1.x[3], size: '6.6pt' });
    hc('durata', 4, 6, 405);
    hc('dalle', 4, 5, 433, { size: '6.8pt' });
    hc('alle', 5, 6, 433, { size: '6.8pt' });
    hc('ORE', 6, 7, 418);

    // tabella anormalità + moduli emessi
    box(f, T2.x[0], T2.top, T2.x.at(-1), T2.bottom);
    hline(f, T2.x[0], T2.x.at(-1), T2.head);
    vline(f, T2.x[1], T2.top, T2.bottom);
    vline(f, T2.x[2], T2.top, T2.bottom);
    vline(f, T2.x[3], T2.head, T2.bottom);
    vline(f, T2.x[4], T2.head, T2.bottom);
    for (let i = 1; i < T2.rows; i++) hline(f, T2.x[0], T2.x.at(-1), rowY(T2, i), 'dot');
    lbl(f, 'località', T2.x[0], 975, { c: true, w: T2.x[1] - T2.x[0] });
    lbl(f, 'ANORMALITÀ - OSSERVAZIONI - MATERIALI', T2.x[1], 975, { c: true, w: T2.x[2] - T2.x[1] });
    lbl(f, 'MODULI EMESSI', T2.x[2], 975, { c: true, w: T2.x[5] - T2.x[2] });
    const y0 = rowY(T2, 0), h0 = rowH(T2);
    lbl(f, '0229', T2.x[2], y0 + h0 - 26, { w: T2.x[3] - T2.x[2] - 14, c: true });
    lbl(f, '0452', T2.x[3], y0 + h0 - 26, { w: T2.x[4] - T2.x[3], c: true });
    if (!codice3) lbl(f, '.......', T2.x[4], y0 + h0 - 26, { w: T2.x[5] - T2.x[4], c: true });
    for (let i = 1; i < T2.rows; i++) lbl(f, 'N.', T2.x[2] + 8, rowY(T2, i) + h0 - 24);

    // riepilogo ore
    box(f, RIEP.x[0], RIEP.top, RIEP.x[2], RIEP.top + RIEP.rowH * 4);
    vline(f, RIEP.x[1], RIEP.top, RIEP.top + RIEP.rowH * 4);
    RIEP.labels.forEach((t, i) => {
      if (i) hline(f, RIEP.x[0], RIEP.x[2], RIEP.top + RIEP.rowH * i);
      lbl(f, t, RIEP.x[0], RIEP.top + RIEP.rowH * i + 18, { c: true, w: RIEP.x[1] - RIEP.x[0] });
    });
    hline(f, 1745, 2133, T2.bottom);

    // firme
    for (const [t, lx, x1, x2] of FIRME) {
      lbl(f, t, lx, 1528, { b: true });
      hline(f, x1, x2, 1553);
    }
    hline(f, 158, 2133, 1572);
  }

  function drawValues(f, r, codice3) {
    const h = r.testata || {};
    for (const [, , x1, x2, y, , k] of HEAD) {
      const v = k === 'data' ? dataIt(r.data) : h[k];
      val(f, v, x1 + 4, y - 42, x2, y - 2);
    }
    const hh = rowH(T1);
    (r.lavori || []).slice(0, T1.rows).forEach((l, i) => {
      const y1 = rowY(T1, i) + 2, y2 = y1 + hh - 3;
      val(f, l.luogo, T1.x[0], y1, T1.x[1], y2, 'wrap');
      val(f, l.treni, T1.x[1], y1, T1.x[2], y2, 'c');
      val(f, l.descrizione, T1.x[2], y1, T1.x[3], y2, 'wrap');
      val(f, l.sigilli, T1.x[3], y1, T1.x[4], y2, 'c');
      val(f, l.dalle, T1.x[4], y1, T1.x[5], y2, 'c');
      val(f, l.alle, T1.x[5], y1, T1.x[6], y2, 'c');
      val(f, l.ore, T1.x[6], y1, T1.x[7], y2, 'c');
    });
    const h2 = rowH(T2);
    (r.anomalie || []).slice(0, T2.rows).forEach((a, i) => {
      const y1 = rowY(T2, i) + 2, y2 = y1 + h2 - 3;
      val(f, a.localita, T2.x[0], y1, T2.x[1], y2, 'wrap');
      val(f, a.testo, T2.x[1], y1, T2.x[2], y2, 'wrap');
    });
    const m = r.moduli || {};
    const code3 = m.codice3 || codice3;
    if (code3) val(f, code3, T2.x[4], rowY(T2, 0) + 2, T2.x[5], rowY(T2, 1) - 2, 'c code');
    [['m0229', 2, 3, 40], ['m0452', 3, 4, 0], ['m3', 4, 5, 0]].forEach(([k, a, b, pad]) => {
      (m[k] || []).slice(0, 8).forEach((n, i) => {
        const y1 = rowY(T2, i + 1) + 2;
        val(f, n, T2.x[a] + pad, y1, T2.x[b], y1 + h2 - 3, 'c');
      });
    });
    const rr = r.riepilogo || {};
    [rr.totaleOre, rr.oreStraord, rr.trasferte, rr.surrogazioni].forEach((v, i) => {
      const y1 = RIEP.top + RIEP.rowH * i + 2;
      val(f, v, RIEP.x[1], y1, RIEP.x[2], y1 + RIEP.rowH - 3, 'c');
    });
  }

  /** Riduce il carattere finché il testo entra nella casella. */
  function fitAll(sheet) {
    sheet.querySelectorAll('.val').forEach(d => {
      let size = 9.5;
      d.style.fontSize = size + 'pt';
      const inner = d.firstElementChild || d;
      const over = () => d.scrollWidth > d.clientWidth + 1 || d.scrollHeight > d.clientHeight + 1 || inner.scrollHeight > d.clientHeight + 1;
      while (over() && size > 5.2) { size -= 0.3; d.style.fontSize = size.toFixed(1) + 'pt'; }
      if (over()) d.classList.add('troncato');
    });
  }

  /**
   * Crea il foglio.
   * mode: 'full' (modulo completo) | 'overlay' (solo dati) | 'test' (foglio di prova per la calibrazione)
   */
  function build(report, settings, mode) {
    const s = settings || {};
    const st = s.stampa || {};
    const sheet = document.createElement('div');
    sheet.className = 'sheet' + (mode === 'full' ? '' : ' overlay');
    const frame = el(sheet, 'frame', {});
    if (mode !== 'full') {
      // calibrazione: spostamento e scala rispetto al modulo cartaceo
      const sc = (Number(st.scala) || 100) / 100;
      frame.style.transform = `translate(${Number(st.offsetX) || 0}mm, ${Number(st.offsetY) || 0}mm) scale(${sc})`;
    }
    drawForm(frame, (report && report.moduli && report.moduli.codice3) || s.codiceModulo3);
    if (mode === 'test') {
      const pts = [[T1.x[0], T1.top], [T1.x.at(-1), T1.top], [T1.x[0], T1.bottom], [T1.x.at(-1), T1.bottom],
        [T2.x[0], T2.top], [T2.x.at(-1), T2.bottom], [RIEP.x[2], RIEP.top], [288, 307], [2133, 372]];
      pts.forEach(([x, y]) => el(frame, 'cross', { left: X(x), top: Y(y) }));
      el(sheet, 'testnote', {}, 'Foglio di prova Rapportini — le crocette rosse devono cadere sugli angoli delle tabelle del modulo.');
      drawValues(frame, {
        data: new Date().toISOString().slice(0, 10),
        testata: { agente: 'ROSSI MARIO', qualifica: 'Qualifica', cid: '123456', residenza: 'Residenza', servizio: 'Servizio', unita: 'Unità' },
        lavori: [{ luogo: 'Luogo di lavoro', treni: '1234', descrizione: 'Descrizione del lavoro di prova', sigilli: '2', dalle: '07:00', alle: '12:00', ore: '5:00' }],
        anomalie: [{ localita: 'Località', testo: 'Riga di prova per anormalità e osservazioni' }],
        moduli: { m0229: ['001'], m0452: ['002'], m3: ['003'] },
        riepilogo: { totaleOre: '8:00', oreStraord: '0:00', trasferte: '1', surrogazioni: '—' }
      }, s.codiceModulo3);
    } else {
      drawValues(frame, report || {}, s.codiceModulo3);
    }
    return sheet;
  }

  window.Modulo0444 = { build, fitAll };
})();
