/* Camper Planner — account personale e amministrazione utenti */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const A = () => window.App;
  let me = {};
  const dataBreve = iso => (iso ? new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function header() {
    $('#userName').textContent = me.nome || '—';
    $('#plUser').textContent = '~/' + (me.nome || '');
    $('#accNome').textContent = me.nome ? `(${me.nome}${me.admin ? ' · amministratore' : ''})` : '';
    $('#secAdmin').hidden = !me.admin;
  }

  async function esci() {
    if (A().dirty) await A().save();
    try { await fetch('api/esci', { method: 'POST', headers: { 'X-Camper': '1' } }); } catch { /* comunque fuori */ }
    location.replace('accesso');
  }

  function show() {
    A().closeTrip();
    for (const id of ['#homeView', '#tripView']) $(id).hidden = true;
    $('#tabTrip').hidden = true;
    $('#accountView').hidden = false;
    $('#tabUser').classList.add('tab-active');
    $('#saveStatus').innerHTML = '';
    history.replaceState(null, '', '#account');
    $('#tempPwBox').hidden = true;
    header();
    renderAdmin();
  }

  async function renderAdmin() {
    if (!me.admin) return;
    let d;
    try { d = await A().api('/admin/utenti'); } catch (e) { A().toast(e.message, true); return; }
    $('#regAperte').checked = !!d.impostazioni.registrazioniAperte;
    $('#regLink').textContent = location.origin + location.pathname.replace(/[^/]*$/, '') + 'accesso?modo=registrati';
    const box = $('#usersList'); box.innerHTML = '';
    for (const u of d.utenti) {
      const row = el('div', 'user-row');
      const info = el('div');
      const n = el('div', 'u-name', u.nome);
      if (u.admin) n.appendChild(el('span', 'tag tag-admin', 'ADMIN'));
      if (u.cambioPassword) n.appendChild(el('span', 'tag tag-reset', 'PASSWORD DA CAMBIARE'));
      if (u.id === me.id) n.appendChild(el('span', 'muted', ' (tu)'));
      const meta = el('div', 'u-meta', `creato ${dataBreve(u.creato)} · ultimo accesso ${dataBreve(u.ultimoAccesso)} · ${u.viaggi} ${u.viaggi === 1 ? 'viaggio' : 'viaggi'} · ${u.punti} punti nella raccolta`);
      info.append(n, meta);

      const act = el('div', 'u-actions');
      const bt = (t, cls, fn) => { const b = el('button', 'btn ' + cls, t); b.type = 'button'; b.onclick = fn; act.appendChild(b); };
      if (u.id !== me.id) {
        bt('Reset password', '', async () => {
          if (!confirm(`Azzerare la password di "${u.nome}"?\nVerrà creata una password temporanea e l'utente sarà disconnesso.`)) return;
          try {
            const r = await A().api(`/admin/utenti/${u.id}/reset`, { method: 'POST', body: {} });
            const t = $('#tempPwBox'); t.innerHTML = '';
            t.append(`Password temporanea per "${r.nome}": `);
            t.appendChild(el('code', '', r.passwordTemporanea));
            t.append(" — comunicala all'utente: al primo accesso dovrà sceglierne una nuova. Non verrà mostrata di nuovo.");
            t.hidden = false;
            try { await navigator.clipboard.writeText(r.passwordTemporanea); A().toast('Password temporanea copiata negli appunti'); } catch { /* copia a mano */ }
            renderAdmin();
          } catch (e) { A().toast(e.message, true); }
        });
        bt(u.admin ? 'Togli admin' : 'Rendi admin', '', async () => {
          try { await A().api(`/admin/utenti/${u.id}/admin`, { method: 'POST', body: { admin: !u.admin } }); renderAdmin(); }
          catch (e) { A().toast(e.message, true); }
        });
        bt('Elimina', 'btn-danger', async () => {
          if (!confirm(`Eliminare l'account "${u.nome}" con TUTTI i suoi viaggi e la sua raccolta?\nL'operazione non si può annullare.`)) return;
          if (prompt(`Per confermare scrivi il nome utente: ${u.nome}`) !== u.nome) { A().toast('Eliminazione annullata'); return; }
          try { await A().api(`/admin/utenti/${u.id}`, { method: 'DELETE' }); A().toast('Account eliminato'); renderAdmin(); }
          catch (e) { A().toast(e.message, true); }
        });
      }
      row.append(info, act);
      box.appendChild(row);
    }
  }

  async function init() {
    try { me = await A().api('/me'); } catch { return; }
    header();
    $('#tabUser').onclick = show;
    $('#btnEsci').onclick = esci;
    $('#regAperte').onchange = async e => {
      try {
        await A().api('/admin/impostazioni', { method: 'POST', body: { registrazioniAperte: e.target.checked } });
        A().toast(e.target.checked ? 'Registrazioni aperte' : 'Registrazioni chiuse');
      } catch (x) { A().toast(x.message, true); e.target.checked = !e.target.checked; }
    };
    $('#fPw').onsubmit = async e => {
      e.preventDefault();
      if ($('#pwNew').value !== $('#pwNew2').value) { A().toast('Le due password non coincidono', true); return; }
      try {
        await A().api('/password', { method: 'POST', body: { attuale: $('#pwOld').value, nuova: $('#pwNew').value } });
        e.target.reset(); e.target.closest('details').open = false;
        A().toast('Password cambiata. Gli altri dispositivi dovranno accedere di nuovo.');
      } catch (x) { A().toast(x.message, true); }
    };
    if (location.hash === '#account') show();
  }

  window.Account = { init, show };
})();
