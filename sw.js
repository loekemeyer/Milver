// Service worker Milver — caché offline del "shell" y del catálogo.
// Versión del caché: subir con cada deploy para invalidar.
const CACHE = "milver-v1_16_0";
const SHELL = [
  "./",
  "./index.html",
  "./script.js?v=22",
  "./version.js?v=22",
  "./css/styles.css?v=22",
  "./css/milver.css?v=22",
  "./img/logo-milver.jpg",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Supabase (catálogo/clientes): network-first, cae al caché si no hay señal.
  if (url.hostname.endsWith("supabase.co")) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Estáticos propios: cache-first (rápido y offline).
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html")))
    );
  }
});
