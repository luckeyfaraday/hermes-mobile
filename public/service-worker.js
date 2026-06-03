const CACHE = 'hermes-mobile-v6'
const SHELL = ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.png']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // Never intercept proxied backend / bridge traffic.
  if (url.pathname.startsWith('/hermes-backend') || url.pathname.startsWith('/mobile-api')) {
    return
  }

  if (event.request.method !== 'GET') {
    return
  }

  // Stale-while-revalidate for the static shell so updates land on next load.
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(event.request)
      const network = fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            cache.put(event.request, response.clone())
          }
          return response
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
