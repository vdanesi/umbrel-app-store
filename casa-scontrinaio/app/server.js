// Scontrinaio server for umbrelOS: accounts, expenses and receipt photos stored on disk.
// No dependencies: runs on the stock node image.
"use strict";
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const USERS_FILE = path.join(DATA_DIR, "utenti.json");
const SESS_FILE = path.join(DATA_DIR, "sessioni.json");
const USERS_DIR = path.join(DATA_DIR, "utenti");
const MAX_FILE = 25 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const SESSION_DAYS = 30;
const COOKIE = "scontrinaio_sessione";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".gz": "application/gzip", ".wasm": "application/wasm", ".md": "text/markdown; charset=utf-8",
};
const FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "application/pdf"]);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const NAME_RE = /^[a-z0-9._-]{3,32}$/;
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN",
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

// ---------- small JSON file store with atomic, serialized writes ----------
const queues = new Map();
function writeJson(file, obj) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(obj), { mode: 0o600 });
    await fsp.rename(tmp, file);
  }).catch(e => console.error("Salvataggio non riuscito:", file, e.message));
  queues.set(file, next);
  return next;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return fallback;
    const bad = file + ".illeggibile-" + Date.now();
    await fsp.rename(file, bad).catch(() => {});
    console.error("File non leggibile, salvato come", bad);
    return fallback;
  }
}

// ---------- accounts ----------
let users = [];                       // {id, nome, hash, salt, admin, creato}
let settings = { registrazioniAperte: true };
let sessions = new Map();             // sha256(token) -> {uid, scade, creata}

const saveUsers = () => writeJson(USERS_FILE, { versione: 1, utenti: users, impostazioni: settings });
const saveSessions = () => writeJson(SESS_FILE, { sessioni: [...sessions.entries()].map(([h, s]) => ({ h, ...s })) });

function scrypt(password, salt) {
  return new Promise((ok, ko) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? ko(e) : ok(k)));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString("base64"), hash: (await scrypt(pw, salt)).toString("base64") };
}
const DUMMY = { salt: crypto.randomBytes(16).toString("base64"), hash: crypto.randomBytes(64).toString("base64") };
async function checkPassword(user, pw) {
  const u = user || DUMMY;               // same work for unknown names: no timing hint
  const k = await scrypt(pw, Buffer.from(u.salt, "base64"));
  const ok = crypto.timingSafeEqual(k, Buffer.from(u.hash, "base64"));
  return !!user && ok;
}
function validPassword(pw) { return typeof pw === "string" && pw.length >= 8 && pw.length <= 200; }
const sha = t => crypto.createHash("sha256").update(t).digest("hex");

// Behind a Cloudflare Tunnel (or another https proxy) the browser talks https even though we get plain http.
function isHttps(req) {
  if (String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") return true;
  try { return JSON.parse(req.headers["cf-visitor"] || "{}").scheme === "https"; } catch { return false; }
}
const cookieAttrs = req => "HttpOnly; SameSite=Lax; Path=/" + (isHttps(req) ? "; Secure" : "");
// The real visitor address: Cloudflare puts it in CF-Connecting-IP, other proxies in X-Forwarded-For.
function clientIp(req) {
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (cf) return cf;
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket.remoteAddress || "";
}
function newSession(req, res, uid) {
  const token = crypto.randomBytes(32).toString("base64url");
  const scade = Date.now() + SESSION_DAYS * 864e5;
  sessions.set(sha(token), { uid, scade, creata: Date.now() });
  saveSessions();
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; ${cookieAttrs(req)}; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearCookie(req, res) { res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`); }
function tokenOf(req) {
  const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)"));
  return m ? m[1] : null;
}
function currentUser(req) {
  const t = tokenOf(req); if (!t) return null;
  const s = sessions.get(sha(t));
  if (!s) return null;
  if (s.scade < Date.now()) { sessions.delete(sha(t)); saveSessions(); return null; }
  return users.find(u => u.id === s.uid) || null;
}
const publicUser = u => u && { id: u.id, nome: u.nome, admin: !!u.admin };

// login throttling: 5 failures per name+address, then 15 minutes wait; 30 per address overall
const fails = new Map();
function throttleKey(req, nome) { return clientIp(req) + "|" + nome; }
function isLocked(key) { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function noteFail(key, limit) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++; if (f.n >= limit) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  fails.set(key, f);
}

// ---------- per-user expenses ----------
const stores = new Map();             // uid -> {spese: Map, file, dir}
async function storeFor(uid) {
  if (stores.has(uid)) return stores.get(uid);
  const dir = path.join(USERS_DIR, uid);
  await fsp.mkdir(path.join(dir, "files"), { recursive: true });
  const file = path.join(dir, "spese.json");
  const raw = await readJson(file, { spese: [] });
  const spese = new Map();
  for (const s of raw.spese || []) if (s && ID_RE.test(s.id)) spese.set(s.id, s);
  const st = { spese, file, dir, save: () => writeJson(file, { versione: 1, aggiornato: new Date().toISOString(), spese: [...spese.values()] }) };
  stores.set(uid, st);
  return st;
}
function removeFile(st, id) {
  for (const f of [id, id + ".type"]) fsp.unlink(path.join(st.dir, "files", f)).catch(() => {});
}
function clean(id, b) {
  const num = Number(b.importo);
  if (!Number.isFinite(num) || num < 0 || num > 1e7) throw new Error("importo");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.data || ""))) throw new Error("data");
  const str = (v, n) => String(v ?? "").slice(0, n);
  return {
    id, importo: Math.round(num * 100) / 100, data: b.data,
    esercente: str(b.esercente, 120), categoria: str(b.categoria, 60), metodo: str(b.metodo, 20), tipo: str(b.tipo, 20),
    detraibile: !!b.detraibile, note: str(b.note, 1000),
    allegato: b.allegato && ID_RE.test(b.allegato) ? b.allegato : null,
    allegatoTipo: b.allegato ? str(b.allegatoTipo, 40) : null,
    creato: str(b.creato, 40) || new Date().toISOString(), modificato: new Date().toISOString(),
  };
}

// Data saved by version 1.0.0 (before accounts) goes to the first account.
async function adoptLegacyData(uid) {
  const legacy = path.join(DATA_DIR, "spese.json");
  try { await fsp.access(legacy); } catch { return; }
  const dir = path.join(USERS_DIR, uid);
  await fsp.mkdir(path.join(dir, "files"), { recursive: true });
  await fsp.rename(legacy, path.join(dir, "spese.json"));
  const oldFiles = path.join(DATA_DIR, "files");
  for (const name of await fsp.readdir(oldFiles).catch(() => [])) {
    await fsp.rename(path.join(oldFiles, name), path.join(dir, "files", name)).catch(() => {});
  }
  await fsp.rmdir(oldFiles).catch(() => {});
  stores.delete(uid);
  console.log("Spese della versione precedente assegnate al primo account");
}

// ---------- http helpers ----------
function send(res, code, body, headers = {}) {
  const text = typeof body === "string";
  res.writeHead(code, { "Content-Type": text ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(text ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((ok, ko) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { ko(Object.assign(new Error("troppo grande"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", ko);
  });
}
async function readJsonBody(req) {
  try { return JSON.parse((await readBody(req, MAX_JSON)).toString("utf8") || "{}"); }
  catch (e) { if (e.status) throw e; throw Object.assign(new Error("json"), { status: 400 }); }
}
async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, "Richiesta non valida"); }
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Vietato");
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error();
    const ext = path.extname(file);
    const long = rel.startsWith("/ocr/") || rel.startsWith("/icons/");
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Length": st.size,
      "Cache-Control": long ? "public, max-age=604800" : "no-cache", ...SECURITY_HEADERS,
      ...(ext === ".html" ? { "Content-Security-Policy": CSP } : {}),
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  } catch { send(res, 404, "Non trovato"); }
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method;

  if (!p.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") return send(res, 405, "Metodo non consentito");
    // The app itself is only served to signed-in people; everyone else lands on the sign-in page.
    const signedIn = !!currentUser(req);
    if (p === "/" || p === "/index.html") {
      if (!signedIn) return send(res, 302, "", { Location: "/accesso" });
      return serveStatic(req, res, "/index.html");
    }
    if (p === "/accesso" || p === "/accesso.html") {
      if (signedIn) return send(res, 302, "", { Location: "/" });
      return serveStatic(req, res, "/accesso.html");
    }
    return serveStatic(req, res, p);
    return send(res, 405, "Metodo non consentito");
  }
  // Changes must come from the app itself: browsers can't add this header from another site without our consent.
  if (method !== "GET" && method !== "HEAD" && req.headers["x-scontrinaio"] !== "1") return send(res, 403, { errore: "Richiesta non consentita" });

  if (p === "/api/salute") return send(res, 200, { ok: true });

  // ----- account -----
  if (p === "/api/stato" && method === "GET") {
    return send(res, 200, { utente: publicUser(currentUser(req)), primoAvvio: users.length === 0, registrazioniAperte: users.length === 0 || settings.registrazioniAperte });
  }
  if (p === "/api/registrati" && method === "POST") {
    const b = await readJsonBody(req);
    const nome = String(b.nome || "").trim().toLowerCase();
    const first = users.length === 0;
    if (!first && !settings.registrazioniAperte) return send(res, 403, { errore: "Le registrazioni sono chiuse. Chiedi all'amministratore di aprirle." });
    if (!NAME_RE.test(nome)) return send(res, 400, { errore: "Il nome utente deve avere da 3 a 32 caratteri: lettere minuscole, numeri, punto, trattino." });
    if (!validPassword(b.password)) return send(res, 400, { errore: "La password deve avere almeno 8 caratteri." });
    if (users.some(u => u.nome === nome)) return send(res, 409, { errore: "Questo nome utente esiste già." });
    const u = { id: crypto.randomUUID(), nome, ...(await hashPassword(b.password)), admin: first, creato: new Date().toISOString() };
    // re-check after the slow hash: another registration may have landed meanwhile
    if ((first && users.length) || users.some(x => x.nome === nome)) return send(res, 409, { errore: "Questo nome utente esiste già, oppure l'account amministratore è appena stato creato. Riprova." });
    users.push(u); await saveUsers();
    if (first) await adoptLegacyData(u.id);
    newSession(req, res, u.id);
    console.log(`Nuovo account: ${nome}${first ? " (amministratore)" : ""}`);
    return send(res, 200, { utente: publicUser(u) });
  }
  if (p === "/api/accedi" && method === "POST") {
    const b = await readJsonBody(req);
    const nome = String(b.nome || "").trim().toLowerCase();
    // limits: 5 wrong tries per name and address, 30 per address, 20 per name from any address
    // (the last one still holds if someone fakes the forwarded address)
    const key = throttleKey(req, nome), ipKey = throttleKey(req, "*"), nameKey = "*|" + nome;
    const wait = isLocked(key) || isLocked(ipKey) || isLocked(nameKey);
    if (wait) return send(res, 429, { errore: `Troppi tentativi. Riprova tra ${wait} minut${wait === 1 ? "o" : "i"}.` });
    const u = users.find(x => x.nome === nome);
    if (!(await checkPassword(u, String(b.password || "")))) {
      noteFail(key, 5); noteFail(ipKey, 30); noteFail(nameKey, 20);
      return send(res, 401, { errore: "Nome utente o password non corretti." });
    }
    fails.delete(key);
    newSession(req, res, u.id);
    return send(res, 200, { utente: publicUser(u) });
  }
  if (p === "/api/esci" && method === "POST") {
    const t = tokenOf(req); if (t) { sessions.delete(sha(t)); saveSessions(); }
    clearCookie(req, res);
    return send(res, 200, { ok: true });
  }

  // ----- everything below needs an account -----
  const me = currentUser(req);
  if (!me) return send(res, 401, { errore: "Accedi per continuare." });

  if (p === "/api/password" && method === "POST") {
    const b = await readJsonBody(req);
    if (!(await checkPassword(me, String(b.attuale || "")))) return send(res, 400, { errore: "La password attuale non è corretta." });
    if (!validPassword(b.nuova)) return send(res, 400, { errore: "La nuova password deve avere almeno 8 caratteri." });
    Object.assign(me, await hashPassword(b.nuova)); await saveUsers();
    for (const [h, s] of sessions) if (s.uid === me.id) sessions.delete(h);   // sign out everywhere else
    newSession(req, res, me.id);
    return send(res, 200, { ok: true });
  }

  // ----- admin -----
  if (p.startsWith("/api/admin/")) {
    if (!me.admin) return send(res, 403, { errore: "Solo l'amministratore può farlo." });
    if (p === "/api/admin/utenti" && method === "GET") {
      const out = [];
      for (const u of users) { const st = await storeFor(u.id); out.push({ ...publicUser(u), creato: u.creato, spese: st.spese.size }); }
      return send(res, 200, { utenti: out, impostazioni: settings });
    }
    if (p === "/api/admin/impostazioni" && method === "POST") {
      const b = await readJsonBody(req);
      settings.registrazioniAperte = !!b.registrazioniAperte; await saveUsers();
      return send(res, 200, { impostazioni: settings });
    }
    const m = p.match(/^\/api\/admin\/utenti\/([A-Za-z0-9-]{1,80})$/);
    if (m && method === "DELETE") {
      const u = users.find(x => x.id === m[1]);
      if (!u) return send(res, 404, { errore: "Utente non trovato." });
      if (u.id === me.id) return send(res, 400, { errore: "Non puoi eliminare il tuo account." });
      users = users.filter(x => x.id !== u.id); await saveUsers();
      for (const [h, s] of sessions) if (s.uid === u.id) sessions.delete(h);
      saveSessions(); stores.delete(u.id);
      await fsp.rm(path.join(USERS_DIR, u.id), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { errore: "Non trovato" });
  }

  // ----- expenses and photos (only the signed-in user's own) -----
  const st = await storeFor(me.id);
  if (p === "/api/spese" && method === "GET") return send(res, 200, { spese: [...st.spese.values()] });
  let m = p.match(/^\/api\/spese\/([A-Za-z0-9_-]{1,80})$/);
  if (m) {
    const id = m[1];
    if (method === "PUT") {
      const body = await readJsonBody(req);
      let doc; try { doc = clean(id, body); } catch (e) { return send(res, 400, { errore: "Dati non validi: " + e.message }); }
      const prev = st.spese.get(id);
      if (prev) doc.creato = prev.creato;
      st.spese.set(id, doc); await st.save();
      if (prev?.allegato && prev.allegato !== doc.allegato) removeFile(st, prev.allegato);
      return send(res, 200, doc);
    }
    if (method === "DELETE") {
      const prev = st.spese.get(id);
      st.spese.delete(id); await st.save();
      if (prev?.allegato) removeFile(st, prev.allegato);
      return send(res, 200, { ok: true });
    }
  }
  if (p === "/api/files" && method === "POST") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    if (!FILE_TYPES.has(type)) return send(res, 415, { errore: "Formato non supportato" });
    const buf = await readBody(req, MAX_FILE);
    if (!buf.length) return send(res, 400, { errore: "File vuoto" });
    const id = crypto.randomUUID();
    await fsp.writeFile(path.join(st.dir, "files", id), buf, { mode: 0o600 });
    await fsp.writeFile(path.join(st.dir, "files", id + ".type"), type);
    return send(res, 200, { id, type, size: buf.length });
  }
  m = p.match(/^\/api\/files\/([A-Za-z0-9_-]{1,80})$/);
  if (m && (method === "GET" || method === "HEAD")) {
    const f = path.join(st.dir, "files", m[1]);
    try {
      const s = await fsp.stat(f);
      const type = (await fsp.readFile(f + ".type", "utf8").catch(() => "application/octet-stream")).trim();
      res.writeHead(200, { "Content-Type": FILE_TYPES.has(type) ? type : "application/octet-stream", "Content-Length": s.size, "Cache-Control": "private, max-age=31536000, immutable", ...SECURITY_HEADERS });
      if (method === "HEAD") return res.end();
      return fs.createReadStream(f).pipe(res);
    } catch { return send(res, 404, "Non trovato"); }
  }
  return send(res, 404, { errore: "Non trovato" });
}

// Once a day: drop expired sessions and photos no expense points to (e.g. a cancelled upload).
async function sweep() {
  try {
    const now = Date.now(); let changed = false;
    for (const [h, s] of sessions) if (s.scade < now) { sessions.delete(h); changed = true; }
    if (changed) saveSessions();
    for (const u of users) {
      const st = await storeFor(u.id);
      const used = new Set([...st.spese.values()].map(s => s.allegato).filter(Boolean));
      const dir = path.join(st.dir, "files");
      for (const name of await fsp.readdir(dir).catch(() => [])) {
        if (used.has(name.replace(/\.type$/, ""))) continue;
        const f = path.join(dir, name);
        const s = await fsp.stat(f).catch(() => null);
        if (s && s.mtimeMs < now - 864e5) await fsp.unlink(f).catch(() => {});
      }
    }
  } catch (e) { console.error("Pulizia:", e.message); }
}

async function main() {
  await fsp.mkdir(USERS_DIR, { recursive: true });
  const u = await readJson(USERS_FILE, { utenti: [], impostazioni: {} });
  users = Array.isArray(u.utenti) ? u.utenti : [];
  settings = { registrazioniAperte: true, ...(u.impostazioni || {}) };
  const s = await readJson(SESS_FILE, { sessioni: [] });
  for (const x of s.sessioni || []) if (x.h && x.scade > Date.now()) sessions.set(x.h, { uid: x.uid, scade: x.scade, creata: x.creata });
  console.log(`Scontrinaio: ${users.length} account, dati in ${DATA_DIR}`);
  http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (e.status !== 400 && e.status !== 413) console.error(e);
      if (!res.headersSent) send(res, e.status || 500, { errore: e.status === 413 ? "File troppo grande" : e.status === 400 ? "Richiesta non valida" : "Errore del server" });
    });
  }).listen(PORT, () => console.log(`Scontrinaio in ascolto sulla porta ${PORT}`));
  setTimeout(sweep, 60e3); setInterval(sweep, 864e5);
}
main();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => Promise.all(queues.values()).finally(() => process.exit(0)));
