/*
 * ManuFlow ERP service worker.
 *
 * Deliberately conservative — an ERP is not a content site:
 *
 *  • `/api/**` is NEVER intercepted or cached. Those responses are tenant data (stock, invoices,
 *    parties), they are already sent with `Cache-Control: no-store`, and caching them would leak
 *    financial records into a shared browser profile and show stale stock on the shop floor.
 *
 *  • Navigations are network-first and are NOT stored. There is therefore no stale-HTML window after
 *    a deployment: every online visit gets the freshly deployed document, otherwise the user gets the
 *    cached `/offline` page. This also means a failed save can never be replayed from a cache.
 *
 *  • Only immutable, content-hashed build assets (`/_next/static/**`) and a handful of public files
 *    (icons, manifest, offline page) are cached.
 *
 * Bump CACHE_VERSION when the caching rules themselves change; `activate` drops every older cache.
 */
const CACHE_VERSION = 'v1'
const STATIC_CACHE = `manuflow-static-${CACHE_VERSION}`
const PRECACHE = ['/offline', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']
const OFFLINE_URL = '/offline'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE)
      // Individually, so one 404 cannot abort the whole install.
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined)))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => k.startsWith('manuflow-') && k !== STATIC_CACHE).map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  // The page can ask for an immediate activation when a new build is waiting.
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

/** Build output and public assets are content-addressed, so cache-first is safe for them. */
function isImmutableAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/static/') ||
    /\.(?:css|js|png|jpg|jpeg|svg|webp|ico|woff2?)$/.test(url.pathname)
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Tenant data and auth: hands off completely.
  if (url.pathname.startsWith('/api/')) return

  // Documents: network-first, never cached, offline page as the fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request)
        } catch {
          const cache = await caches.open(STATIC_CACHE)
          return (await cache.match(OFFLINE_URL)) || Response.error()
        }
      })(),
    )
    return
  }

  if (!isImmutableAsset(url)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE)
      const hit = await cache.match(request)
      if (hit) return hit
      try {
        const response = await fetch(request)
        // Only cache complete, successful, same-origin responses.
        if (response.ok && response.type === 'basic') cache.put(request, response.clone())
        return response
      } catch {
        return Response.error()
      }
    })(),
  )
})
