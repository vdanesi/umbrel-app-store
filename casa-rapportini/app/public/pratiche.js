/* Rapportini — domande di congedo (Mod. 0319) e trasferte / interventi in reperibilità (Mod. 0692 + 0693) */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const A = () => window.App;
  const MAX_G = 10, MAX_V = 5;
  const TIPI_GIORNATA = [['R', 'R · reperibilità'], ['SC', 'SC'], ['FI', 'FI'], ['FN', 'FN'], ['FU', 'FU']];

  let cur = null;          // pratica aperta
  let saveTimer = null;
  let modelli = {};        // { '0319': byte, ... }

  // ---------- date e festivi ----------
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const dmy = s => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s.split('-').reverse().join('/') : '');
  function pasqua(y) {   // algoritmo di Meeus
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
      g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
      l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      mese = Math.floor((h + l - 7 * m + 114) / 31), giorno = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, mese - 1, giorno);
  }
  function festivi(y) {
    const s = new Set(['01-01', '01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-25', '12-26'].map(x => `${y}-${x}`));
    const p = pasqua(y); p.setDate(p.getDate() + 1); s.add(iso(p));   // Pasquetta
    return s;
  }
  function contaGiorni(dal, al) {
    if (!dal || !al || al < dal) return null;
    let cal = 0, lav = 0; const fest = {};
    for (let d = fromIso(dal); iso(d) <= al && cal < 400; d.setDate(d.getDate() + 1)) {
      cal++;
      const y = d.getFullYear(); fest[y] = fest[y] || festivi(y);
      const wd = d.getDay();
      if (wd !== 0 && wd !== 6 && !fest[y].has(iso(d))) lav++;
    }
    return { cal, lav };
  }

  // ---------- pdf-lib caricato solo quando serve ----------
  let pdfLibReady = null;
  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve();
    if (!pdfLibReady) pdfLibReady = new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf-lib.min.js'; s.onload = ok; s.onerror = () => { pdfLibReady = null; ko(new Error('Impossibile caricare pdf-lib')); };
      document.head.appendChild(s);
    });
    return pdfLibReady;
  }

  async function makePdf(code) {
    if (code === '0693' && cur.autoPropria !== false && cur.viaggi.some(v => v.itinerario && !v.km)) await kmMancanti(true);
    await flush();
    if (!modelli[code]) throw new Error(`Carica prima il modulo ${code} vuoto in Impostazioni → Moduli aziendali.`);
    await loadPdfLib();
    const res = await fetch('api/modelli/' + code);
    if (!res.ok) throw new Error(`Modulo ${code} non disponibile`);
    const s = A().getSettings();
    const data = { ...cur, tipoAuto: cur.tipoAuto || s.tipoAuto, euroKm: cur.euroKm || s.euroKm };
    if (data.tipo === 'trasferta' && data.autoPropria !== false && !data.viaggi.some(v => v.itinerario || v.km)) data.viaggi = viaggiDaGiornate();
    const bytes = await ModuliPdf.fill(code, await res.arrayBuffer(), data);
    return new Blob([bytes], { type: 'application/pdf' });
  }
  function fileName(code) {
    if (cur.tipo === 'congedo') return `Mod.${code} congedo ${cur.dal || ''}.pdf`.replace(/\s+/g, ' ');
    return `Mod.${code} trasferta ${String(cur.numero || '').replace(/[\\/:*?"<>|]/g, '-')} ${cur.data || ''}.pdf`.replace(/\s+/g, ' ');
  }
  async function openPdf(code, download) {
    // la finestra va aperta subito, nel clic, altrimenti il browser la blocca
    const w = download ? null : window.open('', '_blank');
    try {
      const blob = await makePdf(code);
      const url = URL.createObjectURL(blob);
      if (w) { w.location.href = url; }
      else {
        const a = document.createElement('a'); a.href = url; a.download = fileName(code);
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { if (w) w.close(); A().toast(e.message, true); }
  }

  /** PDF da un modulo aziendale con dati qualsiasi (usato anche dal rapporto giornaliero). */
  async function pdfDaModulo(code, data, opts, download, nome) {
    const w = download ? null : window.open('', '_blank');
    try {
      await loadModelli();
      if (!modelli[code]) throw new Error(`Il modulo ${code} vuoto non è ancora stato caricato: ` + (A().getSettings()?.utente?.admin ? 'caricalo in Impostazioni → Moduli aziendali.' : "chiedi all'amministratore di caricarlo."));
      await loadPdfLib();
      const res = await fetch('api/modelli/' + code);
      if (!res.ok) throw new Error(`Modulo ${code} non disponibile`);
      const bytes = await ModuliPdf.fill(code, await res.arrayBuffer(), data, opts || {});
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      if (w) w.location.href = url;
      else { const a = document.createElement('a'); a.href = url; a.download = nome || `Mod.${code}.pdf`; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { if (w) w.close(); A().toast(e.message, true); }
  }
  async function haModello(code) { await loadModelli(); return !!modelli[code]; }

  // ---------- salvataggio ----------
  function schedule() {
    A().status('modificato…');
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 600);
  }
  async function save() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!cur) return;
    try { const r = await A().api('pratiche/' + cur.id, { method: 'PUT', body: JSON.stringify(cur) }); cur.creato = r.creato; A().status('salvato ✓', 'ok'); }
    catch (e) { A().status('non salvato', 'err'); A().toast('Salvataggio non riuscito: ' + e.message, true); }
  }
  async function flush() { if (saveTimer) await save(); }

  // ---------- elenco ----------
  async function loadModelli() { try { modelli = await A().api('modelli'); } catch { modelli = {}; } return modelli; }

  async function showList() {
    A().show('praticheView');
    const list = $('pratList');
    list.innerHTML = '<div class="empty">Caricamento…</div>';
    const [items] = await Promise.all([A().api('pratiche'), loadModelli()]);
    const missing = Object.entries(modelli).filter(([, v]) => !v).map(([k]) => k);
    $('pratWarn').hidden = !missing.length;
    $('pratWarnList').textContent = missing.join(', ');
    if (!A().getSettings()?.utente?.admin) $('pratWarn').textContent = `Mancano i PDF vuoti dei moduli ${missing.join(', ')}: chiedi all'amministratore di caricarli in Impostazioni.`;
    list.innerHTML = '';
    if (!items.length) list.innerHTML = '<div class="empty">Nessuna domanda o trasferta. Creane una con i pulsanti qui sopra.</div>';
    for (const p of items) {
      const row = document.createElement('button');
      row.className = 'rep-row prat-row';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (p.tipo === 'congedo' ? 'b-congedo' : 'b-trasferta');
      badge.textContent = p.tipo === 'congedo' ? '0319 congedo' : '0692·0693 trasferta';
      const sub = document.createElement('span'); sub.className = 'rep-sub';
      const meta = document.createElement('span'); meta.className = 'rep-meta';
      if (p.tipo === 'congedo') {
        sub.textContent = `dal ${dmy(p.dal) || '…'} al ${dmy(p.al) || '…'}` + (p.motivo ? ` · ${p.motivo}` : '');
        meta.textContent = p.giornate ? `${p.giornate} gg` : '';
      } else {
        sub.textContent = `N° ${p.numero || '—'} · ${p.destinazione || 'destinazione da indicare'}` + (p.motivazione ? ` · ${p.motivazione}` : '');
        meta.textContent = dmy(p.data);
      }
      row.append(badge, sub, meta);
      row.onclick = () => A().go('#/m/' + p.id);
      list.appendChild(row);
    }
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  async function nuova(tipo) {
    const s = A().getSettings();
    const oggi = A().todayIso();
    const base = { id: uid(), tipo };
    if (tipo === 'congedo') {
      Object.assign(base, {
        anno: oggi.slice(0, 4), servizio: s.servizio, unita: s.unita, nome: s.agente, qualifica: s.qualifica,
        residenza: s.residenza, assunto: s.assunto, cid: s.cid, motivo: '', giornate: '', giornateManuale: false,
        dal: '', al: '', luogo: s.luogo || s.residenza, dataDomanda: oggi, recapito: s.recapito
      });
    } else {
      let numero = '';
      try {   // propongo il numero successivo all'ultima trasferta
        const prev = (await A().api('pratiche')).filter(p => p.tipo === 'trasferta' && p.numero);
        const m = prev.length && /^(\d+)(.*)$/.exec(String(prev[0].numero).trim());
        if (m) numero = String(Number(m[1]) + 1) + m[2];
      } catch { /* niente proposta */ }
      Object.assign(base, {
        numero, data: oggi, richiedente: s.agente, cid: s.cid, qualifica: s.qualifica, struttura: s.struttura || s.unita,
        destinazione: '', motivazione: 'Intervento in reperibilità', dataGiustificativo: oggi,
        giornate: [{ data: oggi, tipo: 'R', dalle: '', alle: '', totale: '' }], omesse: [],
        tipoAuto: s.tipoAuto, euroKm: s.euroKm,
        // riga di viaggio già pronta: andata e ritorno dalla residenza (si aggiorna con la destinazione)
        autoPropria: true, viaggi: []
      });
    }
    cur = base;
    await save();
    A().go('#/m/' + cur.id);
  }

  // ---------- editor ----------
  function input(label, key, opts = {}) {
    const l = document.createElement('label');
    if (opts.span) l.className = 'span2';
    l.append(label);
    const i = document.createElement(opts.area ? 'textarea' : 'input');
    if (opts.type) i.type = opts.type;
    if (opts.list) i.setAttribute('list', opts.list);
    if (opts.max) i.maxLength = opts.max;
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.inputmode) i.inputMode = opts.inputmode;
    const obj = opts.obj || cur;
    i.value = obj[key] ?? '';
    i.addEventListener('input', () => { obj[key] = i.value; opts.onInput?.(i); schedule(); });
    l.appendChild(i);
    if (opts.hintId) { const h = document.createElement('span'); h.className = 'hint'; h.id = opts.hintId; l.appendChild(h); }
    return l;
  }
  function section(title, ...children) {
    const s = document.createElement('section'); s.className = 'box';
    const h = document.createElement('h3'); h.innerHTML = '<span class="c-cyan">#</span> '; h.append(title);
    s.append(h, ...children);
    return s;
  }
  function grid(cls, ...kids) { const g = document.createElement('div'); g.className = 'form-grid ' + cls; g.append(...kids); return g; }
  function btn(text, cls, onClick) { const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.type = 'button'; b.textContent = text; b.onclick = onClick; return b; }
  function hint(text) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = text; return p; }

  function pdfButtons(codes) {
    const box = document.createElement('div'); box.className = 'pdf-actions';
    for (const c of codes) {
      const g = document.createElement('div'); g.className = 'pdf-group';
      const t = document.createElement('div'); t.className = 'pdf-title';
      t.innerHTML = `<b class="c-yellow">Mod. ${c}</b> <span class="muted"></span>`;
      t.lastChild.textContent = ModuliPdf.MODELLI[c].titolo;
      const row = document.createElement('div'); row.className = 'row-actions';
      row.append(btn('Apri PDF', 'btn-primary', () => openPdf(c, false)), btn('Scarica', '', () => openPdf(c, true)));
      if (!modelli[c]) { row.querySelectorAll('button').forEach(b => { b.disabled = true; }); const w = document.createElement('span'); w.className = 'hint'; w.textContent = 'Modulo vuoto non caricato (Impostazioni).'; row.appendChild(w); }
      g.append(t, row); box.appendChild(g);
    }
    return box;
  }

  function aggiornaGiorni() {
    const c = contaGiorni(cur.dal, cur.al);
    const h = $('hintGiorni');
    if (!c) { if (h) h.textContent = cur.dal && cur.al ? 'La data "al" è prima di "dal".' : ''; return; }
    if (!cur.giornateManuale) { cur.giornate = String(c.lav); const g = $('inGiornate'); if (g) g.value = cur.giornate; }
    if (h) h.textContent = `${c.lav} lavorativi (lun–ven, senza festivi) su ${c.cal} di calendario.` + (cur.giornateManuale ? ' Valore inserito a mano.' : '');
  }

  function renderCongedo(root) {
    const gi = input('Giornate N.', 'giornate', { inputmode: 'numeric', max: 6, onInput: i => { cur.giornateManuale = i.value.trim() !== ''; aggiornaGiorni(); }, hintId: 'hintGiorni' });
    gi.querySelector('input').id = 'inGiornate';
    root.append(
      section('Periodo',
        grid('g3',
          input('Dal', 'dal', { type: 'date', onInput: aggiornaGiorni }),
          input('Al', 'al', { type: 'date', onInput: aggiornaGiorni }),
          gi),
        grid('',
          input('Tipo di congedo / note (riga sotto la residenza)', 'motivo', { max: 120, list: 'dlMotivoCongedo', placeholder: 'es. Ferie', span: true }))),
      section('Richiedente',
        grid('g3',
          input('Cognome e nome', 'nome', { max: 120 }), input('Qualifica', 'qualifica', { max: 80 }), input('C.I.D.', 'cid', { max: 40, inputmode: 'numeric' }),
          input('Residenza', 'residenza', { max: 120 }), input('Assunto in servizio il', 'assunto', { type: 'date' }), input('Anno di concessione', 'anno', { max: 4, inputmode: 'numeric' }),
          input('Servizio', 'servizio', { max: 120 }), input('Unità organizzativa', 'unita', { max: 120 }))),
      section('Firma della domanda',
        grid('g3',
          input('Luogo (", lì")', 'luogo', { max: 60 }), input('Data della domanda', 'dataDomanda', { type: 'date' }),
          input("Recapito durante l'assenza", 'recapito', { max: 120 })),
        hint('Parere del capo, decisione del responsabile ed esito restano vuoti: li compilano loro.')),
      section('Stampa', pdfButtons(['0319']),
        hint('Il PDF contiene le tre parti del modulo (domanda, esito, ricevuta) con i tuoi dati già scritti. Stampalo su A4 al 100%.'))
    );
    aggiornaGiorni();
  }

  // ---- trasferta ----
  function durata(dalle, alle) { const d = A().between(dalle, alle); return d == null ? '' : A().fmtMin(d); }

  async function daRapportino(g) {
    if (!g.data) return false;
    let r;
    try { r = await A().api('rapporti/' + g.data); } catch { return false; }
    const lav = (r.lavori || []).filter(l => l.dalle && l.alle);
    if (!lav.length) return false;
    g.dalle = lav[0].dalle;
    g.alle = lav.at(-1).alle;
    g.totale = r.riepilogo?.oreStraord || r.riepilogo?.totaleOre || durata(g.dalle, g.alle);
    if (!cur.destinazione) cur.destinazione = lav.map(l => l.luogo).filter(Boolean)[0] || '';
    return true;
  }

  function tableRows(arr, cols, max, makeNew, title) {
    const wrap = document.createElement('div');
    const draw = () => {
      wrap.innerHTML = '';
      if (!arr.length) wrap.appendChild(hint('Nessuna riga.'));
      arr.forEach((g, i) => {
        const row = document.createElement('div'); row.className = 'grow ' + title;
        const n = document.createElement('span'); n.className = 'rownum'; n.textContent = i + 1;
        row.appendChild(n);
        for (const c of cols) {
          if (c.k === 'tipo') {
            const l = document.createElement('label'); l.textContent = c.label; l.dataset.f = c.k;
            const s = document.createElement('select');
            TIPI_GIORNATA.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; s.appendChild(o); });
            s.value = g.tipo || 'R';
            s.onchange = () => { g.tipo = s.value; schedule(); };
            l.appendChild(s); row.appendChild(l); continue;
          }
          const l = input(c.label, c.k, {
            obj: g, type: c.type, max: c.max, inputmode: c.inputmode, placeholder: c.placeholder,
            onInput: () => {
              if ((c.k === 'dalle' || c.k === 'alle') && 'totale' in g) {
                g.totale = durata(g.dalle, g.alle); row.querySelector('[data-k=totale]').value = g.totale;
              }
              if (c.k === 'itinerario') g.itAuto = false;
              if (c.k === 'km') g.kmAuto = false;
              if (c.k === 'km' || c.k === 'itinerario') aggiornaKm();
            }
          });
          l.dataset.f = c.k;
          l.querySelector('input').dataset.k = c.k;
          if (c.k === 'itinerario') l.querySelector('input').addEventListener('change', async () => {
            if (!g.km || g.kmAuto) { if (await calcolaKm(g, true)) { schedule(); mostraKm(); } }
          });
          if (c.k === 'importo') { l.querySelector('input').readOnly = true; l.querySelector('input').classList.add('auto'); }
          row.appendChild(l);
        }
        const tools = document.createElement('div'); tools.className = 'row-tools';
        if ('dalle' in g) {
          const b = document.createElement('button'); b.className = 'btn-icon'; b.type = 'button'; b.title = 'Prendi gli orari dal rapportino di quel giorno'; b.textContent = '↺';
          b.onclick = async () => { if (await daRapportino(g)) { draw(); schedule(); A().toast('Orari presi dal rapportino del ' + dmy(g.data)); } else A().toast('Nessun rapportino con orari per il ' + (dmy(g.data) || 'giorno indicato'), true); };
          tools.appendChild(b);
        }
        if ('km' in g) {
          const b = document.createElement('button'); b.className = 'btn-icon'; b.type = 'button'; b.title = 'Calcola i km stradali di questo itinerario'; b.textContent = 'km↻';
          b.onclick = async () => { b.disabled = true; if (await calcolaKm(g)) { schedule(); mostraKm(); A().toast(`${g.itinerario}: ${g.km} km`); } b.disabled = false; };
          tools.appendChild(b);
        }
        const del = document.createElement('button'); del.className = 'btn-icon'; del.type = 'button'; del.title = 'Togli riga'; del.textContent = '✕';
        del.onclick = () => { arr.splice(i, 1); draw(); aggiornaKm(); schedule(); };
        tools.appendChild(del);
        row.appendChild(tools);
        wrap.appendChild(row);
      });
      const add = btn('+ Aggiungi riga', '', () => { if (arr.length < max) { arr.push(makeNew()); draw(); schedule(); } });
      add.disabled = arr.length >= max;
      const ra = document.createElement('div'); ra.className = 'row-actions'; ra.appendChild(add);
      wrap.appendChild(ra);
      aggiornaKm();
    };
    draw();
    return wrap;
  }

  const numIt = v => { let t = String(v ?? '').trim(); if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); const n = parseFloat(t); return Number.isFinite(n) ? n : 0; };
  function aggiornaKm() {
    if (cur?.tipo !== 'trasferta') return;
    const ekm = numIt(cur.euroKm);
    let km = 0, tot = 0;
    for (const v of cur.viaggi) { const k = numIt(v.km); km += k; tot += Math.round(k * ekm * 100) / 100; }
    const w = $('kmWarn');
    if (w) {
      const conViaggi = cur.viaggi.some(v => v.itinerario || numIt(v.km));
      let msg = '';
      if (cur.autoPropria === false) msg = '';
      else if (!conViaggi) msg = 'Rimborso km: nessun viaggio inserito, nel Mod. 0693 il riquadro VIAGGIO resterà vuoto. Aggiungi una riga in "Viaggio con auto propria" se hai usato l\'auto.';
      else if (!km) msg = 'Rimborso km: manca il numero di km nei viaggi.';
      else if (!ekm) msg = 'Rimborso km: manca il coefficiente €/km, l\'importo resterà vuoto.';
      else if (!cur.tipoAuto) msg = 'Rimborso km: manca il tipo di auto.';
      w.textContent = msg; w.hidden = !msg;
    }
    const el = $('kmTot');
    if (el) el.textContent = `${String(km).replace('.', ',')} km × ${ekm ? String(cur.euroKm).replace('.', ',') : '—'} €/km = € ${tot.toFixed(2).replace('.', ',')}`;
  }

  /** Itinerario proposto: luogo di partenza - destinazione - luogo di partenza. */
  let kmNoti = {};   // itinerario → km usati l'ultima volta
  async function caricaKmNoti() {
    kmNoti = {};
    try {
      const all = await A().api('pratiche');
      // dalla più vecchia alla più recente: vince l'ultimo valore
      for (const p of all.slice().reverse()) for (const v of p.viaggi || []) if (v.itinerario && v.km) kmNoti[v.itinerario.trim().toLowerCase()] = v.km;
    } catch { /* niente suggerimenti */ }
  }
  function itinerarioProposto() {
    const s = A().getSettings();
    const base = s.luogo || s.residenza || '';
    if (!cur.destinazione) return '';
    return base ? `${base} - ${cur.destinazione} - ${base}` : cur.destinazione;
  }
  const kmPer = it => kmNoti[(it || '').trim().toLowerCase()] || '';

  /** Km stradali dell'itinerario calcolati dal server (mappe OpenStreetMap). */
  async function calcolaKm(v, silenzioso) {
    if (!v.itinerario || !v.itinerario.trim()) { if (!silenzioso) A().toast("Scrivi prima l'itinerario, es. \"Brescia - Iseo - Brescia\".", true); return false; }
    try {
      const r = await A().api('distanza?itinerario=' + encodeURIComponent(v.itinerario));
      v.km = String(r.km); v.kmAuto = true;
      kmNoti[v.itinerario.trim().toLowerCase()] = v.km;
      return true;
    } catch (e) { if (!silenzioso) A().toast('Km non calcolati: ' + e.message, true); return false; }
  }
  function mostraKm() {
    const kms = document.querySelectorAll('.g-viaggio [data-k=km]');
    cur.viaggi.forEach((v, i) => { if (kms[i] && kms[i] !== document.activeElement) kms[i].value = v.km || ''; });
    aggiornaKm();
  }
  /** Completa i km mancanti (o calcolati in automatico) di tutte le righe. */
  async function kmMancanti(silenzioso = true) {
    let n = 0, err = 0;
    const fatti = {};
    for (const v of cur.viaggi) {
      if (!v.itinerario || (v.km && !v.kmAuto)) continue;
      const k = v.itinerario.trim().toLowerCase();
      if (fatti[k]) { v.km = fatti[k]; v.kmAuto = true; n++; continue; }
      if (await calcolaKm(v, true)) { fatti[k] = v.km; n++; } else err++;
    }
    if (n) { schedule(); mostraKm(); }
    if (err && !silenzioso) A().toast('Per alcune righe i km non sono stati calcolati: controlla le località o inseriscili a mano.', true);
    return n;
  }
  /** Una riga di viaggio per ogni giornata della trasferta (andata e ritorno). */
  function viaggiDaGiornate() {
    const it = itinerarioProposto();
    const date = [...new Set([...cur.giornate, ...cur.omesse].map(g => g.data).filter(Boolean))].sort();
    if (!date.length) date.push(cur.data || A().todayIso());
    return date.slice(0, MAX_V).map(d => ({ data: d, itinerario: it, km: kmPer(it), itAuto: true, kmAuto: true }));
  }
  function itinerariAuto() {
    const it = itinerarioProposto();
    if (!it) return;
    const its = document.querySelectorAll('.g-viaggio [data-k=itinerario]');
    const kms = document.querySelectorAll('.g-viaggio [data-k=km]');
    cur.viaggi.forEach((v, i) => {
      if (!v.itAuto) return;
      if (v.itinerario !== it && (!v.km || v.kmAuto || v.itAuto)) { v.km = kmPer(it); v.kmAuto = true; if (kms[i]) kms[i].value = v.km; }
      v.itinerario = it; if (its[i]) its[i].value = it;
    });
    aggiornaKm();
    clearTimeout(itinerariAuto.t);
    itinerariAuto.t = setTimeout(() => kmMancanti(true), 1200);   // quando smetti di scrivere la destinazione
  }

  function renderTrasferta(root) {
    const nuovaGiornata = () => {
      const last = cur.giornate.at(-1);
      let d = cur.data || A().todayIso();
      if (last?.data) { const x = fromIso(last.data); x.setDate(x.getDate() + 1); d = iso(x); }
      return { data: d, tipo: 'R', dalle: '', alle: '', totale: '' };
    };
    const kmBox = document.createElement('p'); kmBox.className = 'km-tot'; kmBox.id = 'kmTot';
    const fill = btn('↺ Orari dai rapportini', '', async () => {
      let n = 0;
      for (const g of cur.giornate) if (await daRapportino(g)) n++;
      for (const g of cur.omesse) if (await daRapportino(g)) n++;
      A().toast(n ? `Aggiornate ${n} righe dai rapportini.` : 'Nessun rapportino con orari per queste date.', !n);
      if (n) { schedule(); render(); }
    });
    root.append(
      section('Lettera di incarico (Mod. 0692)',
        grid('g3',
          input('Trasferta N°', 'numero', { max: 30 }), input('Data', 'data', { type: 'date' }),
          input('Incaricato a recarsi a', 'destinazione', { max: 120, list: 'dlLuogo', onInput: itinerariAuto })),
        grid('', input('Motivazione della trasferta', 'motivazione', { max: 200, span: true, list: 'dlMotivazione' })),
        grid('g3',
          input('Il richiedente', 'richiedente', { max: 120 }), input('C.I.D. N.', 'cid', { max: 40, inputmode: 'numeric' }),
          input('Qualifica', 'qualifica', { max: 80 }), input('Struttura organizzativa', 'struttura', { max: 120 }))),
      section('Giornate con timbratura di inizio e fine (Mod. 0693)',
        tableRows(cur.giornate, [
          { k: 'data', label: 'Data', type: 'date' }, { k: 'tipo', label: 'Tipo giornata' },
          { k: 'dalle', label: 'Dalle ore', type: 'time' }, { k: 'alle', label: 'Alle ore', type: 'time' },
          { k: 'totale', label: 'Totale straord./flex', placeholder: '0:00', max: 6 }
        ], MAX_G, nuovaGiornata, 'g-timb'),
        (() => { const d = document.createElement('div'); d.className = 'row-actions'; d.appendChild(fill); return d; })(),
        hint('R = reperibilità. Il totale si calcola da "dalle/alle"; con ↺ prendi orari e straordinario dal rapportino di quel giorno.')),
      section('Giornate con omessa timbratura',
        tableRows(cur.omesse, [
          { k: 'data', label: 'Data', type: 'date' }, { k: 'tipo', label: 'Tipo giornata' },
          { k: 'dalle', label: 'Dalle ore', type: 'time' }, { k: 'alle', label: 'Alle ore', type: 'time' },
          { k: 'totale', label: 'Totale', placeholder: '0:00', max: 6 },
          { k: 'motivo', label: 'Motivazione omessa timbratura', max: 160 }
        ], MAX_G, () => ({ data: cur.data || '', tipo: 'R', dalle: '', alle: '', totale: '', motivo: '' }), 'g-omessa')),
      section('Viaggio con auto propria (rimborso km)',
        (() => {
          const l = document.createElement('label'); l.className = 'check';
          const c = document.createElement('input'); c.type = 'checkbox'; c.checked = cur.autoPropria !== false;
          c.onchange = () => {
            cur.autoPropria = c.checked;
            if (c.checked && !cur.viaggi.some(v => v.itinerario || v.km)) cur.viaggi.splice(0, cur.viaggi.length, ...viaggiDaGiornate());
            schedule(); render();
          };
          l.append(c, ' Ho usato l\'auto propria: compila il riquadro VIAGGIO del Mod. 0693');
          return l;
        })(),
        ...(cur.autoPropria === false ? [hint('Riquadro VIAGGIO lasciato vuoto.')] : [grid('g3',
          input('Tipo di auto', 'tipoAuto', { max: 120, onInput: aggiornaKm }),
          input('€/km (coefficiente ACI)', 'euroKm', { max: 12, inputmode: 'decimal', placeholder: 'es. 0,35', onInput: aggiornaKm })),
        tableRows(cur.viaggi, [
          { k: 'data', label: 'Data', type: 'date' }, { k: 'itinerario', label: 'Itinerario', max: 160 },
          { k: 'km', label: 'Km', inputmode: 'decimal', max: 8 }
        ], MAX_V, () => { const it = itinerarioProposto(); const last = cur.viaggi.at(-1); return { data: last?.data || cur.data || '', itinerario: it, km: kmPer(it), itAuto: true }; }, 'g-viaggio'),
        (() => { const d = document.createElement('div'); d.className = 'row-actions';
          d.appendChild(btn('↺ Una riga per ogni giornata', '', () => { cur.viaggi.splice(0, cur.viaggi.length, ...viaggiDaGiornate()); schedule(); render(); kmMancanti(false); }));
          d.appendChild(btn('Calcola i km', '', async e => {
            const b = e.currentTarget; b.disabled = true;
            cur.viaggi.forEach(v => { if (v.kmAuto) v.km = ''; });
            const n = await kmMancanti(false);
            if (n) A().toast(`Km calcolati per ${n} ${n === 1 ? 'riga' : 'righe'}.`);
            b.disabled = false;
          }));
          return d; })(),
        kmBox,
        hint("Solo per pronto intervento in linea quando non è possibile usare il mezzo aziendale. Itinerario proposto: andata e ritorno dal luogo delle Impostazioni. I km si calcolano da soli sul percorso stradale (serve internet sull'Umbrel) e si possono correggere a mano. Importo = km × €/km.")])),
      section('Stampa',
        grid('g3', input('Data del giustificativo', 'dataGiustificativo', { type: 'date' })),
        (() => { const w = document.createElement('p'); w.className = 'warn-box'; w.id = 'kmWarn'; w.hidden = true; return w; })(),
        pdfButtons(['0692', '0693']))
    );
    aggiornaKm();
  }

  function render() {
    const root = $('pratBody');
    root.innerHTML = '';
    const congedo = cur.tipo === 'congedo';
    $('pratTitle').textContent = congedo ? 'Domanda di congedo' : 'Trasferta / intervento in reperibilità';
    $('tabRepName').textContent = congedo ? 'Congedo' : 'Trasferta ' + (cur.numero || '');
    if (congedo) renderCongedo(root); else renderTrasferta(root);
  }

  async function openPratica(id) {
    await flush();
    if (!cur || cur.id !== id) cur = await A().api('pratiche/' + id);
    if (cur.tipo === 'trasferta') {
      cur.giornate ||= []; cur.omesse ||= []; cur.viaggi ||= [];
      const s = A().getSettings();   // auto ed €/km mancanti: li prendo dalle impostazioni
      if (!cur.tipoAuto && s.tipoAuto) cur.tipoAuto = s.tipoAuto;
      if (!cur.euroKm && s.euroKm) cur.euroKm = s.euroKm;
    }
    await Promise.all([loadModelli(), caricaKmNoti()]);
    if (cur.tipo === 'trasferta' && cur.autoPropria !== false && !cur.viaggi.some(v => v.itinerario || v.km)) {
      cur.viaggi.splice(0, cur.viaggi.length, ...viaggiDaGiornate());   // pratiche create prima: preparo le righe
    }
    if (cur.tipo === 'trasferta' && cur.autoPropria !== false) setTimeout(() => kmMancanti(true), 50);
    A().show('praticaView');
    $('tabRep').hidden = false;
    render();
    A().status('salvato', 'ok');
  }

  // ---------- impostazioni: modelli PDF ----------
  async function renderModelliSettings() {
    await loadModelli();
    const box = $('modelliList'); if (!box) return;
    box.innerHTML = '';
    for (const [c, info] of Object.entries(ModuliPdf.MODELLI)) {
      const row = document.createElement('div'); row.className = 'modello-row';
      const t = document.createElement('div');
      t.innerHTML = `<b class="c-yellow">Mod. ${c}</b> <span></span><br><small></small>`;
      t.querySelector('span').textContent = info.titolo;
      const st = t.querySelector('small');
      st.textContent = modelli[c] ? `caricato (${Math.round(modelli[c] / 1024)} KB)` : 'non caricato';
      st.className = modelli[c] ? 'ok-text' : 'err-text';
      const lab = document.createElement('label'); lab.className = 'btn';
      lab.append(modelli[c] ? 'Sostituisci PDF' : 'Carica PDF');
      const f = document.createElement('input'); f.type = 'file'; f.accept = 'application/pdf,.pdf'; f.hidden = true;
      f.onchange = async () => {
        const file = f.files[0]; f.value = '';
        if (!file) return;
        try {
          const res = await fetch('api/modelli/' + c, { method: 'PUT', headers: { 'X-Rapportini': '1', 'Content-Type': 'application/pdf' }, body: file });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.errore || 'Caricamento non riuscito');
          A().toast(`Modulo ${c} caricato.`); renderModelliSettings();
        } catch (e) { A().toast(e.message, true); }
      };
      lab.appendChild(f);
      if (A().getSettings()?.utente?.admin) row.append(t, lab);
      else { const h = document.createElement('small'); h.className = 'muted'; h.textContent = modelli[c] ? '' : "lo carica l'amministratore"; row.append(t, h); }
      box.appendChild(row);
    }
  }

  // ---------- routing ----------
  async function route(h) {
    let m;
    if (h === 'moduli') { await flush(); cur = null; await showList(); return true; }
    if ((m = /^m\/([a-z0-9-]{8,64})$/i.exec(h))) { await openPratica(m[1]); return true; }
    await flush(); cur = null;
    return false;
  }

  function init() {
    $('tabModuli').onclick = () => A().go('#/moduli');
    $('btnNewCongedo').onclick = () => nuova('congedo').catch(e => A().toast(e.message, true));
    $('btnNewTrasferta').onclick = () => nuova('trasferta').catch(e => A().toast(e.message, true));
    $('btnPratDelete').onclick = async () => {
      if (!cur || !confirm('Eliminare questa pratica?')) return;
      clearTimeout(saveTimer); saveTimer = null;
      try { await A().api('pratiche/' + cur.id, { method: 'DELETE' }); cur = null; A().toast('Pratica eliminata'); A().go('#/moduli'); }
      catch (e) { A().toast(e.message, true); }
    };
    $('btnPratDup').onclick = async () => {
      if (!cur) return;
      await flush();
      const copy = JSON.parse(JSON.stringify(cur));
      copy.id = uid(); delete copy.creato;
      const oggi = A().todayIso();
      if (copy.tipo === 'trasferta') {
        const m = /^(\d+)(.*)$/.exec(String(copy.numero || '').trim());
        copy.numero = m ? String(Number(m[1]) + 1) + m[2] : '';
        copy.data = oggi; copy.dataGiustificativo = oggi;
        copy.giornate = [{ data: oggi, tipo: 'R', dalle: '', alle: '', totale: '' }]; copy.omesse = [];
        copy.viaggi = copy.viaggi.map(v => ({ ...v, data: oggi }));
      } else { copy.dal = ''; copy.al = ''; copy.giornate = ''; copy.giornateManuale = false; copy.dataDomanda = oggi; }
      cur = copy; await save();
      A().go('#/m/' + cur.id); A().toast('Copia creata: controlla date e numero.');
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }

  window.Pratiche = { init, route, renderModelliSettings, flush, pdfDaModulo, haModello };
})();
