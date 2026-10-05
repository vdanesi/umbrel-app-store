/* Rapportini — logica dell'app */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const MAX_LAV = 9, MAX_ANO = 9, MAX_MOD = 8;
  const GIORNI = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

  let settings = null;
  let rep = null;           // rapporto aperto
  let repExists = false;    // già salvato sul server
  let month = todayIso().slice(0, 7);
  let printMode = 'full';
  let saveTimer = null, settingsTimer = null;

  // ---------- utilità ----------
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const pad = n => String(n).padStart(2, '0');
  const toMin = s => { const m = /^(\d{1,3}):([0-5]\d)$/.exec((s || '').trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const fmtMin = m => `${Math.floor(m / 60)}:${pad(m % 60)}`;
  function between(a, b) {
    const x = toMin(a), y = toMin(b);
    if (x == null || y == null) return null;
    let d = y - x; if (d < 0) d += 1440;   // turno che passa la mezzanotte
    return d;
  }
  function dateLong(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function dateShort(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return { txt: `${GIORNI[dt.getDay()]} ${pad(d)}/${pad(m)}`, weekend: dt.getDay() === 0 || dt.getDay() === 6 };
  }
  function toast(msg, err) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2500);
  }
  function status(txt, cls = '') { const s = $('saveStatus'); s.textContent = txt; s.className = 'save-status ' + cls; }

  async function api(path, opts = {}) {
    const res = await fetch('api/' + path, {
      ...opts,
      headers: { 'X-Rapportini': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }
    });
    let body = null; try { body = await res.json(); } catch { /* nessun corpo */ }
    if (!res.ok) { const e = new Error(body?.errore || `Errore ${res.status}`); e.status = res.status; throw e; }
    return body;
  }

  // ---------- viste ----------
  const VIEWS = ['homeView', 'editView', 'previewView', 'settingsView'];
  function show(view) {
    VIEWS.forEach(v => { $(v).hidden = v !== view; });
    $('tabRep').hidden = !(view === 'editView' || view === 'previewView');
    $('tabSettings').classList.toggle('on', view === 'settingsView');
    window.scrollTo(0, 0);
  }

  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    let m;
    try {
      if ((m = /^r\/(\d{4}-\d\d-\d\d)\/stampa$/.exec(h))) { await openReport(m[1]); openPreview(); }
      else if ((m = /^r\/(\d{4}-\d\d-\d\d)$/.exec(h))) { await openReport(m[1]); show('editView'); }
      else if (h === 'impostazioni') { await flushSave(); fillSettings(); show('settingsView'); }
      else { await flushSave(); rep = null; show('homeView'); loadMonth(); }
    } catch (e) { toast(e.message, true); }
  }
  const go = h => { if (location.hash === h) route(); else location.hash = h; };

  // ---------- elenco del mese ----------
  async function loadMonth() {
    const [y, m] = month.split('-').map(Number);
    $('monthTitle').textContent = new Date(y, m - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
    const list = $('repList');
    list.innerHTML = '<div class="empty">Caricamento…</div>';
    let reps;
    try { reps = await api('rapporti?mese=' + month); }
    catch (e) { list.innerHTML = ''; toast(e.message, true); return; }
    reps.sort((a, b) => b.data.localeCompare(a.data));
    list.innerHTML = '';
    if (!reps.length) list.innerHTML = '<div class="empty">Nessun rapporto in questo mese.</div>';
    for (const r of reps) {
      const d = dateShort(r.data);
      const row = document.createElement('button');
      row.className = 'rep-row' + (d.weekend ? ' weekend' : '');
      row.innerHTML = '<span class="rep-date"></span><span class="rep-sub"></span><span class="rep-meta"></span>';
      row.children[0].textContent = d.txt;
      const sub = row.children[1];
      sub.textContent = [r.servizio, r.luoghi].filter(Boolean).join(' · ') || '—';
      if (r.lavori) { const s = document.createElement('span'); s.className = 'muted'; s.textContent = `(${r.lavori} ${r.lavori === 1 ? 'lavoro' : 'lavori'})`; sub.appendChild(s); }
      const meta = row.children[2];
      meta.textContent = r.totaleMin ? fmtMin(r.totaleMin) + ' h' : '—';
      if (r.straordMin) { const x = document.createElement('span'); x.className = 'x'; x.textContent = '+' + fmtMin(r.straordMin); meta.appendChild(x); }
      row.onclick = () => go('#/r/' + r.data);
      list.appendChild(row);
    }
    const tot = reps.reduce((a, r) => a + r.totaleMin, 0);
    const str = reps.reduce((a, r) => a + r.straordMin, 0);
    const trasf = reps.reduce((a, r) => { const n = parseFloat(String(r.trasferte).replace(',', '.')); return a + (Number.isFinite(n) ? n : (r.trasferte ? 1 : 0)); }, 0);
    const surr = reps.filter(r => r.surrogazioni).length;
    const mod = reps.reduce((a, r) => a + r.moduli, 0);
    const ano = reps.reduce((a, r) => a + r.anomalie, 0);
    $('plDays').textContent = `${reps.length} giorni`;
    $('plHours').textContent = `${fmtMin(tot)} ore`;
    $('plExtra').textContent = `straord. ${fmtMin(str)}`;
    $('monthStats').innerHTML = '';
    [['Giorni con rapporto', reps.length], ['Ore totali', fmtMin(tot)], ['Ore straordinario', fmtMin(str)],
      ['Trasferte', String(trasf).replace('.', ',')], ['Giorni con surrogazioni', surr], ['Moduli emessi', mod], ['Anormalità segnalate', ano]]
      .forEach(([k, v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; $('monthStats').append(dt, dd); });
    $('btnCsv').disabled = !reps.length;
  }

  function shiftMonth(delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    loadMonth();
  }

  async function exportCsv() {
    const sums = await api('rapporti?mese=' + month);
    const reps = await Promise.all(sums.map(s => api('rapporti/' + s.data)));
    reps.sort((a, b) => a.data.localeCompare(b.data));
    const q = v => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [['Data', 'Servizio', 'Luogo di lavoro', 'Treni usufr. N.', 'Descrizione del lavoro', 'Sigilli tolti', 'Dalle', 'Alle', 'Ore',
      'Totale ore giorno', 'Ore straord.', 'Trasferte', 'Surrogazioni', 'Moduli 0229', 'Moduli 0452', 'Altri moduli', 'Anormalità'].join(';')];
    for (const r of reps) {
      const d = r.data.split('-').reverse().join('/');
      const rr = r.riepilogo || {}, m = r.moduli || {};
      const extra = [rr.totaleOre, rr.oreStraord, rr.trasferte, rr.surrogazioni,
        (m.m0229 || []).filter(Boolean).join(' '), (m.m0452 || []).filter(Boolean).join(' '),
        (m.m3 || []).filter(Boolean).map(n => (m.codice3 ? m.codice3 + ' ' : '') + n).join(', '),
        (r.anomalie || []).filter(a => a.testo).map(a => (a.localita ? a.localita + ': ' : '') + a.testo).join(' | ')];
      const lav = (r.lavori || []).length ? r.lavori : [{}];
      lav.forEach((l, i) => lines.push([d, r.testata?.servizio, l.luogo, l.treni, l.descrizione, l.sigilli, l.dalle, l.alle, l.ore,
        ...(i === 0 ? extra : extra.map(() => ''))].map(q).join(';')));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `rapportini-${month}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- rapporto ----------
  function blankReport(data) {
    const s = settings || {};
    return {
      data,
      testata: { agente: s.agente || '', qualifica: s.qualifica || '', cid: s.cid || '', residenza: s.residenza || '', servizio: s.servizio || '', unita: s.unita || '' },
      lavori: [emptyLav()], anomalie: [],
      moduli: { m0229: [], m0452: [], codice3: s.codiceModulo3 || '', m3: [] },
      riepilogo: { totaleOre: '', oreStraord: '', straordManuale: false, turnoDalle: s.turnoDalle || '', turnoAlle: s.turnoAlle || '', trasferte: '', surrogazioni: '' },
      note: ''
    };
  }
  const emptyLav = () => ({ luogo: '', treni: '', descrizione: '', sigilli: '', dalle: '', alle: '', ore: '' });
  const emptyAno = () => ({ localita: '', testo: '' });

  async function openReport(data) {
    if (rep && rep.data === data) return;
    await flushSave();
    try { rep = await api('rapporti/' + data); repExists = true; }
    catch (e) { if (e.status !== 404) throw e; rep = blankReport(data); repExists = false; }
    if (!rep.lavori.length) rep.lavori.push(emptyLav());
    rep.moduli = { m0229: [], m0452: [], m3: [], codice3: '', ...(rep.moduli || {}) };
    if (!rep.moduli.codice3 && settings?.codiceModulo3) rep.moduli.codice3 = settings.codiceModulo3;
    if (!rep.riepilogo.turnoDalle && !rep.riepilogo.turnoAlle && !rep.riepilogo.straordManuale) {
      rep.riepilogo.turnoDalle = settings?.turnoDalle || ''; rep.riepilogo.turnoAlle = settings?.turnoAlle || '';
    }
    fillEditor();
    status(repExists ? 'salvato' : 'nuovo', repExists ? 'ok' : '');
  }

  function fillEditor() {
    const t = rep.testata;
    $('editTitle').textContent = dateLong(rep.data);
    $('tabRepName').textContent = dateShort(rep.data).txt;
    $('hAgente').value = t.agente; $('hQualifica').value = t.qualifica; $('hCid').value = t.cid;
    $('hData').value = rep.data; $('hResidenza').value = t.residenza; $('hServizio').value = t.servizio; $('hUnita').value = t.unita;
    $('rTrasferte').value = rep.riepilogo.trasferte || '';
    $('rSurrogazioni').value = rep.riepilogo.surrogazioni || '';
    $('rStraordMan').checked = !!rep.riepilogo.straordManuale;
    $('rTurnoDalle').value = rep.riepilogo.turnoDalle || '';
    $('rTurnoAlle').value = rep.riepilogo.turnoAlle || '';
    $('note').value = rep.note || '';
    renderLavori(); renderAnomalie(); renderModuli(); recalc(false);
    $('btnDelete').disabled = !repExists;
  }

  function field(label, k, value, opts = {}) {
    const l = document.createElement('label');
    l.dataset.f = k;
    l.textContent = label;
    const i = document.createElement('input');
    i.dataset.k = k; i.value = value || '';
    if (opts.type) i.type = opts.type;
    if (opts.list) i.setAttribute('list', opts.list);
    if (opts.max) i.maxLength = opts.max;
    if (opts.inputmode) i.inputMode = opts.inputmode;
    if (opts.placeholder) i.placeholder = opts.placeholder;
    l.appendChild(i);
    return l;
  }
  function delBtn(onClick) {
    const b = document.createElement('button');
    b.className = 'btn-icon del'; b.type = 'button'; b.title = 'Togli riga'; b.textContent = '✕';
    b.onclick = onClick; return b;
  }

  function renderLavori() {
    const box = $('lavori'); box.innerHTML = '';
    rep.lavori.forEach((l, i) => {
      const row = document.createElement('div');
      row.className = 'lav';
      const n = document.createElement('span'); n.className = 'rownum'; n.textContent = i + 1;
      row.append(n,
        field('Luogo di lavoro', 'luogo', l.luogo, { list: 'dlLuogo', max: 120 }),
        field('Treni usufr. N.', 'treni', l.treni, { max: 40, inputmode: 'numeric' }),
        field('Descrizione del lavoro', 'descrizione', l.descrizione, { list: 'dlDescrizione', max: 400 }),
        field('Sigilli tolti', 'sigilli', l.sigilli, { max: 40 }),
        field('Dalle', 'dalle', l.dalle, { type: 'time' }),
        field('Alle', 'alle', l.alle, { type: 'time' }),
        field('Ore', 'ore', l.ore, { placeholder: '0:00', max: 6 }),
        delBtn(() => { rep.lavori.splice(i, 1); if (!rep.lavori.length) rep.lavori.push(emptyLav()); renderLavori(); recalc(); }));
      row.addEventListener('input', e => {
        const k = e.target.dataset.k; if (!k) return;
        l[k] = e.target.value;
        if (k === 'dalle' || k === 'alle') {
          const d = between(l.dalle, l.alle);
          if (d != null) { l.ore = fmtMin(d); row.querySelector('[data-k="ore"]').value = l.ore; }
        }
        if (k === 'ore') l.ore = e.target.value.trim().replace('.', ':');
        syncOreLock(row, l);
        recalc();
      });
      syncOreLock(row, l);
      box.appendChild(row);
    });
    $('btnAddLav').disabled = rep.lavori.length >= MAX_LAV;
    $('lavCount').textContent = `(${rep.lavori.length}/${MAX_LAV} righe del modulo)`;
  }
  function syncOreLock(row, l) {
    const o = row.querySelector('[data-k="ore"]');
    const auto = between(l.dalle, l.alle) != null;
    o.readOnly = auto; o.classList.toggle('auto', auto);
    o.title = auto ? 'Calcolate da "dalle" e "alle"' : 'Scrivi le ore come 3:30';
  }

  function renderAnomalie() {
    const box = $('anomalie'); box.innerHTML = '';
    rep.anomalie.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'ano';
      const n = document.createElement('span'); n.className = 'rownum'; n.textContent = i + 1;
      row.append(n,
        field('Località', 'localita', a.localita, { list: 'dlLocalita', max: 120 }),
        field('Anormalità · osservazioni · materiali', 'testo', a.testo, { list: 'dlAnomalia', max: 400 }),
        delBtn(() => { rep.anomalie.splice(i, 1); renderAnomalie(); scheduleSave(); }));
      row.addEventListener('input', e => { const k = e.target.dataset.k; if (k) { a[k] = e.target.value; scheduleSave(); } });
      box.appendChild(row);
    });
    if (!rep.anomalie.length) box.innerHTML = '<p class="hint">Nessuna anormalità. Usa "Aggiungi riga" se serve.</p>';
    $('btnAddAno').disabled = rep.anomalie.length >= MAX_ANO;
    $('anoCount').textContent = `(${rep.anomalie.length}/${MAX_ANO})`;
  }

  function renderModuli() {
    const box = $('moduli'); box.innerHTML = '';
    const m = rep.moduli;
    [['m0229', '0229'], ['m0452', '0452'], ['m3', null]].forEach(([k, code]) => {
      const col = document.createElement('div'); col.className = 'mcol';
      if (code) { const h = document.createElement('div'); h.className = 'mhead'; h.textContent = code; col.appendChild(h); }
      else {
        const c = document.createElement('input'); c.className = 'code'; c.placeholder = 'codice'; c.maxLength = 12; c.value = m.codice3 || '';
        c.title = 'Codice del modulo della terza colonna';
        c.oninput = () => { m.codice3 = c.value.trim(); scheduleSave(); };
        col.appendChild(c);
      }
      const arr = m[k];
      const shown = Math.min(MAX_MOD, Math.max(arr.filter(Boolean).length + 1, 2));
      for (let i = 0; i < shown; i++) {
        const w = document.createElement('div'); w.className = 'mnum';
        const s = document.createElement('span'); s.textContent = 'N.';
        const inp = document.createElement('input'); inp.value = arr[i] || ''; inp.maxLength = 20; inp.inputMode = 'numeric';
        inp.oninput = () => {
          arr[i] = inp.value.trim();
          while (arr.length && !arr.at(-1)) arr.pop();
          scheduleSave();
        };
        inp.onchange = () => { compactModuli(); renderModuli(); };
        w.append(s, inp); col.appendChild(w);
      }
      box.appendChild(col);
    });
  }
  function compactModuli() { ['m0229', 'm0452', 'm3'].forEach(k => { rep.moduli[k] = rep.moduli[k].filter(Boolean); }); }

  function recalc(save = true) {
    const tot = rep.lavori.reduce((a, l) => a + (toMin(l.ore) || 0), 0);
    rep.riepilogo.totaleOre = tot ? fmtMin(tot) : '';
    $('rTotale').value = rep.riepilogo.totaleOre;
    const ord = toMin(settings?.orarioOrdinario) ?? 480;
    const man = $('rStraordMan').checked;
    rep.riepilogo.straordManuale = man;
    const s = $('rStraord');
    const turno = between(rep.riepilogo.turnoDalle, rep.riepilogo.turnoAlle) != null;
    if (!man) {
      const x = turno ? straordFuoriTurno(rep.lavori, rep.riepilogo.turnoDalle, rep.riepilogo.turnoAlle) : Math.max(0, tot - ord);
      rep.riepilogo.oreStraord = x ? fmtMin(x) : '';
      s.value = rep.riepilogo.oreStraord;
    } else {
      s.value = rep.riepilogo.oreStraord || '';
    }
    s.readOnly = !man; s.classList.toggle('auto', !man);
    $('straordHint').textContent = man ? 'Valore inserito a mano.'
      : turno ? `Calcolato: lavoro fuori dal turno ${rep.riepilogo.turnoDalle}–${rep.riepilogo.turnoAlle}.`
      : `Calcolato: ore oltre le ${fmtMin(ord)} ordinarie (indica il turno per contare dall'orario di fine).`;
    if (save) scheduleSave();
  }

  /** Minuti lavorati fuori dalla fascia del turno (anche turni che passano la mezzanotte). */
  function straordFuoriTurno(lavori, tDalle, tAlle) {
    const ts = toMin(tDalle), tl = between(tDalle, tAlle);
    let fuori = 0;
    for (const l of lavori) {
      const a = toMin(l.dalle), d = between(l.dalle, l.alle);
      if (a == null || d == null) continue;   // senza orario non si può sapere: non conta
      const b = a + d;
      let dentro = 0;
      for (const off of [-1440, 0, 1440]) {
        const s = ts + off, e = ts + off + tl;
        dentro += Math.max(0, Math.min(b, e) - Math.max(a, s));
      }
      fuori += d - Math.min(d, dentro);
    }
    return fuori;
  }

  function scheduleSave() {
    if (!rep) return;
    status('modificato…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }
  async function save() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!rep) return;
    const body = JSON.parse(JSON.stringify(rep));
    body.lavori = body.lavori.filter(l => Object.values(l).some(Boolean));
    body.anomalie = body.anomalie.filter(a => a.localita || a.testo);
    try {
      const saved = await api('rapporti/' + rep.data, { method: 'PUT', body: JSON.stringify(body) });
      repExists = true; rep.aggiornato = saved.aggiornato;
      $('btnDelete').disabled = false;
      status('salvato ✓', 'ok');
    } catch (e) { status('non salvato', 'err'); toast('Salvataggio non riuscito: ' + e.message, true); }
  }
  async function flushSave() { if (saveTimer) await save(); }

  function bindHeader() {
    const map = { hAgente: 'agente', hQualifica: 'qualifica', hCid: 'cid', hResidenza: 'residenza', hServizio: 'servizio', hUnita: 'unita' };
    Object.entries(map).forEach(([id, k]) => $(id).addEventListener('input', e => { rep.testata[k] = e.target.value; scheduleSave(); }));
    $('hData').addEventListener('change', async e => {
      const nd = e.target.value;
      if (!nd || nd === rep.data) return;
      try {
        await api('rapporti/' + nd);
        toast('Esiste già un rapporto per il ' + nd.split('-').reverse().join('/') + '.', true);
        e.target.value = rep.data; return;
      } catch (err) { if (err.status !== 404) { toast(err.message, true); return; } }
      await flushSave();
      const old = rep.data;
      rep.data = nd;
      await save();
      if (repExists) await api('rapporti/' + old, { method: 'DELETE' }).catch(() => {});
      history.replaceState(null, '', '#/r/' + nd);
      fillEditor();
    });
    $('rTrasferte').addEventListener('input', e => { rep.riepilogo.trasferte = e.target.value; scheduleSave(); });
    $('rSurrogazioni').addEventListener('input', e => { rep.riepilogo.surrogazioni = e.target.value; scheduleSave(); });
    $('rStraord').addEventListener('input', e => { rep.riepilogo.oreStraord = e.target.value.trim().replace('.', ':'); scheduleSave(); });
    $('rStraordMan').addEventListener('change', () => recalc());
    $('rTurnoDalle').addEventListener('input', e => { rep.riepilogo.turnoDalle = e.target.value; recalc(); });
    $('rTurnoAlle').addEventListener('input', e => { rep.riepilogo.turnoAlle = e.target.value; recalc(); });
    $('note').addEventListener('input', e => { rep.note = e.target.value; scheduleSave(); });
    $('btnAddLav').onclick = () => {
      if (rep.lavori.length >= MAX_LAV) return;
      const last = rep.lavori.at(-1);
      const l = emptyLav();
      if (last) { l.luogo = last.luogo; l.dalle = last.alle; }   // continua dal lavoro precedente
      rep.lavori.push(l); renderLavori();
      $('lavori').lastElementChild.querySelector('[data-k="descrizione"]').focus();
    };
    $('btnAddAno').onclick = () => {
      if (rep.anomalie.length >= MAX_ANO) return;
      rep.anomalie.push(emptyAno()); renderAnomalie();
      $('anomalie').lastElementChild.querySelector('input').focus();
    };
    $('btnDelete').onclick = async () => {
      if (!confirm('Eliminare il rapporto del ' + rep.data.split('-').reverse().join('/') + '?')) return;
      clearTimeout(saveTimer); saveTimer = null;
      try { await api('rapporti/' + rep.data, { method: 'DELETE' }); month = rep.data.slice(0, 7); rep = null; toast('Rapporto eliminato'); go('#/'); }
      catch (e) { toast(e.message, true); }
    };
    $('btnCopyPrev').onclick = async () => {
      let p;
      try { p = await api('precedente/' + rep.data); }
      catch (e) { toast(e.status === 404 ? 'Non ci sono rapporti precedenti da copiare.' : e.message, true); return; }
      const hasWork = rep.lavori.some(l => l.descrizione || l.luogo);
      if (hasWork && !confirm(`Sostituire i lavori di oggi con quelli del ${p.data.split('-').reverse().join('/')}?`)) return;
      rep.lavori = (p.lavori || []).map(l => ({ ...emptyLav(), ...l }));
      if (!rep.lavori.length) rep.lavori.push(emptyLav());
      rep.testata = { ...rep.testata, ...p.testata };
      fillEditor(); recalc();
      toast('Copiati i lavori del ' + p.data.split('-').reverse().join('/'));
    };
    $('btnPreview').onclick = async () => { await flushSave(); go('#/r/' + rep.data + '/stampa'); };
  }

  // ---------- anteprima e stampa ----------
  function openPreview() {
    show('previewView');
    document.querySelectorAll('.sw').forEach(b => {
      const on = b.dataset.mode === printMode;
      b.classList.toggle('active', on); b.setAttribute('aria-checked', on);
    });
    const wrap = $('sheetScale');
    wrap.innerHTML = '';
    const sheet = Modulo0444.build(rep, settings, printMode);
    wrap.appendChild(sheet);
    Modulo0444.fitAll(sheet);
    scalePreview();
    const lav = rep.lavori.filter(l => Object.values(l).some(Boolean)).length;
    $('previewHint').textContent = printMode === 'full'
      ? 'Modulo completo su foglio bianco A4 orizzontale. Il logo aziendale non viene stampato.'
      : 'Solo i dati, da stampare sul modulo prestampato. Se il testo non cade nelle righe, regola la calibrazione nelle Impostazioni.';
    if (!lav) $('previewHint').textContent += ' Attenzione: non ci sono lavori inseriti.';
  }
  function scalePreview() {
    const wrap = $('sheetWrap'), inner = $('sheetScale'), sheet = inner.firstElementChild;
    if (!sheet || $('previewView').hidden) return;
    const s = Math.min(1, wrap.clientWidth / sheet.offsetWidth);
    inner.style.transform = `scale(${s})`;
    wrap.style.height = sheet.offsetHeight * s + 'px';
  }
  function printSheet(report, mode) {
    const area = $('printArea');
    area.innerHTML = '';
    area.style.cssText = 'display:block;position:fixed;left:-10000px;top:0;';
    const sheet = Modulo0444.build(report, settings, mode);
    area.appendChild(sheet);
    Modulo0444.fitAll(sheet);
    area.style.cssText = '';
    const prev = document.title;
    if (report) document.title = `Rapporto ${report.data}`;
    setTimeout(() => { window.print(); document.title = prev; }, 50);
  }
  window.addEventListener('afterprint', () => { $('printArea').innerHTML = ''; });

  // ---------- impostazioni ----------
  function fillSettings() {
    const s = settings;
    $('sAgente').value = s.agente; $('sQualifica').value = s.qualifica; $('sCid').value = s.cid;
    $('sResidenza').value = s.residenza; $('sServizio').value = s.servizio; $('sUnita').value = s.unita;
    $('sOrario').value = s.orarioOrdinario; $('sTurnoDalle').value = s.turnoDalle || ''; $('sTurnoAlle').value = s.turnoAlle || ''; $('sCodice3').value = s.codiceModulo3;
    $('sOffX').value = s.stampa.offsetX; $('sOffY').value = s.stampa.offsetY; $('sScala').value = s.stampa.scala;
    $('versionInfo').textContent = 'Rapportini versione ' + (s.versione || '');
  }
  function readSettings() {
    const s = settings;
    s.agente = $('sAgente').value; s.qualifica = $('sQualifica').value; s.cid = $('sCid').value;
    s.residenza = $('sResidenza').value; s.servizio = $('sServizio').value; s.unita = $('sUnita').value;
    if (toMin($('sOrario').value) != null) s.orarioOrdinario = $('sOrario').value.trim();
    s.turnoDalle = $('sTurnoDalle').value; s.turnoAlle = $('sTurnoAlle').value;
    s.codiceModulo3 = $('sCodice3').value.trim();
    s.stampa = { offsetX: Number($('sOffX').value) || 0, offsetY: Number($('sOffY').value) || 0, scala: Number($('sScala').value) || 100 };
  }
  function bindSettings() {
    $('settingsView').addEventListener('input', e => {
      if (e.target.type === 'file') return;
      readSettings();
      status('modificato…');
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(async () => {
        try { settings = await api('impostazioni', { method: 'PUT', body: JSON.stringify(settings) }); status('salvato ✓', 'ok'); }
        catch (err) { status('non salvato', 'err'); toast(err.message, true); }
      }, 600);
    });
    $('btnTestPrint').onclick = () => { readSettings(); printSheet(null, 'test'); };
    $('restoreFile').onchange = async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch { toast('Il file non è un JSON valido.', true); return; }
      if (data?.app !== 'rapportini') { toast('Questo file non è un backup di Rapportini.', true); return; }
      const over = confirm(`Il backup contiene ${data.rapporti?.length || 0} rapporti.\n\nOK = sovrascrivi i giorni già presenti\nAnnulla = aggiungi solo quelli mancanti`);
      try {
        const r = await api('ripristino' + (over ? '?sovrascrivi=1' : ''), { method: 'POST', body: JSON.stringify(data) });
        settings = await api('impostazioni'); fillSettings(); loadSuggestions();
        toast(`Ripristinati ${r.importati} rapporti${r.saltati ? `, ${r.saltati} saltati` : ''}.`);
      } catch (err) { toast(err.message, true); }
    };
  }

  // ---------- suggerimenti ----------
  async function loadSuggestions() {
    try {
      const s = await api('suggerimenti');
      const fill = (id, arr) => { const dl = $(id); dl.innerHTML = ''; arr.forEach(v => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); }); };
      fill('dlServizio', s.servizio); fill('dlLuogo', s.luogo); fill('dlDescrizione', s.descrizione);
      fill('dlLocalita', s.localita); fill('dlAnomalia', s.anomalia);
    } catch { /* non indispensabili */ }
  }

  // ---------- avvio ----------
  async function init() {
    $('tabHome').onclick = () => go('#/');
    $('tabRepClose').onclick = () => go('#/');
    $('tabSettings').onclick = () => go('#/impostazioni');
    $('btnToday').onclick = () => go('#/r/' + todayIso());
    $('openDate').onchange = e => { if (e.target.value) go('#/r/' + e.target.value); };
    $('openDate').onclick = e => e.stopPropagation();
    $('monthPrev').onclick = () => shiftMonth(-1);
    $('monthNext').onclick = () => shiftMonth(1);
    $('btnCsv').onclick = () => exportCsv().catch(e => toast(e.message, true));
    $('btnBackEdit').onclick = () => go('#/r/' + rep.data);
    $('btnPrint').onclick = () => printSheet(rep, printMode);
    document.querySelectorAll('.sw').forEach(b => b.onclick = () => { printMode = b.dataset.mode; openPreview(); });
    window.addEventListener('resize', scalePreview);
    window.addEventListener('beforeunload', e => { if (saveTimer) { save(); e.preventDefault(); } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
    bindHeader(); bindSettings();
    try { settings = await api('impostazioni'); }
    catch (e) { toast('Server non raggiungibile: ' + e.message, true); return; }
    loadSuggestions();
    window.addEventListener('hashchange', route);
    await route();
    if (!settings.agente && location.hash.replace(/^#\/?/, '') === '') toast('Prima volta? Inserisci i tuoi dati in Impostazioni.');
  }
  init();
})();
