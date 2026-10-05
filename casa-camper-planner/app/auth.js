// Camper Planner — account personali (stesso schema di Scontrinaio e Rapportini).
// Il primo account creato è l'amministratore e riceve i viaggi già salvati.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COOKIE = 'camper_sessione';
const SESSION_DAYS = 30;          // con "Resta connesso"
const SESSION_HOURS_SHORT = 12;   // senza: finisce alla chiusura del browser, comunque dopo 12 ore
export const NAME_RE = /^[a-z0-9._-]{3,32}$/;

export function createAuth({ dataDir, writeJsonAtomic, readJson }) {
  const USERS_FILE = path.join(dataDir, 'utenti.json');
  const SESS_FILE = path.join(dataDir, 'sessioni.json');
  const USERS_DIR = path.join(dataDir, 'utenti');

  let users = [];                      // {id, nome, hash, salt, admin, creato, cambioPassword, ultimoAccesso}
  let accSettings = { registrazioniAperte: true };
  const sessions = new Map();          // sha256(token) -> {uid, scade, creata}

  const saveUsers = () => writeJsonAtomic(USERS_FILE, { versione: 1, utenti: users, impostazioni: accSettings });
  let sessTimer = null;
  const saveSessions = () => {
    clearTimeout(sessTimer);
    sessTimer = setTimeout(() => writeJsonAtomic(SESS_FILE, { sessioni: [...sessions.entries()].map(([h, x]) => ({ h, ...x })) }).catch(console.error), 200);
  };

  async function load() {
    const u = await readJson(USERS_FILE, null);
    users = Array.isArray(u?.utenti) ? u.utenti : [];
    accSettings = { registrazioniAperte: true, ...(u?.impostazioni || {}) };
    const s = await readJson(SESS_FILE, null);
    const now = Date.now();
    for (const x of s?.sessioni || []) if (x.scade > now) { const { h, ...rest } = x; sessions.set(h, rest); }
    await fs.mkdir(USERS_DIR, { recursive: true });
  }

  function scrypt(password, salt) {
    return new Promise((ok, ko) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? ko(e) : ok(k))));
  }
  async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    return { salt: salt.toString('base64'), hash: (await scrypt(pw, salt)).toString('base64') };
  }
  const DUMMY = { salt: crypto.randomBytes(16).toString('base64'), hash: crypto.randomBytes(64).toString('base64') };
  async function checkPassword(user, pw) {
    const u = user || DUMMY;   // stesso lavoro anche per nomi inesistenti: nessun indizio dai tempi di risposta
    const k = await scrypt(String(pw), Buffer.from(u.salt, 'base64'));
    return crypto.timingSafeEqual(k, Buffer.from(u.hash, 'base64')) && !!user;
  }
  const validPassword = pw => typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
  const sha = t => crypto.createHash('sha256').update(t).digest('hex');
  function tempPassword() {
    const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return [...crypto.randomBytes(12)].map(x => abc[x % abc.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
  }

  // dietro Cloudflare Tunnel o un altro proxy https il browser usa https anche se a noi arriva http
  function isHttps(req) {
    if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
    try { return JSON.parse(req.headers['cf-visitor'] || '{}').scheme === 'https'; } catch { return false; }
  }
  const cookieAttrs = req => 'HttpOnly; SameSite=Lax; Path=/' + (isHttps(req) ? '; Secure' : '');
  function clientIp(req) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  }
  function newSession(req, res, uid, ricorda) {
    const token = crypto.randomBytes(32).toString('base64url');
    const scade = Date.now() + (ricorda ? SESSION_DAYS * 864e5 : SESSION_HOURS_SHORT * 36e5);
    sessions.set(sha(token), { uid, scade, creata: Date.now() });
    saveSessions();
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(req)}` + (ricorda ? `; Max-Age=${SESSION_DAYS * 86400}` : ''));
  }
  const clearCookie = (req, res) => res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
  function tokenOf(req) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    return m ? m[1] : null;
  }
  function currentUser(req) {
    const t = tokenOf(req); if (!t) return null;
    const x = sessions.get(sha(t));
    if (!x) return null;
    if (x.scade < Date.now()) { sessions.delete(sha(t)); saveSessions(); return null; }
    return users.find(u => u.id === x.uid) || null;
  }
  function closeSessionsOf(uid) { for (const [h, x] of sessions) if (x.uid === uid) sessions.delete(h); saveSessions(); }
  const publicUser = u => u && { id: u.id, nome: u.nome, admin: !!u.admin, cambioPassword: !!u.cambioPassword };

  // tentativi di accesso: 5 errori per nome+indirizzo, 30 per indirizzo, 20 per nome → 15 minuti di attesa
  const fails = new Map();
  const isLocked = key => { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; };
  function noteFail(key, limit) {
    const f = fails.get(key) || { n: 0, until: 0 };
    f.n++; if (f.n >= limit) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
    fails.set(key, f);
  }

  const userDir = uid => path.join(USERS_DIR, uid);

  // I dati della versione senza account (1.x) passano al primo utente creato.
  async function adoptLegacyData(uid) {
    const dir = userDir(uid);
    await fs.mkdir(dir, { recursive: true });
    for (const name of ['trips', 'settings.json', 'collection.json']) {
      try { await fs.rename(path.join(dataDir, name), path.join(dir, name)); console.log(`Dati esistenti (${name}) assegnati al primo account`); }
      catch (e) { if (e.code !== 'ENOENT') console.error('Spostamento dati non riuscito:', name, e.message); }
    }
  }

  const fail = (res, status, msg) => res.status(status).json({ error: msg });

  // ---------- rotte ----------
  function routes(app, { wrap, countData }) {
    app.get('/api/stato', (req, res) => {
      res.json({ utente: publicUser(currentUser(req)), primoAvvio: users.length === 0, registrazioniAperte: users.length === 0 || accSettings.registrazioniAperte });
    });

    app.post('/api/registrati', wrap(async (req, res) => {
      const b = req.body || {};
      const nome = String(b.nome || '').trim().toLowerCase();
      const first = users.length === 0;
      if (!first && !accSettings.registrazioniAperte) return fail(res, 403, "Le registrazioni sono chiuse. Chiedi all'amministratore di aprirle.");
      if (!NAME_RE.test(nome)) return fail(res, 400, 'Il nome utente deve avere da 3 a 32 caratteri: lettere minuscole, numeri, punto, trattino, trattino basso.');
      if (!validPassword(b.password)) return fail(res, 400, 'La password deve avere almeno 8 caratteri.');
      if (users.some(u => u.nome === nome)) return fail(res, 409, 'Questo nome utente esiste già.');
      const u = { id: crypto.randomUUID(), nome, ...(await hashPassword(b.password)), admin: first, creato: new Date().toISOString(), cambioPassword: false };
      // ricontrollo dopo l'hash, che è lento: nel frattempo può essere arrivata un'altra registrazione
      if ((first && users.length) || users.some(x => x.nome === nome)) return fail(res, 409, "Questo nome utente esiste già, oppure l'amministratore è appena stato creato. Riprova.");
      users.push(u); await saveUsers();
      if (first) await adoptLegacyData(u.id);
      await fs.mkdir(path.join(userDir(u.id), 'trips'), { recursive: true });
      newSession(req, res, u.id, !!b.ricorda);
      console.log(`Nuovo account: ${nome}${first ? ' (amministratore)' : ''}`);
      res.json({ utente: publicUser(u) });
    }));

    app.post('/api/accedi', wrap(async (req, res) => {
      const b = req.body || {};
      const nome = String(b.nome || '').trim().toLowerCase();
      const ip = clientIp(req), key = ip + '|' + nome, ipKey = ip + '|*', nameKey = '*|' + nome;
      const wait = isLocked(key) || isLocked(ipKey) || isLocked(nameKey);
      if (wait) return fail(res, 429, `Troppi tentativi. Riprova tra ${wait} minut${wait === 1 ? 'o' : 'i'}.`);
      const u = users.find(x => x.nome === nome);
      if (!(await checkPassword(u, b.password || ''))) {
        noteFail(key, 5); noteFail(ipKey, 30); noteFail(nameKey, 20);
        return fail(res, 401, 'Nome utente o password non corretti.');
      }
      fails.delete(key);
      u.ultimoAccesso = new Date().toISOString(); saveUsers().catch(console.error);
      newSession(req, res, u.id, !!b.ricorda);
      res.json({ utente: publicUser(u) });
    }));

    app.post('/api/esci', (req, res) => {
      const t = tokenOf(req); if (t) { sessions.delete(sha(t)); saveSessions(); }
      clearCookie(req, res);
      res.json({ ok: true });
    });

    app.post('/api/password', wrap(async (req, res) => {
      const me = currentUser(req);
      if (!me) return fail(res, 401, 'Accedi per continuare.');
      const b = req.body || {};
      if (!(await checkPassword(me, b.attuale || ''))) return fail(res, 400, 'La password attuale non è corretta.');
      if (!validPassword(b.nuova)) return fail(res, 400, 'La nuova password deve avere almeno 8 caratteri.');
      if (b.nuova === b.attuale) return fail(res, 400, 'La nuova password deve essere diversa da quella attuale.');
      Object.assign(me, await hashPassword(b.nuova), { cambioPassword: false }); await saveUsers();
      closeSessionsOf(me.id);          // esce dagli altri dispositivi
      newSession(req, res, me.id, false);
      res.json({ utente: publicUser(me) });
    }));

    // tutto il resto delle API richiede un account con la password già scelta
    app.use('/api', (req, res, next) => {
      if (req.path === '/health') return next();
      const me = currentUser(req);
      if (!me) return res.status(401).json({ error: 'Accedi per continuare.', accesso: true });
      if (me.cambioPassword) return res.status(403).json({ error: 'Devi impostare una nuova password.', cambioPassword: true });
      req.user = me;
      next();
    });

    // ---------- amministrazione ----------
    app.use('/api/admin', (req, res, next) => req.user.admin ? next() : fail(res, 403, "Solo l'amministratore può farlo."));

    app.get('/api/admin/utenti', wrap(async (req, res) => {
      const out = [];
      for (const u of users) out.push({ ...publicUser(u), creato: u.creato, ultimoAccesso: u.ultimoAccesso || '', ...(await countData(userDir(u.id))) });
      res.json({ utenti: out, impostazioni: accSettings });
    }));

    app.post('/api/admin/impostazioni', wrap(async (req, res) => {
      accSettings.registrazioniAperte = !!req.body?.registrazioniAperte; await saveUsers();
      res.json({ impostazioni: accSettings });
    }));

    app.post('/api/admin/utenti/:id/reset', wrap(async (req, res) => {
      const u = users.find(x => x.id === req.params.id);
      if (!u) return fail(res, 404, 'Utente non trovato.');
      const temp = tempPassword();
      Object.assign(u, await hashPassword(temp), { cambioPassword: true });
      await saveUsers();
      closeSessionsOf(u.id);
      for (const k of fails.keys()) if (k.endsWith('|' + u.nome)) fails.delete(k);   // sblocca i tentativi
      console.log(`Password azzerata dall'amministratore per: ${u.nome}`);
      res.json({ nome: u.nome, passwordTemporanea: temp });
    }));

    app.post('/api/admin/utenti/:id/admin', wrap(async (req, res) => {
      const u = users.find(x => x.id === req.params.id);
      if (!u) return fail(res, 404, 'Utente non trovato.');
      const val = !!req.body?.admin;
      if (!val && u.admin && users.filter(x => x.admin).length === 1) return fail(res, 400, 'Deve restare almeno un amministratore.');
      u.admin = val; await saveUsers();
      res.json({ utente: publicUser(u) });
    }));

    app.delete('/api/admin/utenti/:id', wrap(async (req, res) => {
      const u = users.find(x => x.id === req.params.id);
      if (!u) return fail(res, 404, 'Utente non trovato.');
      if (u.id === req.user.id) return fail(res, 400, 'Non puoi eliminare il tuo account mentre lo usi.');
      if (u.admin && users.filter(x => x.admin).length === 1) return fail(res, 400, 'Deve restare almeno un amministratore.');
      users = users.filter(x => x.id !== u.id); await saveUsers();
      closeSessionsOf(u.id);
      await fs.rm(userDir(u.id), { recursive: true, force: true });
      console.log(`Account eliminato: ${u.nome}`);
      res.json({ ok: true });
    }));
  }

  // Le pagine: l'app solo con un account, tutti gli altri vedono la pagina di accesso.
  function pageGuard(req) {
    const u = currentUser(req);
    return { user: u, needsLogin: !u || u.cambioPassword };
  }

  return { load, routes, pageGuard, userDir, currentUser };
}
