// 极简 SW：网络优先，静态资源兜底缓存；不缓存 API/存储请求
const CACHE = 'quanzi-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './manifest.webmanifest'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // 只接管同源静态资源，Supabase 域名与实时请求直连
  if (url.origin !== self.location.origin) return
  if (url.pathname.endsWith('/sw.js')) return

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./'))),
  )
})