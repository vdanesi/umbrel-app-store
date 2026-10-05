/* Rapportini — account personale e amministrazione utenti */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const A = () => window.App;

  const me = () => A().getSettings()?.utente || {};
  const dataBreve = iso => (iso ? new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');

  function header() {
    const u = me();
    $('userName').textContent = u.nome || '—';
    $('accNome').textContent = u.nome ? `(${u.nome}${u.admin ? ' · amministratore' : ''})` : '';
    $('secAdmin').hidden = !u.admin;
  }

  async function esci() {
    try { await fetch('api/esci', { method: 'POST', headers: { 'X-Rapportini': '1' } }); } catch { /* comunque fuori */ }
    location.replace('accesso');
  }

  async function renderAdmin() {
    if (!me().admin) return;
    let d;
    try { d = await A().api('admin/utenti'); } catch (e) { A().toast(e.message, true); return; }
    $('regAperte').checked = !!d.impostazioni.registrazioniAperte;
    $('regLink').textContent = location.origin + location.pathname.replace(/[^/]*$/, '') + 'accesso?modo=registrati';
    const box = $('usersList'); box.innerHTML = '';
    for (const u of d.utenti) {
      const row = document.createElement('div'); row.className = 'user-row';
      const info = document.createElement('div');
      const n = document.createElement('div'); n.className = 'u-name'; n.textContent = u.nome;
      if (u.admin) { const b = document.createElement('span'); b.className = 'badge b-admin'; b.textContent = 'admin'; n.appendChild(b); }
      if (u.cambioPassword) { const b = document.createElement('span'); b.className = 'badge b-reset'; b.textContent = 'password da cambiare'; n.appendChild(b); }
      if (u.id === me().id) { const b = document.createElement('span'); b.className = 'muted small'; b.textContent = ' (tu)'; n.appendChild(b); }
      const meta = document.createElement('div'); meta.className = 'u-meta';
      meta.textContent = `creato ${dataBreve(u.creato)} · ultimo accesso ${dataBreve(u.ultimoAccesso)} · ${u.rapporti} rapporti · ${u.pratiche} pratiche`;
      info.append(n, meta);

      const act = document.createElement('div'); act.className = 'u-actions';
      const bt = (t, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.textContent = t; b.onclick = fn; act.appendChild(b); return b; };
      if (u.id !== me().id) {
        bt('Reset password', '', async () => {
          if (!confirm(`Azzerare la password di "${u.nome}"?\nVerrà creata una password temporanea e l'utente sarà disconnesso.`)) return;
          try {
            const r = await A().api(`admin/utenti/${u.id}/reset`, { method: 'POST', body: '{}' });
            const box = $('tempPwBox');
            box.innerHTML = '';
            box.append(`Password temporanea per "${r.nome}": `);
            const c = document.createElement('code'); c.textContent = r.passwordTemporanea; box.appendChild(c);
            box.append(" — comunicala all'utente: al primo accesso dovrà sceglierne una nuova. Non verrà mostrata di nuovo.");
            box.hidden = false;
            try { await navigator.clipboard.writeText(r.passwordTemporanea); A().toast('Password temporanea copiata negli appunti.'); } catch { /* copia manuale */ }
            renderAdmin();
          } catch (e) { A().toast(e.message, true); }
        });
        bt(u.admin ? 'Togli admin' : 'Rendi admin', '', async () => {
          try { await A().api(`admin/utenti/${u.id}/admin`, { method: 'POST', body: JSON.stringify({ admin: !u.admin }) }); renderAdmin(); }
          catch (e) { A().toast(e.message, true); }
        });
        bt('Elimina', 'btn-danger', async () => {
          if (!confirm(`Eliminare l'account "${u.nome}" e TUTTI i suoi rapporti e pratiche?\nL'operazione non si può annullare.`)) return;
          if (prompt(`Per confermare scrivi il nome utente: ${u.nome}`) !== u.nome) { A().toast('Eliminazione annullata.'); return; }
          try { await A().api(`admin/utenti/${u.id}`, { method: 'DELETE' }); A().toast('Account eliminato.'); renderAdmin(); }
          catch (e) { A().toast(e.message, true); }
        });
      }
      row.append(info, act);
      box.appendChild(row);
    }
  }

  function render() { header(); $('tempPwBox').hidden = true; renderAdmin(); }

  function init() {
    header();
    $('tabUser').onclick = () => A().go('#/impostazioni');
    $('btnEsci').onclick = esci;
    $('regAperte').onchange = async e => {
      try { await A().api('admin/impostazioni', { method: 'POST', body: JSON.stringify({ registrazioniAperte: e.target.checked }) }); A().toast(e.target.checked ? 'Registrazioni aperte.' : 'Registrazioni chiuse.'); }
      catch (x) { A().toast(x.message, true); e.target.checked = !e.target.checked; }
    };
    $('fPw').onsubmit = async e => {
      e.preventDefault();
      if ($('pwNew').value !== $('pwNew2').value) { A().toast('Le due password non coincidono.', true); return; }
      try {
        await A().api('password', { method: 'POST', body: JSON.stringify({ attuale: $('pwOld').value, nuova: $('pwNew').value }) });
        e.target.reset(); e.target.closest('details').open = false;
        A().toast('Password cambiata. Gli altri dispositivi dovranno accedere di nuovo.');
      } catch (x) { A().toast(x.message, true); }
    };
  }

  window.Account = { init, render, header };
})();
