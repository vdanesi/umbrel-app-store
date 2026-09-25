// Scontrinaio server for umbrelOS: serves the app and stores expenses and receipt photos on disk.
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
const FILES_DIR = path.join(DATA_DIR, "files");
const DB_FILE = path.join(DATA_DIR, "spese.json");
const MAX_FILE = 25 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".gz": "application/gzip", ".wasm": "application/wasm", ".md": "text/markdown; charset=utf-8",
};
const FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "application/pdf"]);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

// ---------- storage ----------
let spese = new Map();
let writing = Promise.resolve();

async function load() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  try {
    const raw = JSON.parse(await fsp.readFile(DB_FILE, "utf8"));
    for (const s of raw.spese || []) if (s && ID_RE.test(s.id)) spese.set(s.id, s);
  } catch (e) {
    if (e.code !== "ENOENT") {
      // keep the unreadable file aside instead of overwriting it
      const bad = DB_FILE + ".illeggibile-" + Date.now();
      await fsp.rename(DB_FILE, bad).catch(() => {});
      console.error("spese.json non leggibile, salvato come", bad);
    }
  }
  console.log(`Scontrinaio: ${spese.size} spese caricate da ${DATA_DIR}`);
}
function persist() {
  // serialize writes; write to a temp file then rename (atomic on the same disk)
  writing = writing.then(async () => {
    const tmp = DB_FILE + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify({ versione: 1, aggiornato: new Date().toISOString(), spese: [...spese.values()] }));
    await fsp.rename(tmp, DB_FILE);
  }).catch(e => console.error("Salvataggio non riuscito:", e));
  return writing;
}

function removeFile(id) {
  for (const f of [id, id + ".type"]) fsp.unlink(path.join(FILES_DIR, f)).catch(() => {});
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

// ---------- http helpers ----------
function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": isBuf || typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((ok, ko) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { ko(Object.assign(new Error("troppo grande"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", ko);
  });
}
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Vietato");
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error();
    const ext = path.extname(file);
    const long = rel.startsWith("/ocr/") || rel.startsWith("/icons/");
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": long ? "public, max-age=604800" : "no-cache" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  } catch { send(res, 404, "Non trovato"); }
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/api/salute") return send(res, 200, { ok: true, spese: spese.size });

  if (p === "/api/spese" && req.method === "GET") {
    return send(res, 200, { spese: [...spese.values()] });
  }
  let m = p.match(/^\/api\/spese\/([A-Za-z0-9_-]{1,80})$/);
  if (m) {
    const id = m[1];
    if (req.method === "PUT") {
      const body = JSON.parse((await readBody(req, MAX_JSON)).toString("utf8") || "{}");
      let doc; try { doc = clean(id, body); } catch (e) { return send(res, 400, { errore: "Dati non validi: " + e.message }); }
      const prev = spese.get(id);
      if (prev) doc.creato = prev.creato;
      spese.set(id, doc); await persist();
      // remove a replaced photo
      if (prev?.allegato && prev.allegato !== doc.allegato) removeFile(prev.allegato);
      return send(res, 200, doc);
    }
    if (req.method === "DELETE") {
      const prev = spese.get(id);
      spese.delete(id); await persist();
      if (prev?.allegato) removeFile(prev.allegato);
      return send(res, 200, { ok: true });
    }
  }
  if (p === "/api/files" && req.method === "POST") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    if (!FILE_TYPES.has(type)) return send(res, 415, { errore: "Formato non supportato" });
    const buf = await readBody(req, MAX_FILE);
    if (!buf.length) return send(res, 400, { errore: "File vuoto" });
    const id = crypto.randomUUID();
    await fsp.writeFile(path.join(FILES_DIR, id), buf);
    await fsp.writeFile(path.join(FILES_DIR, id + ".type"), type);
    return send(res, 200, { id, type, size: buf.length });
  }
  m = p.match(/^\/api\/files\/([A-Za-z0-9_-]{1,80})$/);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    const f = path.join(FILES_DIR, m[1]);
    try {
      const st = await fsp.stat(f);
      const type = (await fsp.readFile(f + ".type", "utf8").catch(() => "application/octet-stream")).trim();
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Cache-Control": "private, max-age=31536000, immutable" });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(f).pipe(res);
    } catch { return send(res, 404, "Non trovato"); }
  }
  if (p.startsWith("/api/")) return send(res, 404, { errore: "Non trovato" });
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, p);
  send(res, 405, "Metodo non consentito");
}

// Delete photos no expense points to (e.g. an upload whose save was cancelled), once a day.
async function sweep() {
  try {
    const used = new Set([...spese.values()].map(s => s.allegato).filter(Boolean));
    const dayAgo = Date.now() - 864e5;
    for (const name of await fsp.readdir(FILES_DIR)) {
      const id = name.replace(/\.type$/, "");
      if (used.has(id)) continue;
      const f = path.join(FILES_DIR, name);
      const st = await fsp.stat(f).catch(() => null);
      if (st && st.mtimeMs < dayAgo) await fsp.unlink(f).catch(() => {});
    }
  } catch (e) { console.error("Pulizia foto:", e.message); }
}

load().then(() => {
  http.createServer((req, res) => {
    handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, e.status || 500, { errore: e.status === 413 ? "File troppo grande" : "Errore del server" }); });
  }).listen(PORT, () => console.log(`Scontrinaio in ascolto sulla porta ${PORT}`));
  setTimeout(sweep, 60e3); setInterval(sweep, 864e5);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => writing.finally(() => process.exit(0)));
