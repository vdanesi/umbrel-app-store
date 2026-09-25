// Scontrinaio service worker: the app works offline after the first visit.
const VERSION = "scontrinaio-umbrel-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon-180.png", "icons/favicon-64.png"];
const OCR = ["ocr/tesseract.min.js", "ocr/worker.min.js", "ocr/ita.traineddata.gz"];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    // OCR files are large: fetch them in the background, don't block install
    c.addAll(OCR).catch(() => {});
  })());
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.includes("/api/")) return;
  // Pages: network first so updates arrive, cache when offline
  if (req.mode === "navigate"){
    e.respondWith((async () => {
      try { const r = await fetch(req); const c = await caches.open(VERSION); c.put("index.html", r.clone()); return r; }
      catch { return (await caches.match("index.html")) || (await caches.match("./")); }
    })());
    return;
  }
  // Same-origin files and Google Fonts: cache first, then network (and store it)
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)){
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok || r.type === "opaque"){ const c = await caches.open(VERSION); c.put(req, r.clone()); }
        return r;
      } catch { return hit || Response.error(); }
    })());
  }
});
