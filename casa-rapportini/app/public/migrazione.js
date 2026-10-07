/* Rapportini — Generatore migrazione PL (Cisco · Extreme · checklist MikroTik) */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const A = () => window.App;
  let cfg = null;      // modelli e chiave OSPF (in comune, dall'Umbrel)
  let storico = [];

  const validIP = s => { const p = s.split('.'); return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x <= 255); };
  const val = id => $(id).value.trim();

  function sostituisci(t, v) {
    return t.replaceAll('{{X}}', v.x).replaceAll('{{LOOPBACK}}', v.loop).replaceAll('{{PTP}}', v.ptp)
      .replaceAll('{{TAG}}', v.tag).replaceAll('{{CHIAVE_OSPF}}', cfg.chiave || '{{CHIAVE_OSPF}}');
  }

  function checklist(el, testo) {
    el.innerHTML = '';
    let ol = null;
    for (const riga of testo.split('\n').map(r => r.trim()).filter(Boolean)) {
      if (riga.startsWith('!')) {
        ol = null;
        const w = document.createElement('div'); w.className = 'mg-warn'; w.textContent = riga.replace(/^!\s*/, '');
        el.appendChild(w);
      } else {
        if (!ol) { ol = document.createElement('ol'); el.appendChild(ol); }
        const li = document.createElement('li'); li.textContent = riga.replace(/^\d+[.)]\s*/, ''); ol.appendChild(li);
      }
    }
  }

  function genera(salva = true) {
    const v = { x: val('mgX'), loop: val('mgLoop'), ptp: val('mgPtp'), tag: val('mgTag') };
    const e = [];
    if (!/^\d+$/.test(v.x)) e.push('Porta Cisco X non valida');
    if (!validIP(v.loop)) e.push('Loopback / Router-ID non valido');
    if (!validIP(v.ptp)) e.push('IP PTP Extreme non valido');
    if (!/^\d+$/.test(v.tag)) e.push('TAG tratta non valido');
    const msg = $('mgMsg');
    if (e.length) { msg.textContent = e.join(' · '); msg.hidden = false; $('mgOut').hidden = true; return; }
    msg.hidden = true;
    $('mgCisco').textContent = sostituisci(cfg.cisco, v);
    $('mgExtreme').textContent = sostituisci(cfg.extreme, v);
    checklist($('mgCheck'), cfg.checklist);
    $('mgKeyWarn').hidden = !!cfg.chiave || !cfg.extreme.includes('{{CHIAVE_OSPF}}');
    $('mgOut').hidden = false;
    if (salva) salvaStorico(v);
    $('mgOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function salvaStorico(v) {
    try { storico = await A().api('migrazione/storico', { method: 'POST', body: JSON.stringify({ ...v, nota: val('mgNota') }) }); disegnaStorico(); }
    catch { /* lo storico non è indispensabile */ }
  }
  function disegnaStorico() {
    const box = $('mgStorico'); box.innerHTML = '';
    $('mgStoricoBox').hidden = !storico.length;
    for (const s of storico) {
      const row = document.createElement('div'); row.className = 'mg-row';
      const t = document.createElement('button'); t.type = 'button'; t.className = 'mg-load';
      const d = new Date(s.quando);
      t.innerHTML = '<span class="mg-when"></span> <span class="mg-vals"></span> <span class="muted"></span>';
      t.children[0].textContent = d.toLocaleDateString('it-IT') + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      t.children[1].textContent = `X ${s.x} · loop ${s.loop} · PTP ${s.ptp} · TAG ${s.tag}`;
      t.children[2].textContent = s.nota ? '· ' + s.nota : '';
      t.title = 'Ricarica questi valori e rigenera';
      t.onclick = () => { $('mgX').value = s.x; $('mgLoop').value = s.loop; $('mgPtp').value = s.ptp; $('mgTag').value = s.tag; $('mgNota').value = s.nota || ''; genera(false); };
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn-icon'; del.textContent = '✕'; del.title = 'Togli dallo storico';
      del.onclick = async () => { try { storico = await A().api('migrazione/storico/' + s.id, { method: 'DELETE' }); disegnaStorico(); } catch (e) { A().toast(e.message, true); } };
      row.append(t, del); box.appendChild(row);
    }
  }

  async function copia(id) {
    const testo = $(id).textContent;
    try { await navigator.clipboard.writeText(testo); A().toast('Copiato negli appunti.'); }
    catch {   // http senza permesso agli appunti: seleziono il testo
      const r = document.createRange(); r.selectNodeContents($(id));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      try { document.execCommand('copy'); A().toast('Copiato negli appunti.'); } catch { A().toast('Testo selezionato: copialo con Ctrl+C.'); }
    }
  }
  function scarica(id, nome) {
    const b = new Blob([$(id).textContent.replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = nome;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function pulisci() {
    ['mgX', 'mgLoop', 'mgPtp', 'mgTag', 'mgNota'].forEach(i => { $(i).value = ''; });
    $('mgOut').hidden = true; $('mgMsg').hidden = true; $('mgX').focus();
  }

  // ---- modelli (amministratore) ----
  function riempiAdmin() {
    const admin = !!A().getSettings()?.utente?.admin;
    $('mgAdmin').hidden = !admin;
    $('mgKeyInfo').hidden = !admin || !!cfg.chiave || !cfg.extreme.includes('{{CHIAVE_OSPF}}');
    if (!admin) return;
    $('mgTplCisco').value = cfg.cisco; $('mgTplExtreme').value = cfg.extreme; $('mgTplCheck').value = cfg.checklist;
    $('mgKey').value = cfg.chiave || '';
    $('mgKeyState').textContent = cfg.chiave ? 'impostata' : 'non impostata';
    $('mgKeyState').className = cfg.chiave ? 'ok-text' : 'err-text';
  }
  async function salvaAdmin() {
    try {
      cfg = { ...cfg, ...(await A().api('migrazione', { method: 'PUT', body: JSON.stringify({
        cisco: $('mgTplCisco').value, extreme: $('mgTplExtreme').value, checklist: $('mgTplCheck').value, chiave: $('mgKey').value.trim()
      }) })) };
      riempiAdmin(); A().toast('Modelli salvati.');
      if (!$('mgOut').hidden) genera(false);
    } catch (e) { A().toast(e.message, true); }
  }

  async function show() {
    A().show('migrazioneView');
    try {
      [cfg, storico] = await Promise.all([A().api('migrazione'), A().api('migrazione/storico')]);
    } catch (e) { A().toast(e.message, true); return; }
    disegnaStorico(); riempiAdmin();
  }

  function init() {
    $('tabMigrazione').onclick = () => A().go('#/migrazione');
    $('mgGo').onclick = () => genera(true);
    $('mgClear').onclick = pulisci;
    ['mgX', 'mgLoop', 'mgPtp', 'mgTag', 'mgNota'].forEach(i => $(i).addEventListener('keydown', e => { if (e.key === 'Enter') genera(true); }));
    $('mgCopyCisco').onclick = () => copia('mgCisco');
    $('mgCopyExtreme').onclick = () => copia('mgExtreme');
    $('mgDlExtreme').onclick = () => scarica('mgExtreme', `config_extreme_PL${val('mgTag') ? '_tag' + val('mgTag') : ''}.txt`);
    $('mgDlCisco').onclick = () => scarica('mgCisco', `config_cisco_PL${val('mgX') ? '_Gi1-' + val('mgX') : ''}.txt`);
    $('mgSaveTpl').onclick = salvaAdmin;
    $('mgResetTpl').onclick = () => {
      if (!confirm('Rimettere i modelli Cisco, Extreme e la checklist come in origine? La chiave OSPF resta.')) return;
      $('mgTplCisco').value = cfg.predefiniti.cisco; $('mgTplExtreme').value = cfg.predefiniti.extreme; $('mgTplCheck').value = cfg.predefiniti.checklist;
      salvaAdmin();
    };
    $('mgKeyShow').onclick = () => { const k = $('mgKey'); k.type = k.type === 'password' ? 'text' : 'password'; };
  }

  window.Migrazione = { init, show };
})();
